import { describe, expect, it } from 'vitest';
import type { EventSchema, EventSheet } from '../event-sheet/types';
import { matchEvent } from './match-event';

function sheetWith(...names: readonly string[]): EventSheet {
  const events = new Map<string, EventSchema>(
    names.map((name) => [name, { name, fields: [] }]),
  );
  return { events, warnings: [] };
}

describe('matchEvent', () => {
  it('matches an exact name', () => {
    const match = matchEvent('add_to_cart', sheetWith('add_to_cart', 'purchase'));

    expect(match.kind).toBe('matched');
    if (match.kind !== 'matched') return;
    expect(match.schema.name).toBe('add_to_cart');
  });

  it('reports an unmatched name with what the sheet does know', () => {
    const match = matchEvent('checkout', sheetWith('add_to_cart', 'purchase'));

    expect(match).toEqual({
      kind: 'unknown',
      eventName: 'checkout',
      knownEvents: ['add_to_cart', 'purchase'],
    });
  });

  it('does not fold case', () => {
    // Silently equating these would hide the naming defect we exist to report.
    expect(matchEvent('Add_To_Cart', sheetWith('add_to_cart')).kind).toBe('unknown');
  });

  it('does not normalise separators or whitespace', () => {
    expect(matchEvent('Add to Cart', sheetWith('add_to_cart')).kind).toBe('unknown');
    expect(matchEvent(' add_to_cart', sheetWith('add_to_cart')).kind).toBe('unknown');
  });

  it('applies an alias the user supplied', () => {
    const aliases = new Map([['Add to Cart', 'add_to_cart']]);
    const match = matchEvent('Add to Cart', sheetWith('add_to_cart'), aliases);

    expect(match.kind).toBe('matched');
    if (match.kind !== 'matched') return;
    expect(match.schema.name).toBe('add_to_cart');
  });

  it('offers a close match only when asked, and says the names differ', () => {
    const sheet = sheetWith('Add to Cart');

    // Off by default: exactness is what makes a naming defect visible.
    expect(matchEvent('add_to_cart', sheet).kind).toBe('unknown');

    const near = matchEvent('add_to_cart', sheet, new Map(), true);
    expect(near.kind).toBe('close');
    if (near.kind !== 'close') return;
    expect(near.schema.name).toBe('Add to Cart');
    expect(near.observed).toBe('add_to_cart');
    expect(near.similarity).toBe(1);
  });

  it('prefers an exact match over a close one', () => {
    const sheet = sheetWith('add_to_cart', 'Add to Cart');

    expect(matchEvent('add_to_cart', sheet, new Map(), true).kind).toBe('matched');
  });

  it('matches names that differ only in case and separators', () => {
    expect(matchEvent('SIGN-IN', sheetWith('Sign in'), new Map(), true).kind).toBe('close');
    expect(matchEvent('productViewed', sheetWith('product_viewed'), new Map(), true).kind).toBe(
      'close',
    );
  });

  it('scores a partial overlap below an exact one', () => {
    const near = matchEvent('Zolo_Searched', sheetWith('Searched'), new Map(), true);

    expect(near.kind).toBe('close');
    if (near.kind !== 'close') return;
    expect(near.similarity).toBeLessThan(1);
  });

  it('recognises a synonym and says that is why', () => {
    const near = matchEvent('login', sheetWith('Sign in'), new Map(), true);

    expect(near.kind).toBe('close');
    if (near.kind !== 'close') return;
    expect(near.schema.name).toBe('Sign in');
    expect(near.reason).toBe('synonym');
  });

  it.each([
    ['registration', 'Sign up'],
    ['order_placed', 'Purchase'],
    ['add_to_bag', 'Add to Cart'],
    ['product_viewed', 'Item Viewed'],
    ['searched', 'Search'],
  ])('treats %s and %s as the same event', (observed, sheetName) => {
    expect(matchEvent(observed, sheetWith(sheetName), new Map(), true).kind).toBe('close');
  });

  it('keeps sign in and sign out apart', () => {
    // Collapsing these would be far worse than failing to match them.
    expect(matchEvent('logout', sheetWith('Sign in'), new Map(), true).kind).toBe('unknown');
    expect(matchEvent('login', sheetWith('Sign out'), new Map(), true).kind).toBe('unknown');
  });

  it('calls a punctuation difference formatting, not a synonym', () => {
    const near = matchEvent('add_to_cart', sheetWith('Add to Cart'), new Map(), true);

    expect(near.kind).toBe('close');
    if (near.kind !== 'close') return;
    expect(near.reason).toBe('formatting');
  });

  it('does not call unrelated names close', () => {
    expect(matchEvent('newsletter_signup', sheetWith('add_to_cart'), new Map(), true).kind).toBe(
      'unknown',
    );
    expect(matchEvent('purchase', sheetWith('page_viewed'), new Map(), true).kind).toBe('unknown');
  });

  it('still reports unknown when an alias points at a name the sheet lacks', () => {
    const aliases = new Map([['Add to Cart', 'nope']]);

    expect(matchEvent('Add to Cart', sheetWith('add_to_cart'), aliases).kind).toBe('unknown');
  });
});
