import { isSpecial, type TransferableValue } from '../shared/payload';

export type PathSegment =
  | { readonly kind: 'key'; readonly key: string }
  | { readonly kind: 'index'; readonly index: number };

export type PathLookup =
  | { readonly kind: 'found'; readonly value: TransferableValue }
  | { readonly kind: 'missing' };

/**
 * Splits `items[0].price` into its segments.
 *
 * Total by construction: anything it cannot interpret stays part of the key, so a malformed
 * path in the Event Sheet reports as a missing field rather than throwing mid-validation.
 */
export function parsePath(path: string): readonly PathSegment[] {
  const segments: PathSegment[] = [];
  let key = '';

  const flushKey = (): void => {
    if (key !== '') {
      segments.push({ kind: 'key', key });
      key = '';
    }
  };

  for (let index = 0; index < path.length; index += 1) {
    const char = path.charAt(index);

    if (char === '.') {
      flushKey();
      continue;
    }

    if (char === '[') {
      const close = path.indexOf(']', index);
      const inner = close === -1 ? '' : path.slice(index + 1, close);

      if (close !== -1 && /^\d+$/.test(inner)) {
        flushKey();
        segments.push({ kind: 'index', index: Number(inner) });
        index = close;
        continue;
      }
    }

    key += char;
  }

  flushKey();
  return segments;
}

/**
 * Reads a path out of a captured payload.
 *
 * `missing` means the key or index is genuinely absent. A key that is present but holds null
 * or a tagged special value is `found` — telling those apart is the whole point.
 */
export function readPath(source: TransferableValue, path: string): PathLookup {
  let current: TransferableValue = source;

  for (const segment of parsePath(path)) {
    if (current === null || typeof current !== 'object' || isSpecial(current)) {
      return { kind: 'missing' };
    }

    if (segment.kind === 'index') {
      if (!Array.isArray(current) || segment.index >= current.length) {
        return { kind: 'missing' };
      }
      current = current[segment.index] as TransferableValue;
      continue;
    }

    if (Array.isArray(current)) {
      return { kind: 'missing' };
    }

    const record = current as Record<string, TransferableValue>;
    const key = keyIn(record, segment.key);
    if (key === undefined) {
      return { kind: 'missing' };
    }
    current = record[key] as TransferableValue;
  }

  return { kind: 'found', value: current };
}

/**
 * The key this record actually holds, for a key the Event Sheet asked for.
 *
 * Exact first, because that is what a correct sheet and a correct payload agree on. Failing that,
 * case is ignored: the Smartech debug log lowercases every key on its way out, so a sheet writing
 * `Product_ID` describes the same field as a payload carrying `product_id` — the difference is
 * the transport, not a defect, and reporting the field as missing would be a false finding.
 *
 * Nothing looser than case. A key that differs by punctuation or spelling is a real disagreement
 * and is reported as one.
 */
function keyIn(
  record: Record<string, TransferableValue>,
  wanted: string,
): string | undefined {
  if (Object.hasOwn(record, wanted)) {
    return wanted;
  }

  const folded = wanted.toLowerCase();
  return Object.keys(record).find((key) => key.toLowerCase() === folded);
}

/**
 * Array indices carry no meaning when comparing which paths a sheet covers: a sheet writing
 * `items[0].price` describes the same field the payload holds at `items[3].price`.
 */
export function canonicalPath(path: string): string {
  return parsePath(path)
    .map((segment) => (segment.kind === 'index' ? '[]' : segment.key))
    .join('.');
}

/** Every leaf path in a payload, in the same notation the Event Sheet uses. */
export function leafPaths(value: TransferableValue, prefix = ''): readonly string[] {
  if (value === null || typeof value !== 'object' || isSpecial(value)) {
    return prefix === '' ? [] : [prefix];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return prefix === '' ? [] : [prefix];
    }
    return value.flatMap((entry, index) => leafPaths(entry, `${prefix}[${index}]`));
  }

  const keys = Object.keys(value);
  if (keys.length === 0) {
    return prefix === '' ? [] : [prefix];
  }

  return keys.flatMap((key) =>
    leafPaths(
      (value as Record<string, TransferableValue>)[key] as TransferableValue,
      prefix === '' ? key : `${prefix}.${key}`,
    ),
  );
}
