import { describe, expect, it } from 'vitest';
import type { EventSchema, EventSheet } from '../event-sheet/types';
import { intentForEvent, planFromSheet, runnable } from './event-plan';

function sheetWith(...names: readonly string[]): EventSheet {
  return {
    events: new Map<string, EventSchema>(names.map((name) => [name, { name, fields: [] }])),
    warnings: [],
  };
}

describe('intentForEvent', () => {
  it.each([
    ['add_to_cart', 'add-to-cart'],
    ['Add to Bag', 'add-to-cart'],
    ['ADDED_TO_BASKET', 'add-to-cart'],
    ['remove_from_cart', 'remove-from-cart'],
    ['product_viewed', 'product'],
    ['checkout_started', 'checkout'],
    ['purchase', 'checkout'],
    ['view_cart', 'cart'],
  ])('maps %s to %s', (eventName, intent) => {
    expect(intentForEvent(eventName)).toBe(intent);
  });

  it('maps nothing it does not recognise', () => {
    expect(intentForEvent('newsletter_signup')).toBeUndefined();
    expect(intentForEvent('page_view')).toBeUndefined();
  });
});

describe('planFromSheet', () => {
  it('orders runnable tests the way a shopper would do them', () => {
    const plan = planFromSheet(sheetWith('remove_from_cart', 'add_to_cart', 'product_viewed'));

    expect(plan.map((test) => test.eventName)).toEqual([
      'product_viewed',
      'add_to_cart',
      'remove_from_cart',
    ]);
  });

  it('keeps money-spending events out of an unattended run', () => {
    const plan = planFromSheet(sheetWith('add_to_cart', 'purchase'));
    const purchase = plan.find((test) => test.eventName === 'purchase');

    expect(purchase?.skipReason).toContain('Spends money');
    expect(runnable(plan).map((test) => test.eventName)).toEqual(['add_to_cart']);
  });

  it('includes them when asked explicitly', () => {
    const plan = planFromSheet(sheetWith('purchase'), { includeDestructive: true });

    expect(plan[0]?.skipReason).toBeUndefined();
  });

  it('lists an unmappable event rather than dropping it', () => {
    const plan = planFromSheet(sheetWith('add_to_cart', 'newsletter_signup'));

    // A silently shorter list would read as "all tested" when one was never attempted.
    expect(plan).toHaveLength(2);
    expect(plan.find((test) => test.eventName === 'newsletter_signup')?.skipReason).toContain(
      'No page action maps',
    );
  });

  it('sinks skipped tests below runnable ones', () => {
    const plan = planFromSheet(sheetWith('newsletter_signup', 'add_to_cart'));

    expect(plan[0]?.eventName).toBe('add_to_cart');
  });
});
