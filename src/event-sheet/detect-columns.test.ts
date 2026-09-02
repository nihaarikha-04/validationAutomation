import { describe, expect, it } from 'vitest';
import { buildMapping, detectColumns, normalizeHeader } from './detect-columns';
import type { SheetGrid } from './types';

const CANONICAL: SheetGrid = [
  [
    'Event Name',
    'Payload',
    'Payload Data Type',
    'Attribute',
    'Attribute Data Type',
    'Mandatory',
    'Description',
    'Example Value',
  ],
  ['add_to_cart', 'product_id', 'String', 'prid', 'String', 'Yes', 'SKU', 'A1'],
];

describe('normalizeHeader', () => {
  it('reduces punctuation and case to a comparable form', () => {
    expect(normalizeHeader('  Payload_Data Type ')).toBe('payload data type');
  });
});

describe('detectColumns', () => {
  it('resolves all eight roles from a canonical header row', () => {
    const detection = detectColumns(CANONICAL);

    expect(detection.kind).toBe('resolved');
    if (detection.kind !== 'resolved') return;
    expect(detection.mapping).toEqual({
      eventName: 0,
      payloadName: 1,
      payloadType: 2,
      attributeName: 3,
      attributeType: 4,
      required: 5,
      description: 6,
      example: 7,
    });
  });

  it('skips junk rows above the header', () => {
    const detection = detectColumns([
      ['Acme Event Tracking Spec v3', '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', ''],
      ...CANONICAL,
    ]);

    expect(detection.kind).toBe('resolved');
    if (detection.kind !== 'resolved') return;
    expect(detection.headerRow).toBe(2);
  });

  it('keeps the two type columns on their own channels', () => {
    const detection = detectColumns([
      ['Event', 'Payload Key', 'Payload Datatype', 'Network Attribute', 'Attribute Datatype'],
    ]);

    expect(detection.kind).toBe('resolved');
    if (detection.kind !== 'resolved') return;
    expect(detection.mapping.payloadType).toBe(2);
    expect(detection.mapping.attributeType).toBe(4);
  });

  it('gives a bare "Data Type" to the payload column it follows', () => {
    const detection = detectColumns([['Event Name', 'Payload', 'Data Type', 'Mandatory']]);

    expect(detection.kind).toBe('resolved');
    if (detection.kind !== 'resolved') return;
    expect(detection.mapping.payloadType).toBe(2);
    expect(detection.mapping.attributeType).toBeUndefined();
  });

  it('gives a bare "Data Type" to the attribute column it follows', () => {
    const detection = detectColumns([['Event Name', 'Attribute', 'Data Type', 'Mandatory']]);

    expect(detection.kind).toBe('resolved');
    if (detection.kind !== 'resolved') return;
    expect(detection.mapping.attributeType).toBe(2);
    expect(detection.mapping.payloadType).toBeUndefined();
  });

  it('leaves a bare "Data Type" ambiguous when it follows neither name column', () => {
    // Data Type sits at index 4, adjacent to neither Payload (1) nor Attribute (2).
    const detection = detectColumns([
      ['Event Name', 'Payload', 'Attribute', 'Mandatory', 'Data Type'],
    ]);

    expect(detection.kind).toBe('ambiguous');
    if (detection.kind !== 'ambiguous') return;
    expect(detection.missing).toEqual(expect.arrayContaining(['payloadType', 'attributeType']));
  });

  it('resolves a sheet that documents only the payload channel', () => {
    const detection = detectColumns([['Event Name', 'Payload', 'Payload Type', 'Mandatory']]);

    expect(detection.kind).toBe('resolved');
    if (detection.kind !== 'resolved') return;
    expect(detection.mapping.payloadName).toBe(1);
    expect(detection.mapping.attributeName).toBeUndefined();
  });

  it('resolves a sheet that documents only the attribute channel', () => {
    const detection = detectColumns([['Event Name', 'Attribute', 'Attribute Type']]);

    expect(detection.kind).toBe('resolved');
    if (detection.kind !== 'resolved') return;
    expect(detection.mapping.attributeName).toBe(1);
    expect(detection.mapping.payloadName).toBeUndefined();
  });

  it('is ambiguous when neither channel names its fields', () => {
    const detection = detectColumns([['Event Name', 'Mandatory', 'Description']]);

    expect(detection.kind).toBe('ambiguous');
    if (detection.kind !== 'ambiguous') return;
    expect(detection.missing).toEqual(expect.arrayContaining(['payloadName', 'attributeName']));
  });

  it('is ambiguous when the event name column is absent', () => {
    const detection = detectColumns([['Payload', 'Payload Type']]);

    expect(detection.kind).toBe('ambiguous');
    if (detection.kind !== 'ambiguous') return;
    expect(detection.missing).toContain('eventName');
  });

  it('is ambiguous when two columns claim the same role', () => {
    const detection = detectColumns([['Event Name', 'Event Name', 'Payload']]);

    expect(detection.kind).toBe('ambiguous');
    if (detection.kind !== 'ambiguous') return;
    expect(detection.candidates.eventName).toEqual([0, 1]);
  });

  it('does not read an "Optional" column as the mandatory column', () => {
    const detection = detectColumns([['Event Name', 'Payload', 'Optional']]);

    expect(detection.kind).toBe('resolved');
    if (detection.kind !== 'resolved') return;
    expect(detection.mapping.required).toBeUndefined();
  });
});

