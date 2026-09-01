/** The ecommerce actions a test run can drive. */
export type ActionIntent =
  | 'product'
  | 'add-to-cart'
  | 'cart'
  | 'remove-from-cart'
  | 'checkout';

/**
 * How a candidate element was found, in the priority order the plan specifies. The order here
 * is the order they are tried; `confidence` below reflects how much each is trusted.
 */
export type StrategyName =
  | 'platform'
  | 'dataLayer'
  | 'dataAttribute'
  | 'semantic'
  | 'aria'
  | 'text'
  | 'jsonLd'
  | 'manual';

/**
 * Confidence per strategy, 0–1.
 *
 * A platform adapter matched a selector written for that platform, so it is trusted most. Text
 * matching is trusted least: "Add" appears on plenty of buttons that add nothing to a cart.
 */
export const STRATEGY_CONFIDENCE: Readonly<Record<StrategyName, number>> = {
  manual: 1,
  platform: 0.95,
  dataAttribute: 0.9,
  semantic: 0.8,
  aria: 0.75,
  dataLayer: 0.7,
  jsonLd: 0.65,
  text: 0.6,
};

/** At or above this, a candidate may be clicked without asking. Below it, the user confirms. */
export const AUTO_EXECUTE_THRESHOLD = 0.8;

export interface ActionCandidate {
  /** A selector that re-finds the element at execution time. */
  readonly selector: string;
  /** What the user would call this element. */
  readonly label: string;
  readonly strategy: StrategyName;
  readonly confidence: number;
}

export function isConfident(candidate: ActionCandidate): boolean {
  return candidate.confidence >= AUTO_EXECUTE_THRESHOLD;
}

/**
 * What a run is trying to click.
 *
 * `intent` covers the ecommerce actions we curated synonyms for. `keywords` covers everything
 * else: the words are derived from the event's own name, so a sheet listing `newsletter_signup`
 * can still be driven without anyone hand-mapping it first.
 */
export type ActionTarget =
  | { readonly kind: 'intent'; readonly intent: ActionIntent }
  | { readonly kind: 'keywords'; readonly keywords: readonly string[]; readonly label: string };

/**
 * Words that mean an action costs money or destroys something.
 *
 * Checked against the event name as well as the intent, because safety must not depend on our
 * fixed list of ecommerce actions — an event called `payment_completed` has to be gated whether
 * or not we recognised it as checkout.
 */
const IRREVERSIBLE = /\b(pay|payment|purchase|order|checkout|buy|donate|subscribe|delete|cancel)\b/;

/** Actions that spend money or cannot be undone. Never triggered without explicit confirmation. */
export function isDestructive(target: ActionTarget, eventName = ''): boolean {
  if (target.kind === 'intent' && target.intent === 'checkout') {
    return true;
  }
  const words = eventName.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  return IRREVERSIBLE.test(words);
}
