import { describe, expect, it } from 'vitest';
import { fieldIdentity, normalizeSheet, toDataType, toRequired } from './normalize';
import type { ColumnMapping, SheetGrid } from './types';

const MAPPING: ColumnMapping = {
  eventName: 0,
  payloadName: 1,
  payloadType: 2,
  attributeName: 3,
  attributeType: 4,
  required: 5,
  description: 6,
  example: 7,
};

const HEADER = [
  'Event Name',
  'Payload',
  'Payload Data Type',
  'Attribute',
  'Attribute Data Type',
  'Mandatory',
  'Description',
  'Example Value',
];

const GRID: SheetGrid = [
  HEADER,
  ['add_to_cart', 'product_id', 'String', 'prid', 'String', 'Yes', 'Product SKU', 'SKU123'],
  ['', 'price', 'Number', 'pr', 'Number', 'Yes', 'Unit price', '499.00'],
  ['', 'currency', 'String', 'cur', 'String', 'No', 'ISO code', 'INR'],
  ['purchase', 'order_id', 'String', 'oid', 'String', 'Mandatory', 'Order ref', 'ORD-1'],
];

describe('normalizeSheet', () => {
  it('pairs both channel names and types on one field', () => {
    const sheet = normalizeSheet(GRID, MAPPING, 0);
    const field = sheet.events.get('add_to_cart')?.fields[0];

    expect(field).toEqual({
      payloadName: 'product_id',
      payloadType: 'string',
      attributeName: 'prid',
      attributeType: 'string',
      required: true,
      description: 'Product SKU',
      example: 'SKU123',
    });
  });

  it('forward-fills the event name across blank cells', () => {
    const sheet = normalizeSheet(GRID, MAPPING, 0);

    expect([...sheet.events.keys()]).toEqual(['add_to_cart', 'purchase']);
    expect(sheet.events.get('add_to_cart')?.fields.map((f) => f.payloadName)).toEqual([
      'product_id',
      'price',
      'currency',
    ]);
  });

  it('keeps each channel on its own datatype', () => {
    const sheet = normalizeSheet(
      [HEADER, ['evt', 'total', 'Number', 'tot', 'String', 'Yes', '', '']],
      MAPPING,
      0,
    );
    const field = sheet.events.get('evt')?.fields[0];

    expect(field?.payloadType).toBe('number');
    expect(field?.attributeType).toBe('string');
  });

  it('reads required and optional from the mandatory column', () => {
    const sheet = normalizeSheet(GRID, MAPPING, 0);
    const fields = sheet.events.get('add_to_cart')?.fields ?? [];

    expect(fields.find((f) => f.payloadName === 'price')?.required).toBe(true);
    expect(fields.find((f) => f.payloadName === 'currency')?.required).toBe(false);
    expect(sheet.events.get('purchase')?.fields[0]?.required).toBe(true);
  });

  it('accepts a row that names only the attribute channel', () => {
    const sheet = normalizeSheet(
      [HEADER, ['evt', '', '', 'cur', 'String', 'No', '', '']],
      MAPPING,
      0,
    );
    const field = sheet.events.get('evt')?.fields[0];

    expect(field?.payloadName).toBe('');
    expect(field?.attributeName).toBe('cur');
    expect(fieldIdentity(field ?? EMPTY_FIELD)).toBe('cur');
  });

  it('skips a row that names neither channel', () => {
    const sheet = normalizeSheet(
      [HEADER, ['evt', '', '', '', '', 'Yes', 'orphan note', '']],
      MAPPING,
      0,
    );

    expect(sheet.events.get('evt')?.fields).toEqual([]);
  });

  it('warns when the sheet declares no payload column', () => {
    const sheet = normalizeSheet(GRID, { eventName: 0, attributeName: 3 }, 0);

    expect(sheet.warnings.join(' ')).toContain('No payload column');
  });

  it('warns when the sheet declares no attribute column', () => {
    const sheet = normalizeSheet(GRID, { eventName: 0, payloadName: 1 }, 0);

    expect(sheet.warnings.join(' ')).toContain('No attribute column');
  });

  it('warns and skips a field listed twice for one event', () => {
    const sheet = normalizeSheet([HEADER, GRID[1] ?? [], GRID[1] ?? []], MAPPING, 0);

    expect(sheet.events.get('add_to_cart')?.fields).toHaveLength(1);
    expect(sheet.warnings.join(' ')).toContain('listed twice');
  });

  it('warns about a field with no event name above it', () => {
    const sheet = normalizeSheet(
      [HEADER, ['', 'orphan', 'String', 'orp', 'String', 'Yes', '', '']],
      MAPPING,
      0,
    );

    expect(sheet.events.size).toBe(0);
    expect(sheet.warnings.join(' ')).toContain('no event name');
  });

  it('warns per channel about an unrecognised type', () => {
    const sheet = normalizeSheet(
      [HEADER, ['evt', 'attr', 'Blorp', 'atr', 'Zonk', 'Yes', '', '']],
      MAPPING,
      0,
    );

    expect(sheet.warnings.join(' ')).toContain('unrecognised payload type "Blorp"');
    expect(sheet.warnings.join(' ')).toContain('unrecognised attribute type "Zonk"');
  });

  it('merges fields when an event name reappears further down', () => {
    const sheet = normalizeSheet(
      [
        HEADER,
        GRID[1] ?? [],
        GRID[4] ?? [],
        ['add_to_cart', 'coupon', 'String', 'cpn', 'String', 'No', '', ''],
      ],
      MAPPING,
      0,
    );

    expect(sheet.events.get('add_to_cart')?.fields.map((f) => f.payloadName)).toEqual([
      'product_id',
      'coupon',
    ]);
  });
});

const EMPTY_FIELD = {
  payloadName: '',
  payloadType: 'unknown',
  attributeName: '',
  attributeType: 'unknown',
  required: false,
  description: '',
  example: '',
} as const;

describe('toDataType', () => {
  it.each([
    ['String', 'string'],
    ['integer', 'number'],
    ['BOOL', 'boolean'],
    ['Array of objects', 'array'],
    ['JSON', 'object'],
    ['timestamp', 'date'],
    ['', 'unknown'],
    ['blorp', 'unknown'],
  ])('reads %s as %s', (raw, expected) => {
    expect(toDataType(raw)).toBe(expected);
  });
});

describe('toRequired', () => {
  it.each([
    ['Yes', true],
    ['mandatory', true],
    ['TRUE', true],
    ['No', false],
    ['optional', false],
    ['', false],
  ])('reads %s as %s', (raw, expected) => {
    expect(toRequired(raw)).toBe(expected);
  });

  it('returns undefined for a value it cannot classify', () => {
    expect(toRequired('maybe')).toBeUndefined();
  });
});