describe('buildMapping', () => {
  it('accepts a selection with an event name and one channel named', () => {
    const result = buildMapping({ eventName: 0, payloadName: 1 });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.mapping.eventName).toBe(0);
    expect(result.mapping.payloadName).toBe(1);
    expect(result.mapping.attributeName).toBeUndefined();
  });

  it('rejects a selection naming no channel at all', () => {
    const result = buildMapping({ eventName: 0, required: 2 });

    expect(result).toEqual({
      kind: 'incomplete',
      missing: ['payloadName', 'attributeName'],
    });
  });

  it('rejects a selection with no event name', () => {
    const result = buildMapping({ payloadName: 1 });

    expect(result).toEqual({ kind: 'incomplete', missing: ['eventName'] });
  });
});

describe('detectColumns, a role with several partial claimants', () => {
  /** The real ethniq.com sheet's header row, which detection used to give up on. */
  const ETHNIQ = [
    '', 'Event Name', 'Status', 'Attribute', 'Attribute Data Type', 'Attribute Description',
    'Payload Key', 'Array Payload Key', 'Payload Data Type', 'Array Element Type',
    'Payload Description', 'Notes', 'Source (Frontend / API)', 'Netcore web scripts',
    'Netcore web comments', 'Field Type (Contact Attribute / Payload)', 'Implementation Status',
    'Netcore web logs',
  ];

  it('gives the role to the exact header match over weaker partial ones', () => {
    // `payloadName` was claimed by `Payload Key`, `Array Payload Key`, `Payload Description` and
    // `Field Type (Contact Attribute / Payload)`. Detection returned ambiguous, the user mapped
    // the role one column off, and every event validated against fields named `string`/`array`.
    const detection = detectColumns([ETHNIQ, ['', 'Login', '', 'Mobile', 'TEXT', '', 'mobile_number', '', 'string', '', '', '']]);

    expect(detection.kind).toBe('resolved');
    if (detection.kind !== 'resolved') return;
    expect(detection.mapping.payloadName).toBe(6);
    expect(detection.mapping.payloadType).toBe(8);
    expect(detection.mapping.attributeName).toBe(3);
    expect(detection.mapping.attributeType).toBe(4);
  });

  it('still defers to the user when two columns tie at the top score', () => {
    const detection = detectColumns([['Event Name', 'Payload Key', 'Payload Field']]);

    expect(detection.kind).toBe('ambiguous');
    if (detection.kind !== 'ambiguous') return;
    expect(detection.missing).toContain('payloadName');
  });
});

/**
 * Header rows taken from a real client workbook, because the depth limit is only correct if it
 * covers the shapes sheets actually have. One tab opens with a title row above the header; another
 * puts the header on the very first row.
 */
describe('header rows as real sheets write them', () => {
  const TITLE_THEN_HEADER = [
    ['Events', '', '', '', '', '', '', '', '', '', ''],
    [
      'SR. No',
      'Event Name',
      'Attribute',
      'ATT Description',
      'Payload',
      'ATTRIBUTE data type',
      'Array Payload',
      'Data type',
      'Array data type',
      'Payload Description',
      'Development Status',
    ],
    ['1.0', 'Registration', 'Mobile Number', 'Registered mobile', 'mobile_number', 'TEXT', '', '', '', '', 'Done'],
  ];

  const HEADER_FIRST = [
    [
      ' ',
      'Event Name',
      'Status',
      'Attribute',
      'Attribute Data Type',
      'Attribute Description',
      'Payload Key',
      'Array Payload Key',
      'Payload Data Type',
      'Array Element Type',
      'Payload Description',
      'Notes',
      'Source (Frontend / API)',
    ],
    ['1.0', 'Registration', 'New', 'Mobile Number', 'TEXT', 'Primary key', 'mobile_number', '', '', '', '', '', 'Frontend'],
  ];

  it('finds a header sitting under a title row', () => {
    expect(detectColumns(TITLE_THEN_HEADER).headerRow).toBe(1);
  });

  it('finds a header on the very first row', () => {
    expect(detectColumns(HEADER_FIRST).headerRow).toBe(0);
  });

  it('maps the roles it needs from a full sheet', () => {
    const detection = detectColumns(HEADER_FIRST);
    if (detection.kind !== 'resolved') {
      throw new Error(`expected a resolved mapping, got ${detection.kind}`);
    }

    expect(HEADER_FIRST[0]?.[detection.mapping.eventName]).toBe('Event Name');
    expect(HEADER_FIRST[0]?.[detection.mapping.payloadName ?? -1]).toBe('Payload Key');
    expect(HEADER_FIRST[0]?.[detection.mapping.source ?? -1]).toBe('Source (Frontend / API)');
  });

  /**
   * The reason the search stops after five rows. A data row full of role words outscores a real
   * header, and one wrong header row maps every column to the wrong thing.
   */
  it('ignores a data row deep in the sheet that reads like a header', () => {
    const grid = [
      ['Event Name', 'Payload', 'Data type'],
      ...Array.from({ length: 8 }, () => ['Registration', 'mobile_number', 'TEXT']),
      ['Event Name', 'Payload Key', 'Payload Data Type', 'Attribute', 'Description', 'Example'],
    ];

    expect(detectColumns(grid).headerRow).toBe(0);
  });
});
