/**
 * Signer repository with baseline + overlay merge.
 *
 * SignerRepository loads the baseline signer dataset from the bundled
 * `signers.json` fixture (via the {@link fixtureRegistry}) and applies valid
 * local overlays persisted under the `access.signerOverrides.v2` storage domain
 * by stable `signer_id`. The merge is intentionally conservative:
 *
 *   - Overlays are keyed by `signer_id` and merged onto the matching baseline
 *     record; overlays with no corresponding baseline signer (orphans) are
 *     ignored.
 *   - Overlays that fail structural validation are dropped rather than allowed
 *     to corrupt the merged dataset.
 *   - Always-locked fields (`signer_id`, `edit_revision`, `created_at`) can
 *     never be changed by an overlay.
 *
 * The repository exposes an entitlement-scoped visible dataset (filtered by the
 * caller's account scopes and required capability) and produces masked display
 * models so PII never leaks into the UI. It is a demo-only, non-regulatory
 * store: overlays live in local browser storage and carry no server guarantee.
 */

import { STORAGE_DOMAINS, CAPABILITIES } from '@/shared/config/constants';
import { StoredRecordEnvelopeSchema, createStoredRecordEnvelope } from '@/shared/schemas/schemas';
import { fixtureRegistry } from '@/shared/fixtures/fixtureRegistry';
import { maskingPolicy } from '@/shared/privacy/maskingPolicy';
import { demoClock } from '@/shared/time/demoClock';
import { safeLogger } from '@/shared/logging/safeLogger';
import { z } from 'zod';

/** Storage domain suffix backing the signer overlays. */
const OVERRIDES_DOMAIN = STORAGE_DOMAINS.ACCESS.SIGNER_OVERRIDES;

/** Fields that can never be modified by a local overlay. */
const ALWAYS_LOCKED_FIELDS = Object.freeze(['signer_id', 'edit_revision', 'created_at']);

/** Default masking context applied to signer display models. */
const DEFAULT_MASKING_CONTEXT = maskingPolicy.MASKING_CONTEXTS.LIST;

/** Schema describing a single persisted signer overlay. */
const SignerOverlaySchema = z
  .object({
    signer_id: z.string().min(1),
  })
  .passthrough();

/** Schema describing the persisted overlay payload (an array of overlays). */
const SignerOverlaysSchema = z.array(SignerOverlaySchema).default([]);

/** Schema describing the stored envelope wrapping the signer overlays. */
const SignerOverlaysEnvelopeSchema = StoredRecordEnvelopeSchema.extend({
  data: SignerOverlaysSchema,
});

/**
 * Determines whether a value is a plain, non-array object suitable for merging.
 * @param {unknown} value - The candidate value.
 * @returns {boolean} `true` when `value` is a plain object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalizes a value into a string array, dropping non-string entries.
 * @param {unknown} value - The candidate value.
 * @returns {string[]} A safe array of strings (may be empty).
 */
function toStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => typeof item === 'string' && item.length > 0);
}

/**
 * Merges a validated overlay onto a baseline signer record, protecting the
 * always-locked fields from any change.
 * @param {Record<string, unknown>} baseline - The baseline signer record.
 * @param {Record<string, unknown>} overlay - The validated overlay.
 * @returns {Record<string, unknown>} A new merged signer record.
 */
function mergeSigner(baseline, overlay) {
  const merged = { ...baseline };
  for (const key of Object.keys(overlay)) {
    if (ALWAYS_LOCKED_FIELDS.includes(key)) {
      continue;
    }
    merged[key] = overlay[key];
  }
  // Ensure always-locked fields always reflect the baseline values.
  for (const key of ALWAYS_LOCKED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(baseline, key)) {
      merged[key] = baseline[key];
    }
  }
  return merged;
}

/**
 * A local, baseline + overlay signer repository.
 */
export class SignerRepository {
  /**
   * @param {import('@/shared/storage/storageAdapter').StorageAdapter} adapter
   *   The storage adapter used to persist and read signer overlays.
   * @param {{ maskingContext?: string }} [options] - Repository options.
   */
  constructor(adapter, options) {
    if (
      !adapter ||
      typeof adapter.read !== 'function' ||
      typeof adapter.write !== 'function' ||
      typeof adapter.remove !== 'function'
    ) {
      throw new TypeError('SignerRepository: a valid StorageAdapter is required.');
    }
    /** @type {import('@/shared/storage/storageAdapter').StorageAdapter} */
    this.adapter = adapter;
    const requested = options?.maskingContext;
    const contexts = Object.values(maskingPolicy.MASKING_CONTEXTS);
    /** @type {string} */
    this.maskingContext =
      typeof requested === 'string' && contexts.includes(requested)
        ? requested
        : DEFAULT_MASKING_CONTEXT;
  }

