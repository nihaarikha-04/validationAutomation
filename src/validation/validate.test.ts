import { describe, expect, it } from 'vitest';
import type { DataType, EventSchema, FieldSchema } from '../event-sheet/types';
import { validateEvent } from './validate';

const AT = 1_735_689_600_000;

function field(
  payloadName: string,
  payloadType: DataType,
  required: boolean,
  overrides: Partial<FieldSchema> = {},
): FieldSchema {
  return {
    payloadName,
    payloadType,
    attributeName: '',
    attributeType: 'unknown',
    required,
    description: '',
    example: '',
    ...overrides,
  };
}

function schema(...fields: readonly FieldSchema[]): EventSchema {
  return { name: 'add_to_cart', fields, source: 'unknown' };
}

const CART = schema(
  field('product_id', 'string', true),
  field('price', 'number', true),
  field('currency', 'string', false),
);

describe('validateEvent', () => {
  it('passes a payload that matches the sheet exactly', () => {
    const result = validateEvent(
      { product_id: 'SKU123', price: 499, currency: 'INR' },
      CART,
      AT,
    );

    expect(result.status).toBe('PASS');
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.typeMismatches).toEqual([]);
    expect(result.fields.every((entry) => entry.status === 'ok')).toBe(true);
  });

  it('fails a missing required field and names it', () => {
    // currency is supplied so the only absent field is the one under test.
    const result = validateEvent({ price: 499, currency: 'INR' }, CART, AT);

    expect(result.status).toBe('FAIL');
    expect(result.missing).toEqual(['product_id']);
  });

  it('does not penalise a missing optional field', () => {
    const result = validateEvent({ product_id: 'SKU123', price: 499 }, CART, AT);

    expect(result.status).toBe('PASS');
    expect(result.missing).toEqual(['currency']);
  });

  it('fails a required field set to null', () => {
    const result = validateEvent({ product_id: null, price: 499, currency: 'INR' }, CART, AT);

    expect(result.status).toBe('FAIL');
    expect(result.nullValues).toEqual(['product_id']);
    // Present-but-null is not the same defect as absent.
    expect(result.missing).toEqual([]);
  });

  it('warns about an optional field that is present but null', () => {
    const result = validateEvent(
      { product_id: 'SKU123', price: 499, currency: null },
      CART,
      AT,
    );

    expect(result.status).toBe('WARNING');
    expect(result.nullValues).toEqual(['currency']);
  });

  it('treats an empty string as empty, not missing', () => {
    const result = validateEvent({ product_id: '', price: 499 }, CART, AT);

    expect(result.status).toBe('FAIL');
    expect(result.emptyValues).toEqual(['product_id']);
  });

  it('treats empty arrays and objects as empty', () => {
    const withContainers = schema(
      field('items', 'array', true),
      field('meta', 'object', true),
    );
    const result = validateEvent({ items: [], meta: {} }, withContainers, AT);

    expect(result.emptyValues).toEqual(['items', 'meta']);
  });

  it('counts a key explicitly set to undefined as missing', () => {
    const result = validateEvent(
      { product_id: { __special: 'undefined' }, price: 499, currency: 'INR' },
      CART,
      AT,
    );

    expect(result.status).toBe('FAIL');
    expect(result.missing).toEqual(['product_id']);
    expect(result.fields[0]?.status).toBe('undefined');
  });

  it('fails a wrong type and itemises the mismatch', () => {
    const result = validateEvent({ product_id: 'SKU123', price: '499' }, CART, AT);

    expect(result.status).toBe('FAIL');
    expect(result.typeMismatches).toEqual([
      { path: 'price', expected: 'number', actual: 'string' },
    ]);
  });

  it('fails a wrong type even on an optional field', () => {
    const result = validateEvent(
      { product_id: 'SKU123', price: 499, currency: 42 },
      CART,
      AT,
    );

    expect(result.status).toBe('FAIL');
    expect(result.typeMismatches).toHaveLength(1);
  });

  it('accepts anything where the sheet gave no type', () => {
    const loose = schema(field('anything', 'unknown', true));

    expect(validateEvent({ anything: 42 }, loose, AT).status).toBe('PASS');
    expect(validateEvent({ anything: 'text' }, loose, AT).status).toBe('PASS');
  });

  it('accepts an ISO string or an epoch number for a date', () => {
    const dated = schema(field('when', 'date', true));

    expect(validateEvent({ when: '2026-08-31T00:00:00.000Z' }, dated, AT).status).toBe('PASS');
    expect(validateEvent({ when: 1735689600000 }, dated, AT).status).toBe('PASS');
    expect(validateEvent({ when: 'not a date' }, dated, AT).status).toBe('FAIL');
  });

  it('validates a nested path', () => {
    const nested = schema(field('product.category.id', 'number', true));

    expect(validateEvent({ product: { category: { id: 7 } } }, nested, AT).status).toBe('PASS');
    expect(validateEvent({ product: { category: {} } }, nested, AT).missing).toEqual([
      'product.category.id',
    ]);
  });

  it('validates an array path', () => {
    const arrayed = schema(field('items[0].price', 'number', true));

    expect(validateEvent({ items: [{ price: 10 }] }, arrayed, AT).status).toBe('PASS');
    expect(validateEvent({ items: [{ price: 'ten' }] }, arrayed, AT).typeMismatches).toEqual([
      { path: 'items[0].price', expected: 'number', actual: 'string' },
    ]);
  });

  it('ignores extra fields by default', () => {
    const result = validateEvent(
      { product_id: 'SKU123', price: 499, coupon: 'SAVE10' },
      CART,
      AT,
    );

    expect(result.status).toBe('PASS');
    // Still reported as data; the policy governs the verdict, not the record.
    expect(result.extra).toEqual(['coupon']);
  });

  it('can be told to warn about extra fields', () => {
    const result = validateEvent(
      { product_id: 'SKU123', price: 499, coupon: 'SAVE10' },
      CART,
      AT,
      { extraFields: 'warn' },
    );

    expect(result.status).toBe('WARNING');
  });

  it('can be told to fail on extra fields', () => {
    const result = validateEvent(
      { product_id: 'SKU123', price: 499, coupon: 'SAVE10' },
      CART,
      AT,
      { extraFields: 'fail' },
    );

    expect(result.status).toBe('FAIL');
  });

  it('does not call a nested field extra when the sheet vouches for its parent', () => {
    const nested = schema(field('product', 'object', true));
    const result = validateEvent({ product: { sku: 'A', colour: 'red' } }, nested, AT);

    expect(result.extra).toEqual([]);
    expect(result.status).toBe('PASS');
  });

  it('ignores array positions when deciding what is extra', () => {
    const arrayed = schema(field('items[0].price', 'number', true));
    const result = validateEvent({ items: [{ price: 10 }, { price: 20 }] }, arrayed, AT);

    expect(result.extra).toEqual([]);
  });

  it('warns rather than fails when our own serialiser clipped the value', () => {
    const result = validateEvent(
      {
        product_id: 'SKU123',
        price: { __special: 'unserialisable', detail: 'nested deeper than 12 levels' },
      },
      CART,
      AT,
    );

    // We cannot tell whether the site was correct here, so reporting a defect would be a lie.
    expect(result.status).toBe('WARNING');
    expect(result.typeMismatches).toEqual([]);
    expect(result.fields[1]?.status).toBe('unverifiable');
  });

  it('fails a value that is genuinely unusable, such as a function', () => {
    const result = validateEvent(
      { product_id: { __special: 'function', detail: 'cb' }, price: 499 },
      CART,
      AT,
    );

    expect(result.status).toBe('FAIL');
    expect(result.typeMismatches[0]?.actual).toBe('function');
  });

  it('skips rows that describe only a network attribute', () => {
    const attributeOnly = schema(
      field('product_id', 'string', true),
      field('', 'unknown', true, { attributeName: 'prid', attributeType: 'string' }),
    );
    const result = validateEvent({ product_id: 'SKU123' }, attributeOnly, AT);

    expect(result.fields).toHaveLength(1);
    expect(result.status).toBe('PASS');
  });

  it('itemises every expected field in sheet order', () => {
    const result = validateEvent({ product_id: 'SKU123', price: 499 }, CART, AT);

    expect(result.fields.map((entry) => entry.path)).toEqual([
      'product_id',
      'price',
      'currency',
    ]);
    expect(result.fields.map((entry) => entry.required)).toEqual([true, true, false]);
  });

  it('carries the event name, raw payload and timestamp through untouched', () => {
    const payload = { product_id: 'SKU123', price: 499 };
    const result = validateEvent(payload, CART, AT);

    expect(result.eventName).toBe('add_to_cart');
    expect(result.raw).toBe(payload);
    expect(result.timestamp).toBe(AT);
  });

  it('reports several defects at once rather than stopping at the first', () => {
    const result = validateEvent({ price: null, currency: 7, extra_thing: 1 }, CART, AT);

    expect(result.status).toBe('FAIL');
    expect(result.missing).toEqual(['product_id']);
    expect(result.nullValues).toEqual(['price']);
    expect(result.typeMismatches).toHaveLength(1);
    // Recorded even though the default policy does not act on it.
    expect(result.extra).toEqual(['extra_thing']);
  });
});

