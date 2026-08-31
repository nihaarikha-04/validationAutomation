import { describe, expect, it } from 'vitest';
import { parseDebugText } from './parse-debug-text';

function parsed(text: string): unknown {
  const result = parseDebugText(text);
  if (result.kind !== 'ok') {
    throw new Error(`expected a parse, got: ${result.message}`);
  }
  return result.values;
}

describe('parseDebugText', () => {
  it('reads strict JSON', () => {
    expect(parsed('{"event":"add_to_cart","price":499}')).toEqual([
      { event: 'add_to_cart', price: 499 },
    ]);
  });

  it('reads unquoted keys and single quotes', () => {
    expect(parsed("{event: 'add_to_cart', sku: 'A-1'}")).toEqual([
      { event: 'add_to_cart', sku: 'A-1' },
    ]);
  });

  it('tolerates trailing commas', () => {
    expect(parsed("{a: 1, b: [1, 2,],}")).toEqual([{ a: 1, b: [1, 2] }]);
  });

  it('reads several top-level objects from one paste', () => {
    expect(parsed("{event:'a'}\n{event:'b'}")).toEqual([{ event: 'a' }, { event: 'b' }]);
  });

  it('treats commas and semicolons between top-level objects as noise', () => {
    expect(parsed("{a:1}, {b:2}; {c:3}")).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('reads nested objects and arrays', () => {
    expect(parsed("{items: [{sku: 'A', qty: 2}], total: 998}")).toEqual([
      { items: [{ sku: 'A', qty: 2 }], total: 998 },
    ]);
  });

  it('distinguishes null from undefined rather than collapsing both', () => {
    expect(parsed('{a: null, b: undefined}')).toEqual([
      { a: null, b: { __special: 'undefined' } },
    ]);
  });

  it('tags NaN and Infinity instead of failing', () => {
    expect(parsed('{a: NaN, b: Infinity}')).toEqual([
      {
        a: { __special: 'unserialisable', detail: 'NaN' },
        b: { __special: 'unserialisable', detail: 'Infinity' },
      },
    ]);
  });

  it('reads negative and exponent numbers', () => {
    expect(parsed('{a: -1.5, b: 2e3}')).toEqual([{ a: -1.5, b: 2000 }]);
  });

  it('unescapes string escapes', () => {
    expect(parsed('{a: "line\\nbreak", b: "\\u0041"}')).toEqual([
      { a: 'line\nbreak', b: 'A' },
    ]);
  });

  it('keeps a comma inside a quoted string', () => {
    expect(parsed("{a: 'x, y'}")).toEqual([{ a: 'x, y' }]);
  });

  it('reads a bare array', () => {
    expect(parsed("['a', 'b']")).toEqual([['a', 'b']]);
  });

  it('reports empty input rather than returning nothing silently', () => {
    expect(parseDebugText('   ')).toEqual({
      kind: 'failed',
      message: 'Nothing to parse.',
      position: 0,
    });
  });

  it('reports an unterminated string with a position', () => {
    const result = parseDebugText("{a: 'oops}");

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.message).toContain('Unterminated string');
  });

  it('reports a missing value', () => {
    const result = parseDebugText('{event: }');

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.message).toContain('Unexpected character');
  });

  it('explains the DevTools collapsed-object placeholder', () => {
    const result = parseDebugText('{payload: {…}}');

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.message).toContain('collapsed DevTools placeholder');
  });

  it('names an unknown bare word instead of guessing', () => {
    const result = parseDebugText('{a: someVar}');

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.message).toContain('"someVar" is not a value');
  });

  it('never evaluates the text it is given', () => {
    // If this were eval-based, the assignment would land on globalThis.
    parseDebugText("{a: 'x'}; globalThis.__pwned = true");

    expect(Reflect.get(globalThis, '__pwned')).toBeUndefined();
  });
});
