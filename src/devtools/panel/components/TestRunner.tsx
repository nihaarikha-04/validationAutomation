import { useEffect, useRef, useState } from 'react';
import { associatePayload } from '../../../automation/associate';
import type { PageDriver } from '../../../automation/commands';
import {
  advance,
  DEFAULT_TIMEOUTS,
  type RunContext,
  type RunState,
} from '../../../automation/test-run';
import {
  planFromSheet,
  runnable,
  type PlannedTest,
} from '../../../automation/event-plan';
import { isDestructive, type ActionIntent, type ActionTarget } from '../../../automation/types';
import type { EventSheet } from '../../../event-sheet/types';
import type { CapturedPayload } from '../../../shared/payload';
import { matchEvent } from '../../../validation/match-event';
import type { ValidationResult } from '../../../validation/types';
import { validateEvent } from '../../../validation/validate';
import { VerdictDetail } from './VerdictDetail';

const INTENTS: readonly ActionIntent[] = [
  'add-to-cart',
  'remove-from-cart',
  'product',
  'cart',
  'checkout',
];

const TICK_MS = 250;

export interface BatchResult {
  readonly eventName: string;
  readonly outcome: 'PASS' | 'FAIL' | 'SKIPPED' | 'NEEDS REVIEW';
  readonly detail: string | undefined;
  /** The debug log this run actually captured, when one arrived. */
  readonly payload: CapturedPayload | undefined;
  /** The per-field verdict, when the run got far enough to produce one. */
  readonly result: ValidationResult | undefined;
  /**
   * Events that fired while this run was waiting but were not the one it expected. The most
   * useful thing to know when a run reports no matching event.
   */
  readonly alsoFired: readonly string[];
}

/** What the current run is for. Set from the dropdowns, or from the queue during a batch. */
interface ActiveTest {
  readonly target: ActionTarget;
  readonly eventName: string;
}

export interface TestRunnerProps {
  readonly driver: PageDriver;
  readonly sheet: EventSheet | undefined;
  readonly payloads: readonly CapturedPayload[];
  readonly sdkReady: boolean | undefined;
  readonly sdkDiagnostic: string | undefined;
  readonly now: () => number;
}

/**
 * Drives one automated test: detect the element, click it, wait for the event it should fire,
 * and validate the payload against the Event Sheet.
 *
 * The decisions all live in `advance` — this component only carries out whatever the state it is
 * in requires, and reports what came back.
 */
