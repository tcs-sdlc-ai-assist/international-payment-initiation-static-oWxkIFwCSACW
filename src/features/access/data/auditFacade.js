/**
 * Audit facade (cross-cluster contract).
 *
 * AuditFacade is the single entry point both clusters (access + payment) use to
 * record and query sanitized demo audit history. It implements the AuditFacade
 * contract:
 *
 *   - `append(event)` constructs a schema-compliant, masked audit event and
 *     persists it via an {@link AuditRepository}. Free-form metadata is masked
 *     before persistence and identifiers/timestamps are auto-generated when
 *     omitted.
 *   - `search(filter)` queries the local, bounded audit history, returning
 *     matching events newest-first.
 *
 * The facade is intentionally lazy: it lazily provisions a shared
 * {@link StorageAdapter} and {@link AuditRepository} on first use so it can be
 * imported freely without side effects at module load. A custom repository may
 * be injected (primarily for tests) via {@link configureAuditFacade}.
 *
 * This is a demo-only, non-regulatory audit trail: entries are sanitized,
 * masked, and stored in local browser storage. It is not tamper-evident and
 * must never be treated as a compliant audit trail.
 */

import { createLocalStorageAdapter } from '@/shared/storage/storageAdapter';
import { createAuditRepository } from '@/features/access/data/auditRepository';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Lazily-provisioned audit repository shared across facade calls. */
let sharedRepository = null;

/**
 * Provisions (or returns) the shared audit repository, creating a local storage
 * adapter and repository on first use. Failures degrade to `null` so callers
 * never crash on a storage fault.
 * @returns {import('@/features/access/data/auditRepository').AuditRepository | null}
 *   The shared repository, or `null` when it could not be provisioned.
 */
function resolveRepository() {
  if (sharedRepository) {
    return sharedRepository;
  }
  try {
    const adapter = createLocalStorageAdapter();
    sharedRepository = createAuditRepository(adapter);
    return sharedRepository;
  } catch (error) {
    safeLogger.error('auditFacade: failed to provision audit repository', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

/**
 * Overrides the repository backing the facade. Primarily used by tests to
 * inject a deterministic or in-memory repository.
 * @param {import('@/features/access/data/auditRepository').AuditRepository | null} repository
 *   The repository to use, or `null` to reset to lazy provisioning.
 * @returns {void}
 */
export function configureAuditFacade(repository) {
  sharedRepository = repository ?? null;
}

/**
 * Appends a schema-compliant, masked audit event to the local history.
 *
 * Missing identifiers and timestamps are generated, and any free-form metadata
 * is masked before persistence by the underlying repository.
 *
 * @param {{
 *   eventType: string,
 *   actorId?: string,
 *   subjectId?: string,
 *   safeReasonCode?: string,
 *   metadata?: Record<string, unknown>,
 *   eventId?: string,
 *   occurredAt?: string,
 * }} event - The audit event to record.
 * @returns {import('@/shared/schemas/schemas').AuditEventV1 | undefined}
 *   The appended event, or `undefined` when it could not be recorded.
 */
export function append(event) {
  const repository = resolveRepository();
  if (!repository) {
    safeLogger.warn('auditFacade: append skipped; no repository available');
    return undefined;
  }
  try {
    return repository.append(event);
  } catch (error) {
    safeLogger.error('auditFacade: failed to append audit event', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return undefined;
  }
}

/**
 * Searches the local audit history, returning matching events newest-first.
 *
 * @param {{
 *   eventType?: string,
 *   actorId?: string,
 *   subjectId?: string,
 *   safeReasonCode?: string,
 *   text?: string,
 *   since?: string,
 *   until?: string,
 *   limit?: number,
 * }} [filter] - Optional search filter.
 * @returns {import('@/shared/schemas/schemas').AuditEventV1[]}
 *   The matching audit events, newest-first (may be empty).
 */
export function search(filter) {
  const repository = resolveRepository();
  if (!repository) {
    safeLogger.warn('auditFacade: search skipped; no repository available');
    return [];
  }
  try {
    return repository.search(filter);
  } catch (error) {
    safeLogger.error('auditFacade: failed to search audit history', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return [];
  }
}

/**
 * The AuditFacade contract, exposed as a single frozen object.
 * @type {{
 *   append: typeof append,
 *   search: typeof search,
 *   configureAuditFacade: typeof configureAuditFacade,
 * }}
 */
export const auditFacade = Object.freeze({
  append,
  search,
  configureAuditFacade,
});

export default auditFacade;