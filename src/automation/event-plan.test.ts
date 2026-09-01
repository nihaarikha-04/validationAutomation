import { describe, expect, it } from 'vitest';
import type { EventSchema, EventSheet } from '../event-sheet/types';
import { intentForEvent, planFromSheet, runnable } from './event-plan';

function sheetWith(...names: readonly string[]): EventSheet {
  return {
    events: new Map<string, EventSchema>(names.map((name) => [name, { name, fields: [], source: 'unknown' }])),
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

  it('drives a non-ecommerce event from its own name', () => {
    const plan = planFromSheet(sheetWith('newsletter_signup'));

    expect(plan[0]?.skipReason).toBeUndefined();
    expect(plan[0]?.target).toEqual({
      kind: 'keywords',
      keywords: ['newsletter', 'sign', 'up'],
      label: 'newsletter_signup',
    });
  });

  it('lists an event nothing can click rather than dropping it', () => {
    // "page viewed" is all reporting words — there is no button called that.
    const plan = planFromSheet(sheetWith('add_to_cart', 'page_viewed'));

    // A silently shorter list would read as "all tested" when one was never attempted.
    expect(plan).toHaveLength(2);
    expect(plan.find((test) => test.eventName === 'page_viewed')?.skipReason).toContain(
      'Nothing on a page can be clicked',
    );
  });

  it('gates a destructive event even outside the ecommerce set', () => {
    const plan = planFromSheet(sheetWith('subscription_payment'));

    expect(plan[0]?.skipReason).toContain('Spends money');
  });

  it('sinks skipped tests below runnable ones', () => {
    const plan = planFromSheet(sheetWith('page_viewed', 'add_to_cart'));

    expect(plan[0]?.eventName).toBe('add_to_cart');
  });
});
