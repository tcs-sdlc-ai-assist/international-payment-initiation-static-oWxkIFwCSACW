/**
 * Unit tests for the centralized PII masking policy.
 *
 * These tests exercise the full 16-field PII inventory across the four display
 * contexts (list / detail / confirmation / audit), the single-field `mask`
 * entry point (including alias resolution and unknown-field passthrough), and
 * the shallow-object `sanitizeObject` sweep.
 */

import { describe, it, expect } from 'vitest';
import {
  mask,
  sanitizeObject,
  maskAccount,
  maskIban,
  maskBic,
  maskCard,
  maskEmail,
  maskPhone,
  maskName,
  maskReference,
  maskAddress,
  maskDateOfBirth,
  maskCountry,
  maskTaxId,
  maskingPolicy,
  MASKING_CONTEXTS,
  PII_FIELDS,
} from '@/shared/privacy/maskingPolicy';

describe('maskingPolicy field maskers', () => {
  it('masks an account number revealing only the trailing digits by context', () => {
    const list = maskAccount('123456789012', MASKING_CONTEXTS.LIST);
    expect(list).toContain('9012');
    expect(list).not.toBe('123456789012');

    const audit = maskAccount('123456789012', MASKING_CONTEXTS.AUDIT);
    expect(audit).not.toContain('9012');
  });

  it('masks an IBAN preserving its country prefix outside of audit', () => {
    const detail = maskIban('DE89370400440532013000', MASKING_CONTEXTS.DETAIL);
    expect(detail.startsWith('DE')).toBe(true);
    expect(detail).not.toContain('370400440532013000');

    const audit = maskIban('DE89370400440532013000', MASKING_CONTEXTS.AUDIT);
    expect(audit).toBe('DE');
  });

  it('masks a BIC revealing more of the identifier outside of audit', () => {
    const list = maskBic('MANHUS33XXX', MASKING_CONTEXTS.LIST);
    expect(list.startsWith('MANHUS')).toBe(true);

    const audit = maskBic('MANHUS33XXX', MASKING_CONTEXTS.AUDIT);
    expect(audit.startsWith('MANH')).toBe(true);
    expect(audit).not.toContain('MANHUS');
  });

  it('masks a card/PAN revealing only the last four digits outside of audit', () => {
    const list = maskCard('4111111111111234', MASKING_CONTEXTS.LIST);
    expect(list).toContain('1234');

    const audit = maskCard('4111111111111234', MASKING_CONTEXTS.AUDIT);
    expect(audit).not.toContain('1234');
  });

  it('masks an email preserving only the leading initial and TLD hint', () => {
    const detail = maskEmail('amelia.hartwell@example.test', MASKING_CONTEXTS.DETAIL);
    expect(detail.startsWith('a')).toBe(true);
    expect(detail).not.toContain('hartwell');
    expect(detail).toContain('.test');

    const audit = maskEmail('amelia.hartwell@example.test', MASKING_CONTEXTS.AUDIT);
    expect(audit.startsWith('a')).toBe(true);
    expect(audit).not.toContain('@');
  });

  it('masks a phone number revealing only trailing digits outside of audit', () => {
    const detail = maskPhone('+1-555-1001', MASKING_CONTEXTS.DETAIL);
    expect(detail).toContain('01');
    expect(detail).not.toContain('555');

    const audit = maskPhone('+1-555-1001', MASKING_CONTEXTS.AUDIT);
    expect(audit).not.toContain('01');
  });

  it('masks a name to initials only in the audit context', () => {
    const audit = maskName('Amelia Grace Hartwell', MASKING_CONTEXTS.AUDIT);
    expect(audit).toBe('A.G.H.');
    expect(audit).not.toContain('Amelia');

    const list = maskName('Amelia Hartwell', MASKING_CONTEXTS.LIST);
    expect(list.startsWith('A')).toBe(true);
    expect(list).not.toContain('Amelia');
  });

  it('masks a reference revealing only a short prefix outside of audit', () => {
    const detail = maskReference('INV-2026-0001', MASKING_CONTEXTS.DETAIL);
    expect(detail.startsWith('INV')).toBe(true);
    expect(detail).not.toContain('2026');

    const audit = maskReference('INV-2026-0001', MASKING_CONTEXTS.AUDIT);
    expect(audit).not.toContain('INV');
  });

  it('masks an address component revealing only a short hint outside of audit', () => {
    const detail = maskAddress('221B Baker Street', MASKING_CONTEXTS.DETAIL);
    expect(detail.startsWith('22')).toBe(true);
    expect(detail).not.toContain('Baker');

    const audit = maskAddress('221B Baker Street', MASKING_CONTEXTS.AUDIT);
    expect(audit).not.toContain('22');
  });

  it('masks a date of birth revealing only the year outside of audit', () => {
    const detail = maskDateOfBirth('1985-03-14', MASKING_CONTEXTS.DETAIL);
    expect(detail).toContain('1985');
    expect(detail).not.toContain('03');

    const audit = maskDateOfBirth('1985-03-14', MASKING_CONTEXTS.AUDIT);
    expect(audit).not.toContain('1985');
  });

  it('reveals a country except in the audit context', () => {
    const detail = maskCountry('Germany', MASKING_CONTEXTS.DETAIL);
    expect(detail).toBe('Germany');

    const audit = maskCountry('Germany', MASKING_CONTEXTS.AUDIT);
    expect(audit).toBe('GE');
  });

  it('masks a tax/national identifier revealing trailing characters outside of audit', () => {
    const list = maskTaxId('AB1234567', MASKING_CONTEXTS.LIST);
    expect(list).toContain('4567');

    const audit = maskTaxId('AB1234567', MASKING_CONTEXTS.AUDIT);
    expect(audit).not.toContain('4567');
  });

  it('returns an empty placeholder for absent values', () => {
    expect(maskAccount('', MASKING_CONTEXTS.LIST)).toBe('—');
    expect(maskEmail(null, MASKING_CONTEXTS.DETAIL)).toBe('—');
    expect(maskName(undefined, MASKING_CONTEXTS.AUDIT)).toBe('—');
  });
});

