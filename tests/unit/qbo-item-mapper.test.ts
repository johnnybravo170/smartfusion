import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  process.env.QBO_CLIENT_ID ??= 'test';
  process.env.QBO_CLIENT_SECRET ??= 'test';
  process.env.QBO_REDIRECT_URI ??= 'http://localhost:3000/api/qbo/callback';
  process.env.QBO_STATE_SECRET ??= 'unit-test-secret-padded-to-32-chars-min';
});

import { mapQboItemToRow } from '@/lib/qbo/import/items';
import type { QboItem } from '@/lib/qbo/types';

function makeItem(overrides: Partial<QboItem> = {}): QboItem {
  return { Id: '1', SyncToken: '0', Active: true, Name: 'Item', ...overrides };
}

describe('mapQboItemToRow', () => {
  it('maps a flat-rate service item', () => {
    const row = mapQboItemToRow(
      makeItem({
        Name: 'Furnace tune-up',
        Type: 'Service',
        UnitPrice: 89,
        Taxable: true,
        Description: 'Annual maintenance',
      }),
    );
    expect(row).not.toBeNull();
    expect(row?.pricing_model).toBe('fixed');
    expect(row?.unit_price_cents).toBe(8900);
    expect(row?.category).toBe('service');
    expect(row?.description).toBe('Annual maintenance');
    expect(row?.is_taxable).toBe(true);
  });

  it('maps a service item with no price as time_and_materials', () => {
    const row = mapQboItemToRow(
      makeItem({
        Name: 'Custom service',
        Type: 'Service',
        UnitPrice: 0,
      }),
    );
    expect(row?.pricing_model).toBe('time_and_materials');
    expect(row?.unit_price_cents).toBeNull();
  });

  it('maps an inventory item as fixed with inventory category', () => {
    const row = mapQboItemToRow(
      makeItem({
        Name: 'AC filter 16x25',
        Type: 'Inventory',
        UnitPrice: 19.99,
        Sku: 'FLT-1625',
      }),
    );
    expect(row?.pricing_model).toBe('fixed');
    expect(row?.unit_price_cents).toBe(1999);
    expect(row?.category).toBe('inventory');
    expect(row?.sku).toBe('FLT-1625');
  });

  it('maps NonInventory items as materials category', () => {
    const row = mapQboItemToRow(
      makeItem({ Name: 'Sheet metal', Type: 'NonInventory', UnitPrice: 45 }),
    );
    expect(row?.category).toBe('materials');
    expect(row?.pricing_model).toBe('fixed');
  });

  it('skips Group items', () => {
    const row = mapQboItemToRow(makeItem({ Name: 'Service Bundle', Type: 'Group' }));
    expect(row).toBeNull();
  });

  it('skips Category items', () => {
    const row = mapQboItemToRow(makeItem({ Name: 'Subcontractors', Type: 'Category' }));
    expect(row).toBeNull();
  });

  it('defaults Taxable to true when missing', () => {
    const row = mapQboItemToRow(makeItem({ Name: 'Default tax', Type: 'Service', UnitPrice: 100 }));
    expect(row?.is_taxable).toBe(true);
  });

  it('rounds fractional prices to nearest cent', () => {
    const row = mapQboItemToRow(
      makeItem({ Name: 'Odd price', Type: 'Inventory', UnitPrice: 12.345 }),
    );
    // 12.345 * 100 = 1234.5 → rounds to 1235
    expect(row?.unit_price_cents).toBe(1235);
  });

  it('truncates very long names', () => {
    const row = mapQboItemToRow(makeItem({ Name: 'A'.repeat(500), Type: 'Service', UnitPrice: 1 }));
    expect(row?.name.length).toBe(200);
  });
});
