import { useEffect, useRef, useState } from 'react';
import type { PageDriver } from '../../../automation/commands';
import type { NavigationSource } from '../chrome-navigation';
import {
  crawlSite,
  sweepPage,
  type InputDecision,
  type InputRequest,
  type Observation,
  type PageResult,
} from '../../../automation/crawl';
import type { ClickRisk } from '../../../automation/sweep';
import type { EventSheet } from '../../../event-sheet/types';
import type { CapturedPayload } from '../../../shared/payload';
import { VerdictDetail } from './VerdictDetail';
import { Dashboard } from './Dashboard';
import { buildReport } from '../../../reports/build';
import type { RunReport } from '../../../reports/types';

/** How long to wait after a click for whatever it fires to arrive. */
const SETTLE_MS = 1_200;

/**
 * How long the pointer rests on a control before the click.
 *
 * Above the hover-intent thresholds sites typically use (300–500ms) so a deliberate hover is
 * registered as one, rather than read as the pointer passing over on its way somewhere else.
 */
const HOVER_DWELL_MS = 700;

/** How long the scroll pass rests at each step; a second is the usual visibility threshold. */
const VIEW_DWELL_MS = 1_200;

/** Enough for lazy content to load when we are only scrolling to populate the DOM. */
const LOAD_SCROLL_MS = 180;

export const DEFAULT_SETTLE_MS = SETTLE_MS;

export interface PageSweepProps {
  readonly driver: PageDriver;
  readonly sheet: EventSheet | undefined;
  readonly payloads: readonly CapturedPayload[];
  readonly now: () => number;
  readonly navigation: NavigationSource;
  /** Recorded in the report, so one opened months later still says where it came from. */
  readonly site: string;
  readonly sheetName: string;
  readonly sdkReady: boolean;
  /** Hands a finished export to the browser. Downloading is the composition root's job. */
  readonly onExport: (contents: string, fileName: string) => void;
  /** Injected so tests need not wait a real second per click. */
  readonly settleMs?: number;
}

/**
 * Clicks everything on the page and reports which Event Sheet events it managed to produce.
 *
 * This inverts the targeted runner: rather than guessing which control fires a given event —
 * the step that goes wrong most often — it clicks each control and reads whatever arrives. What
 * an element is *called* stops mattering.
 */
