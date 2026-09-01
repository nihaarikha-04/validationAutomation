import { describe, expect, it } from 'vitest';
import { findRename } from './match-field';

describe('findRename', () => {
  it('sees through a Smartech abbreviation', () => {
    expect(findRename('product_id', ['prid'])?.foundAs).toBe('prid');
    expect(findRename('productid', ['prid'])?.foundAs).toBe('prid');
    expect(findRename('quantity', ['prqt'])?.foundAs).toBe('prqt');
  });

  it('sees through formatting alone', () => {
    expect(findRename('product_name', ['productName'])?.foundAs).toBe('productName');
  });

  it('does not match a different field that happens to share a word', () => {
    expect(findRename('product_id', ['category_id', 'order_id'])).toBeUndefined();
  });

  it('does not treat an enclosing object as a rename of the key inside it', () => {
    expect(findRename('product.category.id', ['product.category'])).toBeUndefined();
  });

  it('prefers the closest candidate when several are near', () => {
    expect(findRename('quantity', ['prqt', 'unrelated'])?.foundAs).toBe('prqt');
  });
});
