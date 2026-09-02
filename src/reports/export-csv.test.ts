import { describe, expect, it } from 'vitest';
import { toCsv } from './export-csv';
import type { RunReport } from './types';

const BASE: RunReport = {
  site: 'shop.example.com',
  sheetName: 'events.xlsx',
  sdkReady: true,
  at: 1_735_689_600_000,
  totals: { events: 0, tested: 0, passed: 0, failed: 0, warning: 0, apiOnly: 0, payment: 0, reachable: 0 },
  events: [],
  undocumented: [],
  channel: 'debug-payload',
};

/**
 * A real RFC 4180 reader, because the rows under test deliberately contain commas, quotes and
 * newlines — a captured payload is pretty-printed JSON. Splitting on commas would have tested the
 * helper's naivety rather than the exporter.
 */
function rows(csv: string): string[][] {
  const table: string[][] = [[]];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];

    if (quoted) {
      if (character === '"') {
        if (csv[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      table[table.length - 1]?.push(cell);
      cell = '';
    } else if (character === '\r' && csv[index + 1] === '\n') {
      table[table.length - 1]?.push(cell);
      cell = '';
      table.push([]);
      index += 1;
    } else {
      cell += character;
    }
  }

  table[table.length - 1]?.push(cell);
  return table;
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
          status: 'FAIL',
          firedAs: undefined,
          matchReason: undefined,
          checkedIn: undefined,
          firedSeparately: false,
          result: undefined,
        },
      ],
    });

    expect(rows(csv)[1]?.slice(0, 9)).toEqual([
      'Checkout Started',
      '',
      'FAIL',
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
  });

  it('writes one row per checked field, naming the event once', () => {
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
    expect(table[1]?.slice(0, 9)).toEqual([
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
    // The second field of the same event leaves the event's own columns blank, the way a sheet
    // writes a merged cell.
    expect(table[2]?.slice(0, 3)).toEqual(['', '', '']);
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

describe('the columns a reviewer fills in from', () => {
  const FIRED = {
    ...BASE,
    events: [
      {
        eventName: 'Cart Viewed',
        status: 'WARNING' as const,
        firedAs: 'cart viewed',
        matchReason: 'formatting' as const,
        checkedIn: undefined,
        firedSeparately: false,
        result: {
          status: 'WARNING' as const,
          eventName: 'Cart Viewed',
          missing: [],
          extra: [],
          renamed: [{ path: 'product_id', foundAs: 'prid' }],
          nullValues: [],
          emptyValues: [],
          typeMismatches: [],
          fields: [
            {
              path: 'product_id',
              status: 'renamed' as const,
              required: true,
              expectedType: 'string' as const,
              actualType: 'string',
              value: 'SKU1',
              foundAs: 'prid',
            },
            {
              path: 'value',
              status: 'type-mismatch' as const,
              required: true,
              expectedType: 'number' as const,
              actualType: 'string',
              value: '1390',
            },
          ],
          raw: { prid: 'SKU1', value: '1390' },
          timestamp: BASE.at,
        },
      },
    ],
  };

  it('dates the debug-log column, so two rounds of testing stay apart', () => {
    expect(rows(toCsv(FIRED))[0]?.[9]).toBe('Smartech debug logs (2025-01-01)');
  });

  it('puts the captured payload on the event row only', () => {
    const table = rows(toCsv(FIRED));

    expect(table[1]?.[9]).toContain('prid');
    expect(table[2]?.[9]).toBe('');
  });

  it('says a key was renamed, and what to', () => {
    expect(rows(toCsv(FIRED))[1]?.[10]).toBe(
      'Renaming — the sheet says "product_id", the payload sends "prid".',
    );
  });

  it('says which datatype was expected and which arrived', () => {
    expect(rows(toCsv(FIRED))[2]?.[10]).toBe(
      'Incorrect data type — expected number, received string.',
    );
  });

  it('says an event that never fired was not triggered', () => {
    const csv = toCsv({
      ...BASE,
      events: [
        {
          eventName: 'Order Details Viewed',
          status: 'FAIL' as const,
          firedAs: undefined,
          matchReason: undefined,
          checkedIn: undefined,
          firedSeparately: false,
          result: undefined,
        },
      ],
    });

    expect(rows(csv)[1]?.[10]).toContain('Event not triggered');
  });

  it('says why a payment event was left alone rather than calling it a gap', () => {
    const csv = toCsv({
      ...BASE,
      events: [
        {
          eventName: 'Order Placed',
          status: 'PAYMENT' as const,
          firedAs: undefined,
          matchReason: undefined,
          checkedIn: undefined,
          firedSeparately: false,
          result: undefined,
        },
      ],
    });

    expect(rows(csv)[1]?.[10]).toContain('only fires when money actually moves');
  });
});
