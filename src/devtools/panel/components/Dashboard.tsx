import { reportFileName } from '../../../reports/build';
import { toCsv } from '../../../reports/export-csv';
import type { RunReport } from '../../../reports/types';

export interface DashboardProps {
  readonly report: RunReport;
  /** Called with the file's contents and name; the download itself happens at the composition root. */
  readonly onExport: (contents: string, fileName: string) => void;
}

/**
 * The run at a glance: where it ran, what it checked, and how the sheet's events came out.
 *
 * Renders the report and decides nothing. Every number here was computed by `buildReport`.
 */
export function Dashboard({ report, onExport }: DashboardProps) {
  const { totals } = report;

  return (
    <section className="dashboard">
      <h2>Run summary</h2>

      <dl className="dashboard__facts">
        <div>
          <dt>Site</dt>
          <dd>{report.site === '' ? 'unknown' : report.site}</dd>
        </div>
        <div>
          <dt>SDK</dt>
          <dd>{report.sdkReady ? '🟢 detected' : '🔴 not detected'}</dd>
        </div>
        <div>
          <dt>Event Sheet</dt>
          <dd>{report.sheetName}</dd>
        </div>
        <div>
          <dt>Run at</dt>
          <dd>{new Date(report.at).toLocaleString()}</dd>
        </div>
      </dl>

      <ul className="dashboard__totals">
        <li className="dashboard__total">
          <strong>{totals.reachable}</strong> reachable from the browser
          {totals.apiOnly + totals.payment > 0 ? (
            <span> (of {totals.events} in the sheet)</span>
          ) : null}
        </li>
        <li className="dashboard__total dashboard__total--pass">
          <strong>{totals.passed}</strong> passed
        </li>
        <li className="dashboard__total dashboard__total--warn">
          <strong>{totals.warning}</strong> warning
        </li>
        <li className="dashboard__total dashboard__total--fail">
          <strong>{totals.failed}</strong> not triggered
        </li>
        {totals.apiOnly > 0 ? (
          <li className="dashboard__total dashboard__total--api">
            <strong>{totals.apiOnly}</strong> API only
          </li>
        ) : null}
        {totals.payment > 0 ? (
          <li className="dashboard__total dashboard__total--payment">
            <strong>{totals.payment}</strong> payment
          </li>
        ) : null}
      </ul>

      {/*
        Stated, never implied. Until Phase 7 captures the network call, "passed" means the debug
        payload was correct — not that the right data left the browser.
      */}
      <p className="dashboard__caveat">
        Checked against the Smartech <strong>debug payload</strong> only. The outbound network call
        has not been verified.
      </p>

      {totals.warning > 0 ? (
        <p className="dashboard__caveat">
          {totals.warning} events fired but disagree with the sheet — a renamed key, a datatype
          that does not match, a field the sheet expects and the payload omits. Open one to see
          which field and why.
        </p>
      ) : null}

      {totals.failed > 0 ? (
        <p className="dashboard__caveat">
          {totals.failed} events never fired. That may mean they are unimplemented, or that this
          run never reached the flow that produces them — the two are not distinguished here, so
          confirm the flow was reachable before reporting one as a defect.
        </p>
      ) : null}

      {totals.apiOnly > 0 ? (
        <p className="dashboard__caveat">
          {totals.apiOnly} events are fired from a server, not the browser — the sheet's
          <strong> Source (Frontend / API)</strong> column says so. Nothing done on the site can
          produce them here. <strong>Check those in the Smartech panel instead.</strong>
        </p>
      ) : null}

      {totals.payment > 0 ? (
        <p className="dashboard__caveat">
          {totals.payment} events only fire when money actually moves — a card is charged, an order
          is placed, a refund is issued. This run did not trigger them, and it should not: putting a
          live card through the site to satisfy a report is not a test.{' '}
          <strong>Trigger these by hand on a test order, or check them in the Smartech panel.</strong>{' '}
          Starting or completing a <em>checkout</em> is not counted here — that costs nothing and is
          expected to be swept like any other flow.
        </p>
      ) : null}

      {report.undocumented.length > 0 ? (
        <p className="dashboard__caveat">
          The site also fired {report.undocumented.length} event
          {report.undocumented.length === 1 ? '' : 's'} the sheet does not describe:{' '}
          {report.undocumented.map((name) => (
            <code key={name}>{name} </code>
          ))}
        </p>
      ) : null}

      <div className="dashboard__exports">
        <button
          type="button"
          onClick={() =>
            onExport(JSON.stringify(report, null, 2), reportFileName(report, 'json'))
          }
        >
          Export JSON
        </button>
        <button type="button" onClick={() => onExport(toCsv(report), reportFileName(report, 'csv'))}>
          Export CSV
        </button>
      </div>
    </section>
  );
}
