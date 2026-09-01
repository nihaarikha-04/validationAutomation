import type { RunReport } from './types';

const HEADER = [
  'Event',
  'Fired as',
  'Event status',
  'Field',
  'Required',
  'Expected type',
  'Actual type',
  'Field status',
  'Value',
] as const;

/**
 * The report as one flat table: a row per checked field, and a single row for events that never
 * fired.
 *
 * Flat rather than nested because CSV has no nesting, and a spreadsheet user's first move is to
 * filter the Event or Field status column. Repeating the event name on every row is what makes
 * that work.
 */
export function toCsv(report: RunReport): string {
  const rows: string[][] = [[...HEADER]];

  for (const event of report.events) {
    const firedAs = event.firedAs ?? '';

    if (event.result === undefined) {
      rows.push([event.eventName, firedAs, event.status, '', '', '', '', '', '']);
      continue;
    }

    for (const field of event.result.fields) {
      rows.push([
        event.eventName,
        firedAs,
        event.status,
        field.path,
        field.required ? 'yes' : 'no',
        field.expectedType,
        field.actualType,
        field.status,
        renderValue(field.value),
      ]);
    }

    // Extra keys are part of the record even when policy ignores them for the verdict; a reader
    // filtering for surprises in the payload should find them here.
    for (const path of event.result.extra) {
      rows.push([event.eventName, firedAs, event.status, path, 'no', '', '', 'extra', '']);
    }
  }

  for (const name of report.undocumented) {
    rows.push([name, name, 'UNDOCUMENTED', '', '', '', '', '', '']);
  }

  return rows.map((row) => row.map(escape).join(',')).join('\r\n');
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
