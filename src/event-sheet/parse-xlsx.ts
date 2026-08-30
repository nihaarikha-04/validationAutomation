import readXlsxFile from 'read-excel-file/browser';
import { EventSheetError } from './errors';
import { padRows } from './grid';
import type { SheetGrid } from './types';

export interface Worksheet {
  readonly name: string;
  readonly grid: SheetGrid;
}

/**
 * Reads every worksheet in an uploaded workbook.
 *
 * read-excel-file@9 returns `[{ sheet, data }, ...]` for the whole workbook even when a
 * `sheet` option is passed, and its published types disagree with that. The shape is
 * therefore checked at runtime here rather than asserted — an Event Sheet is untrusted
 * input and a library upgrade changing this should fail loudly, not corrupt the parse.
 */
export async function readWorkbook(file: Blob): Promise<readonly Worksheet[]> {
  const result: unknown = await readXlsxFile(file);

  if (!Array.isArray(result) || result.length === 0) {
    throw new EventSheetError('The workbook contains no worksheets.');
  }

  return result.map(toWorksheet);
}

function toWorksheet(entry: unknown, index: number): Worksheet {
  if (typeof entry !== 'object' || entry === null) {
    throw new EventSheetError(`Worksheet ${index + 1} could not be read.`);
  }

  const { sheet, data } = entry as { sheet?: unknown; data?: unknown };

  if (!Array.isArray(data)) {
    throw new EventSheetError(`Worksheet ${index + 1} has no readable rows.`);
  }

  const rows = data.map((row) =>
    Array.isArray(row) ? row.map(toCellText) : [],
  );

  return {
    name: typeof sheet === 'string' && sheet !== '' ? sheet : `Sheet${index + 1}`,
    grid: padRows(rows),
  };
}

/** Every cell becomes text; typing of attribute values is the normaliser's job, not the reader's. */
function toCellText(cell: unknown): string {
  if (cell === null || cell === undefined) {
    return '';
  }
  if (cell instanceof Date) {
    return cell.toISOString();
  }
  if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') {
    return String(cell);
  }
  return '';
}