export function TestRunner({
  driver,
  sheet,
  payloads,
  sdkReady,
  sdkDiagnostic,
  now,
}: TestRunnerProps) {
  const [intent, setIntent] = useState<ActionIntent>('add-to-cart');
  const [expectedEvent, setExpectedEvent] = useState('');
  const [platform, setPlatform] = useState<string | undefined>(undefined);
  const [state, setState] = useState<RunState>({ kind: 'idle' });
  const [active, setActive] = useState<ActiveTest | undefined>(undefined);
  const [queue, setQueue] = useState<readonly PlannedTest[]>([]);
  const [results, setResults] = useState<readonly BatchResult[]>([]);
  const [clickWhenUnsure, setClickWhenUnsure] = useState(false);
  const [lastCapture, setLastCapture] = useState<CapturedPayload | undefined>(undefined);
  const batching = useRef(false);
  const testId = useRef(0);
  /** The run already written into `results`, so a re-render cannot record it twice. */
  const recorded = useRef(0);
  /** When the click landed, kept past the state that carried it so failures can report context. */
  const waitedFrom = useRef<number | undefined>(undefined);

  const runTarget: ActionTarget = active?.target ?? { kind: 'intent', intent };
  const runEvent = active?.eventName ?? expectedEvent;

  const contextFor = (test: ActiveTest): RunContext => ({
    target: test.target,
    destructive: isDestructive(test.target, test.eventName),
    clickWhenUnsure,
    now: now(),
    timeouts: DEFAULT_TIMEOUTS,
  });

  const context = (): RunContext =>
    contextFor(active ?? { target: runTarget, eventName: runEvent });

  const begin = (test: ActiveTest): void => {
    testId.current += 1;
    setLastCapture(undefined);
    setActive(test);
    setState(advance({ kind: 'idle' }, { kind: 'start' }, contextFor(test)));
  };
  const dispatch = (event: Parameters<typeof advance>[1]): void => {
    setState((current) => advance(current, event, context()));
  };

  // Deadlines are absolute, so a periodic tick is all that is needed to enforce every timeout.
  useEffect(() => {
    const timer = setInterval(() => {
      setState((current) => advance(current, { kind: 'tick', now: now() }, context()));
    }, TICK_MS);
    return () => clearInterval(timer);
  });

  useEffect(() => {
    if (state.kind !== 'checking-sdk' || sdkReady === undefined) {
      return;
    }
    dispatch(
      sdkReady
        ? { kind: 'sdk-ready' }
        : { kind: 'sdk-absent', diagnostic: sdkDiagnostic ?? 'not detected' },
    );
  }, [state.kind, sdkReady, sdkDiagnostic]);

  useEffect(() => {
    if (state.kind !== 'detecting') {
      return;
    }
    void driver.send({ kind: 'detect', target: runTarget }).then((reply) => {
      if (reply.kind === 'candidates') {
        setPlatform(reply.platform);
        dispatch({ kind: 'candidates', candidates: reply.candidates });
      } else if (reply.kind === 'error') {
        dispatch({ kind: 'execution-failed', reason: reply.message });
      }
    });
  }, [state.kind]);

  useEffect(() => {
    if (state.kind !== 'executing') {
      return;
    }
    const { selector } = state.candidate;
    void driver.send({ kind: 'click', selector }).then((reply) => {
      dispatch(
        reply.kind === 'clicked'
          ? { kind: 'executed' }
          : {
              kind: 'execution-failed',
              reason: reply.kind === 'error' ? reply.message : 'The click did not land.',
            },
      );
    });
  }, [state.kind]);

  // Association runs on every new payload while waiting: the event may arrive at any moment.
  useEffect(() => {
    if (state.kind === 'waiting-for-event') {
      waitedFrom.current = state.startedAt;
    }
  }, [state.kind]);

  useEffect(() => {
    if (state.kind !== 'waiting-for-event' || sheet === undefined) {
      return;
    }

    const association = associatePayload(payloads, {
      testId: String(testId.current),
      startedAt: state.startedAt,
      expectedEvent: runEvent,
      windowMs: DEFAULT_TIMEOUTS.eventMs,
    });
    if (association.kind !== 'matched') {
      return;
    }

    const match = matchEvent(runEvent, sheet);
    if (match.kind !== 'matched') {
      dispatch({ kind: 'execution-failed', reason: `${runEvent} is not in the Event Sheet.` });
      return;
    }

    const subject = association.payload.args.find(
      (argument) => typeof argument === 'object' && argument !== null && !Array.isArray(argument),
    );
    if (subject === undefined) {
      dispatch({ kind: 'execution-failed', reason: 'The captured event carried no payload.' });
      return;
    }

    setLastCapture(association.payload);
    dispatch({ kind: 'payload-captured' });
    dispatch({
      kind: 'validated',
      result: validateEvent(subject, match.schema, association.payload.at),
    });
  }, [state.kind, payloads, sheet, runEvent]);

  /**
   * Records a finished run and, during a batch, starts the next one.
   *
   * A run that stops for a human is only auto-recorded while batching — on its own, the dialog is
   * the point. Blocking a batch on one dialog left the rest of the sheet untested, which is what
   * happened on the first real sheet we tried.
   */
  useEffect(() => {
    const finished = terminalOutcome(state, batching.current);
    if (finished === undefined || active === undefined || recorded.current === testId.current) {
      return;
    }
    recorded.current = testId.current;

    const since = waitedFrom.current;
    const alsoFired =
      lastCapture !== undefined || since === undefined
        ? []
        : [
            ...new Set(
              payloads
                .filter((payload) => payload.at >= since && payload.eventName !== undefined)
                .map((payload) => payload.eventName ?? ''),
            ),
          ];

    setResults((current) => [
      ...current,
      {
        eventName: active.eventName,
        outcome: finished.outcome,
        detail: finished.detail,
        payload: lastCapture,
        result: state.kind === 'passed' || state.kind === 'failed' ? state.result : undefined,
        alsoFired,
      },
    ]);

    if (!batching.current) {
      return;
    }

    const [next, ...rest] = queue;
    if (next?.target === undefined) {
      batching.current = false;
      setActive(undefined);
      setState({ kind: 'idle' });
      return;
    }

    setQueue(rest);
    begin({ target: next.target, eventName: next.eventName });
  }, [state.kind]);

  const events = sheet === undefined ? [] : [...sheet.events.keys()];
  const running = state.kind !== 'idle' && state.kind !== 'passed' && state.kind !== 'failed';

  return (
    <section className="runner">
      <h2>Run a test</h2>

      <div className="runner__controls">
        <label>
          <span>Action</span>
          <select
            value={intent}
            disabled={running}
            onChange={(event) => setIntent(event.target.value as ActionIntent)}
          >
            {INTENTS.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Expected event</span>
          <select
            value={expectedEvent}
            disabled={running || events.length === 0}
            onChange={(event) => setExpectedEvent(event.target.value)}
          >
            <option value="">— choose —</option>
            {events.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          // Runnable with no sheet on purpose: pressing Run then says what is missing, which is
          // clearer than a button that is silently dead because the event list is empty.
          disabled={running || (sheet !== undefined && expectedEvent === '')}
          onClick={() => {
            batching.current = false;
            setResults([]);
            if (sheet === undefined) {
              setState({ kind: 'sheet-required' });
              return;
            }
            begin({ target: { kind: 'intent', intent }, eventName: expectedEvent });
          }}
        >
          Run
        </button>

        <label className="runner__toggle">
          <input
            type="checkbox"
            checked={clickWhenUnsure}
            disabled={running}
            onChange={(event) => setClickWhenUnsure(event.target.checked)}
          />
          <span>Click best match even when unsure</span>
        </label>

        <button
          type="button"
          disabled={running}
          onClick={() => {
            if (sheet === undefined) {
              setState({ kind: 'sheet-required' });
              return;
            }

            const plan = planFromSheet(sheet);
            setResults(
              plan
                .filter((test) => test.skipReason !== undefined)
                .map((test) => ({
                  eventName: test.eventName,
                  outcome: 'SKIPPED' as const,
                  detail: test.skipReason,
                  payload: undefined,
                  result: undefined,
                  alsoFired: [],
                })),
            );

            const [first, ...rest] = runnable(plan);
            if (first?.target === undefined) {
              batching.current = false;
              setActive(undefined);
              return;
            }

            batching.current = true;
            setQueue(rest);
            begin({ target: first.target, eventName: first.eventName });
          }}
        >
          Run all from sheet
        </button>
      </div>

      <p className="runner__state">
        {active === undefined ? null : <span className="runner__active">{active.eventName}: </span>}
        {describe(state)}
        {platform === undefined ? null : <span className="runner__platform"> · {platform}</span>}
      </p>

      {state.kind === 'awaiting-confirmation' ? (
        <div className="runner__confirm">
          <p>
            {state.reason === 'spends-money'
              ? 'This action can place a real order. Nothing is clicked unless you say so.'
              : 'Detection is not confident about this element.'}
          </p>
          <p>
            <code>{state.candidate.label}</code> — <code>{state.candidate.selector}</code> (
            {Math.round(state.candidate.confidence * 100)}%)
          </p>
          <button type="button" onClick={() => dispatch({ kind: 'cancel' })}>
            Cancel
          </button>
          <button type="button" onClick={() => dispatch({ kind: 'confirm' })}>
            Click it
          </button>
        </div>
      ) : null}

      {state.kind === 'awaiting-manual-pick' ? (
        <div className="runner__confirm">
          <p>Nothing was found automatically. Point at the element yourself.</p>
          <button
            type="button"
            onClick={() => {
              void driver.send({ kind: 'pick' }).then((reply) => {
                if (reply.kind === 'picked') {
                  dispatch({ kind: 'manual-pick', candidate: reply.candidate });
                } else if (reply.kind === 'error') {
                  dispatch({ kind: 'execution-failed', reason: reply.message });
                }
              });
            }}
          >
            Pick element on the page
          </button>
        </div>
      ) : null}

      {state.kind === 'failed' ? (
        <p className="runner__failed" role="alert">
          {state.reason}
        </p>
      ) : null}

      {results.length === 0 ? null : (
        <ul className="runner__results">
          {results.map((entry) => (
            <li key={entry.eventName}>
              <details>
                <summary>
                  <code>{entry.eventName}</code>
                  <span className={`runner__outcome runner__outcome--${entry.outcome.toLowerCase().replace(' ', '-')}`}>
                    {entry.outcome}
                  </span>
                  {entry.detail === undefined ? null : (
                    <span className="runner__detail">{entry.detail}</span>
                  )}
                </summary>

                {entry.result === undefined ? null : (
                  <VerdictDetail verdict={{ kind: 'validated', result: entry.result, firedAs: undefined, matchReason: undefined }} />
                )}

                {entry.payload === undefined ? (
                  <p className="runner__note">
                    No debug log was captured for this run.
                    {entry.alsoFired.length > 0 ? (
                      <>
                        {' '}
                        The page did fire{' '}
                        {entry.alsoFired.map((name, index) => (
                          <span key={name}>
                            {index > 0 ? ', ' : ''}
                            <code>{name}</code>
                          </span>
                        ))}
                        . If one of those is this event under another name, add it to the Event
                        Sheet or alias it.
                      </>
                    ) : null}
                  </p>
                ) : (
                  <pre className="stream__raw">{prettify(entry.payload.raw)}</pre>
                )}
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** `undefined` while a run is still in progress; otherwise how it should be recorded. */
function terminalOutcome(
  state: RunState,
  batching: boolean,
): { outcome: BatchResult['outcome']; detail: string | undefined } | undefined {
  if (!batching && (state.kind === 'awaiting-confirmation' || state.kind === 'awaiting-manual-pick')) {
    // On its own, waiting for the user is the intended behaviour, not an outcome.
    return undefined;
  }

  switch (state.kind) {
    case 'passed':
      return { outcome: 'PASS', detail: undefined };
    case 'failed':
      return { outcome: 'FAIL', detail: state.reason };
    case 'awaiting-confirmation':
      return {
        outcome: 'NEEDS REVIEW',
        detail: `Detection was only ${Math.round(state.candidate.confidence * 100)}% sure of "${state.candidate.label}", so nothing was clicked and no event fired. Run it on its own to confirm the click, or tick "Click best match even when unsure".`,
      };
    case 'awaiting-manual-pick':
      return {
        outcome: 'NEEDS REVIEW',
        detail:
          'No element on this page looks like this event — run it on its own and point at the element yourself.',
      };
    default:
      return undefined;
  }
}

/** The stored raw text is authoritative; this only re-indents it for reading. */
function prettify(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function describe(state: RunState): string {
  switch (state.kind) {
    case 'idle':
      return 'Idle.';
    case 'checking-sdk':
      return 'Checking the Smartech SDK…';
    case 'sheet-required':
      return 'Upload an Event Sheet first.';
    case 'detecting':
      return 'Looking for the element…';
    case 'awaiting-confirmation':
      return 'Waiting for you to confirm.';
    case 'awaiting-manual-pick':
      return 'Waiting for you to pick an element.';
    case 'executing':
      return 'Clicking…';
    case 'waiting-for-event':
      return 'Clicked. Waiting for the event…';
    case 'validating':
      return 'Validating the payload…';
    case 'passed':
      return `PASS — ${state.result.eventName}`;
    case 'failed':
      return 'FAIL';
  }
}
