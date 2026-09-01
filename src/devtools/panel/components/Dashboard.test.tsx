import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RunReport } from '../../../reports/types';
import { Dashboard } from './Dashboard';

const REPORT: RunReport = {
  site: 'shop.example.com',
  sheetName: 'events.xlsx',
  sdkReady: true,
  at: 1_735_689_600_000,
  totals: { events: 3, tested: 2, passed: 1, failed: 1, notTested: 1, apiOnly: 0, reachable: 3 },
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
      '1 failed',
      '1 not tested',
    ]);
  });

  /** PLAN.md Terminology: never imply the network call was checked when only the payload was. */
  it('says only the debug payload was checked', () => {
    render(<Dashboard report={REPORT} onExport={() => undefined} />);

    expect(screen.getByText(/debug payload/)).toBeInTheDocument();
  });

  it('does not present events that never fired as failures', () => {
    render(<Dashboard report={REPORT} onExport={() => undefined} />);

    expect(screen.getByText(/never fired/)).toHaveTextContent(
      /they are unimplemented, or simply that this run never reached/,
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
