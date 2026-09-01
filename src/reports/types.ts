import type { ValidationResult } from '../validation/types';

/**
 * What became of one Event Sheet event during a run.
 *
 * `NOT SEEN` is deliberately not a failure. An event that never fired may be unimplemented, or
 * may simply sit behind a flow the run never reached — a login, a checkout, a page nobody
 * visited. Collapsing those two into FAIL would report defects that do not exist.
 *
 * `API ONLY` is not a result at all. The sheet says the event is fired server-to-server, so it
 * never reaches the browser and no amount of clicking will produce it — it has to be checked in
 * the Smartech panel instead. Leaving these in NOT SEEN inflated the gap by eleven events on the
 * first real sheet and made a complete run look like a third of one.
 */
export type EventStatus = 'PASS' | 'FAIL' | 'NOT SEEN' | 'API ONLY';

export interface EventOutcome {
  /** The Event Sheet's name for this event, which is the name a report is organised by. */
  readonly eventName: string;
  readonly status: EventStatus;
  /** The site's own name for it, when that differs from the sheet's. */
  readonly firedAs: string | undefined;
  readonly matchReason: 'formatting' | 'synonym' | undefined;
  /**
   * The parent event whose payload this one was checked inside, for an event the sheet merged
   * into another. Absent when the event was checked under its own name.
   */
  readonly checkedIn: string | undefined;
  /**
   * Set when the sheet said this event must not fire separately and it did anyway. The payload is
   * still validated — but the site and the sheet disagree about whether this event should exist.
   */
  readonly firedSeparately: boolean;
  /** Absent when the event never fired, or fired without a payload object to check. */
  readonly result: ValidationResult | undefined;
}

export interface RunTotals {
  /** Events the Event Sheet describes. The denominator for everything else. */
  readonly events: number;
  /** Events observed firing at least once. */
  readonly tested: number;
  readonly passed: number;
  readonly failed: number;
  readonly notTested: number;
  /** Sheet events fired from a server, which this channel cannot observe at all. */
  readonly apiOnly: number;
  /** Events that could have been produced from the browser: the honest denominator. */
  readonly reachable: number;
}

/**
 * One run, complete enough to render, export, and store without consulting anything else.
 *
 * Self-contained on purpose: a report opened from history months later must still say what site
 * it came from and which sheet it was checked against, or it means nothing.
 */
export interface RunReport {
  readonly site: string;
  readonly sheetName: string;
  readonly sdkReady: boolean;
  /** Epoch milliseconds. Supplied by the caller — nothing in here reads the clock. */
  readonly at: number;
  readonly totals: RunTotals;
  readonly events: readonly EventOutcome[];
  /** Events the site fired that the sheet does not describe — a finding in its own right. */
  readonly undocumented: readonly string[];
  /**
   * Which channel these verdicts came from.
   *
   * Only the debug payload is checked until Phase 7 captures the network call. A report must
   * state that rather than let a reader assume both were verified (PLAN.md, Terminology).
   */
  readonly channel: 'debug-payload';
}
