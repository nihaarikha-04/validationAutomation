import { describe, expect, it } from 'vitest';
import type { DataType, EventSchema, EventSheet, FieldSchema } from '../event-sheet/types';
import type { CapturedPayload, TransferableValue } from '../shared/payload';
import { buildReport, reportFileName } from './build';

const AT = 1_735_689_600_000;

const CONTEXT = { site: 'shop.example.com', sheetName: 'events.xlsx', sdkReady: true, at: AT };

function field(payloadName: string, payloadType: DataType, required: boolean): FieldSchema {
  return {
    payloadName,
    payloadType,
    attributeName: '',
    attributeType: 'unknown',
    required,
    description: '',
    example: '',
  };
}

function sheetOf(...events: readonly EventSchema[]): EventSheet {
  return { events: new Map(events.map((event) => [event.name, event])), warnings: [] };
}

function fired(eventName: string, payload: TransferableValue, at = AT): CapturedPayload {
  const args: readonly TransferableValue[] = [`Firing EVT: '${eventName}'`, payload];
  return { id: `${eventName}-${at}`, at, eventName, args, raw: '[]', origin: 'intercepted' };
}

const CART: EventSchema = {
  source: 'unknown',
  name: 'Add to Cart',
  fields: [field('product_id', 'string', true), field('price', 'number', true)],
};

const LOGIN: EventSchema = { name: 'Sign in', fields: [field('mobile_number', 'string', true)], source: 'unknown' };

describe('buildReport', () => {
  it('lists every sheet event, including the ones that never fired', () => {
    const report = buildReport(sheetOf(CART, LOGIN), [], CONTEXT);

    expect(report.events.map((event) => event.eventName)).toEqual(['Add to Cart', 'Sign in']);
    expect(report.events.every((event) => event.status === 'NOT SEEN')).toBe(true);
  });

  it('counts a correct payload as passed', () => {
    const report = buildReport(
      sheetOf(CART, LOGIN),
      [fired('Add to Cart', { product_id: 'SKU1', price: 499 })],
      CONTEXT,
    );

    expect(report.totals).toEqual({
      events: 2, tested: 1, passed: 1, failed: 0, notTested: 1, apiOnly: 0, reachable: 2,
    });
  });

  it('counts a payload missing a required field as failed', () => {
    const report = buildReport(
      sheetOf(CART),
      [fired('Add to Cart', { product_id: 'SKU1' })],
      CONTEXT,
    );

    expect(report.totals.failed).toBe(1);
    expect(report.events[0]?.result?.missing).toEqual(['price']);
  });

  /**
   * An event that never fired is not a defect until someone establishes it should have. Folding
   * it into `failed` would report defects the run has no evidence for.
   */
  it('keeps events that never fired out of the failed count', () => {
    const report = buildReport(sheetOf(CART, LOGIN), [], CONTEXT);

    expect(report.totals.failed).toBe(0);
    expect(report.totals.notTested).toBe(2);
  });

  it('reconciles a name the site spells differently, and says so', () => {
    const report = buildReport(sheetOf(LOGIN), [fired('login', { mobile_number: '9199' })], CONTEXT);

    expect(report.events[0]?.status).toBe('PASS');
    expect(report.events[0]?.firedAs).toBe('login');
    expect(report.events[0]?.matchReason).toBe('synonym');
  });

  it('records events the sheet does not describe, once each', () => {
    const report = buildReport(
      sheetOf(CART),
      [fired('mystery_event', { a: 1 }), fired('mystery_event', { a: 2 })],
      CONTEXT,
    );

    expect(report.undocumented).toEqual(['mystery_event']);
  });

  /** A sweep clicks one control per group, so the first firing is the one that control produced. */
  it('validates the first payload for an event, not a later repeat', () => {
    const report = buildReport(
      sheetOf(CART),
      [
        fired('Add to Cart', { product_id: 'FIRST', price: 1 }, AT),
        fired('Add to Cart', { product_id: 'SECOND', price: 2 }, AT + 500),
      ],
      CONTEXT,
    );

    expect(report.events[0]?.result?.raw).toEqual({ product_id: 'FIRST', price: 1 });
  });

  it('does not count an event that fired without a readable payload as passed', () => {
    const bare: CapturedPayload = {
      id: 'bare',
      at: AT,
      eventName: 'Add to Cart',
      args: ["Firing EVT: 'Add to Cart'"],
      raw: '[]',
      origin: 'intercepted',
    };

    const report = buildReport(sheetOf(CART), [bare], CONTEXT);

    expect(report.totals.passed).toBe(0);
    expect(report.events[0]?.status).toBe('NOT SEEN');
  });

  /** PLAN.md Terminology: a report must never let a reader assume the network call was checked. */
  it('states which channel it checked', () => {
    expect(buildReport(sheetOf(CART), [], CONTEXT).channel).toBe('debug-payload');
  });

  it('carries the run context through, so a stored report still identifies itself', () => {
    const report = buildReport(sheetOf(CART), [], CONTEXT);

    expect(report.site).toBe('shop.example.com');
    expect(report.sheetName).toBe('events.xlsx');
    expect(report.sdkReady).toBe(true);
    expect(report.at).toBe(AT);
  });
});

