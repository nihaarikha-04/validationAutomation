import type { ValidationResult } from '../validation/types';
import { isConfident, isDestructive, type ActionCandidate, type ActionIntent } from './types';

/**
 * The run's stages, following the plan's sequence:
 * IDLE → SDK/DEBUG → EVENT_SHEET_LOADED → ACTION_DETECTION → ACTION_EXECUTION →
 * WAITING_FOR_EVENT → EVENT_CAPTURED → VALIDATING → PASS/FAIL.
 *
 * Two stages the plan implies but does not name are explicit here: awaiting confirmation before
 * a low-confidence click, and awaiting confirmation before anything that spends money.
 */
export type RunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking-sdk'; readonly deadline: number }
  | { readonly kind: 'sheet-required' }
  | { readonly kind: 'detecting'; readonly deadline: number }
  | { readonly kind: 'awaiting-confirmation'; readonly candidate: ActionCandidate; readonly reason: ConfirmReason }
  | { readonly kind: 'awaiting-manual-pick' }
  | { readonly kind: 'executing'; readonly candidate: ActionCandidate; readonly deadline: number }
  | { readonly kind: 'waiting-for-event'; readonly startedAt: number; readonly deadline: number }
  | { readonly kind: 'validating' }
  | { readonly kind: 'passed'; readonly result: ValidationResult }
  | { readonly kind: 'failed'; readonly reason: string; readonly result?: ValidationResult };

export type ConfirmReason = 'low-confidence' | 'spends-money';

export type RunEvent =
  | { readonly kind: 'start'; readonly intent: ActionIntent }
  | { readonly kind: 'sdk-ready' }
  | { readonly kind: 'sdk-absent'; readonly diagnostic: string }
  | { readonly kind: 'sheet-missing' }
  | { readonly kind: 'candidates'; readonly candidates: readonly ActionCandidate[] }
  | { readonly kind: 'confirm' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'manual-pick'; readonly candidate: ActionCandidate }
  | { readonly kind: 'executed' }
  | { readonly kind: 'execution-failed'; readonly reason: string }
  | { readonly kind: 'payload-captured' }
  | { readonly kind: 'validated'; readonly result: ValidationResult }
  | { readonly kind: 'tick'; readonly now: number };

export interface RunTimeouts {
  readonly sdkMs: number;
  readonly detectMs: number;
  readonly executeMs: number;
  readonly eventMs: number;
}

export const DEFAULT_TIMEOUTS: RunTimeouts = {
  sdkMs: 5_000,
  detectMs: 5_000,
  executeMs: 5_000,
  eventMs: 10_000,
};

export interface RunContext {
  readonly intent: ActionIntent;
  readonly now: number;
  readonly timeouts: RunTimeouts;
}

/**
 * Pure transition. Every stage that can hang carries an absolute deadline, and a `tick` past it
 * fails the run rather than leaving it stuck — a test that never finishes is worse than one that
 * reports a timeout.
 */
export function advance(state: RunState, event: RunEvent, context: RunContext): RunState {
  if (event.kind === 'tick') {
    return expired(state, event.now) ? { kind: 'failed', reason: timeoutReason(state) } : state;
  }

  switch (event.kind) {
    case 'start':
      return { kind: 'checking-sdk', deadline: context.now + context.timeouts.sdkMs };

    case 'sdk-ready':
      return state.kind === 'checking-sdk'
        ? { kind: 'detecting', deadline: context.now + context.timeouts.detectMs }
        : state;

    case 'sdk-absent':
      return { kind: 'failed', reason: `Smartech was not detected: ${event.diagnostic}` };

    case 'sheet-missing':
      return { kind: 'sheet-required' };

    case 'candidates':
      return chooseCandidate(event.candidates, context);

    case 'confirm':
      return state.kind === 'awaiting-confirmation'
        ? { kind: 'executing', candidate: state.candidate, deadline: context.now + context.timeouts.executeMs }
        : state;

    case 'cancel':
      return { kind: 'failed', reason: 'Cancelled before the action ran.' };

    case 'manual-pick':
      // A human pointed at the element, so nothing is guessed and nothing needs confirming —
      // unless the action spends money, which always asks.
      return isDestructive(context.intent)
        ? { kind: 'awaiting-confirmation', candidate: event.candidate, reason: 'spends-money' }
        : { kind: 'executing', candidate: event.candidate, deadline: context.now + context.timeouts.executeMs };

    case 'executed':
      return state.kind === 'executing'
        ? { kind: 'waiting-for-event', startedAt: context.now, deadline: context.now + context.timeouts.eventMs }
        : state;

    case 'execution-failed':
      return { kind: 'failed', reason: event.reason };

    case 'payload-captured':
      return state.kind === 'waiting-for-event' ? { kind: 'validating' } : state;

    case 'validated':
      return event.result.status === 'FAIL'
        ? { kind: 'failed', reason: 'The payload did not match the Event Sheet.', result: event.result }
        : { kind: 'passed', result: event.result };
  }
}

/**
 * Nothing is clicked blindly. A weak candidate asks first, and an action that spends money asks
 * regardless of how certain detection was.
 */
function chooseCandidate(
  candidates: readonly ActionCandidate[],
  context: RunContext,
): RunState {
  const best = candidates[0];
  if (best === undefined) {
    return { kind: 'awaiting-manual-pick' };
  }

  if (isDestructive(context.intent)) {
    return { kind: 'awaiting-confirmation', candidate: best, reason: 'spends-money' };
  }
  if (!isConfident(best)) {
    return { kind: 'awaiting-confirmation', candidate: best, reason: 'low-confidence' };
  }

  return {
    kind: 'executing',
    candidate: best,
    deadline: context.now + context.timeouts.executeMs,
  };
}

/** Stages that wait on a human have no deadline; a person is allowed to take their time. */
function expired(state: RunState, now: number): boolean {
  return 'deadline' in state && now >= state.deadline;
}

function timeoutReason(state: RunState): string {
  switch (state.kind) {
    case 'checking-sdk':
      return 'Timed out waiting for the Smartech SDK.';
    case 'detecting':
      return 'Timed out looking for the element to click.';
    case 'executing':
      return 'Timed out clicking the element.';
    case 'waiting-for-event':
      return 'The action ran but no matching event was captured in time.';
    default:
      return 'Timed out.';
  }
}