  /**
   * Reads the baseline signer dataset from the bundled fixture.
   * @returns {Array<Record<string, unknown>>} The baseline signer records.
   */
  readBaseline() {
    return fixtureRegistry.getSigners();
  }

  /**
   * Reads and validates the persisted signer overlays.
   * @returns {Array<Record<string, unknown>>} The stored overlays (may be empty).
   */
  readOverlays() {
    const envelope = this.adapter.read(OVERRIDES_DOMAIN, SignerOverlaysEnvelopeSchema, undefined);
    if (!envelope || !Array.isArray(envelope.data)) {
      return [];
    }
    return envelope.data;
  }

  /**
   * Persists the supplied overlays, wrapping them in a stored envelope.
   * @param {Array<Record<string, unknown>>} overlays - The overlays to persist.
   * @returns {boolean} `true` when the write succeeded.
   */
  persistOverlays(overlays) {
    const created = createStoredRecordEnvelope(overlays, {
      createdAt: demoClock.now(),
      expiresAt: null,
    });
    if (!created.ok) {
      safeLogger.error('signerRepository: failed to build stored envelope', {
        reason: created.error,
      });
      return false;
    }
    return this.adapter.write(OVERRIDES_DOMAIN, created.value);
  }

  /**
   * Builds a map of valid overlays keyed by `signer_id`, dropping malformed and
   * orphan overlays (overlays with no matching baseline signer).
   * @param {Set<string>} baselineIds - The set of known baseline signer IDs.
   * @returns {Map<string, Record<string, unknown>>} Valid overlays by signer ID.
   */
  buildOverlayIndex(baselineIds) {
    const overlays = this.readOverlays();
    const index = new Map();
    for (const raw of overlays) {
      const parsed = SignerOverlaySchema.safeParse(raw);
      if (!parsed.success) {
        safeLogger.warn('signerRepository: dropped malformed signer overlay');
        continue;
      }
      const overlay = parsed.data;
      if (!baselineIds.has(overlay.signer_id)) {
        // Orphan overlay: no baseline signer to attach to; ignore it.
        safeLogger.warn('signerRepository: ignored orphan signer overlay');
        continue;
      }
      index.set(overlay.signer_id, overlay);
    }
    return index;
  }

  /**
   * Returns the merged signer dataset: baseline records with valid overlays
   * applied by `signer_id`.
   * @returns {Array<Record<string, unknown>>} The merged signer records.
   */
  list() {
    const baseline = this.readBaseline();
    const baselineIds = new Set(
      baseline
        .map((signer) => (typeof signer.signer_id === 'string' ? signer.signer_id : undefined))
        .filter((id) => typeof id === 'string'),
    );
    const overlays = this.buildOverlayIndex(baselineIds);

    return baseline.map((signer) => {
      const overlay =
        typeof signer.signer_id === 'string' ? overlays.get(signer.signer_id) : undefined;
      if (overlay) {
        return mergeSigner(signer, overlay);
      }
      return { ...signer };
    });
  }

  /**
   * Looks up a single merged signer by its identifier.
   * @param {string} signerId - The signer identifier.
   * @returns {Record<string, unknown> | undefined} The merged signer, or `undefined`.
   */
  getById(signerId) {
    if (typeof signerId !== 'string' || signerId.length === 0) {
      return undefined;
    }
    return this.list().find((signer) => signer.signer_id === signerId);
  }

