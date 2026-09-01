import { describe, expect, it } from 'vitest';
import type { EventSchema, EventSheet, FieldSchema } from '../event-sheet/types';
import type { CapturedPayload, TransferableValue } from '../shared/payload';
import { payloadSubject, unwrapEnvelope, verdictFor } from './from-capture';

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
    ['add_to_cart', { name: 'add_to_cart', fields: [field('product_id', true)], source: 'unknown' }],
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

describe('Smartech envelopes', () => {
  /**
   * The shape a live Smartech debug line actually has: a session record naming the event, with
   * the event's own fields nested under `payload`.
   */
  function enveloped(eventName: string, payload: Record<string, unknown>): CapturedPayload {
    const envelope = {
      user_key: 'ADGMOT35',
      customer_key: '919384660680',
      siteid: '80a6d96f',
      sid: 1_788_271_712_383,
      url: 'https://shop.example.com/profile',
      eventname: eventName,
      payload,
    } as unknown as TransferableValue;

    return {
      id: eventName,
      at: AT,
      eventName,
      args: ['[Smartech Debugger] Firing EVT', envelope],
      raw: '[]',
      origin: 'intercepted',
    };
  }

  it('validates the fields inside the envelope, not the session record around them', () => {
    const subject = payloadSubject(enveloped('cart viewed', { item_count: 3, value: 1390 }));

    expect(subject).toEqual({ item_count: 3, value: 1390 });
  });

  it('leaves a plain payload alone', () => {
    expect(unwrapEnvelope({ product_id: 'SKU1', price: 499 })).toEqual({
      product_id: 'SKU1',
      price: 499,
    });
  });

  /** Without the event-name guard, any payload with a `data` key would be silently truncated. */
  it('does not treat a payload that merely has a data key as an envelope', () => {
    const payload = { order_id: 'A1', data: { note: 'gift' } };

    expect(unwrapEnvelope(payload)).toEqual(payload);
  });

  it('reads the fields Netcore\'s activity API nests under activity_params', () => {
    const subject = unwrapEnvelope({
      activity_name: 'Registration',
      activity_params: { mobile_number: '919384660680' },
    });

    expect(subject).toEqual({ mobile_number: '919384660680' });
  });
});
