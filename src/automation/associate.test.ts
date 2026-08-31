import { describe, expect, it } from 'vitest';
import type { CapturedPayload } from '../shared/payload';
import { associatePayload, type AssociationWindow } from './associate';

const START = 1_000_000;

function payload(id: string, at: number, eventName: string): CapturedPayload {
  return { id, at, eventName, args: [], raw: '[]', origin: 'intercepted' };
}

const WINDOW: AssociationWindow = {
  testId: 'run-1',
  startedAt: START,
  expectedEvent: 'add_to_cart',
  windowMs: 5_000,
};

describe('associatePayload', () => {
  it('matches the event the run was waiting for', () => {
    const association = associatePayload([payload('a', START + 100, 'add_to_cart')], WINDOW);

    expect(association.kind).toBe('matched');
    if (association.kind !== 'matched') return;
    expect(association.payload.id).toBe('a');
    expect(association.testId).toBe('run-1');
  });

  it('ignores a co-occurring event of a different name', () => {
    // The failure this exists to prevent: page_view firing alongside add_to_cart.
    const association = associatePayload(
      [payload('pv', START + 10, 'page_view'), payload('atc', START + 20, 'add_to_cart')],
      WINDOW,
    );

    expect(association.kind).toBe('matched');
    if (association.kind !== 'matched') return;
    expect(association.payload.id).toBe('atc');
  });

  it('ignores a payload captured before the click', () => {
    const association = associatePayload([payload('old', START - 1, 'add_to_cart')], WINDOW);

    expect(association).toEqual({ kind: 'none', testId: 'run-1', considered: 0 });
  });

  it('ignores a payload captured after the window closes', () => {
    const association = associatePayload([payload('late', START + 5_001, 'add_to_cart')], WINDOW);

    expect(association.kind).toBe('none');
  });

  it('takes the earliest match and reports the rest as duplicates', () => {
    const association = associatePayload(
      [payload('second', START + 200, 'add_to_cart'), payload('first', START + 100, 'add_to_cart')],
      WINDOW,
    );

    expect(association.kind).toBe('matched');
    if (association.kind !== 'matched') return;
    expect(association.payload.id).toBe('first');
    // A double-fire is a real defect, so it is surfaced rather than dropped.
    expect(association.duplicates.map((entry) => entry.id)).toEqual(['second']);
  });

  it('reports how many payloads it considered when nothing matched', () => {
    const association = associatePayload(
      [payload('pv', START + 10, 'page_view'), payload('id', START + 20, 'identify')],
      WINDOW,
    );

    expect(association).toEqual({ kind: 'none', testId: 'run-1', considered: 2 });
  });

  it('does not match on a near-miss name', () => {
    const association = associatePayload([payload('a', START + 10, 'Add to Cart')], WINDOW);

    expect(association.kind).toBe('none');
  });
});
