import { describe, expect, it, vi } from 'vitest';
import {
  detectAndEnableDebug,
  SMARTECH_DEBUG_EXPRESSION,
  type EvaluationOutcome,
  type PageEvaluator,
} from './sdk';

/** Replays the given outcomes in order, repeating the last one once exhausted. */
function evaluatorReturning(...outcomes: readonly EvaluationOutcome[]): PageEvaluator {
  let index = 0;

  return {
    evaluate(): Promise<EvaluationOutcome> {
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      return Promise.resolve(outcome ?? { kind: 'value', value: 'missing' });
    },
  };
}

const MISSING: EvaluationOutcome = { kind: 'value', value: 'missing' };
const ENABLED: EvaluationOutcome = { kind: 'value', value: 'enabled' };

const noWait = (): Promise<void> => Promise.resolve();

describe('detectAndEnableDebug', () => {
  it('reports ready on the first attempt when the SDK is already present', async () => {
    const status = await detectAndEnableDebug(evaluatorReturning(ENABLED), noWait, {
      attempts: 5,
      retryDelayMs: 0,
    });

    expect(status).toEqual({ kind: 'ready', attempts: 1 });
  });

  it('keeps retrying while the SDK is still loading', async () => {
    const status = await detectAndEnableDebug(
      evaluatorReturning(MISSING, MISSING, ENABLED),
      noWait,
      { attempts: 5, retryDelayMs: 0 },
    );

    expect(status).toEqual({ kind: 'ready', attempts: 3 });
  });

  it('probes with the single detect-and-enable expression', async () => {
    const evaluate = vi.fn().mockResolvedValue(ENABLED);

    await detectAndEnableDebug({ evaluate }, noWait, { attempts: 1, retryDelayMs: 0 });

    expect(evaluate).toHaveBeenCalledWith(SMARTECH_DEBUG_EXPRESSION);
  });

  it('gives up after the configured attempts with a diagnostic', async () => {
    const status = await detectAndEnableDebug(evaluatorReturning(MISSING), noWait, {
      attempts: 3,
      retryDelayMs: 0,
    });

    expect(status.kind).toBe('absent');
    if (status.kind !== 'absent') return;
    expect(status.attempts).toBe(3);
    expect(status.diagnostic).toContain('never defined');
  });

  it('surfaces a page-thrown error in the diagnostic', async () => {
    const status = await detectAndEnableDebug(
      evaluatorReturning({ kind: 'error', message: 'smartech is not a function' }),
      noWait,
      { attempts: 2, retryDelayMs: 0 },
    );

    expect(status.kind).toBe('absent');
    if (status.kind !== 'absent') return;
    expect(status.diagnostic).toContain('smartech is not a function');
  });

  it('does not wait after the final attempt', async () => {
    const wait = vi.fn().mockResolvedValue(undefined);

    await detectAndEnableDebug(evaluatorReturning(MISSING), wait, {
      attempts: 3,
      retryDelayMs: 10,
    });

    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(10);
  });
});
