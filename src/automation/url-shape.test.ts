import { describe, expect, it } from 'vitest';
import { urlShape } from './url-shape';

const at = (path: string): string => `https://shop.test${path}`;

describe('urlShape', () => {
  it('gives every product page the same shape', () => {
    expect(urlShape(at('/products/easy-peasy-gut'))).toBe(urlShape(at('/products/gut-shot')));
  });

  it('gives every category page the same shape', () => {
    expect(urlShape(at('/collections/skin'))).toBe(urlShape(at('/collections/gut')));
  });

  it('keeps products and categories apart', () => {
    expect(urlShape(at('/products/gut-shot'))).not.toBe(urlShape(at('/collections/gut')));
  });

  it('leaves a single-segment page as itself', () => {
    expect(urlShape(at('/shop'))).toBe('/shop');
    expect(urlShape(at('/free-consultation'))).toBe('/free-consultation');
  });

  it('keeps two different single-segment pages apart', () => {
    expect(urlShape(at('/shop'))).not.toBe(urlShape(at('/profile')));
  });

  /** `/page-2` and `/level-3` are ordinary pages, not one page with an id in it. */
  it('does not collapse a page whose name merely contains a number', () => {
    expect(urlShape(at('/next-1'))).not.toBe(urlShape(at('/other-1')));
  });

  it('collapses a bare numeric id anywhere in the path', () => {
    expect(urlShape(at('/order/48898902917371/track'))).toBe(urlShape(at('/order/47438996/track')));
  });

  it('collapses a uuid', () => {
    expect(urlShape(at('/session/c4da14d7-b4a0-4f4a-9cac-4d053ff07bbe'))).toBe(
      urlShape(at('/session/eb55872e-3a40-40e2-b006-d717d312244d')),
    );
  });

  /** Query keys are the shape; their values are which particular page. */
  it('gives two values of the same query parameter one shape', () => {
    expect(urlShape(at('/profile?tab=orders'))).toBe(urlShape(at('/profile?tab=my-profile')));
  });

  it('keeps a page with a query apart from the same page without one', () => {
    expect(urlShape(at('/shop?page=2'))).not.toBe(urlShape(at('/shop')));
  });

  it('treats something it cannot parse as its own shape rather than guessing', () => {
    expect(urlShape('not a url')).toBe('not a url');
  });
});
