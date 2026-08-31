import { describe, expect, it } from 'vitest';
import type { EventSchema, EventSheet } from '../event-sheet/types';
import { matchEvent } from './match-event';

function sheetWith(...names: readonly string[]): EventSheet {
  const events = new Map<string, EventSchema>(
    names.map((name) => [name, { name, fields: [] }]),
  );
  return { events, warnings: [] };
}

describe('matchEvent', () => {
  it('matches an exact name', () => {
    const match = matchEvent('add_to_cart', sheetWith('add_to_cart', 'purchase'));

    expect(match.kind).toBe('matched');
    if (match.kind !== 'matched') return;
    expect(match.schema.name).toBe('add_to_cart');
  });

  it('reports an unmatched name with what the sheet does know', () => {
    const match = matchEvent('checkout', sheetWith('add_to_cart', 'purchase'));

    expect(match).toEqual({
      kind: 'unknown',
      eventName: 'checkout',
      knownEvents: ['add_to_cart', 'purchase'],
    });
  });

  it('does not fold case', () => {
    // Silently equating these would hide the naming defect we exist to report.
    expect(matchEvent('Add_To_Cart', sheetWith('add_to_cart')).kind).toBe('unknown');
  });

  it('does not normalise separators or whitespace', () => {
    expect(matchEvent('Add to Cart', sheetWith('add_to_cart')).kind).toBe('unknown');
    expect(matchEvent(' add_to_cart', sheetWith('add_to_cart')).kind).toBe('unknown');
  });

  it('applies an alias the user supplied', () => {
    const aliases = new Map([['Add to Cart', 'add_to_cart']]);
    const match = matchEvent('Add to Cart', sheetWith('add_to_cart'), aliases);

    expect(match.kind).toBe('matched');
    if (match.kind !== 'matched') return;
    expect(match.schema.name).toBe('add_to_cart');
  });

  it('still reports unknown when an alias points at a name the sheet lacks', () => {
    const aliases = new Map([['Add to Cart', 'nope']]);

    expect(matchEvent('Add to Cart', sheetWith('add_to_cart'), aliases).kind).toBe('unknown');
  });
});
