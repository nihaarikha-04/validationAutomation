/**
 * Comparing two names that may be spellings of the same thing.
 *
 * Shared by event matching and payload-key matching, which ask the same question of different
 * vocabularies: one knows that `login` and `Sign in` are one event, the other that `prid` and
 * `product_id` are one field. The comparison is identical; only the synonym table differs, so
 * each caller supplies its own.
 */

/**
 * The words in a name, with punctuation, case and camelCase humps reduced away.
 *
 * A synonym maps to the *phrase* it stands for, not a single token, so a table may collapse an
 * abbreviation into several words — `prid` into `product id` — and still compare cleanly.
 */
export function tokensOf(
  name: string,
  synonyms: Readonly<Record<string, string>> = {},
): ReadonlySet<string> {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token !== '');

  return new Set(words.flatMap((word) => (synonyms[word] ?? word).split(' ')));
}

/** Dice coefficient over the words: 1 when the names use exactly the same words. */
export function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
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
