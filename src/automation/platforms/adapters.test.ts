import { describe, expect, it } from 'vitest';
import { detectPlatform, findByPlatform, genericAdapter, magentoAdapter, shopifyAdapter } from './adapters';

function pageWith(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
}

describe('detectPlatform', () => {
  it('recognises Shopify by its wallet meta tag', () => {
    expect(detectPlatform(pageWith('<meta name="shopify-digital-wallet" content="x">')).name).toBe(
      'shopify',
    );
  });

  it('recognises Shopify by its CDN script', () => {
    expect(
      detectPlatform(pageWith('<script src="https://cdn.shopify.com/x.js"></script>')).name,
    ).toBe('shopify');
  });

  it('recognises Magento by its init attribute', () => {
    expect(detectPlatform(pageWith('<div data-mage-init="{}"></div>')).name).toBe('magento');
  });

  it('falls back to generic on an unrecognised storefront', () => {
    expect(detectPlatform(pageWith('<button>Add to Cart</button>')).name).toBe('generic');
  });
});

describe('findByPlatform', () => {
  it('finds a Shopify add-to-cart submit inside its cart form', () => {
    const page = pageWith('<form action="/cart/add"><button type="submit">Add</button></form>');
    const candidates = findByPlatform(page, shopifyAdapter, 'add-to-cart');

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.strategy).toBe('platform');
    expect(candidates[0]?.confidence).toBe(0.95);
  });

  it("finds Magento's add-to-cart button by id", () => {
    const page = pageWith('<button id="product-addtocart-button">Add</button>');

    expect(findByPlatform(page, magentoAdapter, 'add-to-cart')).toHaveLength(1);
  });

  it('finds nothing through the generic adapter, which knows no selectors', () => {
    const page = pageWith('<button>Add to Cart</button>');

    expect(findByPlatform(page, genericAdapter, 'add-to-cart')).toEqual([]);
  });

  it('does not match a Shopify selector on a page that is not Shopify', () => {
    const page = pageWith('<form action="/basket"><button type="submit">Add</button></form>');

    expect(findByPlatform(page, shopifyAdapter, 'add-to-cart')).toEqual([]);
  });
});