describe('reportFileName', () => {
  it('names the file after the site and the moment it ran', () => {
    const report = buildReport(sheetOf(CART), [], CONTEXT);

    expect(reportFileName(report, 'csv')).toBe('smartech-shop-example-com-2025-01-01-00-00-00.csv');
  });

  it('falls back to a usable name when the site is unknown', () => {
    const report = buildReport(sheetOf(CART), [], { ...CONTEXT, site: '' });

    expect(reportFileName(report, 'json')).toMatch(/^smartech-site-/);
  });
});

describe('buildReport, events the sheet says are fired from a server', () => {
  const apiEvent: EventSchema = { name: 'Order Placed', fields: [], source: 'api' };

  it('marks an unseen API event as API ONLY rather than never fired', () => {
    // Reporting a server-fired event as NOT SEEN blames the site for the tool's blind spot: no
    // amount of clicking can produce it, so it is not evidence of anything.
    const report = buildReport(sheetOf(apiEvent), [], CONTEXT);

    expect(report.events[0]?.status).toBe('API ONLY');
  });

  it('keeps API events out of the reachable denominator and the untested count', () => {
    const report = buildReport(sheetOf(CART, apiEvent), [], CONTEXT);

    expect(report.totals).toMatchObject({
      events: 2,
      reachable: 1,
      apiOnly: 1,
      notTested: 1,
    });
  });

  it('validates an API event normally if it does turn up in the browser', () => {
    // The sheet can be wrong about the source. Something that actually fired is real evidence.
    const report = buildReport(
      sheetOf({ ...apiEvent, fields: CART.fields }),
      [fired('Order Placed', { product_id: 'SKU1', price: 10 })],
      CONTEXT,
    );

    expect(report.events[0]?.status).toBe('PASS');
  });
});

describe('buildReport, events the sheet merged into another', () => {
  const parent: EventSchema = {
    name: 'Page View (Front End)',
    source: 'frontend',
    fields: [field('page_url', 'string', true)],
  };
  const child: EventSchema = {
    name: 'Page Idle Time',
    source: 'frontend',
    // The sheet writes the parent without its qualifier, so resolving it needs close matching.
    mergeInto: 'Page View',
    fields: [field('idle_duration', 'number', true)],
  };

  it('checks a merged event inside its parent payload instead of calling it never fired', () => {
    const report = buildReport(
      sheetOf(parent, child),
      [fired('Page View (Front End)', { page_url: '/profile', idle_duration: 20000 })],
      CONTEXT,
    );

    const outcome = report.events.find((event) => event.eventName === 'Page Idle Time');
    expect(outcome?.status).toBe('PASS');
    expect(outcome?.checkedIn).toBe('Page View (Front End)');
  });

  it('fails a merged event whose fields are absent from the parent payload', () => {
    const report = buildReport(
      sheetOf(parent, child),
      [fired('Page View (Front End)', { page_url: '/profile' })],
      CONTEXT,
    );

    expect(report.events.find((event) => event.eventName === 'Page Idle Time')?.status).toBe('FAIL');
  });

  it('does not report the rest of the parent payload as undocumented on the child', () => {
    const report = buildReport(
      sheetOf(parent, child),
      [fired('Page View (Front End)', { page_url: '/profile', idle_duration: 1, unrelated: 'x' })],
      CONTEXT,
    );

    expect(report.events.find((event) => event.eventName === 'Page Idle Time')?.result?.extra)
      .toEqual([]);
  });

  it('is NOT SEEN while the parent has not fired either', () => {
    const report = buildReport(sheetOf(parent, child), [], CONTEXT);

    expect(report.events.find((event) => event.eventName === 'Page Idle Time')?.status)
      .toBe('NOT SEEN');
  });

  it('flags a merged event that fired on its own, and still validates it', () => {
    // The sheet said it must not fire separately. It did, so the two disagree — but the payload
    // it carried is still evidence and is checked.
    const report = buildReport(
      sheetOf(parent, child),
      [fired('Page Idle Time', { idle_duration: 20000 })],
      CONTEXT,
    );

    const outcome = report.events.find((event) => event.eventName === 'Page Idle Time');
    expect(outcome?.firedSeparately).toBe(true);
    expect(outcome?.status).toBe('PASS');
    expect(outcome?.checkedIn).toBeUndefined();
  });
});
