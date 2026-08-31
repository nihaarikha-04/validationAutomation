import { describe, expect, it } from 'vitest';
import { canonicalPath, leafPaths, parsePath, readPath } from './path';

describe('parsePath', () => {
  it('splits dotted keys', () => {
    expect(parsePath('product.category.id')).toEqual([
      { kind: 'key', key: 'product' },
      { kind: 'key', key: 'category' },
      { kind: 'key', key: 'id' },
    ]);
  });

  it('reads array indices', () => {
    expect(parsePath('items[0].price')).toEqual([
      { kind: 'key', key: 'items' },
      { kind: 'index', index: 0 },
      { kind: 'key', key: 'price' },
    ]);
  });

  it('keeps a non-numeric bracket as part of the key rather than failing', () => {
    expect(parsePath('odd[name]')).toEqual([{ kind: 'key', key: 'odd[name]' }]);
  });
});

describe('readPath', () => {
  const payload = {
    product_id: 'SKU123',
    price: 0,
    blank: '',
    nothing: null,
    product: { category: { id: 7 } },
    items: [{ price: 10 }, { price: 20 }],
  };

  it('reads a top-level key', () => {
    expect(readPath(payload, 'product_id')).toEqual({ kind: 'found', value: 'SKU123' });
  });

  it('reads a nested key', () => {
    expect(readPath(payload, 'product.category.id')).toEqual({ kind: 'found', value: 7 });
  });

  it('reads through an array index', () => {
    expect(readPath(payload, 'items[1].price')).toEqual({ kind: 'found', value: 20 });
  });

  it('reports an absent key as missing', () => {
    expect(readPath(payload, 'nope')).toEqual({ kind: 'missing' });
  });

  it('reports an out-of-range index as missing', () => {
    expect(readPath(payload, 'items[5].price')).toEqual({ kind: 'missing' });
  });

  it('finds a key holding null rather than calling it missing', () => {
    // The whole point: present-but-null and absent are different defects.
    expect(readPath(payload, 'nothing')).toEqual({ kind: 'found', value: null });
  });

  it('finds a key holding falsy values', () => {
    expect(readPath(payload, 'price')).toEqual({ kind: 'found', value: 0 });
    expect(readPath(payload, 'blank')).toEqual({ kind: 'found', value: '' });
  });

  it('stops at a primitive rather than pretending to descend', () => {
    expect(readPath(payload, 'product_id.nope')).toEqual({ kind: 'missing' });
  });

  it('refuses to read a key off an array', () => {
    expect(readPath(payload, 'items.price')).toEqual({ kind: 'missing' });
  });

  it('does not fall through to inherited properties', () => {
    expect(readPath(payload, 'toString')).toEqual({ kind: 'missing' });
  });
});

describe('canonicalPath', () => {
  it('erases index numbers so array positions compare equal', () => {
    expect(canonicalPath('items[0].price')).toBe('items.[].price');
    expect(canonicalPath('items[3].price')).toBe(canonicalPath('items[0].price'));
  });
});

describe('leafPaths', () => {
  it('lists every leaf in Event Sheet notation', () => {
    expect(leafPaths({ a: 1, b: { c: 2 }, d: [{ e: 3 }] })).toEqual(['a', 'b.c', 'd[0].e']);
  });

  it('treats an empty object or array as a leaf', () => {
    expect(leafPaths({ a: {}, b: [] })).toEqual(['a', 'b']);
  });

  it('treats a tagged special as a leaf', () => {
    expect(leafPaths({ a: { __special: 'undefined' } })).toEqual(['a']);
  });
});
