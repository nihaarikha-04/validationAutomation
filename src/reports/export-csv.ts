import type { EventOutcome } from './types';
import type { FieldResult } from '../validation/types';
import type { RunReport } from './types';

/**
 * The report laid out the way an Event Sheet is: one block per event, one row per field.
 *
 * The event's own columns are written on its first row and left blank underneath, which is how
 * every real Event Sheet writes a multi-field event and what the parser already forward-fills on
 * the way in. Repeating the name on all nine rows of a payload made the export unreadable next to
 * the sheet it is meant to be compared against.
 *
 * True merged cells need a spreadsheet format; CSV has no such thing, and a blank continuation
 * cell is what a spreadsheet shows when a merge is unmerged. XLSX can merge properly once that
 * export exists.
 */
export function toCsv(report: RunReport): string {
  const rows: string[][] = [[...header(report.at)]];

  for (const event of report.events) {
    rows.push(...blockFor(event));
  }

  for (const name of report.undocumented) {
    rows.push([
      name,
      name,
      'UNDOCUMENTED',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      'Fired by the site but not described anywhere in the Event Sheet.',
    ]);
  }

  return rows.map((row) => row.map(escape).join(',')).join('\r\n');
}

/**
 * The debug-log column is dated because a report is a snapshot.
 *
 * A sheet that accumulates runs needs to say which day each column of logs came from, or two
 * rounds of testing become indistinguishable.
 */
function header(at: number): readonly string[] {
  const date = new Date(at).toISOString().slice(0, 10);

  return [
    'Event',
    'Fired as',
    'Event status',
    'Field',
    'Required',
    'Expected type',
    'Actual type',
    'Field status',
    'Value',
    `Smartech debug logs (${date})`,
    'Comments',
  ];
}

/** One event's rows: its own columns on the first, blank underneath. */
function blockFor(event: EventOutcome): string[][] {
  const log = event.result === undefined ? '' : JSON.stringify(event.result.raw, null, 2);

  if (event.result === undefined) {
    return [
      [event.eventName, event.firedAs ?? '', event.status, '', '', '', '', '', '', '', eventComment(event)],
    ];
  }

  const rows: string[][] = [];
  const lead = (): readonly string[] =>
    rows.length === 0
      ? [event.eventName, event.firedAs ?? '', event.status]
      : ['', '', ''];

  for (const field of event.result.fields) {
    rows.push([
      ...lead(),
      field.path,
      field.required ? 'yes' : 'no',
      field.expectedType,
      field.actualType,
      field.status,
      renderValue(field.value),
      // The captured payload belongs to the event, so it sits on the event's own row only.
      rows.length === 0 ? log : '',
      fieldComment(field),
    ]);
  }

  // Extra keys are part of the record even when policy ignores them for the verdict; a reader
  // filtering for surprises in the payload should find them here.
  for (const path of event.result.extra) {
    rows.push([
      ...lead(),
      path,
      'no',
      '',
      '',
      'extra',
      '',
      rows.length === 0 ? log : '',
      'Sent by the site but not described in the Event Sheet.',
    ]);
  }

  if (rows.length === 0) {
    rows.push([event.eventName, event.firedAs ?? '', event.status, '', '', '', '', '', '', log, eventComment(event)]);
  }

  return rows;
}

/** Why the event as a whole came out the way it did. */
function eventComment(event: EventOutcome): string {
  const renamed =
    event.firedAs === undefined
      ? ''
      : ` The site calls it "${event.firedAs}"; the sheet calls it "${event.eventName}".`;

  switch (event.status) {
    case 'FAIL':
      return `Event not triggered — nothing fired under this name during the run.${renamed}`;
    case 'API ONLY':
      return 'Not triggered: the sheet says this event is sent from a server, so it never reaches the browser. Check it in the Smartech panel.';
    case 'PAYMENT':
      return 'Not triggered: this event only fires when money actually moves. Trigger it by hand on a test order, or check it in the Smartech panel.';
    case 'WARNING':
      return `Fired, but see the field comments below.${renamed}`;
    default:
      return `Pass.${renamed}`;
  }
}

/** Why one field came out the way it did, in the words a tester would use in a review. */
function fieldComment(field: FieldResult): string {
  switch (field.status) {
    case 'ok':
      return 'Pass';
    case 'renamed':
      return `Renaming — the sheet says "${field.path}", the payload sends "${field.foundAs ?? 'a different key'}".`;
    case 'type-mismatch':
      return `Incorrect data type — expected ${field.expectedType}, received ${field.actualType}.`;
    case 'missing':
      return field.required
        ? 'Not sent, and the sheet marks it mandatory.'
        : 'Not sent.';
    case 'undefined':
      return 'Sent as undefined — the site set the key and the SDK dropped the value.';
    case 'null':
      return 'Sent as null.';
    case 'empty':
      return 'Sent empty.';
    case 'unverifiable':
      return 'Could not be checked — the value was clipped when it was captured.';
    default:
      return '';
  }
}

/**
 * RFC 4180 quoting.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with a tab as well: spreadsheets treat those as
 * formulas, and an Event Sheet is untrusted input that must never execute on the way through us.
 */
function escape(cell: string): string {
  const guarded = /^[=+\-@]/.test(cell) ? `\t${cell}` : cell;
  return /[",\r\n\t]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function renderValue(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}
