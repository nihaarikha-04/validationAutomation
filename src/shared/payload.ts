/** Marks our traffic so a page's own messages are never mistaken for ours. */
export const CAPTURE_MARKER = 'smartech-validator/payload';

/**
 * Page → extension handoff runs over a private DOM event, not `window.postMessage`.
 *
 * postMessage is a shared channel: every listener on the page receives it. Live sites do
 * override `postMessage` and do reject unexpected messages — one threw "Invalid Origin" at us
 * — and since we inject everywhere, that is noise we create on pages we have no business
 * touching. A custom event on `document` is addressed to nobody but our own bridge.
 */
export const CAPTURE_EVENT = 'smartech-validator:payload';

/**
 * Values that survive the page → extension hop.
 *
 * Special JS values are tagged rather than dropped, because Phase 3 has to tell `null`,
 * `undefined` and "key absent" apart — JSON alone collapses two of those into nothing.
 */
export type SpecialTag = 'undefined' | 'function' | 'symbol' | 'bigint' | 'circular' | 'unserialisable';

export interface Special {
  readonly __special: SpecialTag;
  readonly detail?: string;
}

export type TransferableValue =
  | string
  | number
  | boolean
  | null
  | Special
  | readonly TransferableValue[]
  | { readonly [key: string]: TransferableValue };

export type PayloadOrigin = 'intercepted' | 'pasted';

export interface CapturedPayload {
  readonly id: string;
  /** Epoch milliseconds, stamped in the page at call time. */
  readonly at: number;
  /** The arguments `smartech(...)` was called with, in order. */
  readonly args: readonly TransferableValue[];
  /** JSON text of `args` exactly as captured — the unmodified record. */
  readonly raw: string;
  readonly origin: PayloadOrigin;
  /** Parsed out of the debug line when it names one, e.g. "Firing EVT: 'Add to Cart'". */
  readonly eventName?: string;
}

export interface CaptureMessage {
  readonly marker: typeof CAPTURE_MARKER;
  readonly payload: CapturedPayload;
}

/**
 * Bounds on what we will walk. A payload carrying a DOM node or a deep object graph would
 * otherwise expand into a structure that `postMessage` cannot clone, and the whole capture is
 * lost — which is exactly what happened on a real site.
 */
const MAX_DEPTH = 12;
const MAX_KEYS = 200;
const MAX_ITEMS = 500;

/** DOM nodes, Window and friends are enormous and never the payload; tag, never traverse. */
function describeHostObject(value: object): Special | undefined {
  if (value === globalThis) {
    return { __special: 'unserialisable', detail: 'window' };
  }

  const candidate = value as { nodeType?: unknown; nodeName?: unknown };
  if (typeof candidate.nodeType === 'number' && typeof candidate.nodeName === 'string') {
    return { __special: 'unserialisable', detail: `<${candidate.nodeName.toLowerCase()}>` };
  }

  return undefined;
}

export function isSpecial(value: TransferableValue): value is Special {
  return typeof value === 'object' && value !== null && '__special' in value;
}

/**
 * Converts an arbitrary page value into something structured-cloneable and JSON-safe,
 * without touching the original — the site's own object must not be mutated.
 *
 * Cycles, functions and symbols become tags rather than throwing, so one awkward field
 * never costs us the whole payload.
 */
export function toTransferable(
  value: unknown,
  seen: Set<object> = new Set(),
  depth = 0,
): TransferableValue {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : { __special: 'unserialisable', detail: String(value) };
    case 'undefined':
      return { __special: 'undefined' };
    case 'function':
      return { __special: 'function', detail: value.name === '' ? 'anonymous' : value.name };
    case 'symbol':
      return { __special: 'symbol', detail: value.toString() };
    case 'bigint':
      return { __special: 'bigint', detail: value.toString() };
    default:
      break;
  }

  const object = value as object;
  if (seen.has(object)) {
    return { __special: 'circular' };
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const host = describeHostObject(object);
  if (host !== undefined) {
    return host;
  }

  if (depth >= MAX_DEPTH) {
    return { __special: 'unserialisable', detail: `nested deeper than ${MAX_DEPTH} levels` };
  }

  const nested = new Set(seen);
  nested.add(object);

  if (Array.isArray(value)) {
    const items: TransferableValue[] = value
      .slice(0, MAX_ITEMS)
      .map((entry) => toTransferable(entry, nested, depth + 1));

    if (value.length > MAX_ITEMS) {
      items.push({ __special: 'unserialisable', detail: `${value.length - MAX_ITEMS} more items` });
    }
    return items;
  }

  const result: Record<string, TransferableValue> = {};
  const keys = Object.keys(object);

  for (const key of keys.slice(0, MAX_KEYS)) {
    try {
      result[key] = toTransferable((object as Record<string, unknown>)[key], nested, depth + 1);
    } catch (error) {
      // A getter on the page's object threw. Record it and keep the rest of the payload.
      result[key] = {
        __special: 'unserialisable',
        detail: error instanceof Error ? error.message : 'threw on access',
      };
    }
  }

  if (keys.length > MAX_KEYS) {
    result['__truncated'] = {
      __special: 'unserialisable',
      detail: `${keys.length - MAX_KEYS} more keys`,
    };
  }

  return result;
}

/** A live feed of captured payloads for the inspected page. */
export interface PayloadSource {
  /** Registers a listener and returns the function that unregisters it. */
  subscribe(listener: (payload: CapturedPayload) => void): () => void;
}

export function isCaptureMessage(message: unknown): message is CaptureMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }

  const candidate = message as { marker?: unknown; payload?: unknown };
  if (candidate.marker !== CAPTURE_MARKER) {
    return false;
  }

  const payload = candidate.payload as { id?: unknown; at?: unknown; args?: unknown } | undefined;
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof payload.id === 'string' &&
    typeof payload.at === 'number' &&
    Array.isArray(payload.args)
  );
}
