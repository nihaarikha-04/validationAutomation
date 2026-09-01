import { describe, expect, it } from 'vitest';
import { detectAction, keywordsFromEventName } from './detect-action';
import { AUTO_EXECUTE_THRESHOLD, type ActionIntent, type ActionTarget } from './types';

const forIntent = (intent: ActionIntent): ActionTarget => ({ kind: 'intent', intent });
const forEvent = (eventName: string): ActionTarget => ({
  kind: 'keywords',
  keywords: keywordsFromEventName(eventName),
  label: eventName,
});

function pageWith(html: string): Document {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return parsed;
}

describe('detectAction', () => {
  it('finds a semantic button by its accessible name', () => {
    const candidates = detectAction(pageWith('<button>Add to Cart</button>'), forIntent('add-to-cart'));

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.label).toBe('Add to Cart');
  });

  it('trusts a data attribute over plain text', () => {
    const candidates = detectAction(
      pageWith('<button data-action="add-to-cart">Go</button>'),
      forIntent('add-to-cart'),
    );

    expect(candidates[0]?.strategy).toBe('dataAttribute');
    expect(candidates[0]?.confidence).toBeGreaterThanOrEqual(AUTO_EXECUTE_THRESHOLD);
  });

  it('finds a non-control element by aria-label alone', () => {
    // A <button> carrying only an aria-label is still a semantic control and is attributed to
    // the stronger strategy, so aria is isolated here on something that is not a control.
    const candidates = detectAction(
      pageWith('<span aria-label="Add to bag"></span>'),
      forIntent('add-to-cart'),
    );

    expect(candidates[0]?.strategy).toBe('aria');
  });

  it('still finds a button whose only label is an aria-label', () => {
    const candidates = detectAction(
      pageWith('<button aria-label="Add to bag"><svg></svg></button>'),
      forIntent('add-to-cart'),
    );

    expect(candidates[0]?.label).toBe('Add to bag');
    expect(candidates[0]?.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('finds an element whose handler pushes to a dataLayer', () => {
    const candidates = detectAction(
      pageWith(`<a onclick="dataLayer.push({event:'add_to_cart'})">Buy</a>`),
      forIntent('add-to-cart'),
    );

    expect(candidates.some((entry) => entry.strategy === 'dataLayer')).toBe(true);
  });

  it('scores a text-only match below the auto-execute threshold', () => {
    // "Add to cart" as bare text is the weakest evidence, so it must ask before clicking.
    const candidates = detectAction(pageWith('<a>add to cart</a>'), forIntent('add-to-cart'));

    expect(candidates[0]?.confidence).toBeLessThan(AUTO_EXECUTE_THRESHOLD);
  });

  it('ignores unrelated buttons', () => {
    const candidates = detectAction(
      pageWith('<button>Subscribe</button><button>Log in</button>'),
      forIntent('add-to-cart'),
    );

    expect(candidates).toEqual([]);
  });

  it('does not confuse one intent for another', () => {
    const page = pageWith('<button>Checkout</button><button>Add to Cart</button>');

    expect(detectAction(page, forIntent('checkout'))[0]?.label).toBe('Checkout');
    expect(detectAction(page, forIntent('add-to-cart'))[0]?.label).toBe('Add to Cart');
  });

  it('merges one element found by several strategies, keeping the strongest', () => {
    const candidates = detectAction(
      pageWith('<button data-testid="add-to-cart" aria-label="Add to Cart">Add to Cart</button>'),
      forIntent('add-to-cart'),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.strategy).toBe('dataAttribute');
  });

  it('orders candidates strongest first', () => {
    const candidates = detectAction(
      pageWith('<a>add to cart</a><button data-action="add-to-cart">Go</button>'),
      forIntent('add-to-cart'),
    );

    expect(candidates[0]?.confidence).toBeGreaterThan(candidates[1]?.confidence ?? 1);
  });

  it('recognises a product page from JSON-LD', () => {
    const candidates = detectAction(
      pageWith('<script type="application/ld+json">{"@type":"Product"}</script>'),
      forIntent('product'),
    );

    expect(candidates.some((entry) => entry.strategy === 'jsonLd')).toBe(true);
  });

  it('drives an event outside the ecommerce set, using its own name', () => {
    const candidates = detectAction(
      pageWith('<button data-action="newsletter-signup">Join</button>'),
      forEvent('newsletter_signup'),
    );

    expect(candidates[0]?.strategy).toBe('dataAttribute');
  });

  it('matches a button whose label splits a compound word', () => {
    const candidates = detectAction(
      pageWith('<button>Sign up</button>'),
      forEvent('signup_completed'),
    );

    expect(candidates).toHaveLength(1);
  });

  it('matches across words the label puts in between', () => {
    // Seen live: the sheet said Schedule_visit, the page says "Schedule a visit".
    const candidates = detectAction(
      pageWith('<button>Schedule a visit</button>'),
      forEvent('Schedule_visit'),
    );

    expect(candidates).toHaveLength(1);
  });

  it('matches a word the sheet wrote in a different tense', () => {
    // Seen live: the sheet said "Searched", the page says "Search".
    const candidates = detectAction(
      pageWith('<button>Search</button>'),
      forEvent('Searched'),
    );

    expect(candidates).toHaveLength(1);
  });

  it('needs every word, not just one', () => {
    // Seen live: "Zolo_Searched" matched a link labelled "ZOLO SCHOLAR" because the brand name
    // alone was enough. It must not be.
    const candidates = detectAction(
      pageWith('<a>ZOLO SCHOLAR</a><button>Search</button>'),
      forEvent('Zolo_Searched'),
    );

    expect(candidates.map((entry) => entry.label)).not.toContain('ZOLO SCHOLAR');
  });

  it('falls back to the most distinctive word, at reduced confidence', () => {
    const candidates = detectAction(
      pageWith('<button>Search</button>'),
      forEvent('Zolo_Searched'),
    );

    expect(candidates[0]?.label).toBe('Search');
    // Reduced, so it asks rather than clicking on a partial match.
    expect(candidates[0]?.confidence).toBeLessThan(AUTO_EXECUTE_THRESHOLD);
  });

  it('never falls back to a word too short to mean anything', () => {
    const candidates = detectAction(pageWith('<a>ZOLO SCHOLAR</a>'), forEvent('zolo_booking'));

    expect(candidates).toEqual([]);
  });

  it('does not match a keyword inside a longer word', () => {
    // Seen live: the event "Zolo_Searched" matched <a class="zolostays-social-insta-feeds">
    // because punctuation was stripped before a substring test.
    const candidates = detectAction(
      pageWith('<a class="zolostays-social-insta-feeds">Follow us</a>'),
      forEvent('Zolo_Searched'),
    );

    expect(candidates).toEqual([]);
  });

  it('still matches a keyword written with separators', () => {
    const candidates = detectAction(
      pageWith('<button data-action="add-to-cart">Go</button>'),
      forIntent('add-to-cart'),
    );

    expect(candidates).toHaveLength(1);
  });

  it('gives every candidate a selector that finds it again', () => {
    const page = pageWith('<div><button id="atc">Add to Cart</button></div>');
    const candidates = detectAction(page, forIntent('add-to-cart'));

    for (const entry of candidates) {
      expect(page.querySelector(entry.selector)).not.toBeNull();
    }
  });
});

describe('keywordsFromEventName', () => {
  it('yields the words to search for', () => {
    expect(keywordsFromEventName('newsletter_signup')).toEqual(['newsletter', 'sign', 'up']);
  });

  it('splits camelCase names', () => {
    expect(keywordsFromEventName('wishlistAdd')).toEqual(['wish', 'list', 'add']);
  });

  it('drops words that describe the event rather than the action', () => {
    // No button is ever labelled "completed".
    expect(keywordsFromEventName('booking_completed')).not.toContain('completed');
  });

  it('returns nothing for a name made only of reporting words', () => {
    expect(keywordsFromEventName('page_viewed')).toEqual([]);
  });
});
