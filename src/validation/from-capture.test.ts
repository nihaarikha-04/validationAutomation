import { describe, expect, it } from 'vitest';
import type { EventSchema, EventSheet, FieldSchema } from '../event-sheet/types';
import type { CapturedPayload } from '../shared/payload';
import { payloadSubject, verdictFor } from './from-capture';

const AT = 1_735_689_600_000;
const LINE = "[Smartech Debugger] Firing EVT: 'add_to_cart' with payload: ";

function field(payloadName: string, required: boolean): FieldSchema {
  return {
    payloadName,
    payloadType: 'string',
    attributeName: '',
    attributeType: 'unknown',
    required,
    description: '',
    example: '',
  };
}

const SHEET: EventSheet = {
  events: new Map<string, EventSchema>([
    ['add_to_cart', { name: 'add_to_cart', fields: [field('product_id', true)] }],
  ]),
  warnings: [],
};

function captured(overrides: Partial<CapturedPayload> = {}): CapturedPayload {
  const args = overrides.args ?? [LINE, { product_id: 'SKU123' }];
  return {
    id: 'p1',
    at: AT,
    eventName: 'add_to_cart',
    args,
    raw: JSON.stringify(args),
    origin: 'intercepted',
    ...overrides,
  };
}

describe('payloadSubject', () => {
  it('picks the first plain object among the logged arguments', () => {
    expect(payloadSubject(captured())).toEqual({ product_id: 'SKU123' });
  });

  it('ignores the prefixed message string', () => {
    expect(payloadSubject(captured({ args: [LINE] }))).toBeUndefined();
  });

  it('ignores arrays and tagged specials', () => {
    expect(
      payloadSubject(captured({ args: [LINE, [1, 2], { __special: 'circular' }] })),
    ).toBeUndefined();
  });
});

describe('verdictFor', () => {
  it('validates a named event that the sheet knows', () => {
    const verdict = verdictFor(captured(), SHEET);

    expect(verdict.kind).toBe('validated');
    if (verdict.kind !== 'validated') return;
    expect(verdict.result.status).toBe('PASS');
    expect(verdict.result.timestamp).toBe(AT);
  });

  it('reports a failing payload', () => {
    const verdict = verdictFor(captured({ args: [LINE, { product_id: null }] }), SHEET);

    expect(verdict.kind).toBe('validated');
    if (verdict.kind !== 'validated') return;
    expect(verdict.result.status).toBe('FAIL');
  });

  it('reports an event the sheet does not describe', () => {
    const verdict = verdictFor(captured({ eventName: 'checkout' }), SHEET);

    expect(verdict).toEqual({
      kind: 'unknown-event',
      eventName: 'checkout',
      knownEvents: ['add_to_cart'],
    });
  });

  it('reports a debug line that named no event', () => {
    const { eventName: _dropped, ...rest } = captured();

    expect(verdictFor(rest, SHEET)).toEqual({ kind: 'unnamed' });
  });

  it('reports a named event with no payload object to check', () => {
    expect(verdictFor(captured({ args: [LINE] }), SHEET)).toEqual({ kind: 'no-payload' });
  });

  it('honours a user-supplied alias', () => {
    const aliases = new Map([['Add to Cart', 'add_to_cart']]);
    const verdict = verdictFor(captured({ eventName: 'Add to Cart' }), SHEET, aliases);

    expect(verdict.kind).toBe('validated');
  });
});
