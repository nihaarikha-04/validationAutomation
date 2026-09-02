import type { EventSchema, EventSheet } from '../event-sheet/types';
import { similarity, tokensOf } from './name-similarity';

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
 * Exact name match, then case, then — only if asked — close matching.
 *
 * No whitespace normalisation and no fuzzy matching by default. A tool that quietly treats
 * `Add to Cart` and `add_to_cart` as the same event hides exactly the defect it exists to find.
 * Aliases are accepted, but only ones a user supplied deliberately.
 *
 * **Case is the exception, and it is not a concession.** The Smartech debug log lowercases every
 * event name on its way out, so the case a sheet uses cannot survive the trip and a difference in
 * it is evidence of nothing. Reporting one as a naming disagreement flagged every event on a real
 * run — five out of five — and buried the disagreements that were real.
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

  // The log lowercased it. That is the transport, not the implementation, so it is a match.
  const folded = matchByCase(target, sheet);
  if (folded !== undefined) {
    return { kind: 'matched', schema: folded };
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

/**
 * The sheet event whose name differs only in case.
 *
 * Separate from close matching because it is a different claim: close matching says two spellings
 * probably mean one event, while this says the two names *are* the same name once the log's
 * lowercasing is undone.
 */
function matchByCase(eventName: string, sheet: EventSheet): EventSchema | undefined {
  const wanted = eventName.toLowerCase();

  for (const [name, schema] of sheet.events) {
    if (name.toLowerCase() === wanted) {
      return schema;
    }
  }
  return undefined;
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

  const canonicalWanted = tokensOf(eventName, SYNONYMS);

  let best: { schema: EventSchema; score: number; reason: 'formatting' | 'synonym' } | undefined;
  for (const schema of sheet.events.values()) {
    // Sheets qualify names they would otherwise repeat — `Product Viewed (Front End)` marks where
    // the event comes from, it is not part of what the site calls it. Left in, those words dilute
    // the score enough to lose to a genuinely different event: `product viewed` scored 0.67
    // against `Product Viewed (Front End)` but 0.80 against `Product List Viewed`, and was
    // validated against the wrong schema. Both spellings are tried and the better one counts.
    const written = [schema.name, ...variantsOf(schema.name)];

    // The same words punctuated differently is a weaker claim than needing a synonym, so it is
    // tried first and reported differently.
    const asWritten = Math.max(...written.map((name) => similarity(wanted, tokensOf(name))));
    const asMeant = Math.max(
      ...written.map((name) => similarity(canonicalWanted, tokensOf(name, SYNONYMS))),
    );

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

/** The name without its trailing qualifier, when it carries one worth ignoring. */
function variantsOf(name: string): readonly string[] {
  const core = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return core === '' || core === name ? [] : [core];
}
