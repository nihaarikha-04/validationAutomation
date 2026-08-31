import type { EventSchema, EventSheet } from '../event-sheet/types';

export type EventMatch =
  | { readonly kind: 'matched'; readonly schema: EventSchema }
  | { readonly kind: 'unknown'; readonly eventName: string; readonly knownEvents: readonly string[] };

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
): EventMatch {
  const target = aliases.get(eventName) ?? eventName;
  const schema = sheet.events.get(target);

  if (schema === undefined) {
    return { kind: 'unknown', eventName, knownEvents: [...sheet.events.keys()] };
  }

  return { kind: 'matched', schema };
}
