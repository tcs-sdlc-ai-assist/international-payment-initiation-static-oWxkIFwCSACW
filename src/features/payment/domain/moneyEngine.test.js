/**
 * Unit tests for the integer-minor-units money engine.
 *
 * These tests exercise golden vectors for parsing, formatting, conversion, and
 * total-debit computation, covering integer minor-unit precision, banker's
 * (half-even) and half-up rounding boundaries, and negative/overflow inputs.
 */

import { describe, it, expect } from 'vitest';
import {
  parseAmount,
  formatAmount,
  convert,
  computeTotalDebit,
  ROUNDING_MODES,
  MONEY_REASON_CODES,
} from '@/features/payment/domain/moneyEngine';

describe('moneyEngine.parseAmount', () => {
  it('parses a decimal string into integer minor units at the requested precision', () => {
    const result = parseAmount('1234.56', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.minor).toBe(123456);
      expect(result.minorString).toBe('123456');
      expect(result.precision).toBe(2);
    }
  });

  it('pads a short fractional part to the requested precision', () => {
    const result = parseAmount('10.5', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.minor).toBe(1050);
    }
  });

  it('parses a zero-precision amount without a fractional part', () => {
    const result = parseAmount('1000', 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.minor).toBe(1000);
    }
  });

  it('rounds excess fraction using banker\u2019s rounding on an exact tie down to even', () => {
    const result = parseAmount('1.005', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 1.005 at 2 dp: tie rounds to nearest even -> 1.00 (100).
      expect(result.minor).toBe(100);
    }
  });

  it('rounds excess fraction using banker\u2019s rounding on an exact tie up to even', () => {
    const result = parseAmount('1.015', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 1.015 at 2 dp: tie rounds to nearest even -> 1.02 (102).
      expect(result.minor).toBe(102);
    }
  });

  it('rounds excess fraction using half-up when opted in', () => {
    const result = parseAmount('1.005', 2, { roundingMode: ROUNDING_MODES.HALF_UP });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.minor).toBe(101);
    }
  });

  it('rounds a non-tie fraction up correctly', () => {
    const result = parseAmount('1.008', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.minor).toBe(101);
    }
  });

  it('parses a negative amount into signed minor units', () => {
    const result = parseAmount('-42.50', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.minor).toBe(-4250);
    }
  });

  it('parses a finite number input', () => {
    const result = parseAmount(99.99, 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.minor).toBe(9999);
    }
  });

  it('rejects a malformed amount with a sanitized reason code', () => {
    const result = parseAmount('not-a-number', 2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.safeReasonCode).toBe(MONEY_REASON_CODES.INVALID_AMOUNT);
    }
  });

  it('rejects a non-finite number input', () => {
    const result = parseAmount(Number.POSITIVE_INFINITY, 2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.safeReasonCode).toBe(MONEY_REASON_CODES.INVALID_AMOUNT);
    }
  });
});

describe('moneyEngine.formatAmount', () => {
  it('formats integer minor units into a fixed-precision decimal string', () => {
    const result = formatAmount(123456, 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('1234.56');
      expect(result.precision).toBe(2);
    }
  });

  it('formats a value smaller than one unit with a zero integer part', () => {
    const result = formatAmount(5, 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('0.05');
    }
  });

  it('formats a negative minor amount with a leading sign', () => {
    const result = formatAmount(-4250, 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('-42.50');
    }
  });

  it('formats a zero-precision amount without a fractional part', () => {
    const result = formatAmount(1000, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('1000');
    }
  });

  it('formats a string-encoded minor amount', () => {
    const result = formatAmount('987654', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('9876.54');
    }
  });

  it('rejects a non-integer numeric minor amount', () => {
    const result = formatAmount(12.5, 2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.safeReasonCode).toBe(MONEY_REASON_CODES.INVALID_AMOUNT);
    }
  });
});

describe('moneyEngine.convert', () => {
  it('converts a source minor amount into the beneficiary currency at equal precision', () => {
    const result = convert(100000, {
      rate: '1.084200',
      rateScale: 6,
      sourcePrecision: 2,
      beneficiaryPrecision: 2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 1000.00 EUR * 1.0842 = 1084.20 USD -> 108420 minor.
      expect(result.minor).toBe(108420);
      expect(result.value).toBe('1084.20');
      expect(result.beneficiaryPrecision).toBe(2);
    }
  });

  it('re-scales when the beneficiary precision differs from the source precision', () => {
    const result = convert(100000, {
      rate: '1.000000',
      rateScale: 6,
      sourcePrecision: 2,
      beneficiaryPrecision: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 1000.00 at 0 dp -> 1000 minor units.
      expect(result.minor).toBe(1000);
      expect(result.value).toBe('1000');
    }
  });

  it('applies deterministic rounding on conversion', () => {
    const result = convert(1, {
      rate: '1.005000',
      rateScale: 6,
      sourcePrecision: 2,
      beneficiaryPrecision: 2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 0.01 * 1.005 = 0.01005 -> rounds to 0.01 (1 minor) half-even.
      expect(result.minor).toBe(1);
    }
  });

  it('rejects a malformed rate with a sanitized reason code', () => {
    const result = convert(100000, {
      rate: 'invalid',
      rateScale: 6,
      sourcePrecision: 2,
      beneficiaryPrecision: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.safeReasonCode).toBe(MONEY_REASON_CODES.INVALID_RATE);
    }
  });

  it('rejects a negative source amount for conversion', () => {
    const result = convert(-100, {
      rate: '1.000000',
      rateScale: 6,
      sourcePrecision: 2,
      beneficiaryPrecision: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.safeReasonCode).toBe(MONEY_REASON_CODES.INVALID_RATE);
    }
  });

  it('rejects a malformed source amount for conversion', () => {
    const result = convert('not-a-number', {
      rate: '1.000000',
      rateScale: 6,
      sourcePrecision: 2,
      beneficiaryPrecision: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.safeReasonCode).toBe(MONEY_REASON_CODES.INVALID_AMOUNT);
    }
  });
});

describe('moneyEngine.computeTotalDebit', () => {
  it('returns the instructed amount unchanged when there are no fee legs (BEN treatment)', () => {
    const result = computeTotalDebit({
      instructedMinor: 100000,
      legs: [],
      precision: 2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.minor).toBe(100000);
      expect(result.value).toBe('1000.00');
    }
  });

  it('sums the instructed amount and a sender-borne fee leg (OUR/SHA treatment)', () => {
    const result = computeTotalDebit({
      instructedMinor: 100000,
      legs: [800],
      precision: 2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.minor).toBe(100800);
      expect(result.value).toBe('1008.00');
    }
  });

  it('sums multiple fee legs without floating-point drift', () => {
    const result = computeTotalDebit({
      instructedMinor: 250000,
      legs: [125, 375, '250'],
      precision: 2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.minor).toBe(250750);
      expect(result.value).toBe('2507.50');
    }
  });

  it('rejects a malformed instructed amount with a sanitized reason code', () => {
    const result = computeTotalDebit({
      instructedMinor: 'invalid',
      legs: [100],
      precision: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.safeReasonCode).toBe(MONEY_REASON_CODES.INVALID_AMOUNT);
    }
  });

  it('rejects a malformed fee leg with a sanitized reason code', () => {
    const result = computeTotalDebit({
      instructedMinor: 100000,
      legs: [12.5],
      precision: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.safeReasonCode).toBe(MONEY_REASON_CODES.INVALID_LEG);
    }
  });
});