import type { DataType, EventSchema } from '../event-sheet/types';
import { isSpecial, type TransferableValue } from '../shared/payload';
import { canonicalPath, leafPaths, readPath, type PathLookup } from './path';
import {
  DEFAULT_VALIDATION_OPTIONS,
  type FieldResult,
  type FieldStatus,
  type TypeMismatch,
  type ValidationOptions,
  type ValidationResult,
  type ValidationStatus,
} from './types';

/**
 * Checks one captured payload against one event's schema.
 *
 * Takes a plain object rather than a CapturedPayload, so Phase 7 can feed it decoded network
 * attributes without the engine knowing where they came from. The timestamp is passed in for
 * the same reason: nothing here reads a clock.
 *
 * Only the payload side of each field is checked. Rows describing solely a network attribute
 * belong to the channel Phase 7 validates and are skipped here.
 */
export function validateEvent(
  payload: TransferableValue,
  schema: EventSchema,
  timestamp: number,
  options: ValidationOptions = DEFAULT_VALIDATION_OPTIONS,
): ValidationResult {
  const expected = schema.fields.filter((field) => field.payloadName !== '');

  const fields: FieldResult[] = expected.map((field) => {
    const lookup = readPath(payload, field.payloadName);
    const { status, actualType, value } = classify(lookup, field.payloadType);

    return {
      path: field.payloadName,
      status,
      required: field.required,
      expectedType: field.payloadType,
      actualType,
      value,
    };
  });

  const pathsWithStatus = (wanted: FieldStatus): readonly string[] =>
    fields.filter((field) => field.status === wanted).map((field) => field.path);

  const typeMismatches: TypeMismatch[] = fields
    .filter((field) => field.status === 'type-mismatch')
    .map((field) => ({
      path: field.path,
      expected: field.expectedType,
      actual: field.actualType,
    }));

  const extra = findExtraPaths(payload, expected.map((field) => field.payloadName));

  return {
    status: decideStatus(fields, typeMismatches, extra, options),
    eventName: schema.name,
    // A key explicitly set to undefined never reaches the server, so it counts as missing here
    // even though the itemised result keeps the distinction visible.
    missing: [...pathsWithStatus('missing'), ...pathsWithStatus('undefined')],
    extra,
    nullValues: pathsWithStatus('null'),
    emptyValues: pathsWithStatus('empty'),
    typeMismatches,
    fields,
    raw: payload,
    timestamp,
  };
}

/**
 * A required field that is absent, blank or the wrong type fails the event. A type mismatch
 * fails it whether or not the field was required — the site sent something, and it sent the
 * wrong shape.
 *
 * An absent *optional* field is normal and says nothing. An optional field that is present but
 * null or empty is suspicious rather than wrong, so it warns.
 */
function decideStatus(
  fields: readonly FieldResult[],
  typeMismatches: readonly TypeMismatch[],
  extra: readonly string[],
  options: ValidationOptions,
): ValidationStatus {
  const requiredFailure = fields.some(
    (field) => field.required && field.status !== 'ok' && field.status !== 'unverifiable',
  );

  if (requiredFailure || typeMismatches.length > 0) {
    return 'FAIL';
  }

  // Nothing the sheet describes is present. Reached only when the sheet marks every field
  // optional — the rules above would have failed it otherwise — and passing it would be a green
  // verdict on a payload where not one expected field was found. Observed live: a sheet with no
  // mandatory column plus a payload read at the wrong nesting level produced five such passes,
  // each reporting every field missing. Absence of evidence is not a pass.
  if (fields.length > 0 && fields.every((field) => field.status === 'missing')) {
    return 'FAIL';
  }
  if (options.extraFields === 'fail' && extra.length > 0) {
    return 'FAIL';
  }

  const blankOptional = fields.some(
    (field) => !field.required && (field.status === 'null' || field.status === 'empty'),
  );
  const unverifiable = fields.some((field) => field.status === 'unverifiable');
  const extraWarning = options.extraFields === 'warn' && extra.length > 0;

  return blankOptional || unverifiable || extraWarning ? 'WARNING' : 'PASS';
}

function classify(
  lookup: PathLookup,
  expectedType: DataType,
): { status: FieldStatus; actualType: string; value: TransferableValue | undefined } {
  if (lookup.kind === 'missing') {
    return { status: 'missing', actualType: 'absent', value: undefined };
  }

  const value = lookup.value;

  if (isSpecial(value)) {
    if (value.__special === 'undefined') {
      return { status: 'undefined', actualType: 'undefined', value };
    }
    if (value.__special === 'circular' || value.__special === 'unserialisable') {
      return { status: 'unverifiable', actualType: describeType(value), value };
    }
    return { status: 'type-mismatch', actualType: describeType(value), value };
  }

  if (value === null) {
    return { status: 'null', actualType: 'null', value };
  }
  if (isEmpty(value)) {
    return { status: 'empty', actualType: describeType(value), value };
  }
  if (!matchesType(value, expectedType)) {
    return { status: 'type-mismatch', actualType: describeType(value), value };
  }

  return { status: 'ok', actualType: describeType(value), value };
}

/** Present, but carrying nothing. */
function isEmpty(value: TransferableValue): boolean {
  if (typeof value === 'string') {
    return value.trim() === '';
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === 'object' && value !== null) {
    return Object.keys(value).length === 0;
  }
  return false;
}

function matchesType(value: TransferableValue, expected: DataType): boolean {
  switch (expected) {
    case 'unknown':
      // The sheet did not say, so nothing can contradict it.
      return true;
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'date':
      // Dates survive capture as ISO strings; epoch numbers are accepted too.
      return typeof value === 'number'
        ? Number.isFinite(value)
        : typeof value === 'string' && !Number.isNaN(Date.parse(value));
  }
}

function describeType(value: TransferableValue): string {
  if (value === null) {
    return 'null';
  }
  if (isSpecial(value)) {
    return value.__special;
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/**
 * Payload paths the sheet does not describe.
 *
 * A leaf counts as covered when the sheet names it or any of its ancestors — a sheet declaring
 * `product` as an object vouches for everything inside it. Array indices are ignored in the
 * comparison, so a sheet writing `items[0].price` covers `items[3].price` too.
 */
function findExtraPaths(
  payload: TransferableValue,
  expectedPaths: readonly string[],
): readonly string[] {
  const covered = new Set(expectedPaths.map(canonicalPath));

  return leafPaths(payload).filter((leaf) => {
    const segments = canonicalPath(leaf).split('.');

    for (let length = segments.length; length > 0; length -= 1) {
      if (covered.has(segments.slice(0, length).join('.'))) {
        return false;
      }
    }
    return true;
  });
}
