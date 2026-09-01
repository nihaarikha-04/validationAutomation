import type { ValidationResult } from '../validation/types';

/**
 * What became of one Event Sheet event during a run.
 *
 * `NOT SEEN` is deliberately not a failure. An event that never fired may be unimplemented, or
 * may simply sit behind a flow the run never reached — a login, a checkout, a page nobody
 * visited. Collapsing those two into FAIL would report defects that do not exist.
 */
export type EventStatus = 'PASS' | 'FAIL' | 'NOT SEEN';

export interface EventOutcome {
  /** The Event Sheet's name for this event, which is the name a report is organised by. */
  readonly eventName: string;
  readonly status: EventStatus;
  /** The site's own name for it, when that differs from the sheet's. */
  readonly firedAs: string | undefined;
  readonly matchReason: 'formatting' | 'synonym' | undefined;
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
