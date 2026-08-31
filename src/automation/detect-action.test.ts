import { describe, expect, it } from 'vitest';
import { detectAction } from './detect-action';
import { AUTO_EXECUTE_THRESHOLD } from './types';

function pageWith(html: string): Document {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return parsed;
}

describe('detectAction', () => {
  it('finds a semantic button by its accessible name', () => {
    const candidates = detectAction(pageWith('<button>Add to Cart</button>'), 'add-to-cart');

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.label).toBe('Add to Cart');
  });

  it('trusts a data attribute over plain text', () => {
    const candidates = detectAction(
      pageWith('<button data-action="add-to-cart">Go</button>'),
      'add-to-cart',
    );

    expect(candidates[0]?.strategy).toBe('dataAttribute');
    expect(candidates[0]?.confidence).toBeGreaterThanOrEqual(AUTO_EXECUTE_THRESHOLD);
  });

  it('finds a non-control element by aria-label alone', () => {
    // A <button> carrying only an aria-label is still a semantic control and is attributed to
    // the stronger strategy, so aria is isolated here on something that is not a control.
    const candidates = detectAction(
      pageWith('<span aria-label="Add to bag"></span>'),
      'add-to-cart',
    );

    expect(candidates[0]?.strategy).toBe('aria');
  });

  it('still finds a button whose only label is an aria-label', () => {
    const candidates = detectAction(
      pageWith('<button aria-label="Add to bag"><svg></svg></button>'),
      'add-to-cart',
    );

    expect(candidates[0]?.label).toBe('Add to bag');
    expect(candidates[0]?.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('finds an element whose handler pushes to a dataLayer', () => {
    const candidates = detectAction(
      pageWith(`<a onclick="dataLayer.push({event:'add_to_cart'})">Buy</a>`),
      'add-to-cart',
    );

    expect(candidates.some((entry) => entry.strategy === 'dataLayer')).toBe(true);
  });

  it('scores a text-only match below the auto-execute threshold', () => {
    // "Add to cart" as bare text is the weakest evidence, so it must ask before clicking.
    const candidates = detectAction(pageWith('<a>add to cart</a>'), 'add-to-cart');

    expect(candidates[0]?.confidence).toBeLessThan(AUTO_EXECUTE_THRESHOLD);
  });

  it('ignores unrelated buttons', () => {
    const candidates = detectAction(
      pageWith('<button>Subscribe</button><button>Log in</button>'),
      'add-to-cart',
    );

    expect(candidates).toEqual([]);
  });

  it('does not confuse one intent for another', () => {
    const page = pageWith('<button>Checkout</button><button>Add to Cart</button>');

    expect(detectAction(page, 'checkout')[0]?.label).toBe('Checkout');
    expect(detectAction(page, 'add-to-cart')[0]?.label).toBe('Add to Cart');
  });

  it('merges one element found by several strategies, keeping the strongest', () => {
    const candidates = detectAction(
      pageWith('<button data-testid="add-to-cart" aria-label="Add to Cart">Add to Cart</button>'),
      'add-to-cart',
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.strategy).toBe('dataAttribute');
  });

  it('orders candidates strongest first', () => {
    const candidates = detectAction(
      pageWith('<a>add to cart</a><button data-action="add-to-cart">Go</button>'),
      'add-to-cart',
    );

    expect(candidates[0]?.confidence).toBeGreaterThan(candidates[1]?.confidence ?? 1);
  });

  it('recognises a product page from JSON-LD', () => {
    const candidates = detectAction(
      pageWith('<script type="application/ld+json">{"@type":"Product"}</script>'),
      'product',
    );

    expect(candidates.some((entry) => entry.strategy === 'jsonLd')).toBe(true);
  });

  it('gives every candidate a selector that finds it again', () => {
    const page = pageWith('<div><button id="atc">Add to Cart</button></div>');
    const candidates = detectAction(page, 'add-to-cart');

    for (const entry of candidates) {
      expect(page.querySelector(entry.selector)).not.toBeNull();
    }
  });
});
