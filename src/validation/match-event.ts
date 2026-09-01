import type { EventSchema, EventSheet } from '../event-sheet/types';

export type EventMatch =
  | { readonly kind: 'matched'; readonly schema: EventSchema }
  /**
   * The names differ but plainly describe the same event — `Add to Cart` against `add_to_cart`.
   * Reported separately from an exact match so the naming discrepancy stays visible: the payload
   * is worth validating, *and* the sheet and the implementation disagree about the name.
   */
  | {
      readonly kind: 'close';
      readonly schema: EventSchema;
      readonly observed: string;
      readonly similarity: number;
      /**
       * `formatting` — the same words, punctuated differently (`add_to_cart` / `Add to Cart`).
       * `synonym`  — different words for the same thing (`login` / `Sign in`).
       */
      readonly reason: 'formatting' | 'synonym';
    }
  | { readonly kind: 'unknown'; readonly eventName: string; readonly knownEvents: readonly string[] };

/** Below this, two names are different events rather than two spellings of one. */
const CLOSE_ENOUGH = 0.6;

/**
 * Words the industry uses interchangeably, mapped to one spelling.
 *
 * Each maps to the *phrase* it stands for, not a single token, so `login` and `Sign in` reduce to
 * the same pair of words while `logout` stays distinct — collapsing those two would be worse than
 * not matching at all.
 */
const SYNONYMS: Readonly<Record<string, string>> = {
  login: 'sign in',
  logon: 'sign in',
  signin: 'sign in',
  authenticate: 'sign in',
  authentication: 'sign in',
  logout: 'sign out',
  signout: 'sign out',
  register: 'sign up',
  registration: 'sign up',
  registered: 'sign up',
  signup: 'sign up',
  buy: 'purchase',
  bought: 'purchase',
  order: 'purchase',
  checkout: 'purchase',
  payment: 'purchase',
  paid: 'purchase',
  transaction: 'purchase',
  bag: 'cart',
  basket: 'cart',
  delete: 'remove',
  deleted: 'remove',
  removed: 'remove',
  added: 'add',
  viewed: 'view',
  browse: 'view',
  browsed: 'view',
  visit: 'view',
  visited: 'view',
  impression: 'view',
  opened: 'view',
  searched: 'search',
  query: 'search',
  queried: 'search',
  item: 'product',
  sku: 'product',
  screen: 'page',
};

/**
 * Exact name match only.
 *
 * No case-folding, no whitespace normalisation, no fuzzy matching. A tool that quietly treats
 * `Add to Cart` and `add_to_cart` as the same event hides exactly the defect it exists to find.
 * Aliases are accepted, but only ones a user supplied deliberately.
 */
export function matchEvent(
  eventName: string,
  sheet: EventSheet,
  aliases: ReadonlyMap<string, string> = new Map(),
  allowClose = false,
): EventMatch {
  const target = aliases.get(eventName) ?? eventName;
  const schema = sheet.events.get(target);

  if (schema !== undefined) {
    return { kind: 'matched', schema };
  }

  if (allowClose) {
    const near = closest(target, sheet);
    if (near !== undefined) {
      return {
        kind: 'close',
        schema: near.schema,
        observed: eventName,
        similarity: near.score,
        reason: near.reason,
      };
    }
  }

  return { kind: 'unknown', eventName, knownEvents: [...sheet.events.keys()] };
}

/** The sheet event whose name overlaps this one most, if any overlap enough to count. */
function closest(
  eventName: string,
  sheet: EventSheet,
): { schema: EventSchema; score: number; reason: 'formatting' | 'synonym' } | undefined {
  const wanted = tokensOf(eventName);
  if (wanted.size === 0) {
    return undefined;
  }

  const canonicalWanted = tokensOf(eventName, true);

  let best: { schema: EventSchema; score: number; reason: 'formatting' | 'synonym' } | undefined;
  for (const schema of sheet.events.values()) {
    // The same words punctuated differently is a weaker claim than needing a synonym, so it is
    // tried first and reported differently.
    const asWritten = similarity(wanted, tokensOf(schema.name));
    const asMeant = similarity(canonicalWanted, tokensOf(schema.name, true));

    const score = Math.max(asWritten, asMeant);
    if (score < CLOSE_ENOUGH) {
      continue;
    }

    const reason = asWritten >= CLOSE_ENOUGH ? 'formatting' : 'synonym';
    if (best === undefined || score > best.score) {
      best = { schema, score, reason };
    }
  }
  return best;
}

function tokensOf(name: string, useSynonyms = false): ReadonlySet<string> {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token !== '');

  if (!useSynonyms) {
    return new Set(words);
  }

  return new Set(words.flatMap((word) => (SYNONYMS[word] ?? word).split(' ')));
}

/** Dice coefficient over the words: 1 when the names use exactly the same words. */
function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) {
      shared += 1;
    }
  }
  return (2 * shared) / (a.size + b.size);
}
