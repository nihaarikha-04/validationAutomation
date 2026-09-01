import {
  isSpecial,
  type CaptureStats,
  type CapturedPayload,
  type TransferableValue,
} from '../../../shared/payload';
import type { CaptureVerdict } from '../../../validation/from-capture';
import { VerdictDetail } from './VerdictDetail';

export interface PayloadStreamProps {
  readonly payloads: readonly CapturedPayload[];
  /** Keyed by payload id. Empty until an Event Sheet is loaded. */
  readonly verdicts: ReadonlyMap<string, CaptureVerdict>;
  /** Capture's own account of what it is seeing. Undefined until the first report arrives. */
  readonly stats: CaptureStats | undefined;
  readonly onClear: () => void;
}

export function PayloadStream({ payloads, verdicts, stats, onClear }: PayloadStreamProps) {
  return (
    <section className="stream">
      <div className="stream__head">
        <h2>
          {payloads.length} {payloads.length === 1 ? 'payload' : 'payloads'}
        </h2>
        <button type="button" onClick={onClear} disabled={payloads.length === 0}>
          Clear
        </button>
      </div>

      {stats === undefined ? null : (
        <p className="stream__stats">
          Watched {stats.seen} console {stats.seen === 1 ? 'line' : 'lines'} on this page;{' '}
          {stats.matched} looked like Smartech.
          {stats.matched === 0 && stats.recent.length > 0 ? (
            <>
              {' '}
              Nothing matched, so either this page has no Smartech debug output or its format is one
              we do not recognise. Most recent lines:{' '}
              {stats.recent.map((line, index) => (
                <span key={line}>
                  {index > 0 ? ' · ' : ''}
                  <code>{line}</code>
                </span>
              ))}
            </>
          ) : null}
        </p>
      )}

      {payloads.length === 0 ? (
        <p className="stream__empty">
          Waiting for Smartech debug output on the inspected page.
        </p>
      ) : (
        <ul className="stream__list">
          {payloads.map((payload) => (
            <li key={payload.id}>
              <details>
                <summary>
                  <span className="stream__time">{formatTime(payload.at)}</span>
                  <code className="stream__label">{describe(payload)}</code>
                  {payload.origin === 'pasted' ? (
                    <span className="stream__badge">pasted</span>
                  ) : null}
                  <VerdictBadge verdict={verdicts.get(payload.id)} />
                </summary>

                {verdicts.get(payload.id) === undefined ? null : (
                  <VerdictDetail verdict={verdicts.get(payload.id) as CaptureVerdict} />
                )}

                <pre className="stream__raw">{prettify(payload.raw)}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** `undefined` means no Event Sheet is loaded yet, so nothing can be judged. */
function VerdictBadge({ verdict }: { readonly verdict: CaptureVerdict | undefined }) {
  if (verdict === undefined) {
    return null;
  }

  const label = verdict.kind === 'validated' ? verdict.result.status : labelFor(verdict.kind);

  return <span className={`stream__verdict stream__verdict--${label.toLowerCase()}`}>{label}</span>;
}

function labelFor(kind: Exclude<CaptureVerdict['kind'], 'validated'>): string {
  switch (kind) {
    case 'unknown-event':
      return 'UNKNOWN';
    case 'unnamed':
      return 'UNNAMED';
    case 'no-payload':
      return 'NO PAYLOAD';
  }
}

/** Local time only — payloads are read next to a live page, never across time zones. */
function formatTime(at: number): string {
  const date = new Date(at);
  const time = date.toTimeString().slice(0, 8);
  return `${time}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

/** The event name when the debug line named one, otherwise a hint of what was logged. */
function describe(payload: CapturedPayload): string {
  if (payload.eventName !== undefined) {
    return payload.eventName;
  }

  const [first, second] = payload.args;
  const head = summarise(first);

  return second === undefined ? head : `${head} ${summarise(second)}`;
}

function summarise(value: TransferableValue | undefined): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return `'${value}'`;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (isSpecial(value)) {
    return `<${value.__special}>`;
  }
  if (Array.isArray(value)) {
    return `[${value.length}]`;
  }

  const keys = Object.keys(value);
  return keys.length === 0 ? '{}' : `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''}}`;
}

/** The stored raw text is authoritative; this only re-indents it for reading. */
function prettify(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
