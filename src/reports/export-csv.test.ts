import { describe, expect, it } from 'vitest';
import { toCsv } from './export-csv';
import type { RunReport } from './types';

const BASE: RunReport = {
  site: 'shop.example.com',
  sheetName: 'events.xlsx',
  sdkReady: true,
  at: 1_735_689_600_000,
  totals: { events: 0, tested: 0, passed: 0, failed: 0, notTested: 0, apiOnly: 0, reachable: 0 },
  events: [],
  undocumented: [],
  channel: 'debug-payload',
};

function rows(csv: string): string[][] {
  return csv.split('\r\n').map((line) => line.split(','));
}

describe('toCsv', () => {
  it('writes a header even when nothing was captured', () => {
    expect(rows(toCsv(BASE))[0]?.[0]).toBe('Event');
  });

  it('gives an event that never fired one row, with no field columns', () => {
    const csv = toCsv({
      ...BASE,
      events: [
        {
          eventName: 'Checkout Started',
          status: 'NOT SEEN',
          firedAs: undefined,
          matchReason: undefined,
          checkedIn: undefined,
          firedSeparately: false,
          result: undefined,
        },
      ],
    });

    expect(rows(csv)[1]).toEqual(['Checkout Started', '', 'NOT SEEN', '', '', '', '', '', '']);
  });

  it('writes one row per checked field, repeating the event on each', () => {
    const csv = toCsv({
      ...BASE,
      events: [
        {
          eventName: 'Add to Cart',
          status: 'FAIL',
          firedAs: 'add_to_cart',
          matchReason: 'formatting',
          checkedIn: undefined,
          firedSeparately: false,
          result: {
            status: 'FAIL',
            eventName: 'Add to Cart',
            missing: ['price'],
            extra: [],
            renamed: [],
            nullValues: [],
            emptyValues: [],
            typeMismatches: [],
            fields: [
              {
                path: 'product_id',
                status: 'ok',
                required: true,
                expectedType: 'string',
                actualType: 'string',
                value: 'SKU1',
              },
              {
                path: 'price',
                status: 'missing',
                required: true,
                expectedType: 'number',
                actualType: 'undefined',
                value: undefined,
              },
            ],
            raw: { product_id: 'SKU1' },
            timestamp: BASE.at,
          },
        },
      ],
    });

    const table = rows(csv);
    expect(table).toHaveLength(3);
    expect(table[1]).toEqual([
      'Add to Cart',
      'add_to_cart',
      'FAIL',
      'product_id',
      'yes',
      'string',
      'string',
      'ok',
      'SKU1',
    ]);
    expect(table[2]?.[7]).toBe('missing');
  });

  it('lists undocumented events as their own rows', () => {
    const csv = toCsv({ ...BASE, undocumented: ['mystery_event'] });

    expect(rows(csv)[1]?.[2]).toBe('UNDOCUMENTED');
  });

  it('quotes a value containing a comma rather than splitting the row', () => {
    const csv = toCsv({ ...BASE, undocumented: ['a,b'] });

    expect(csv).toContain('"a,b"');
  });

  /**
   * An Event Sheet is untrusted input. A field named `=cmd|...` must reach the spreadsheet as
   * text, not as something it offers to evaluate.
   */
  it('defuses a value a spreadsheet would treat as a formula', () => {
    const csv = toCsv({ ...BASE, undocumented: ['=1+1'] });

    expect(csv).toContain('"\t=1+1"');
    expect(csv).not.toMatch(/,=1\+1/);
  });
});
