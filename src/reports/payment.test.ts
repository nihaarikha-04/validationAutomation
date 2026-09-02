import { describe, expect, it } from 'vitest';
import { isPaymentEvent } from './payment';

describe('isPaymentEvent', () => {
  it.each([
    'Payment Info Added',
    'Make Payment Clicked',
    'Order Placed',
    'Order Failed',
    'Subscription Payment Failed',
    'Card Saved',
    'purchase_completed',
    'Refund Issued',
  ])('treats %s as a payment event', (name) => {
    expect(isPaymentEvent(name)).toBe(true);
  });

  /**
   * Stated separately because it is the distinction that matters. A checkout can be started and
   * completed on any storefront without a card being charged, so excusing it as PAYMENT would
   * hide a genuine gap behind a reason that does not apply.
   */
  it.each(['Checkout Started', 'Checkout completed', 'Buy Now Clicked'])(
    'does not treat %s as a payment event',
    (name) => {
      expect(isPaymentEvent(name)).toBe(false);
    },
  );

  /** The whole order-history section reads as payment if `order` is matched on its own. */
  it.each([
    'Order Details Viewed',
    'Order Tracking Clicked',
    'Order List Filter Clicked',
    'Order Invoice Viewed',
    'Reorder Clicked',
    'Add New Card Modal Opened',
    'Product Viewed (Front End)',
    'Add to Cart',
  ])('leaves %s alone', (name) => {
    expect(isPaymentEvent(name)).toBe(false);
  });

  it('reads a name however the sheet punctuated it', () => {
    expect(isPaymentEvent('order_placed')).toBe(true);
    expect(isPaymentEvent('ORDER-PLACED')).toBe(true);
  });
});
