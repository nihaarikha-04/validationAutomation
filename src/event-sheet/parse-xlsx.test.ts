import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readWorkbook } from './parse-xlsx';

const FIXTURE = resolve(import.meta.dirname, '../../tests/fixtures/sample-event-sheet.xlsx');

async function loadFixture(): Promise<Blob> {
  return new Blob([await readFile(FIXTURE)]);
}

describe('readWorkbook', () => {
  it('reads the worksheet and its name', async () => {
    const worksheets = await readWorkbook(await loadFixture());

    expect(worksheets).toHaveLength(1);
    expect(worksheets[0]?.name).toBe('Events');
  });

  it('returns every row including the junk title and blank rows', async () => {
    const [sheet] = await readWorkbook(await loadFixture());

    expect(sheet?.grid).toHaveLength(8);
    expect(sheet?.grid[0]?.[0]).toBe('Acme Event Tracking Spec v3');
    expect(sheet?.grid[2]).toEqual([
      'Event Name',
      'Payload',
      'Payload Data Type',
      'Attribute',
      'Attribute Data Type',
      'Mandatory',
      'Description',
      'Example Value',
    ]);
  });

  it('renders empty cells as empty strings, not null', async () => {
    const [sheet] = await readWorkbook(await loadFixture());

    expect(sheet?.grid[4]?.[0]).toBe('');
    expect(sheet?.grid[4]?.[1]).toBe('price');
  });

  it('pads every row to the same width', async () => {
    const [sheet] = await readWorkbook(await loadFixture());
    const widths = new Set(sheet?.grid.map((row) => row.length));

    expect(widths).toEqual(new Set([8]));
  });
});
