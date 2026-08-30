import type { SheetGrid } from './types';

/**
 * Pads every row to the width of the widest row, so a column index taken from detection
 * is always safe to read regardless of trailing empty cells in the source file.
 */
export function padRows(rows: readonly (readonly string[])[]): SheetGrid {
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);

  return rows.map((row) => {
    const padded = [...row];
    while (padded.length < width) {
      padded.push('');
    }
    return padded;
  });
}

/** True when every cell in the row is blank once trimmed. */
export function isBlankRow(row: readonly string[]): boolean {
  return row.every((cell) => cell.trim() === '');
}
