/**
 * Phrases that mean an event only happens when real money moves.
 *
 * Deliberately **not** `checkout`. Starting or completing a checkout is a step a tester can take
 * on any site without being charged — the card is taken at the end, not at the beginning — so
 * treating it as payment would excuse a genuine gap. The same goes for `Buy Now`, which opens a
 * checkout rather than paying for anything.
 *
 * Phrases rather than bare words, for the reason the sweep's destructive guard learned the hard
 * way: `order` alone matches "Order Details" and "Order Tracking", and `card` alone matches a
 * product card. What is being matched is the transaction, not the noun.
 */
const PAYMENT_PHRASES: readonly string[] = [
  'payment',
  '\\bpaid\\b',
  '\\bpay\\b',
  'order placed',
  'place(d)? (the )?order',
  'order failed',
  'purchase(d)?',
  'transaction',
  'refund',
  'card saved',
  'save(d)? card',
  'billing',
  'invoice paid',
];

const PAYMENT = new RegExp(PAYMENT_PHRASES.join('|'));

/**
 * Whether an event can only be produced by spending real money.
 *
 * Such an event is not missing when a run does not see it — nobody should be putting a live card
 * through a client's storefront to satisfy a report, and the sweep's own safety gate refuses to
 * click these controls unless asked. Reporting it as NOT SEEN puts it alongside events that
 * genuinely failed to fire and states two very different things in the same word.
 *
 * Matched on the event's name because that is the only signal every sheet carries. Kept
 * deliberately narrow: labelling an event PAYMENT hides it from the gap, so a phrase earns its
 * place here only when it cannot mean anything else. Anything uncertain stays NOT SEEN, which
 * overstates the gap rather than concealing it.
 */
export function isPaymentEvent(eventName: string): boolean {
  return PAYMENT.test(eventName.toLowerCase().replace(/[^a-z0-9]+/g, ' '));
}
