import type { ValidationResult } from '../validation/types';

/**
 * What became of one Event Sheet event during a run.
 *
 * Severity follows how hard the problem is to live with, not how loud it looks:
 *
 * - `PASS` — fired, and everything the sheet describes arrived correctly.
 * - `WARNING` — fired, but something is wrong with it: a key renamed, a datatype that does not
 *   match, a field the sheet expects and the payload omits. The integration works and needs a
 *   correction.
 * - `FAIL` — never fired. Nothing to correct, because nothing is there. A missing event is a
 *   harder blocker than a wrong one, so it is the more severe verdict of the two.
 *
 * Two statuses are not results at all, and exist so the gap is not padded with things nobody could
 * have produced:
 *
 * - `API ONLY` — the sheet says the event is sent server-to-server, so it never reaches the
 *   browser and has to be checked in the Smartech panel.
 * - `PAYMENT` — the event only fires when money actually moves. Nobody should put a live card
 *   through a client's storefront to satisfy a report. Checkout is deliberately *not* in this
 *   class: it costs nothing to reach and is expected to be swept.
 */
export type EventStatus = 'PASS' | 'WARNING' | 'FAIL' | 'API ONLY' | 'PAYMENT';

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
  /** Events observed firing at least once — the ones a verdict could be reached about. */
  readonly tested: number;
  readonly passed: number;
  /** Fired, but carrying something the sheet disagrees with. */
  readonly warning: number;
  /** Never fired, and nothing excuses it. */
  readonly failed: number;
  /** Sheet events fired from a server, which this channel cannot observe at all. */
  readonly apiOnly: number;
  /** Sheet events that only fire when money moves, so a run is not expected to produce them. */
  readonly payment: number;
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
