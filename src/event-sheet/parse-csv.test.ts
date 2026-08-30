import { describe, expect, it } from 'vitest';
import { parseCsv } from './parse-csv';

describe('parseCsv', () => {
  it('splits plain rows and columns', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps delimiters inside quoted fields', () => {
    expect(parseCsv('name,desc\nprice,"amount, in paise"')).toEqual([
      ['name', 'desc'],
      ['price', 'amount, in paise'],
    ]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('a\n"He said ""hi"""')).toEqual([['a'], ['He said "hi"']]);
  });

  it('keeps newlines inside quoted fields', () => {
    expect(parseCsv('a,b\n"line1\nline2",x')).toEqual([
      ['a', 'b'],
      ['line1\nline2', 'x'],
    ]);
  });

  it('handles CRLF endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('strips a leading BOM', () => {
    expect(parseCsv('﻿Event Name,Attribute')).toEqual([['Event Name', 'Attribute']]);
  });

  it('keeps the final row when the file does not end in a newline', () => {
    expect(parseCsv('a\nb')).toEqual([['a'], ['b']]);
  });

  it('pads short rows to the widest row', () => {
    expect(parseCsv('a,b,c\n1')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', ''],
    ]);
  });

  it('preserves empty cells rather than dropping them', () => {
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']]);
  });
});
