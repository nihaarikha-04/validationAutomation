import { similarity, tokensOf } from './name-similarity';

/** Below this, two keys name different fields rather than one field spelled two ways. */
const CLOSE_ENOUGH = 0.6;

/**
 * Smartech's abbreviated payload keys, expanded to the words a sheet writes them out as.
 *
 * Token overlap alone cannot see through an abbreviation — `prid` and `product_id` share no word
 * at all and score zero. Only an explicit expansion makes them comparable, so this table holds
 * exactly the abbreviations whose meaning is established, and nothing speculative.
 */
const SMARTECH_KEYS: Readonly<Record<string, string>> = {
  prid: 'product id',
  productid: 'product id',
  prqt: 'quantity',
  qty: 'quantity',
};

export interface FieldRename {
  /** The key the payload actually carried the value under. */
  readonly foundAs: string;
  readonly similarity: number;
}

/**
 * The payload key that plainly means what the sheet asked for, when the sheet's own spelling is
 * absent.
 *
 * A renamed field is a naming defect, not a missing one: the site sent the data, under a key the
 * sheet did not predict. Reporting it as `missing` — which is what happens without this — fails
 * an event whose payload is materially correct, and buries the actual disagreement under an
 * unrelated verdict.
 *
 * `candidates` are the payload's own leaf paths that no expected field has already claimed.
 */
export function findRename(
  expectedKey: string,
  candidates: readonly string[],
): FieldRename | undefined {
  const wanted = tokensOf(expectedKey, SMARTECH_KEYS);
  if (wanted.size === 0) {
    return undefined;
  }

  let best: FieldRename | undefined;
  for (const candidate of candidates) {
    // An ancestor or descendant of the wanted path shares almost all its words and would score
    // highly, but `product.category` is not a renaming of `product.category.id` — it is the
    // object the key is missing from.
    if (encloses(candidate, expectedKey) || encloses(expectedKey, candidate)) {
      continue;
    }

    const score = similarity(wanted, tokensOf(candidate, SMARTECH_KEYS));
    if (score < CLOSE_ENOUGH) {
      continue;
    }
    if (best === undefined || score > best.similarity) {
      best = { foundAs: candidate, similarity: score };
    }
  }

  return best;
}

/** Whether `outer` is the path of an object that `inner` sits inside. */
function encloses(outer: string, inner: string): boolean {
  return inner.startsWith(`${outer}.`);
}
