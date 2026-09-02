import type { EventSchema, EventSheet } from '../event-sheet/types';
import type { CapturedPayload } from '../shared/payload';
import { payloadSubject } from '../validation/from-capture';
import { matchEvent } from '../validation/match-event';
import { validateEvent } from '../validation/validate';
import type { ValidationResult } from '../validation/types';
import { DEFAULT_VALIDATION_OPTIONS, type ValidationOptions } from '../validation/types';
import { isPaymentEvent } from './payment';
import type { EventOutcome, EventStatus, RunReport, RunTotals } from './types';

export interface RunContext {
  readonly site: string;
  readonly sheetName: string;
  readonly sdkReady: boolean;
  /** Epoch milliseconds, passed in so this stays pure and testable. */
  readonly at: number;
}

/**
 * Turns what a run captured into the report every surface reads from — dashboard, detail view,
 * and all three exports.
 *
 * This used to live inside the sweep component, which meant a React component decided verdicts
 * and nothing else could reuse them. It is pure: plain objects in, a report out, no DOM and no
 * clock.
 *
 * Every sheet event appears in the result, whether it fired or not. A report that lists only
 * what fired cannot answer the question the run was asked — what is missing.
 */
export function buildReport(
  sheet: EventSheet,
  captured: readonly CapturedPayload[],
  context: RunContext,
  options: ValidationOptions = DEFAULT_VALIDATION_OPTIONS,
): RunReport {
  const hits = firstHitPerEvent(sheet, captured);
  const events = [...sheet.events.values()].map((schema): EventOutcome => {
    const hit = hits.matched.get(schema.name);

    if (hit === undefined) {
      return unfired(schema, sheet, hits, options);
    }

    const subject = payloadSubject(hit.payload);
    const result =
      subject === undefined
        ? undefined
        : validateEvent(subject, schema, hit.payload.at, options);

    return {
      eventName: schema.name,
      // A payload we could not read is not a pass — nothing was checked. It is treated exactly
      // like an event that never arrived, because for reporting purposes it did not.
      status: result === undefined ? unreachedStatus(schema) : firedStatus(result),
      firedAs: hit.observed === schema.name ? undefined : hit.observed,
      matchReason: hit.reason,
      checkedIn: undefined,
      // The sheet told this one not to fire on its own, and here it is.
      firedSeparately: schema.mergeInto !== undefined,
      result,
    };
  });

  return {
    site: context.site,
    sheetName: context.sheetName,
    sdkReady: context.sdkReady,
    at: context.at,
    totals: tally(events),
    events,
    undocumented: [...new Set(hits.unmatched)],
    channel: 'debug-payload',
  };
}

/**
 * What to report for a sheet event no payload matched.
 *
 * An event the sheet merged into another was never going to appear under its own name — that is
 * the whole point of merging it. Its fields are expected inside the parent's payload, so that is
 * where they are checked, and it gets a real verdict instead of the NOT SEEN that made 23 correct
 * implementations look like 23 gaps.
 */
function unfired(
  schema: EventSchema,
  sheet: EventSheet,
  hits: Hits,
  options: ValidationOptions,
): EventOutcome {
  const base = {
    eventName: schema.name,
    firedAs: undefined,
    matchReason: undefined,
    firedSeparately: false,
  } as const;

  const parent = parentOf(schema, sheet);
  const parentHit = parent === undefined ? undefined : hits.matched.get(parent.name);
  const parentSubject = parentHit === undefined ? undefined : payloadSubject(parentHit.payload);

  if (parent !== undefined && parentHit !== undefined && parentSubject !== undefined) {
    const result = validateEvent(parentSubject, schema, parentHit.payload.at, options);

    return {
      ...base,
      status: firedStatus(result),
      checkedIn: parent.name,
      // Everything else in the parent's payload belongs to the parent and to its other merged
      // children. Listing it against this one would report the whole event as undocumented here.
      result: { ...result, extra: [] },
    };
  }

  return {
    ...base,
    // Neither of these is the site's defect. A server-fired event was never going to appear
    // here, and a payment event only happens when someone is charged — saying either "never
    // fired" would report our own blind spots as findings.
    status: unreachedStatus(schema),
    checkedIn: undefined,
    result: undefined,
  };
}

