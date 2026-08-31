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

/** Actions that spend money. Never triggered without an explicit, separate confirmation. */
export function isDestructive(intent: ActionIntent): boolean {
  return intent === 'checkout';
}
