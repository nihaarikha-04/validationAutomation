import type { EventSheet } from '../event-sheet/types';
import { isSpecial, type CapturedPayload, type TransferableValue } from '../shared/payload';
import { matchEvent } from './match-event';
import { DEFAULT_VALIDATION_OPTIONS, type ValidationOptions, type ValidationResult } from './types';
import { validateEvent } from './validate';

export type CaptureVerdict =
  | { readonly kind: 'validated'; readonly result: ValidationResult }
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
 * The payload object inside a captured debug line.
 *
 * A line arrives as its arguments: the prefixed message, then whatever the SDK logged with it.
 * The subject is the first plain object among them — arrays and our own tagged specials are not
 * payloads.
 */
export function payloadSubject(captured: CapturedPayload): TransferableValue | undefined {
  return captured.args.find(
    (argument) =>
      typeof argument === 'object' &&
      argument !== null &&
      !Array.isArray(argument) &&
      !isSpecial(argument),
  );
}

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

  const match = matchEvent(captured.eventName, sheet, aliases);
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
  };
}
