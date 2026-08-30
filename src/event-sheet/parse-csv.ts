import { padRows } from './grid';
import type { SheetGrid } from './types';

/**
 * RFC 4180 CSV. Double quotes escape the delimiter and newlines; "" is a literal quote.
 * Accepts CRLF, LF and CR endings, and strips a leading BOM.
 *
 * Rows are padded to the widest row so a column index from detection is always safe to read.
 */
export function parseCsv(text: string): SheetGrid {
  const source = text.startsWith('﻿') ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source.charAt(i);

    if (inQuotes) {
      if (char !== '"') {
        field += char;
      } else if (source.charAt(i + 1) === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = false;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source.charAt(i + 1) === '\n') {
        i += 1;
      }
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
    } else {
      field += char;
    }
  }

  // A file not ending in a newline still has a final row pending.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return padRows(rows);
}
