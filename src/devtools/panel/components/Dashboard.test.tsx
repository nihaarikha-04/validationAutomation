import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RunReport } from '../../../reports/types';
import { Dashboard } from './Dashboard';

const REPORT: RunReport = {
  site: 'shop.example.com',
  sheetName: 'events.xlsx',
  sdkReady: true,
  at: 1_735_689_600_000,
  totals: { events: 3, tested: 2, passed: 1, failed: 1, warning: 0, apiOnly: 0, payment: 0, reachable: 3 },
  events: [],
  undocumented: [],
  channel: 'debug-payload',
};

describe('Dashboard', () => {
  it('names the site and the sheet the run was checked against', () => {
    render(<Dashboard report={REPORT} onExport={() => undefined} />);

    expect(screen.getByText('shop.example.com')).toBeInTheDocument();
    expect(screen.getByText('events.xlsx')).toBeInTheDocument();
  });

  it('shows the totals the report computed', () => {
    render(<Dashboard report={REPORT} onExport={() => undefined} />);

    const totals = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(totals).toEqual([
      '3 reachable from the browser',
      '1 passed',
      '0 warning',
      '1 not triggered',
    ]);
  });

  /** PLAN.md Terminology: never imply the network call was checked when only the payload was. */
  it('says only the debug payload was checked', () => {
    render(<Dashboard report={REPORT} onExport={() => undefined} />);

    expect(screen.getByText(/debug payload/)).toBeInTheDocument();
  });

  it('says a missing event may be unreached rather than absent', () => {
    render(<Dashboard report={REPORT} onExport={() => undefined} />);

    expect(screen.getByText(/never fired/)).toHaveTextContent(
      /confirm the flow was reachable before reporting one as a defect/,
    );
  });

  it('hands a CSV export to the caller, named after the run', () => {
    const saved: { contents: string; fileName: string }[] = [];
    render(
      <Dashboard
        report={REPORT}
        onExport={(contents, fileName) => saved.push({ contents, fileName })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    expect(saved[0]?.fileName).toBe('smartech-shop-example-com-2025-01-01-00-00-00.csv');
    expect(saved[0]?.contents.startsWith('Event,')).toBe(true);
  });

  it('exports the whole report as JSON, including the channel it checked', () => {
    const saved: string[] = [];
    render(<Dashboard report={REPORT} onExport={(contents) => saved.push(contents)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));

    expect(JSON.parse(saved[0] ?? '{}')).toMatchObject({
      site: 'shop.example.com',
      channel: 'debug-payload',
    });
  });
});

describe('payment events on the dashboard', () => {
  const WITH_PAYMENT: RunReport = {
    ...REPORT,
    totals: { ...REPORT.totals, payment: 4, warning: 0, reachable: 3 },
  };

  it('counts them separately from the gap', () => {
    render(<Dashboard report={WITH_PAYMENT} onExport={() => undefined} />);

    expect(screen.getByText(/^4$/).parentElement).toHaveTextContent('4 payment');
  });

  it('says why they were not triggered, and that they should not have been', () => {
    render(<Dashboard report={WITH_PAYMENT} onExport={() => undefined} />);

    expect(screen.getByText(/only fire when money actually moves/)).toHaveTextContent(
      /putting a live card through the site to satisfy a report is not a test/,
    );
  });

  /** The distinction the caveat exists to make. */
  it('says checkout is not counted as payment', () => {
    render(<Dashboard report={WITH_PAYMENT} onExport={() => undefined} />);

    expect(screen.getByText(/only fire when money actually moves/)).toHaveTextContent(
      /is not counted here/,
    );
  });

  it('shows nothing about payment when the sheet has none', () => {
    render(<Dashboard report={REPORT} onExport={() => undefined} />);

    expect(screen.queryByText(/only fire when money actually moves/)).toBeNull();
  });
});