export function PageSweep({
  driver,
  sheet,
  payloads,
  now,
  navigation,
  site,
  sheetName,
  sdkReady,
  onExport,
  settleMs = SETTLE_MS,
}: PageSweepProps) {
  const [includeNavigating, setIncludeNavigating] = useState(false);
  const [includeDestructive, setIncludeDestructive] = useState(false);
  const [progress, setProgress] = useState<string | undefined>(undefined);
  const [showPointer, setShowPointer] = useState(true);
  /** Hover and dwell alongside clicking, for the events no click can produce. */
  const [observe, setObserve] = useState(true);
  const [autoResume, setAutoResume] = useState(true);
  /** Set while the sweep is waiting for a form to be filled in by hand. */
  const [waiting, setWaiting] = useState<
    { request: InputRequest; decide: (decision: InputDecision) => void } | undefined
  >(undefined);
  const [crawl, setCrawl] = useState(false);
  // Zero means no limit: click everything, visit every page the site links to.
  const [maxPages, setMaxPages] = useState(0);
  const [clicksPerPage, setClicksPerPage] = useState(0);
  const cancelled = useRef(false);
  /** Wall-clock moment the run must end, when a time limit was chosen. */
  const deadline = useRef<number | undefined>(undefined);
  const [minutes, setMinutes] = useState(0);
  const [pages, setPages] = useState<readonly PageResult[]>([]);
  const [observations, setObservations] = useState<readonly Observation[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [report, setReport] = useState<RunReport | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const running = progress !== undefined;

  // The loop is async and cannot see prop updates, so the newest payloads are mirrored here.
  const latest = useRef(payloads);
  useEffect(() => {
    latest.current = payloads;
  }, [payloads]);

  /**
   * Pick up wherever browsing goes next.
   *
   * Only when nothing is running: a crawl navigates constantly by design, and restarting on its
   * own navigations would tear it down and begin again on every page.
   */
  const sweepRef = useRef<() => Promise<void>>(async () => undefined);
  useEffect(() => {
    if (!autoResume) {
      return undefined;
    }
    return navigation.subscribe(() => {
      if (progress === undefined) {
        void sweepRef.current();
      }
    });
  }, [navigation, autoResume, progress]);

  const allowed = (risk: ClickRisk): boolean =>
    risk === 'safe' ||
    // While crawling, a link that leaves the page is followed and swept rather than lost, so
    // skipping links would leave most of a storefront — tiles, categories — untouched.
    (risk === 'navigates' && (includeNavigating || crawl)) ||
    (risk === 'destructive' && includeDestructive);

  const sweep = async (): Promise<void> => {
    setProblem(undefined);
    setObservations([]);
    setReport(undefined);
    setPages([]);
    setSkipped(0);
    cancelled.current = false;
    deadline.current = minutes > 0 ? now() + minutes * 60_000 : undefined;
    setProgress('Starting…');

    const shared = {
      driver,
      now,
      settleMs,
      showPointer,
      hoverMs: observe ? HOVER_DWELL_MS : 0,
      dwellMs: observe ? VIEW_DWELL_MS : LOAD_SCROLL_MS,
      payloadsSince: (from: number) => latest.current.filter((payload) => payload.at >= from),
      onProgress: (message: string) => setProgress(message),
      allowed,
      onNeedsInput: (request: InputRequest) =>
        new Promise<InputDecision>((resolve) => {
          const pausedAt = now();
          setWaiting({
            request,
            decide: (decision) => {
              // Time spent waiting for a person is not time spent sweeping, so the run limit is
              // pushed back rather than expiring while the tester types.
              if (deadline.current !== undefined) {
                deadline.current += now() - pausedAt;
              }
              setWaiting(undefined);
              resolve(decision);
            },
          });
        }),
      isCancelled: () =>
        cancelled.current ||
        (deadline.current !== undefined && now() >= deadline.current),
    };

    try {
      if (crawl) {
        const outcome = await crawlSite({ ...shared, maxPages, clicksPerPage });
        setPages(outcome.pages);
        setObservations(outcome.pages.flatMap((page) => page.observations));
        setSkipped(outcome.pages.reduce((total, page) => total + page.skippedAsRepeats, 0));
        record();
        setProblem(outcome.stopped ?? outcome.pages.find((page) => page.stopped)?.stopped);
      } else {
        const outcome = await sweepPage(shared);
        setObservations(outcome.observations);
        setSkipped(outcome.skippedAsRepeats);
        record();
        setProblem(outcome.stopped);
      }
    } catch (error) {
      // A thrown error used to leave the sweep frozen mid-progress with no explanation.
      setProblem(error instanceof Error ? error.message : 'The sweep failed unexpectedly.');
    }

    setProgress(undefined);
  };

  /**
   * Deciding verdicts is not a component's job — the whole report is built by `buildReport`,
   * which is pure and is what the exports and (later) stored history read from too.
   *
   * It reports on everything captured this session, not only what the sweep itself triggered.
   * Scoping it to the sweep's own window silently dropped every event produced by hand: a run
   * summarised as "5 passed, 0 failed" while the stream held seven passes and a failing `banner`
   * fired a minute before the sweep started. Clearing the stream is what starts a fresh window.
   */
  const record = (): void => {
    if (sheet === undefined) {
      return;
    }
    setReport(buildReport(sheet, latest.current, { site, sheetName, sdkReady, at: now() }));
  };

  sweepRef.current = sweep;

  return (
    <section className="sweep">
      <h2>Sweep the page</h2>
      <p className="sweep__why">
        Clicks everything clickable and reports which Event Sheet events actually fired. No
        guessing about which control produces which event.
      </p>

      <div className="sweep__controls">
        <label className="runner__toggle">
          <input
            type="checkbox"
            checked={includeNavigating || crawl}
            disabled={running || crawl}
            onChange={(event) => setIncludeNavigating(event.target.checked)}
          />
          <span>
            {crawl
              ? 'Links are followed automatically while crawling'
              : 'Include links that leave the page (ends the sweep early)'}
          </span>
        </label>

        <label className="runner__toggle">
          <input
            type="checkbox"
            checked={includeDestructive}
            disabled={running}
            onChange={(event) => setIncludeDestructive(event.target.checked)}
          />
          <span>Include Pay / Delete / Sign out — never on a live site</span>
        </label>

        <label className="runner__toggle">
          <input
            type="checkbox"
            checked={showPointer}
            disabled={running}
            onChange={(event) => setShowPointer(event.target.checked)}
          />
          <span>Show a pointer on each click (slower, but you can watch it)</span>
        </label>

        <label className="runner__toggle">
          <input
            type="checkbox"
            checked={crawl}
            disabled={running}
            onChange={(event) => setCrawl(event.target.checked)}
          />
          <span>Also visit pages this site links to</span>
        </label>

        {crawl ? (
          <>
            <label className="runner__toggle">
              <span>Pages to visit (0 = all)</span>
              <input
                type="number"
                min={0}
                value={maxPages}
                disabled={running}
                onChange={(event) => setMaxPages(Math.max(0, Number(event.target.value)))}
              />
            </label>
            <label className="runner__toggle">
              <span>Clicks per page (0 = all)</span>
              <input
                type="number"
                min={0}
                value={clicksPerPage}
                disabled={running}
                onChange={(event) => setClicksPerPage(Math.max(0, Number(event.target.value)))}
              />
            </label>
          </>
        ) : null}

        <label className="runner__toggle">
          <input
            type="checkbox"
            checked={observe}
            disabled={running}
            onChange={(event) => setObserve(event.target.checked)}
          />
          <span>Hover and dwell as well as click (slower, reaches view/hover events)</span>
        </label>

        <label className="runner__toggle">
          <input
            type="checkbox"
            checked={autoResume}
            onChange={(event) => setAutoResume(event.target.checked)}
          />
          <span>Carry on automatically when the page changes</span>
        </label>

        <label className="runner__toggle">
          <span>Run for</span>
          <select
            value={minutes}
            disabled={running}
            onChange={(event) => setMinutes(Number(event.target.value))}
          >
            <option value={0}>as long as it takes</option>
            <option value={5}>5 minutes</option>
            <option value={10}>10 minutes</option>
            <option value={15}>15 minutes</option>
            <option value={30}>30 minutes</option>
          </select>
        </label>

        <button type="button" disabled={running} onClick={() => void sweep()}>
          {crawl ? 'Crawl the site' : 'Sweep page'}
        </button>

        {running ? (
          <button
            type="button"
            onClick={() => {
              cancelled.current = true;
              setProgress('Stopping…');
            }}
          >
            Stop
          </button>
        ) : null}
      </div>

      {waiting === undefined ? null : (
        <div className="runner__confirm" role="alert">
          <p>
            <strong>This form needs filling in.</strong> Fill it on the page, then continue.
            Clicking <code>{waiting.request.label}</code> with these empty would submit nothing:
          </p>
          <ul className="sweep__needed">
            {waiting.request.fields.map((field) => (
              <li key={field}>{field}</li>
            ))}
          </ul>
          <button type="button" onClick={() => waiting.decide('continue')}>
            I have filled it — continue
          </button>
          <button type="button" onClick={() => waiting.decide('skip')}>
            Skip this one
          </button>
          <button type="button" onClick={() => waiting.decide('stop')}>
            Stop
          </button>
        </div>
      )}

      {progress === undefined ? null : (
        <p className="sweep__progress">
          {progress}
          {minutes > 0 ? <span className="runner__detail"> · {minutes} min limit</span> : null}
        </p>
      )}
      {problem === undefined ? null : (
        <p className="runner__failed" role="alert">
          {problem}
        </p>
      )}

      {report === undefined ? null : (
        <>
          <Dashboard report={report} onExport={onExport} />

          <ul className="runner__results">
            {report.events.map((entry) => (
              <li key={entry.eventName}>
                <details>
                  <summary>
                    <code>{entry.eventName}</code>
                    <span
                      className={`runner__outcome runner__outcome--${entry.status.toLowerCase().replace(' ', '-')}`}
                    >
                      {entry.status}
                    </span>
                    {entry.firedAs === undefined ? null : (
                      <span className="runner__detail">
                        fired as <code>{entry.firedAs}</code>
                        {entry.matchReason === 'synonym'
                          ? ' — synonymous name'
                          : ' — same words, different formatting'}
                      </span>
                    )}
                    {entry.checkedIn === undefined ? null : (
                      <span className="runner__detail">
                        checked inside <code>{entry.checkedIn}</code>
                      </span>
                    )}
                    {entry.firedSeparately ? (
                      <span className="runner__detail runner__detail--warn">
                        fired on its own, though the sheet says it must not
                      </span>
                    ) : null}
                  </summary>
                  {entry.checkedIn !== undefined ? (
                    <p className="runner__note">
                      The sheet merges this event into <code>{entry.checkedIn}</code>, so it never
                      fires under its own name. Its fields were checked inside that event’s
                      payload instead.
                    </p>
                  ) : null}
                  {entry.status === 'API ONLY' ? (
                    <p className="runner__note">
                      It’s an API event — check the Smartech panel. The sheet’s Source
                      (Frontend / API) column says this one is fired from a server, so it never
                      reaches the browser and nothing done on the site can produce it here.
                    </p>
                  ) : entry.result === undefined ? (
                    <p className="runner__note">
                      No click on this page produced this event. It may need input first, or live
                      on another page.
                    </p>
                  ) : (
                    <>
                      <VerdictDetail
                        verdict={{
                          kind: 'validated',
                          result: entry.result,
                          firedAs: entry.firedAs,
                          matchReason: entry.matchReason,
                        }}
                      />
                      {/* The payload exactly as captured, for when the table is not enough. */}
                      <details className="runner__raw">
                        <summary>Raw payload</summary>
                        <pre>{JSON.stringify(entry.result.raw, null, 2)}</pre>
                      </details>
                    </>
                  )}
                </details>
              </li>
            ))}
          </ul>
        </>
      )}

      {pages.length === 0 ? null : (
        <details className="sweep__log">
          <summary>{pages.length} pages visited</summary>
          <ul>
            {pages.map((page) => (
              <li key={page.url}>
                <code>{page.url}</code> — {page.observations.length} clicks
                {page.skippedAsRepeats > 0 ? ` (+${page.skippedAsRepeats} repeats skipped)` : ''},{' '}
                {page.linksFound} links found
                {page.framesSeen > 1 ? ` · ${page.framesSeen} frames` : ' · top frame only'}
                {page.frames.length > 1 ? (
                  <details className="sweep__frames">
                    <summary>frames</summary>
                    <ul>
                      {page.frames.map((frame) => (
                        <li key={frame.frameId}>
                          <code>#{frame.frameId}</code> {frame.url}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {page.unreachableFrames > 0
                  ? ` · ${page.unreachableFrames} cross-origin frame${page.unreachableFrames === 1 ? '' : 's'} not reachable`
                  : ''}
                {page.routesSeen.length > 0 ? (
                  <>
                    {' · overlays: '}
                    {page.routesSeen.map((route, index) => (
                      <span key={route}>
                        {index > 0 ? ', ' : ''}
                        <code>{route}</code>
                      </span>
                    ))}
                  </>
                ) : null}
                {page.stopped === undefined ? null : ` (${page.stopped})`}
              </li>
            ))}
          </ul>
        </details>
      )}

      {observations.length === 0 ? null : (
        <details className="sweep__log">
          <summary>
            {observations.length} clicks
            {skipped > 0 ? `, ${skipped} skipped as repeats of the same control` : ''}
          </summary>
          <ul>
            {observations.map((entry) => (
              <li key={entry.label}>
                <code>{entry.label}</code> →{' '}
                {entry.eventNames.length === 0 ? 'nothing' : entry.eventNames.join(', ')}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
