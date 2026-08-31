import { selectorFor } from './selector';
import {
  STRATEGY_CONFIDENCE,
  type ActionCandidate,
  type ActionIntent,
  type StrategyName,
} from './types';

/**
 * Words that identify each action when matching accessible names, aria labels, data attributes
 * and visible text. Deliberately conservative: a false match clicks the wrong thing on someone's
 * live shop.
 */
const INTENT_KEYWORDS: Readonly<Record<ActionIntent, readonly string[]>> = {
  'add-to-cart': ['add to cart', 'add to bag', 'add to basket', 'addtocart', 'add-to-cart'],
  'remove-from-cart': ['remove from cart', 'remove item', 'delete item', 'removefromcart', 'remove'],
  cart: ['view cart', 'go to cart', 'my cart', 'shopping cart', 'basket', 'cart'],
  checkout: ['checkout', 'check out', 'place order', 'proceed to pay', 'buy now', 'pay now'],
  product: ['view product', 'view details', 'product details', 'quick view'],
};

/** Genuine controls. Clicking one is what it is for. */
const SEMANTIC_CONTROLS = 'button, input[type="submit"], input[type="button"], [role="button"]';

/** Anything a user can click, including links — the loose set the text strategy searches. */
const CLICKABLE = `${SEMANTIC_CONTROLS}, a`;

/**
 * Finds elements that would trigger an action, best candidate first.
 *
 * Every strategy in the plan is tried and their results merged: one element found by several
 * strategies keeps its highest score, and results are ordered by confidence so the caller can
 * decide between clicking and asking.
 */
export function detectAction(
  document: Document,
  intent: ActionIntent,
): readonly ActionCandidate[] {
  const found: ActionCandidate[] = [
    ...byDataAttribute(document, intent),
    ...bySemantics(document, intent),
    ...byAria(document, intent),
    ...byDataLayer(document, intent),
    ...byText(document, intent),
    ...byJsonLd(document, intent),
  ];

  return rank(found);
}

/** Merges duplicates by selector, keeping the strongest evidence, then orders by confidence. */
export function rank(candidates: readonly ActionCandidate[]): readonly ActionCandidate[] {
  const best = new Map<string, ActionCandidate>();

  for (const candidate of candidates) {
    const existing = best.get(candidate.selector);
    if (existing === undefined || candidate.confidence > existing.confidence) {
      best.set(candidate.selector, candidate);
    }
  }

  return [...best.values()].sort((a, b) => b.confidence - a.confidence);
}

function candidate(
  element: Element,
  strategy: StrategyName,
  label: string,
): ActionCandidate {
  return {
    selector: selectorFor(element),
    label: label.trim() === '' ? element.nodeName.toLowerCase() : label.trim(),
    strategy,
    confidence: STRATEGY_CONFIDENCE[strategy],
  };
}

/** `data-add-to-cart`, `data-action="add-to-cart"`, `data-testid="add-to-cart"` and friends. */
function byDataAttribute(document: Document, intent: ActionIntent): ActionCandidate[] {
  const keywords = INTENT_KEYWORDS[intent];
  const results: ActionCandidate[] = [];

  for (const element of document.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      if (!attribute.name.startsWith('data-')) {
        continue;
      }

      const haystack = normalise(`${attribute.name} ${attribute.value}`);
      if (keywords.some((keyword) => haystack.includes(normalise(keyword)))) {
        results.push(candidate(element, 'dataAttribute', accessibleName(element)));
        break;
      }
    }
  }

  return results;
}

/**
 * A real button or submit whose accessible name says what it does. Anchors are deliberately
 * excluded: a link's text is the weakest evidence there is, and it belongs to `byText`.
 */
function bySemantics(document: Document, intent: ActionIntent): ActionCandidate[] {
  return [...document.querySelectorAll(SEMANTIC_CONTROLS)]
    .filter((element) => matchesIntent(accessibleName(element), intent))
    .map((element) => candidate(element, 'semantic', accessibleName(element)));
}

function byAria(document: Document, intent: ActionIntent): ActionCandidate[] {
  return [...document.querySelectorAll('[aria-label]')]
    .filter((element) => matchesIntent(element.getAttribute('aria-label') ?? '', intent))
    .map((element) => candidate(element, 'aria', element.getAttribute('aria-label') ?? ''));
}

/**
 * Elements whose inline handler pushes to a tag-manager dataLayer for this action. Weak on its
 * own, but it is direct evidence that clicking fires analytics.
 */
function byDataLayer(document: Document, intent: ActionIntent): ActionCandidate[] {
  const keywords = INTENT_KEYWORDS[intent];

  return [...document.querySelectorAll('[onclick]')]
    .filter((element) => {
      const handler = normalise(element.getAttribute('onclick') ?? '');
      return (
        (handler.includes('datalayer') || handler.includes('gtag')) &&
        keywords.some((keyword) => handler.includes(normalise(keyword)))
      );
    })
    .map((element) => candidate(element, 'dataLayer', accessibleName(element)));
}

/** Visible text on something clickable. The loosest signal, and scored accordingly. */
function byText(document: Document, intent: ActionIntent): ActionCandidate[] {
  return [...document.querySelectorAll(CLICKABLE)]
    .filter((element) => matchesIntent(element.textContent ?? '', intent))
    .map((element) => candidate(element, 'text', element.textContent ?? ''));
}

/**
 * JSON-LD describes the page, not its buttons, so it cannot point at an element. It is used as
 * corroboration for `product`: a page declaring a Product is a product page.
 */
function byJsonLd(document: Document, intent: ActionIntent): ActionCandidate[] {
  if (intent !== 'product') {
    return [];
  }

  const declaresProduct = [...document.querySelectorAll('script[type="application/ld+json"]')].some(
    // normalise() strips punctuation, so the needle must be stripped too.
    (script) => normalise(script.textContent ?? '').includes('typeproduct'),
  );

  if (!declaresProduct) {
    return [];
  }

  const body = document.body;
  return body === null ? [] : [candidate(body, 'jsonLd', 'product page (JSON-LD)')];
}

function matchesIntent(text: string, intent: ActionIntent): boolean {
  const haystack = normalise(text);
  if (haystack === '') {
    return false;
  }
  return INTENT_KEYWORDS[intent].some((keyword) => haystack.includes(normalise(keyword)));
}

/** aria-label wins, then the element's own text, then value/title. */
function accessibleName(element: Element): string {
  const aria = element.getAttribute('aria-label');
  if (aria !== null && aria.trim() !== '') {
    return aria;
  }

  const text = element.textContent ?? '';
  if (text.trim() !== '') {
    return text;
  }

  return element.getAttribute('value') ?? element.getAttribute('title') ?? '';
}

/** Case, punctuation and spacing are noise when matching human labels. */
function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