describe('maskingPolicy.mask', () => {
  it('masks a known canonical PII field', () => {
    const masked = mask(PII_FIELDS.EMAIL, 'benjamin.osei@example.test', MASKING_CONTEXTS.DETAIL);
    expect(masked).not.toContain('osei');
    expect(masked.startsWith('b')).toBe(true);
  });

  it('resolves an aliased object property name to a canonical field', () => {
    const masked = mask('beneficiaryName', 'Helvetia Components', MASKING_CONTEXTS.LIST);
    expect(masked).not.toContain('Helvetia');
    expect(masked.startsWith('H')).toBe(true);
  });

  it('returns an unknown field value unchanged', () => {
    expect(mask('status', 'active', MASKING_CONTEXTS.DETAIL)).toBe('active');
    expect(mask('unknownField', 'demo-value', MASKING_CONTEXTS.AUDIT)).toBe('demo-value');
  });

  it('falls back to the default (list) context when the context is invalid', () => {
    const masked = mask(PII_FIELDS.ACCOUNT, '123456789012', 'not-a-context');
    expect(masked).toContain('9012');
  });
});

describe('maskingPolicy.sanitizeObject', () => {
  it('masks every known PII field within a flat object', () => {
    const sanitized = sanitizeObject(
      {
        signer_id: 'demo-signer-0001',
        name: 'Amelia Hartwell',
        email: 'amelia.hartwell@example.test',
        phone: '+1-555-1001',
        iban: 'DE89370400440532013000',
        status: 'active',
      },
      MASKING_CONTEXTS.DETAIL,
    );

    expect(sanitized.signer_id).toBe('demo-signer-0001');
    expect(sanitized.status).toBe('active');
    expect(sanitized.name).not.toContain('Amelia');
    expect(sanitized.email).not.toContain('hartwell');
    expect(sanitized.phone).not.toContain('555');
    expect(sanitized.iban.startsWith('DE')).toBe(true);
  });

  it('masks known PII fields within nested plain objects', () => {
    const sanitized = sanitizeObject(
      {
        reference: 'INV-2026-0001',
        beneficiary: {
          name: 'Nordic Timber Exports',
          account: '123456789012',
        },
      },
      MASKING_CONTEXTS.CONFIRMATION,
    );

    expect(sanitized.reference).not.toContain('2026');
    expect(sanitized.beneficiary.name).not.toContain('Nordic');
    expect(sanitized.beneficiary.account).toContain('12');
    expect(sanitized.beneficiary.account).not.toBe('123456789012');
  });

  it('masks known PII fields within arrays of plain objects', () => {
    const sanitized = sanitizeObject(
      {
        signers: [
          { name: 'Amelia Hartwell', email: 'amelia@example.test' },
          { name: 'Benjamin Osei', email: 'benjamin@example.test' },
        ],
      },
      MASKING_CONTEXTS.LIST,
    );

    expect(Array.isArray(sanitized.signers)).toBe(true);
    expect(sanitized.signers[0].name).not.toContain('Amelia');
    expect(sanitized.signers[1].email).not.toContain('benjamin');
  });

  it('does not mutate the source object', () => {
    const source = { name: 'Amelia Hartwell', status: 'active' };
    const sanitized = sanitizeObject(source, MASKING_CONTEXTS.AUDIT);
    expect(source.name).toBe('Amelia Hartwell');
    expect(sanitized.name).not.toBe(source.name);
  });

  it('returns null and undefined inputs unchanged', () => {
    expect(sanitizeObject(null, MASKING_CONTEXTS.LIST)).toBeNull();
    expect(sanitizeObject(undefined, MASKING_CONTEXTS.LIST)).toBeUndefined();
  });

  it('preserves non-PII keys and their values', () => {
    const sanitized = sanitizeObject(
      { amount: 1000, eligible: true, pairId: 'EUR-USD' },
      MASKING_CONTEXTS.DETAIL,
    );
    expect(sanitized.amount).toBe(1000);
    expect(sanitized.eligible).toBe(true);
    expect(sanitized.pairId).toBe('EUR-USD');
  });
});

describe('maskingPolicy contract', () => {
  it('exposes the masking API and constants', () => {
    expect(typeof maskingPolicy.mask).toBe('function');
    expect(typeof maskingPolicy.sanitizeObject).toBe('function');
    expect(maskingPolicy.MASKING_CONTEXTS).toBe(MASKING_CONTEXTS);
    expect(maskingPolicy.PII_FIELDS).toBe(PII_FIELDS);
  });

  it('sanitizes an object through the contract entry point', () => {
    const sanitized = maskingPolicy.sanitizeObject(
      { name: 'Clara Nishimura', status: 'active' },
      MASKING_CONTEXTS.LIST,
    );
    expect(sanitized.name).not.toContain('Clara');
    expect(sanitized.status).toBe('active');
  });
});