describe('a payload with none of the expected fields', () => {
  const ALL_OPTIONAL = schema(
    field('page_url', 'string', false),
    field('page_type', 'string', false),
  );

  /**
   * Observed live: a sheet with no mandatory column meant every field was optional, and a payload
   * read at the wrong nesting level had none of them. Every rule above was satisfied and the
   * event passed — a green verdict on a payload where nothing was actually checked.
   */
  it('fails rather than passing on absence of evidence', () => {
    const result = validateEvent({ user_key: 'ADGMOT35', sid: 1 }, ALL_OPTIONAL, AT);

    expect(result.status).toBe('FAIL');
    expect(result.missing).toEqual(['page_url', 'page_type']);
  });

  it('still passes when even one expected field is present', () => {
    const result = validateEvent({ page_url: '/shop' }, ALL_OPTIONAL, AT);

    expect(result.status).toBe('PASS');
  });

  /** An event the sheet describes no fields for has nothing to be absent. */
  it('does not fail an event the sheet gives no fields', () => {
    expect(validateEvent({ anything: 1 }, schema(), AT).status).toBe('PASS');
  });
});

describe('validateEvent, a field the site named differently', () => {
  const schema: EventSchema = {
    name: 'Add to Cart',
    source: 'unknown',
    fields: [
      { payloadName: 'product_id', payloadType: 'string', attributeName: '', attributeType: 'unknown', required: true, description: '', example: '' },
      { payloadName: 'quantity', payloadType: 'number', attributeName: '', attributeType: 'unknown', required: true, description: '', example: '' },
    ],
  };

  it('warns rather than fails when a mandatory field arrived under another name', () => {
    // The data is there and correctly shaped; the sheet and the implementation disagree about
    // what to call it. Failing that reports a data defect where only a naming one exists.
    const result = validateEvent({ prid: 'SKU-1', prqt: 2 }, schema, AT);

    expect(result.status).toBe('WARNING');
    expect(result.missing).toEqual([]);
    expect(result.renamed).toEqual([
      { path: 'product_id', foundAs: 'prid' },
      { path: 'quantity', foundAs: 'prqt' },
    ]);
  });

  it('does not also report the renamed key as an undocumented extra', () => {
    expect(validateEvent({ prid: 'SKU-1', prqt: 2 }, schema, AT).extra).toEqual([]);
  });

  it('fails when the renamed field carries the wrong type', () => {
    // A wrong type is a data defect and outranks the naming one.
    const result = validateEvent({ prid: 'SKU-1', prqt: 'two' }, schema, AT);

    expect(result.status).toBe('FAIL');
    expect(result.typeMismatches).toEqual([
      { path: 'quantity', expected: 'number', actual: 'string' },
    ]);
  });

  it('still fails a mandatory field that is genuinely absent', () => {
    expect(validateEvent({ prid: 'SKU-1' }, schema, AT).status).toBe('FAIL');
  });

  it('passes untouched when the site used the sheet’s own names', () => {
    expect(validateEvent({ product_id: 'SKU-1', quantity: 2 }, schema, AT).status).toBe('PASS');
  });
});
