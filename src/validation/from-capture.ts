import type { EventSheet } from '../event-sheet/types';
import { isSpecial, type CapturedPayload, type TransferableValue } from '../shared/payload';
import { matchEvent } from './match-event';
import { DEFAULT_VALIDATION_OPTIONS, type ValidationOptions, type ValidationResult } from './types';
import { validateEvent } from './validate';

export type CaptureVerdict =
  | {
      readonly kind: 'validated';
      readonly result: ValidationResult;
      /** Set when the site's name for this event differs from the sheet's. */
      readonly firedAs: string | undefined;
      readonly matchReason: 'formatting' | 'synonym' | undefined;
    }
  | {
      readonly kind: 'unknown-event';
      readonly eventName: string;
      readonly knownEvents: readonly string[];
    }
  /** The debug line did not name an event, so there is nothing to match against. */
  | { readonly kind: 'unnamed' }
  /** The line named an event but carried no payload object to check. */
  | { readonly kind: 'no-payload' };

/**
 * Keys an envelope carries the event's own fields under.
 *
 * Ordered most specific first. `activity_params` is what Netcore's own activity API calls it, so
 * a sheet documenting that shape and a debug line using `payload` describe the same thing.
 */
const ENVELOPE_KEYS: readonly string[] = ['payload', 'activity_params', 'params', 'data'];

/**
 * The payload object inside a captured debug line.
 *
 * A line arrives as its arguments: the prefixed message, then whatever the SDK logged with it.
 * The subject is the first plain object among them — arrays and our own tagged specials are not
 * payloads.
 *
 * That object is often an **envelope** rather than the payload: Smartech logs a session record
 * (`user_key`, `sid`, `url`, `eventname`…) with the event's own fields nested one level down
 * under `payload`. Validating the envelope compares the sheet's fields against session
 * bookkeeping, so every expected field reads as missing and every real field as extra — which is
 * exactly what a live run produced before this descended.
 */
export function payloadSubject(captured: CapturedPayload): TransferableValue | undefined {
  const outer = captured.args.find(
    (argument) =>
      typeof argument === 'object' &&
      argument !== null &&
      !Array.isArray(argument) &&
      !isSpecial(argument),
  );

  return outer === undefined ? undefined : unwrapEnvelope(outer);
}

/**
 * The event's own fields, where the logged object merely wraps them.
 *
 * Only unwraps when the outer object also names the event: a payload that happens to have a
 * `data` key of its own is a payload, not an envelope, and descending into it would validate a
 * fragment. One level only — nothing observed nests further, and guessing deeper would start
 * discarding real fields.
 */
export function unwrapEnvelope(subject: TransferableValue): TransferableValue {
  if (typeof subject !== 'object' || subject === null || Array.isArray(subject)) {
    return subject;
  }

  const record = subject as Record<string, TransferableValue>;
  const namesTheEvent = Object.keys(record).some(
    (key) => NAME_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]+/g, '')),
  );
  if (!namesTheEvent) {
    return subject;
  }

  for (const key of ENVELOPE_KEYS) {
    const inner = record[key];
    if (typeof inner === 'object' && inner !== null && !Array.isArray(inner) && !isSpecial(inner)) {
      return inner;
    }
  }

  return subject;
}

/**
 * Keys an SDK names the event with, punctuation and case removed.
 *
 * The capture side's list plus `activity_name`, which is what Netcore's activity API calls it —
 * here it only decides whether an object is an envelope, so recognising one more spelling costs
 * nothing and a Netcore-shaped record is exactly what this has to see through.
 */
const NAME_KEYS = new Set(['eventname', 'evtname', 'activityname', 'event', 'evt', 'name']);

/** Joins capture to validation: name → schema, arguments → payload, then check one against the other. */
export function verdictFor(
  captured: CapturedPayload,
  sheet: EventSheet,
  aliases: ReadonlyMap<string, string> = new Map(),
  options: ValidationOptions = DEFAULT_VALIDATION_OPTIONS,
): CaptureVerdict {
  if (captured.eventName === undefined) {
    return { kind: 'unnamed' };
  }

  // Close matching is on here: an event the site calls `login` against a sheet saying `Sign in`
  // deserves a validated payload and a note about the naming, not a bare "unknown".
  const match = matchEvent(captured.eventName, sheet, aliases, true);
  if (match.kind === 'unknown') {
    return {
      kind: 'unknown-event',
      eventName: captured.eventName,
      knownEvents: match.knownEvents,
    };
  }

  const subject = payloadSubject(captured);
  if (subject === undefined) {
    return { kind: 'no-payload' };
  }

  return {
    kind: 'validated',
    result: validateEvent(subject, match.schema, captured.at, options),
    firedAs: match.kind === 'close' ? match.observed : undefined,
    matchReason: match.kind === 'close' ? match.reason : undefined,
  };
}
