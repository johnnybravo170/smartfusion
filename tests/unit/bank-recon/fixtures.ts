/**
 * In-line CSV fixtures for the bank-recon parser tests. Fixtures live as
 * string constants rather than .csv files so tests don't depend on
 * runtime file IO and so reviewers can see the input + expectation
 * side-by-side.
 *
 * Each fixture is representative of the public export format documented
 * by the bank as of 2026-01. Real-world drift will require updates here +
 * in `presets.ts`.
 */

export const RBC_CSV = `Account Type,Account Number,Transaction Date,Cheque Number,Description 1,Description 2,CAD$,USD$
Chequing,12345-6789,3/4/2026,,HOME DEPOT #7042,YALETOWN,-184.27,
Chequing,12345-6789,3/5/2026,,PAYROLL DEPOSIT,ACME RENO LTD,5200.00,
Chequing,12345-6789,3/7/2026,1042,CHEQUE WRITTEN,,-1500.00,
Chequing,12345-6789,3/8/2026,,STARBUCKS #00214,GRANVILLE,-6.85,
`;

export const TD_CSV = `Date,Description,Withdrawals,Deposits,Balance
3/4/2026,HOME DEPOT #7042 YALETOWN,184.27,,4815.73
3/5/2026,PAYROLL DEPOSIT,,5200.00,10015.73
3/7/2026,CHEQUE 1042,1500.00,,8515.73
3/8/2026,STARBUCKS #00214,6.85,,8508.88
`;

export const BMO_CSV = `First Bank Card,Transaction Type,Date Posted,Transaction Amount,Description
'1234567890123456,DEBIT,20260304,-184.27,HOME DEPOT #7042
'1234567890123456,CREDIT,20260305,5200.00,PAYROLL DEPOSIT
'1234567890123456,DEBIT,20260307,-1500.00,CHEQUE 1042
'1234567890123456,DEBIT,20260308,-6.85,STARBUCKS #00214
`;

export const SCOTIA_CSV = `Filter,Date,Description,Sub-description,Status,Type of Transaction,Amount
,3/4/2026,HOME DEPOT #7042,YALETOWN,POSTED,DEBIT,-184.27
,3/5/2026,PAYROLL DEPOSIT,ACME RENO LTD,POSTED,CREDIT,5200.00
,3/7/2026,CHEQUE 1042,,POSTED,DEBIT,-1500.00
,3/8/2026,STARBUCKS #00214,GRANVILLE,POSTED,DEBIT,-6.85
`;

export const CIBC_CSV = `Date,Description,Withdrawn,Deposited,Card Number
2026-03-04,HOME DEPOT #7042,184.27,,4567
2026-03-05,PAYROLL DEPOSIT,,5200.00,4567
2026-03-07,CHEQUE 1042,1500.00,,4567
2026-03-08,STARBUCKS #00214,6.85,,4567
`;

/**
 * Amex Canada — Date | Description | Cardmember | Amount | ... extras.
 * Charges land as POSITIVE in the Amount column; payments come through
 * negative. Our preset converts charges to negative (= money out).
 */
export const AMEX_CSV = `Date,Description,Cardmember,Amount,Extended Details,Address,Town/City,Postal Code,Country,Reference,Category
3/4/2026,HOME DEPOT #7042 YALETOWN,JONATHAN BOETTCHER,184.27,DEBIT,,VANCOUVER,V6B,CA,A1B2C3,Home & Garden
3/5/2026,AUTOPAY PAYMENT - THANK YOU,JONATHAN BOETTCHER,-3000.00,PAYMENT,,,,,P9X8Y7,Payment
3/7/2026,STARBUCKS #00214,JONATHAN BOETTCHER,6.85,DEBIT,,VANCOUVER,V6B,CA,Q1W2E3,Restaurant
`;

/**
 * Generic CSV with no recognizable bank — falls through to header hints
 * + content shape.
 */
export const GENERIC_CSV = `Trans Date,Memo,Value
2026-03-04,HOME DEPOT,-184.27
2026-03-05,PAYROLL DEPOSIT,5200.00
2026-03-07,CHEQUE,-1500.00
`;

/**
 * Mojibake-prone CSV where vendor names contain ÉÊÔ chars encoded as
 * Win-1252 bytes — UTF-8 decoder produces replacement chars, fallback
 * recovers the original.
 *
 * Returns a Buffer so tests can feed it through decodeBuffer directly.
 */
export function mojibakeWin1252Buffer(): Buffer {
  // Header (ASCII) + two rows containing É (0xC9), Ê (0xCA), Ô (0xD4)
  // in Windows-1252.
  const ascii = (s: string) => Buffer.from(s, 'ascii');
  const win = (b: number) => Buffer.from([b]);
  return Buffer.concat([
    ascii('Date,Description,Amount\n'),
    ascii('2026-03-04,'),
    ascii('CAF'),
    win(0xc9), // É
    ascii(' MONTR'),
    win(0xc9), // É
    ascii('AL,-12.50\n'),
    ascii('2026-03-05,'),
    ascii('H'),
    win(0xd4), // Ô
    ascii('TEL,'),
    ascii('-200.00\n'),
  ]);
}
