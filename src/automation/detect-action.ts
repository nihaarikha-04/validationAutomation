import { selectorFor } from './selector';
import {
  STRATEGY_CONFIDENCE,
  type ActionCandidate,
  type ActionIntent,
  type ActionTarget,
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
  target: ActionTarget,
): readonly ActionCandidate[] {
  // Every token present is the honest reading of an event name, so try that first.
  const strict = collect(document, target, matchesAll(target), 1);
  if (strict.length > 0) {
    return rank(strict);
  }

  // Nothing matched fully. Fall back to the single most distinctive word — "Searched" finding a
  // "Search" box is better than finding nothing — but at reduced confidence, so it asks first.
  const distinctive = mostDistinctive(target);
  if (distinctive === undefined) {
    return [];
  }
  return rank(collect(document, target, (text) => hasToken(wordsOf(text), distinctive), 0.6));
}

type Matcher = (text: string) => boolean;

function collect(
  document: Document,
  target: ActionTarget,
  matches: Matcher,
  scale: number,
): ActionCandidate[] {
  return [
    ...byDataAttribute(document, matches, scale),
    ...bySemantics(document, matches, scale),
    ...byAria(document, matches, scale),
    ...byDataLayer(document, matches, scale),
    ...byText(document, matches, scale),
    ...byJsonLd(document, target, scale),
  ];
}

/**
 * A curated intent matches any of its synonym phrases. A name-derived target must match *every*
 * word it carries — matching any one word made the event "Zolo_Searched" match a link labelled
 * "ZOLO SCHOLAR", because the brand name appears on nearly every element of that site.
 */
function matchesAll(target: ActionTarget): Matcher {
  if (target.kind === 'intent') {
    const phrases = INTENT_KEYWORDS[target.intent];
    return (text) => {
      const haystack = normalise(text);
      return haystack !== '' && phrases.some((phrase) => haystack.includes(normalise(phrase)));
    };
  }

  return (text) => {
    const words = wordsOf(text);
    return words.length > 0 && target.keywords.every((token) => hasToken(words, token));
  };
}

/** The longest word in the target, and only if it is long enough to mean something on its own. */
function mostDistinctive(target: ActionTarget): string | undefined {
  if (target.kind === 'intent') {
    return undefined;
  }
  const longest = [...target.keywords].sort((a, b) => b.length - a.length)[0];
  // "zolo" is four letters and matches half a site; "search" and "signup" identify a control.
  return longest !== undefined && longest.length >= 5 ? longest : undefined;
}

function wordsOf(text: string): readonly string[] {
  return normalise(text).trim().split(' ').filter((word) => word !== '');
}

/**
 * Whether a word appears, allowing for the endings English puts on it: an event called
 * "Searched" has to find a button labelled "Search", and "Registration" a "Register" link.
 */
function hasToken(words: readonly string[], token: string): boolean {
  const wanted = stem(token);
  if (wanted === '') {
    return false;
  }

  return words.some((word) => {
    const candidateStem = stem(word);
    if (candidateStem === wanted) {
      return true;
    }
    // Prefix matching only where the shared start is long enough to be meaningful, which keeps
    // "regist" matching "register" without letting "zolo" match "zolostays".
    const shorter = candidateStem.length < wanted.length ? candidateStem : wanted;
    const longer = candidateStem.length < wanted.length ? wanted : candidateStem;
    return shorter.length >= 6 && longer.startsWith(shorter);
  });
}

function stem(word: string): string {
  return word.replace(/(ations?|ions?|ings?|ed|es|s)$/, '');
}

/**
 * Words that describe the *event* rather than the action behind it. No button is ever labelled
 * "completed", so keeping these would only ever cost matches.
 */
const REPORTING_WORDS = new Set([
  'event', 'events', 'success', 'successful', 'completed', 'complete', 'done',
  'viewed', 'clicked', 'triggered', 'fired', 'tracked', 'page',
]);

/** Compound words that appear split on real buttons. */
const SPLITS: Readonly<Record<string, string>> = {
  signup: 'sign up',
  signin: 'sign in',
  signout: 'sign out',
  login: 'log in',
  logout: 'log out',
  checkout: 'check out',
  wishlist: 'wish list',
  addtocart: 'add to cart',
};

