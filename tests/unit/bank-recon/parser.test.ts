/**
 * BR-2: bank-recon multi-layer CSV parser.
 *
 * Coverage: each Canadian big-bank preset, the encoding fallback layer,
 * the header-hints + content-shape fallbacks, and a couple of edge
 * cases (mojibake, ambiguous dates, manual override).
 */

import { describe, expect, it } from 'vitest';
import { decodeBuffer } from '@/lib/bank-recon/csv';
import { detectDateFormat } from '@/lib/bank-recon/date-detection';
import { parseBankStatement } from '@/lib/bank-recon/parser';
import { extractSignedCents, parseMoneyToCents } from '@/lib/bank-recon/sign-detection';
import {
  AMEX_CSV,
  BMO_CSV,
  CIBC_CSV,
  GENERIC_CSV,
  mojibakeWin1252Buffer,
  RBC_CSV,
  SCOTIA_CSV,
  TD_CSV,
} from './fixtures';

const buf = (s: string) => Buffer.from(s, 'utf-8');

describe('parseMoneyToCents', () => {
  it('parses plain dollars', () => {
    expect(parseMoneyToCents('184.27')).toBe(18427);
    expect(parseMoneyToCents('5200.00')).toBe(520000);
  });
  it('parses thousands separators', () => {
    expect(parseMoneyToCents('1,234.56')).toBe(123456);
    expect(parseMoneyToCents('$1,234.56')).toBe(123456);
  });
  it('handles parens and trailing-sign negatives', () => {
    expect(parseMoneyToCents('(450.00)')).toBe(-45000);
    expect(parseMoneyToCents('1234.56-')).toBe(-123456);
  });
  it('rejects garbage', () => {
    expect(parseMoneyToCents('')).toBeNull();
    expect(parseMoneyToCents('abc')).toBeNull();
    expect(parseMoneyToCents('1.2.3')).toBeNull();
  });
});

describe('detectDateFormat', () => {
  it('picks ISO when all rows look ISO', () => {
    const r = detectDateFormat(['2026-03-04', '2026-03-05', '2026-12-31']);
    expect(r?.format).toBe('YYYY-MM-DD');
    expect(r?.parse_rate).toBe(1);
  });
  it('picks YYYYMMDD for compact dates', () => {
    expect(detectDateFormat(['20260304', '20260305'])?.format).toBe('YYYYMMDD');
  });
  it('disambiguates DD vs MM via days > 12', () => {
    // 31/03/2026 forces DD/MM since 31 cannot be a month.
    const r = detectDateFormat(['31/03/2026', '15/03/2026', '04/04/2026']);
    expect(r?.format === 'DD/MM/YYYY' || r?.format === 'D/M/YYYY').toBe(true);
    expect(r?.ambiguous).toBe(false);
  });
  it('flags ambiguous when DD/MM and MM/DD both fit', () => {
    const r = detectDateFormat(['03/04/2026', '05/06/2026', '07/08/2026']);
    expect(r?.ambiguous).toBe(true);
  });
});

describe('parseBankStatement — RBC', () => {
  it('detects preset and parses transactions', () => {
    const result = parseBankStatement(buf(RBC_CSV));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.detected_preset).toBe('rbc');
    expect(result.data.detection_source).toBe('preset');
    expect(result.data.confidence).toBe('high');
    expect(result.data.rows).toHaveLength(4);
    expect(result.data.rows[0]).toMatchObject({
      posted_at: '2026-03-04',
      amount_cents: -18427,
      description: 'HOME DEPOT #7042',
    });
    expect(result.data.rows[1].amount_cents).toBe(520000);
  });
});

describe('parseBankStatement — TD', () => {
  it('handles separate debit/credit columns', () => {
    const result = parseBankStatement(buf(TD_CSV));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.detected_preset).toBe('td');
    expect(result.data.sign_convention.kind).toBe('separate_debit_credit');
    expect(result.data.rows[0].amount_cents).toBe(-18427);
    expect(result.data.rows[1].amount_cents).toBe(520000);
    expect(result.data.rows[2].amount_cents).toBe(-150000);
  });
});

