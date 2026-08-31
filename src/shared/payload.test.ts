import { describe, expect, it } from 'vitest';
import { isCaptureMessage, toTransferable, CAPTURE_MARKER } from './payload';

describe('toTransferable', () => {
  it('passes primitives through', () => {
    expect(toTransferable('a')).toBe('a');
    expect(toTransferable(1)).toBe(1);
    expect(toTransferable(true)).toBe(true);
    expect(toTransferable(null)).toBeNull();
  });

  it('tags undefined so it stays distinguishable from null', () => {
    expect(toTransferable({ a: null, b: undefined })).toEqual({
      a: null,
      b: { __special: 'undefined' },
    });
  });

  it('tags functions by name', () => {
    expect(toTransferable({ cb: function handler() {} })).toEqual({
      cb: { __special: 'function', detail: 'handler' },
    });
  });

  it('tags non-finite numbers', () => {
    expect(toTransferable(Number.NaN)).toEqual({ __special: 'unserialisable', detail: 'NaN' });
  });

  it('breaks cycles instead of overflowing the stack', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;

    expect(toTransferable(cyclic)).toEqual({ name: 'root', self: { __special: 'circular' } });
  });

  it('keeps a repeated sibling that is not a cycle', () => {
    const shared = { id: 1 };

    expect(toTransferable({ a: shared, b: shared })).toEqual({ a: { id: 1 }, b: { id: 1 } });
  });

  it('records a throwing getter without losing the rest of the payload', () => {
    const hostile = {
      good: 'kept',
      get bad(): string {
        throw new Error('nope');
      },
    };

    expect(toTransferable(hostile)).toEqual({
      good: 'kept',
      bad: { __special: 'unserialisable', detail: 'nope' },
    });
  });

  it('does not mutate the source object', () => {
    const source = { a: 1, nested: { b: 2 } };
    toTransferable(source);

    expect(source).toEqual({ a: 1, nested: { b: 2 } });
  });

  it('renders dates as ISO strings', () => {
    expect(toTransferable(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
  });

  it('tags a DOM node instead of walking it', () => {
    expect(toTransferable(document.createElement('div'))).toEqual({
      __special: 'unserialisable',
      detail: '<div>',
    });
  });

  it('tags the global object instead of walking it', () => {
    expect(toTransferable(globalThis)).toEqual({ __special: 'unserialisable', detail: 'window' });
  });

  it('stops at a depth limit rather than overflowing the stack', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let level = 0; level < 40; level += 1) {
      deep = { nested: deep };
    }

    const result = JSON.stringify(toTransferable(deep));
    expect(result).toContain('nested deeper than 12 levels');
    expect(result).not.toContain('"end"');
  });

  it('truncates a very long array and says how much was dropped', () => {
    const long = Array.from({ length: 520 }, (_unused, index) => index);
    const result = toTransferable(long);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(501);
    expect((result as readonly unknown[])[500]).toEqual({
      __special: 'unserialisable',
      detail: '20 more items',
    });
  });

  it('truncates an object with very many keys', () => {
    const wide: Record<string, number> = {};
    for (let index = 0; index < 210; index += 1) {
      wide[`k${index}`] = index;
    }

    const result = toTransferable(wide) as Record<string, unknown>;
    expect(Object.keys(result)).toHaveLength(201);
    expect(result['__truncated']).toEqual({
      __special: 'unserialisable',
      detail: '10 more keys',
    });
  });

  it('stays structured-cloneable for a payload that used to blow the stack', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < 200; level += 1) {
      deep = { nested: deep, node: document.createElement('span') };
    }

    expect(() => structuredClone(toTransferable(deep))).not.toThrow();
  });

  it('produces something JSON can round-trip', () => {
    const value = toTransferable({ a: undefined, b: [1, 'x'], c: () => {} });

    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  });
});

describe('isCaptureMessage', () => {
  it('accepts a well-formed message', () => {
    expect(
      isCaptureMessage({
        marker: CAPTURE_MARKER,
        payload: { id: '1', at: 0, args: [], raw: '[]', origin: 'intercepted' },
      }),
    ).toBe(true);
  });

  it.each([
    ['a foreign postMessage', { marker: 'something-else', payload: {} }],
    ['a missing payload', { marker: CAPTURE_MARKER }],
    ['a malformed payload', { marker: CAPTURE_MARKER, payload: { id: 1, at: 0, args: [] } }],
    ['a non-object', 'nope'],
    ['null', null],
  ])('rejects %s', (_label, message) => {
    expect(isCaptureMessage(message)).toBe(false);
  });
});