  /**
   * Returns the entitlement-scoped visible signer dataset for a session.
   *
   * Visibility follows a deny-by-default policy: a signer is only visible when
   * the acting session holds the required capability (defaulting to
   * `signer.read`) and, when account scopes are supplied, at least one of the
   * signer's account scopes intersects the session's account scopes. When no
   * session account scopes are supplied the account-scope filter is skipped.
   *
   * @param {{
   *   capabilities?: string[],
   *   accountScopes?: string[],
   *   requiredCapability?: string,
   * }} [entitlements] - The acting session's entitlements.
   * @returns {Array<Record<string, unknown>>} The visible merged signer records.
   */
  listVisible(entitlements) {
    const source = entitlements ?? {};
    const capabilities = toStringArray(source.capabilities);
    const requiredCapability =
      typeof source.requiredCapability === 'string' && source.requiredCapability.length > 0
        ? source.requiredCapability
        : CAPABILITIES.SIGNER_READ;

    if (!capabilities.includes(requiredCapability)) {
      return [];
    }

    const sessionScopes = toStringArray(source.accountScopes);
    const merged = this.list();

    if (sessionScopes.length === 0) {
      return merged;
    }

    const scopeSet = new Set(sessionScopes);
    return merged.filter((signer) => {
      const signerScopes = toStringArray(signer.account_scopes);
      return signerScopes.some((scope) => scopeSet.has(scope));
    });
  }

  /**
   * Builds a masked display model for a single merged signer record.
   * @param {Record<string, unknown>} signer - The merged signer record.
   * @param {string} [context] - Optional masking context override.
   * @returns {Record<string, unknown> | undefined} A masked display model.
   */
  toDisplayModel(signer, context) {
    if (!isPlainObject(signer)) {
      return undefined;
    }
    const contexts = Object.values(maskingPolicy.MASKING_CONTEXTS);
    const maskingContext =
      typeof context === 'string' && contexts.includes(context) ? context : this.maskingContext;

    return {
      signer_id: typeof signer.signer_id === 'string' ? signer.signer_id : undefined,
      signer_name: maskingPolicy.mask('name', signer.signer_name, maskingContext),
      email: maskingPolicy.mask('email', signer.email, maskingContext),
      phone: maskingPolicy.mask('phone', signer.phone, maskingContext),
      organization_id:
        typeof signer.organization_id === 'string' ? signer.organization_id : undefined,
      authority: typeof signer.authority === 'string' ? signer.authority : undefined,
      amount_limit:
        typeof signer.amount_limit === 'number' ? signer.amount_limit : null,
      account_scopes: toStringArray(signer.account_scopes),
      status: typeof signer.status === 'string' ? signer.status : undefined,
      locked: signer.locked === true,
      lock_reason: typeof signer.lock_reason === 'string' ? signer.lock_reason : null,
      invitation_state:
        typeof signer.invitation_state === 'string' ? signer.invitation_state : undefined,
      edit_revision: typeof signer.edit_revision === 'number' ? signer.edit_revision : 0,
      editable_fields: toStringArray(signer.editable_fields),
      locked_fields: toStringArray(signer.locked_fields),
    };
  }

  /**
   * Returns masked display models for the entitlement-scoped visible dataset.
   * @param {{
   *   capabilities?: string[],
   *   accountScopes?: string[],
   *   requiredCapability?: string,
   * }} [entitlements] - The acting session's entitlements.
   * @param {string} [context] - Optional masking context override.
   * @returns {Array<Record<string, unknown>>} Masked signer display models.
   */
  listVisibleDisplayModels(entitlements, context) {
    return this.listVisible(entitlements)
      .map((signer) => this.toDisplayModel(signer, context))
      .filter((model) => model !== undefined);
  }

  /**
   * Clears all persisted signer overlays.
   * @returns {boolean} `true` when the overlays were cleared.
   */
  clearOverlays() {
    return this.adapter.remove(OVERRIDES_DOMAIN);
  }
}

/**
 * Creates a {@link SignerRepository} bound to the supplied storage adapter.
 * @param {import('@/shared/storage/storageAdapter').StorageAdapter} adapter
 *   The storage adapter used to persist and read signer overlays.
 * @param {{ maskingContext?: string }} [options] - Repository options.
 * @returns {SignerRepository} A configured signer repository.
 */
export function createSignerRepository(adapter, options) {
  return new SignerRepository(adapter, options);
}

/**
 * The signer repository contract, exposed as a single frozen object.
 * @type {{
 *   SignerRepository: typeof SignerRepository,
 *   createSignerRepository: typeof createSignerRepository,
 *   ALWAYS_LOCKED_FIELDS: typeof ALWAYS_LOCKED_FIELDS,
 * }}
 */
export const signerRepository = Object.freeze({
  SignerRepository,
  createSignerRepository,
  ALWAYS_LOCKED_FIELDS,
});

export default signerRepository;