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
          {totals.apiOnly > 0 ? <span> (of {totals.events} in the sheet)</span> : null}
        </li>
        <li className="dashboard__total dashboard__total--pass">
          <strong>{totals.passed}</strong> passed
        </li>
        <li className="dashboard__total dashboard__total--fail">
          <strong>{totals.failed}</strong> failed
        </li>
        <li className="dashboard__total dashboard__total--unseen">
          <strong>{totals.notTested}</strong> not tested
        </li>
        {totals.apiOnly > 0 ? (
          <li className="dashboard__total dashboard__total--api">
            <strong>{totals.apiOnly}</strong> API only
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

      {totals.notTested > 0 ? (
        <p className="dashboard__caveat">
          {totals.notTested} events never fired. That may mean they are unimplemented, or simply
          that this run never reached the flow that produces them — the two are not distinguished
          here.
        </p>
      ) : null}

      {totals.apiOnly > 0 ? (
        <p className="dashboard__caveat">
          {totals.apiOnly} events are fired from a server, not the browser — the sheet's
          <strong> Source (Frontend / API)</strong> column says so. Nothing done on the site can
          produce them here. <strong>Check those in the Smartech panel instead.</strong>
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