/**
 * The verdict on an event that did fire.
 *
 * Anything the validator is unhappy about is a warning rather than a failure: the event exists and
 * arrived, and a renamed key or a wrong datatype is a correction to make, not an absence to chase.
 * Failure is reserved for events that never came at all.
 */
function firedStatus(result: ValidationResult): EventStatus {
  return result.status === 'PASS' ? 'PASS' : 'WARNING';
}

/**
 * The verdict on an event the run never saw.
 *
 * Excused first, if there is a reason: the sheet states outright which events are server-fired,
 * and payment is inferred from the name, since no sheet has a column for "this one costs money".
 * Everything else failed — an event that should have fired from the browser and did not is the
 * finding this tool exists to produce.
 */
function unreachedStatus(schema: EventSchema): EventStatus {
  if (schema.source === 'api') {
    return 'API ONLY';
  }
  return isPaymentEvent(schema.name) ? 'PAYMENT' : 'FAIL';
}

/** The event a merged one was folded into, reconciling the sheet's two spellings of its name. */
function parentOf(schema: EventSchema, sheet: EventSheet): EventSchema | undefined {
  if (schema.mergeInto === undefined) {
    return undefined;
  }

  const match = matchEvent(schema.mergeInto, sheet, new Map(), true);
  if (match.kind === 'unknown' || match.schema.name === schema.name) {
    return undefined;
  }
  return match.schema;
}

interface Hit {
  readonly payload: CapturedPayload;
  /** The name the site used, which close matching may have reconciled to a different one. */
  readonly observed: string;
  readonly reason: 'formatting' | 'synonym' | undefined;
}

interface Hits {
  readonly matched: ReadonlyMap<string, Hit>;
  readonly unmatched: readonly string[];
}

/**
 * The first payload seen for each sheet event, plus the names that matched nothing.
 *
 * First rather than last: a sweep clicks one control per group, so the first firing is the one
 * that control produced. Later duplicates are the same event from a repeat.
 */
function firstHitPerEvent(sheet: EventSheet, captured: readonly CapturedPayload[]): Hits {
  const matched = new Map<string, Hit>();
  const unmatched: string[] = [];

  for (const payload of captured) {
    if (payload.eventName === undefined) {
      continue;
    }

    // Close matching is on: a site firing `login` against a sheet saying `Sign in` is the same
    // event with a naming disagreement, which the outcome reports separately.
    const match = matchEvent(payload.eventName, sheet, new Map(), true);
    if (match.kind === 'unknown') {
      unmatched.push(payload.eventName);
      continue;
    }
    if (matched.has(match.schema.name)) {
      continue;
    }

    matched.set(match.schema.name, {
      payload,
      observed: payload.eventName,
      reason: match.kind === 'close' ? match.reason : undefined,
    });
  }

  return { matched, unmatched };
}

function tally(events: readonly EventOutcome[]): RunTotals {
  const countOf = (status: EventOutcome['status']): number =>
    events.filter((event) => event.status === status).length;

  const passed = countOf('PASS');
  const warning = countOf('WARNING');
  const failed = countOf('FAIL');
  const apiOnly = countOf('API ONLY');
  const payment = countOf('PAYMENT');

  return {
    events: events.length,
    tested: passed + warning,
    passed,
    warning,
    failed,
    apiOnly,
    payment,
    // What a run could honestly have produced. Server-fired and payment events are outside it, so
    // a complete run reads as complete rather than as a third of one.
    reachable: events.length - apiOnly - payment,
  };
}

/**
 * A filename that identifies the run on disk without being opened.
 *
 * Site and timestamp, because a downloads folder collects reports from several sites and several
 * attempts at the same one, and "report.csv" tells a reader nothing about which is which.
 */
export function reportFileName(report: RunReport, extension: string): string {
  const site = report.site.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site';
  const stamp = new Date(report.at).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `smartech-${site}-${stamp}.${extension}`;
}
