import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  // The customer mapper itself doesn't read env, but the module graph
  // pulls in /lib/qbo/types (no side effects) and /lib/customers/dedup
  // (pure). No env needed; this guard is defensive against accidental
  // env reads slipping in.
  process.env.QBO_CLIENT_ID ??= 'test';
  process.env.QBO_CLIENT_SECRET ??= 'test';
  process.env.QBO_REDIRECT_URI ??= 'http://localhost:3000/api/qbo/callback';
  process.env.QBO_STATE_SECRET ??= 'unit-test-secret-padded-to-32-chars-min';
});

import { mapQboCustomerToRow } from '@/lib/qbo/import/customers';
import type { QboCustomer } from '@/lib/qbo/types';

function makeQboCustomer(overrides: Partial<QboCustomer> = {}): QboCustomer {
  return {
    Id: '123',
    SyncToken: '0',
    Active: true,
    DisplayName: 'Default Name',
    ...overrides,
  };
}

describe('mapQboCustomerToRow', () => {
  it('maps a residential customer with no company name', () => {
    const row = mapQboCustomerToRow(
      makeQboCustomer({
        DisplayName: 'Jane Doe',
        PrimaryEmailAddr: { Address: 'jane@example.com' },
        PrimaryPhone: { FreeFormNumber: '(604) 555-1234' },
        BillAddr: {
          Line1: '123 Main St',
          City: 'Vancouver',
          CountrySubDivisionCode: 'BC',
          PostalCode: 'V5K 0A1',
        },
      }),
    );
    expect(row.name).toBe('Jane Doe');
    expect(row.type).toBe('residential');
    expect(row.email).toBe('jane@example.com');
    expect(row.phone).toBe('(604) 555-1234');
    expect(row.address_line1).toBe('123 Main St');
    expect(row.city).toBe('Vancouver');
    expect(row.province).toBe('BC');
    expect(row.postal_code).toBe('V5K 0A1');
  });

  it('flips to commercial and uses CompanyName when present', () => {
    const row = mapQboCustomerToRow(
      makeQboCustomer({
        DisplayName: 'Bob the Owner',
        CompanyName: 'Acme Pressure Washing Inc',
      }),
    );
    expect(row.name).toBe('Acme Pressure Washing Inc');
    expect(row.type).toBe('commercial');
  });

  it('falls back to mobile when no primary phone', () => {
    const row = mapQboCustomerToRow(
      makeQboCustomer({
        Mobile: { FreeFormNumber: '604-555-9876' },
      }),
    );
    expect(row.phone).toBe('604-555-9876');
  });

  it('returns null for missing fields', () => {
    const row = mapQboCustomerToRow(makeQboCustomer({ DisplayName: 'Just a Name' }));
    expect(row.email).toBeNull();
    expect(row.phone).toBeNull();
    expect(row.address_line1).toBeNull();
    expect(row.city).toBeNull();
    expect(row.province).toBeNull();
    expect(row.postal_code).toBeNull();
  });

  it('trims whitespace on string fields', () => {
    const row = mapQboCustomerToRow(
      makeQboCustomer({
        DisplayName: 'Trim Me',
        PrimaryEmailAddr: { Address: '  bob@example.com  ' },
        PrimaryPhone: { FreeFormNumber: '  604-555-0000  ' },
        BillAddr: {
          Line1: '  456 Elm  ',
          City: '  Burnaby  ',
        },
      }),
    );
    expect(row.email).toBe('bob@example.com');
    expect(row.phone).toBe('604-555-0000');
    expect(row.address_line1).toBe('456 Elm');
    expect(row.city).toBe('Burnaby');
  });

  it('truncates very long names to fit the column constraint', () => {
    const longName = 'A'.repeat(500);
    const row = mapQboCustomerToRow(
      makeQboCustomer({
        DisplayName: longName,
      }),
    );
    expect(row.name.length).toBe(200);
  });

  it('treats whitespace-only CompanyName as residential', () => {
    const row = mapQboCustomerToRow(
      makeQboCustomer({
        DisplayName: 'Real Name',
        CompanyName: '   ',
      }),
    );
    expect(row.type).toBe('residential');
    expect(row.name).toBe('Real Name');
  });
});
