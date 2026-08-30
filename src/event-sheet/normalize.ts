import { isBlankRow } from './grid';
import type {
  ColumnMapping,
  DataType,
  EventSchema,
  EventSheet,
  FieldSchema,
  SheetGrid,
} from './types';

const TRUTHY = new Set(['yes', 'y', 'true', '1', 'mandatory', 'required', 'must']);
const FALSY = new Set(['no', 'n', 'false', '0', 'optional', 'nice to have']);

const TYPE_ALIASES: Readonly<Record<string, DataType>> = {
  string: 'string', str: 'string', text: 'string', varchar: 'string', char: 'string',
  number: 'number', num: 'number', int: 'number', integer: 'number', float: 'number',
  double: 'number', decimal: 'number', long: 'number', currency: 'number',
  boolean: 'boolean', bool: 'boolean', flag: 'boolean',
  array: 'array', list: 'array', collection: 'array',
  object: 'object', json: 'object', map: 'object', dictionary: 'object', dict: 'object',
  date: 'date', datetime: 'date', timestamp: 'date', time: 'date',
};

/**
 * Turns a raw grid plus a column mapping into the internal schema.
 *
 * Each row is one logical field carrying both channel names: the payload name seen in the
 * debug log and the attribute name seen in the network call. Either may be blank when the
 * sheet documents only one channel.
 *
 * Event-name cells are forward-filled: real Event Sheets name the event once and leave the
 * cell blank for its remaining field rows. Blank separator rows do not clear the carried
 * event name, because a blank line between blocks is followed by a fresh event name anyway.
 *
 * Problems inside a readable sheet become warnings rather than throwing — the user should
 * see the events that did parse, alongside what was skipped.
 */
export function normalizeSheet(
  grid: SheetGrid,
  mapping: ColumnMapping,
  headerRow: number,
): EventSheet {
  const warnings: string[] = [];
  const fieldsByEvent = new Map<string, FieldSchema[]>();
  let currentEvent = '';

  if (mapping.required === undefined) {
    warnings.push(
      'No mandatory/required column was mapped, so every field is treated as optional.',
    );
  }
  if (mapping.payloadName === undefined) {
    warnings.push(
      'No payload column was mapped. Debug-log validation has nothing to compare against.',
    );
  }
  if (mapping.attributeName === undefined) {
    warnings.push(
      'No attribute column was mapped. Network-call validation will be unavailable.',
    );
  }

  for (let row = headerRow + 1; row < grid.length; row += 1) {
    const cells = grid[row];
    if (cells === undefined || isBlankRow(cells)) {
      continue;
    }

    const eventName = readCell(cells, mapping.eventName);
    if (eventName !== '') {
      currentEvent = eventName;
      if (!fieldsByEvent.has(currentEvent)) {
        fieldsByEvent.set(currentEvent, []);
      }
    }

    const payloadName = readCell(cells, mapping.payloadName);
    const attributeName = readCell(cells, mapping.attributeName);
    if (payloadName === '' && attributeName === '') {
      continue;
    }

    // Identity follows the payload channel when present; it is the channel the MVP validates.
    const identity = payloadName !== '' ? payloadName : attributeName;

    if (currentEvent === '') {
      warnings.push(`Row ${row + 1}: field "${identity}" has no event name above it.`);
      continue;
    }

    const fields = fieldsByEvent.get(currentEvent) ?? [];
    if (fields.some((field) => fieldIdentity(field) === identity)) {
      warnings.push(`Row ${row + 1}: "${identity}" is listed twice for ${currentEvent}.`);
      continue;
    }

    const rawPayloadType = readCell(cells, mapping.payloadType);
    const rawAttributeType = readCell(cells, mapping.attributeType);
    const payloadType = toDataType(rawPayloadType);
    const attributeType = toDataType(rawAttributeType);

    if (rawPayloadType !== '' && payloadType === 'unknown') {
      warnings.push(
        `Row ${row + 1}: unrecognised payload type "${rawPayloadType}" for ${currentEvent}.${identity}.`,
      );
    }
    if (rawAttributeType !== '' && attributeType === 'unknown') {
      warnings.push(
        `Row ${row + 1}: unrecognised attribute type "${rawAttributeType}" for ${currentEvent}.${identity}.`,
      );
    }

    const rawRequired = readCell(cells, mapping.required);
    const required = toRequired(rawRequired);
    if (rawRequired !== '' && required === undefined) {
      warnings.push(
        `Row ${row + 1}: unrecognised mandatory value "${rawRequired}" for ${currentEvent}.${identity}; treated as optional.`,
      );
    }

    fields.push({
      payloadName,
      payloadType,
      attributeName,
      attributeType,
      required: required ?? false,
      description: readCell(cells, mapping.description),
      example: readCell(cells, mapping.example),
    });
    fieldsByEvent.set(currentEvent, fields);
  }

  const events = new Map<string, EventSchema>();
  for (const [name, fields] of fieldsByEvent) {
    events.set(name, { name, fields });
  }

  return { events, warnings };
}

/** The name a field is known by: payload where the sheet gives one, attribute otherwise. */
export function fieldIdentity(field: FieldSchema): string {
  return field.payloadName !== '' ? field.payloadName : field.attributeName;
}

function readCell(cells: readonly string[], column: number | undefined): string {
  if (column === undefined) {
    return '';
  }
  return (cells[column] ?? '').trim();
}

/** Matches the whole cell first, then any single word in it, so "Array of objects" reads as an array. */
export function toDataType(raw: string): DataType {
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (normalized === '') {
    return 'unknown';
  }

  const exact = TYPE_ALIASES[normalized];
  if (exact !== undefined) {
    return exact;
  }

  for (const word of normalized.split(' ')) {
    const alias = TYPE_ALIASES[word];
    if (alias !== undefined) {
      return alias;
    }
  }

  return 'unknown';
}

/** `undefined` means the cell was present but unreadable, which the caller reports. */
export function toRequired(raw: string): boolean | undefined {
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (normalized === '') {
    return false;
  }
  if (TRUTHY.has(normalized)) {
    return true;
  }
  if (FALSY.has(normalized)) {
    return false;
  }
  return undefined;
}
