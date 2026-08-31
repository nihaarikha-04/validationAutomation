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
import type { ActionIntent } from '../../../automation/types';
import type { EventSheet } from '../../../event-sheet/types';
import type { CapturedPayload } from '../../../shared/payload';
import { matchEvent } from '../../../validation/match-event';
import { validateEvent } from '../../../validation/validate';

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
  readonly outcome: 'PASS' | 'FAIL' | 'SKIPPED';
  readonly detail: string | undefined;
}

/** What the current run is for. Set from the dropdowns, or from the queue during a batch. */
interface ActiveTest {
  readonly intent: ActionIntent;
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
  const batching = useRef(false);
  const testId = useRef(0);

  const runIntent = active?.intent ?? intent;
  const runEvent = active?.eventName ?? expectedEvent;

  const context = (): RunContext => ({ intent: runIntent, now: now(), timeouts: DEFAULT_TIMEOUTS });

  const begin = (test: ActiveTest): void => {
    testId.current += 1;
    setActive(test);
    setState(
      advance(
        { kind: 'idle' },
        { kind: 'start', intent: test.intent },
        { intent: test.intent, now: now(), timeouts: DEFAULT_TIMEOUTS },
      ),
    );
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
    void driver.send({ kind: 'detect', intent }).then((reply) => {
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

    dispatch({ kind: 'payload-captured' });
    dispatch({
      kind: 'validated',
      result: validateEvent(subject, match.schema, association.payload.at),
    });
  }, [state.kind, payloads, sheet, runEvent]);

  // Batch progression: record the finished run, then start the next queued one.
  useEffect(() => {
    if ((state.kind !== 'passed' && state.kind !== 'failed') || !batching.current) {
      return;
    }

    if (active !== undefined) {
      setResults((current) => [
        ...current,
        {
          eventName: active.eventName,
          outcome: state.kind === 'passed' ? 'PASS' : 'FAIL',
          detail: state.kind === 'failed' ? state.reason : undefined,
        },
      ]);
    }

    const [next, ...rest] = queue;
    if (next?.intent === undefined) {
      batching.current = false;
      setActive(undefined);
      return;
    }

    setQueue(rest);
    begin({ intent: next.intent, eventName: next.eventName });
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
            begin({ intent, eventName: expectedEvent });
          }}
        >
          Run
        </button>

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
                })),
            );

            const [first, ...rest] = runnable(plan);
            if (first?.intent === undefined) {
              batching.current = false;
              setActive(undefined);
              return;
            }

            batching.current = true;
            setQueue(rest);
            begin({ intent: first.intent, eventName: first.eventName });
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
        <table className="runner__results">
          <thead>
            <tr>
              <th scope="col">Event</th>
              <th scope="col">Outcome</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {results.map((entry) => (
              <tr key={entry.eventName} className={`runner__result--${entry.outcome.toLowerCase()}`}>
                <td>
                  <code>{entry.eventName}</code>
                </td>
                <td>{entry.outcome}</td>
                <td>{entry.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
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