/**
 * The words worth searching a page for, given an event's name.
 *
 * `Schedule_visit` becomes ["schedule", "visit"] — separate words, because a page writes
 * "Schedule a visit" and requiring them to be adjacent would miss it.
 */
export function keywordsFromEventName(eventName: string): readonly string[] {
  const tokens = eventName
    // Split camelCase before lowercasing, or there is no case left to split on.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token !== '' && !REPORTING_WORDS.has(token));

  // Individual words, because a page writes "Schedule a visit" where the sheet says
  // "Schedule_visit" — requiring the words to sit next to each other would miss it.
  return [...new Set(tokens.flatMap((token) => (SPLITS[token] ?? token).split(' ')))];
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
  scale: number,
): ActionCandidate {
  return {
    selector: selectorFor(element),
    label: label.trim() === '' ? element.nodeName.toLowerCase() : label.trim(),
    strategy,
    confidence: STRATEGY_CONFIDENCE[strategy] * scale,
  };
}

/** `data-add-to-cart`, `data-action="add-to-cart"`, `data-testid="add-to-cart"` and friends. */
function byDataAttribute(document: Document, matches: Matcher, scale: number): ActionCandidate[] {
  const results: ActionCandidate[] = [];

  for (const element of document.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      if (!attribute.name.startsWith('data-')) {
        continue;
      }

      if (matches(`${attribute.name} ${attribute.value}`)) {
        results.push(candidate(element, 'dataAttribute', accessibleName(element), scale));
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
function bySemantics(document: Document, matches: Matcher, scale: number): ActionCandidate[] {
  return [...document.querySelectorAll(SEMANTIC_CONTROLS)]
    .filter((element) => matches(accessibleName(element)))
    .map((element) => candidate(element, 'semantic', accessibleName(element), scale));
}

function byAria(document: Document, matches: Matcher, scale: number): ActionCandidate[] {
  return [...document.querySelectorAll('[aria-label]')]
    .filter((element) => matches(element.getAttribute('aria-label') ?? ''))
    .map((element) => candidate(element, 'aria', element.getAttribute('aria-label') ?? '', scale));
}

/**
 * Elements whose inline handler pushes to a tag-manager dataLayer for this action. Weak on its
 * own, but it is direct evidence that clicking fires analytics.
 */
function byDataLayer(document: Document, matches: Matcher, scale: number): ActionCandidate[] {
  return [...document.querySelectorAll('[onclick]')]
    .filter((element) => {
      const handler = element.getAttribute('onclick') ?? '';
      const normalised = normalise(handler);
      return (
        (normalised.includes(' datalayer ') || normalised.includes(' gtag ')) && matches(handler)
      );
    })
    .map((element) => candidate(element, 'dataLayer', accessibleName(element), scale));
}

/** Visible text on something clickable. The loosest signal, and scored accordingly. */
function byText(document: Document, matches: Matcher, scale: number): ActionCandidate[] {
  return [...document.querySelectorAll(CLICKABLE)]
    .filter((element) => matches(element.textContent ?? ''))
    .map((element) => candidate(element, 'text', element.textContent ?? '', scale));
}

/**
 * JSON-LD describes the page, not its buttons, so it cannot point at an element. It is used as
 * corroboration for `product`: a page declaring a Product is a product page.
 */
function byJsonLd(document: Document, target: ActionTarget, scale: number): ActionCandidate[] {
  if (target.kind !== 'intent' || target.intent !== 'product') {
    return [];
  }

  const declaresProduct = [...document.querySelectorAll('script[type="application/ld+json"]')].some(
    // normalise() turns punctuation into spaces, so "@type":"Product" reads as "type product".
    (script) => normalise(script.textContent ?? '').includes(' type product '),
  );

  if (!declaresProduct) {
    return [];
  }

  const body = document.body;
  return body === null ? [] : [candidate(body, 'jsonLd', 'product page (JSON-LD)', scale)];
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

/**
 * Reduces a label to space-separated words, padded so `includes` compares whole words.
 *
 * Punctuation becomes a space rather than being deleted. Deleting it made "zolo" match
 * "zolostays-social-insta-feeds", so a brand name in an event title matched every element on
 * the site — the padding is what stops a token matching the middle of a longer word.
 */
function normalise(value: string): string {
  const words = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return words === '' ? '' : ` ${words} `;
}