describe('parseBankStatement — BMO', () => {
  it('parses YYYYMMDD dates and signed amounts', () => {
    const result = parseBankStatement(buf(BMO_CSV));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.detected_preset).toBe('bmo');
    expect(result.data.detected_date_format).toBe('YYYYMMDD');
    expect(result.data.rows[0].posted_at).toBe('2026-03-04');
    expect(result.data.rows[0].amount_cents).toBe(-18427);
  });
});

describe('parseBankStatement — Scotiabank', () => {
  it('finds amount column despite extra metadata columns', () => {
    const result = parseBankStatement(buf(SCOTIA_CSV));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.detected_preset).toBe('scotia');
    expect(result.data.rows).toHaveLength(4);
    expect(result.data.rows[1].amount_cents).toBe(520000);
  });
});

describe('parseBankStatement — CIBC', () => {
  it('handles ISO dates + separate withdrawn/deposited columns', () => {
    const result = parseBankStatement(buf(CIBC_CSV));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.detected_preset).toBe('cibc');
    expect(result.data.detected_date_format).toBe('YYYY-MM-DD');
    expect(result.data.rows[0].amount_cents).toBe(-18427);
    expect(result.data.rows[1].amount_cents).toBe(520000);
  });
});

describe('parseBankStatement — Amex', () => {
  it('matches preset signature and surfaces all rows', () => {
    const result = parseBankStatement(buf(AMEX_CSV));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.detected_preset).toBe('amex');
    expect(result.data.rows.length).toBeGreaterThanOrEqual(2);
  });
});

describe('parseBankStatement — generic CSV (header-hints fallback)', () => {
  it('detects without a preset', () => {
    const result = parseBankStatement(buf(GENERIC_CSV));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.detected_preset).toBeNull();
    expect(['header', 'content_shape']).toContain(result.data.detection_source);
    expect(result.data.rows).toHaveLength(3);
    expect(result.data.rows[0].amount_cents).toBe(-18427);
  });
});

describe('decodeBuffer', () => {
  it('falls back to Windows-1252 on mojibake', () => {
    const { encoding } = decodeBuffer(mojibakeWin1252Buffer());
    expect(encoding).toBe('windows-1252');
  });
  it('passes UTF-8 through without fallback', () => {
    const { encoding } = decodeBuffer(buf('hello, world'));
    expect(encoding).toBe('utf-8');
  });
});

describe('parseBankStatement — manual overrides', () => {
  it('lets caller pin columns by index', () => {
    // Generic file with columns rearranged.
    const csv = `c0,c1,c2\n2026-03-04,HOME DEPOT,-184.27\n2026-03-05,DEPOSIT,5200.00\n`;
    const result = parseBankStatement(buf(csv), {
      manual_overrides: { date: 0, description: 1, amount: 2, date_format: 'YYYY-MM-DD' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.detection_source).toBe('manual');
    expect(result.data.confidence).toBe('high');
    expect(result.data.rows[0].amount_cents).toBe(-18427);
  });
});

describe('parseBankStatement — caps + errors', () => {
  it('rejects empty input', () => {
    const result = parseBankStatement(Buffer.alloc(0));
    expect(result.ok).toBe(false);
  });
  it('rejects header-only files', () => {
    const result = parseBankStatement(buf('Date,Description,Amount\n'));
    expect(result.ok).toBe(false);
  });
});

describe('extractSignedCents', () => {
  it('flips debits negative in separate-column convention', () => {
    const row = ['', '', '184.27', ''];
    const cents = extractSignedCents(
      row,
      { date: 0, description: 1, amount: -1 },
      {
        kind: 'separate_debit_credit',
        debit_index: 2,
        credit_index: 3,
      },
    );
    expect(cents).toBe(-18427);
  });
  it('returns null for fully-empty separate-column rows (balance roll-forward)', () => {
    const row = ['', '', '', ''];
    const cents = extractSignedCents(
      row,
      { date: 0, description: 1, amount: -1 },
      {
        kind: 'separate_debit_credit',
        debit_index: 2,
        credit_index: 3,
      },
    );
    expect(cents).toBeNull();
  });
});
