import type { EventSheet } from '../event-sheet/types';
import { isDestructive, type ActionIntent } from './types';

/**
 * Maps an Event Sheet name to the action that produces it.
 *
 * This is deliberately fuzzy, unlike `matchEvent`, which refuses to fold case or normalise
 * separators. The difference matters: matching a *captured* event to a schema decides whether
 * the site is correct, so a loose match there would hide defects. This decides what to click,
 * and a wrong guess is caught downstream — a mis-mapped action finds no element, or finds a weak
 * one that asks for confirmation before doing anything.
 */
const INTENT_PATTERNS: readonly { readonly pattern: RegExp; readonly intent: ActionIntent }[] = [
  { pattern: /\b(add|added)\b.*\b(cart|bag|basket)\b/, intent: 'add-to-cart' },
  { pattern: /\b(remove|removed|delete)\b.*\b(cart|bag|basket|item)\b/, intent: 'remove-from-cart' },
  { pattern: /\b(checkout|purchase|order placed|place order|payment|transaction)\b/, intent: 'checkout' },
  { pattern: /\b(cart)\b.*\b(view|viewed|open)\b|\bview cart\b|^cart$/, intent: 'cart' },
  { pattern: /\bproduct\b.*\b(view|viewed|detail|details|page)\b|^product$/, intent: 'product' },
];

/** The order a shopper would do these in — you cannot remove from a cart nothing is in. */
const NATURAL_ORDER: readonly ActionIntent[] = [
  'product',
  'add-to-cart',
  'cart',
  'remove-from-cart',
  'checkout',
];

export interface PlannedTest {
  readonly eventName: string;
  /** `undefined` when nothing in the page can be clicked to produce this event. */
  readonly intent: ActionIntent | undefined;
  /** Present when this event will not run unattended, and why. */
  readonly skipReason: string | undefined;
}

export interface PlanOptions {
  /**
   * Keep money-spending actions out of an unattended batch. They remain runnable one at a time,
   * behind the same explicit confirmation.
   */
  readonly includeDestructive: boolean;
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = { includeDestructive: false };

export function intentForEvent(eventName: string): ActionIntent | undefined {
  const normalised = eventName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return INTENT_PATTERNS.find((entry) => entry.pattern.test(normalised))?.intent;
}

/**
 * Turns an Event Sheet into an ordered run plan.
 *
 * Every event in the sheet appears, including the ones that cannot be automated — a silently
 * shorter list would read as "all tested" when several were never attempted.
 */
export function planFromSheet(
  sheet: EventSheet,
  options: PlanOptions = DEFAULT_PLAN_OPTIONS,
): readonly PlannedTest[] {
  const planned: PlannedTest[] = [...sheet.events.keys()].map((eventName) => {
    const intent = intentForEvent(eventName);

    if (intent === undefined) {
      return {
        eventName,
        intent: undefined,
        skipReason: 'No page action maps to this event name — trigger it yourself.',
      };
    }
    if (isDestructive(intent) && !options.includeDestructive) {
      return {
        eventName,
        intent,
        skipReason: 'Spends money — run this one on its own.',
      };
    }

    return { eventName, intent, skipReason: undefined };
  });

  return [...planned].sort(byNaturalOrder);
}

/** Runnable tests first, in shopper order; everything skipped sinks to the bottom. */
function byNaturalOrder(a: PlannedTest, b: PlannedTest): number {
  const rank = (test: PlannedTest): number =>
    test.intent === undefined ? NATURAL_ORDER.length : NATURAL_ORDER.indexOf(test.intent);

  const skipped = Number(a.skipReason !== undefined) - Number(b.skipReason !== undefined);
  return skipped !== 0 ? skipped : rank(a) - rank(b);
}

export function runnable(plan: readonly PlannedTest[]): readonly PlannedTest[] {
  return plan.filter((test) => test.skipReason === undefined && test.intent !== undefined);
}
