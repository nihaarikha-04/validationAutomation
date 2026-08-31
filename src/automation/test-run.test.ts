import { describe, expect, it } from 'vitest';
import type { ValidationResult } from '../validation/types';
import { advance, DEFAULT_TIMEOUTS, type RunContext, type RunState } from './test-run';
import { type ActionCandidate } from './types';

const NOW = 1_000_000;

function context(overrides: Partial<RunContext> = {}): RunContext {
  return { intent: 'add-to-cart', now: NOW, timeouts: DEFAULT_TIMEOUTS, ...overrides };
}

function candidate(confidence: number): ActionCandidate {
  return { selector: '#atc', label: 'Add to Cart', strategy: 'semantic', confidence };
}

function result(status: ValidationResult['status']): ValidationResult {
  return {
    status,
    eventName: 'add_to_cart',
    missing: [],
    extra: [],
    nullValues: [],
    emptyValues: [],
    typeMismatches: [],
    fields: [],
    raw: {},
    timestamp: NOW,
  };
}

const CONFIDENT = candidate(0.95);
const WEAK = candidate(0.6);

describe('advance', () => {
  it('starts by checking the SDK', () => {
    const next = advance({ kind: 'idle' }, { kind: 'start', intent: 'add-to-cart' }, context());

    expect(next.kind).toBe('checking-sdk');
  });

  it('fails outright when the SDK is absent', () => {
    const next = advance(
      { kind: 'checking-sdk', deadline: NOW + 1 },
      { kind: 'sdk-absent', diagnostic: 'never defined' },
      context(),
    );

    expect(next.kind).toBe('failed');
    if (next.kind !== 'failed') return;
    expect(next.reason).toContain('never defined');
  });

  it('stops and asks for a sheet when none is loaded', () => {
    expect(advance({ kind: 'idle' }, { kind: 'sheet-missing' }, context()).kind).toBe(
      'sheet-required',
    );
  });

  it('clicks straight away when detection is confident', () => {
    const next = advance(
      { kind: 'detecting', deadline: NOW + 1 },
      { kind: 'candidates', candidates: [CONFIDENT] },
      context(),
    );

    expect(next.kind).toBe('executing');
  });

  it('asks first when detection is weak', () => {
    const next = advance(
      { kind: 'detecting', deadline: NOW + 1 },
      { kind: 'candidates', candidates: [WEAK] },
      context(),
    );

    expect(next.kind).toBe('awaiting-confirmation');
    if (next.kind !== 'awaiting-confirmation') return;
    expect(next.reason).toBe('low-confidence');
  });

  it('always asks before an action that spends money, however confident', () => {
    const next = advance(
      { kind: 'detecting', deadline: NOW + 1 },
      { kind: 'candidates', candidates: [CONFIDENT] },
      context({ intent: 'checkout' }),
    );

    expect(next.kind).toBe('awaiting-confirmation');
    if (next.kind !== 'awaiting-confirmation') return;
    expect(next.reason).toBe('spends-money');
  });

  it('asks before a manually picked checkout too', () => {
    const next = advance(
      { kind: 'awaiting-manual-pick' },
      { kind: 'manual-pick', candidate: CONFIDENT },
      context({ intent: 'checkout' }),
    );

    expect(next.kind).toBe('awaiting-confirmation');
  });

  it('runs a manually picked element without asking for a harmless action', () => {
    const next = advance(
      { kind: 'awaiting-manual-pick' },
      { kind: 'manual-pick', candidate: WEAK },
      context(),
    );

    // A human pointed at it, so there is nothing left to guess.
    expect(next.kind).toBe('executing');
  });

  it('falls back to a manual pick when nothing was found', () => {
    const next = advance(
      { kind: 'detecting', deadline: NOW + 1 },
      { kind: 'candidates', candidates: [] },
      context(),
    );

    expect(next.kind).toBe('awaiting-manual-pick');
  });

  it('cancelling ends the run without clicking', () => {
    const next = advance(
      { kind: 'awaiting-confirmation', candidate: WEAK, reason: 'low-confidence' },
      { kind: 'cancel' },
      context(),
    );

    expect(next.kind).toBe('failed');
  });

  it('waits for an event once the click landed', () => {
    const next = advance(
      { kind: 'executing', candidate: CONFIDENT, deadline: NOW + 1 },
      { kind: 'executed' },
      context(),
    );

    expect(next.kind).toBe('waiting-for-event');
    if (next.kind !== 'waiting-for-event') return;
    expect(next.startedAt).toBe(NOW);
  });

  it('validates once a payload arrives', () => {
    const next = advance(
      { kind: 'waiting-for-event', startedAt: NOW, deadline: NOW + 1 },
      { kind: 'payload-captured' },
      context(),
    );

    expect(next.kind).toBe('validating');
  });

  it('passes on a passing verdict and fails on a failing one', () => {
    expect(advance({ kind: 'validating' }, { kind: 'validated', result: result('PASS') }, context()).kind).toBe('passed');
    expect(advance({ kind: 'validating' }, { kind: 'validated', result: result('WARNING') }, context()).kind).toBe('passed');
    expect(advance({ kind: 'validating' }, { kind: 'validated', result: result('FAIL') }, context()).kind).toBe('failed');
  });

  it('keeps the result on a failing verdict so the reason is inspectable', () => {
    const next = advance(
      { kind: 'validating' },
      { kind: 'validated', result: result('FAIL') },
      context(),
    );

    expect(next.kind).toBe('failed');
    if (next.kind !== 'failed') return;
    expect(next.result?.eventName).toBe('add_to_cart');
  });
});

describe('timeouts', () => {
  const stages: readonly RunState[] = [
    { kind: 'checking-sdk', deadline: NOW },
    { kind: 'detecting', deadline: NOW },
    { kind: 'executing', candidate: CONFIDENT, deadline: NOW },
    { kind: 'waiting-for-event', startedAt: NOW, deadline: NOW },
  ];

  it.each(stages.map((state) => [state.kind, state] as const))(
    'fails %s once its deadline passes',
    (_label, state) => {
      const next = advance(state, { kind: 'tick', now: NOW + 1 }, context());

      expect(next.kind).toBe('failed');
    },
  );

  it('says which stage timed out', () => {
    const next = advance(
      { kind: 'waiting-for-event', startedAt: NOW, deadline: NOW },
      { kind: 'tick', now: NOW + 1 },
      context(),
    );

    expect(next.kind).toBe('failed');
    if (next.kind !== 'failed') return;
    expect(next.reason).toContain('no matching event was captured');
  });

  it('leaves a stage alone before its deadline', () => {
    const state: RunState = { kind: 'detecting', deadline: NOW + 100 };

    expect(advance(state, { kind: 'tick', now: NOW }, context())).toBe(state);
  });

  it('never times out a stage that is waiting on a person', () => {
    const waiting: RunState = { kind: 'awaiting-confirmation', candidate: WEAK, reason: 'low-confidence' };

    // A human is allowed to take as long as they like.
    expect(advance(waiting, { kind: 'tick', now: NOW + 1_000_000 }, context())).toBe(waiting);
    const picking: RunState = { kind: 'awaiting-manual-pick' };
    expect(advance(picking, { kind: 'tick', now: NOW + 1_000_000 }, context())).toBe(picking);
  });
});
