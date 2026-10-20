import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EventTree } from './EventTree';
import type { EventSchema, EventSheet } from '../../../event-sheet/types';
import type { AutomationReply, PageDriver } from '../../../automation/commands';

function sheetWith(trigger: string | undefined): EventSheet {
  const event: EventSchema = {
    name: 'Product Search',
    fields: [],
    source: 'unknown',
    trigger: trigger === undefined ? undefined : { source: trigger },
  };

  return { events: new Map([[event.name, event]]), warnings: [] };
}

/**
 * The reading is a claim about the client's sentence, and only a person can check it. Showing it
 * beside their own words is what makes that possible without leaving the panel — the alternative
 * is finding out it was wrong several stages later, as a step that clicked nothing.
 */
describe('the trigger condition in the sheet view', () => {
  const PROSE =
    "Click the search icon in the header, type a keyword (e.g. 'jacket'), then press Enter.";

  it('shows the client’s own words', () => {
    render(<EventTree sheet={sheetWith(PROSE)} />);

    expect(screen.getByText(PROSE)).toBeInTheDocument();
  });

  it('shows what was read out of them, in order', () => {
    render(<EventTree sheet={sheetWith(PROSE)} />);

    // The innermost items only: the event's own <li> wraps all of this text as well.
    const steps = screen
      .getAllByRole('listitem')
      .filter((item) => item.querySelector('li') === null)
      .map((item) => item.textContent ?? '');

    expect(steps[0]).toContain('search');
    expect(steps[1]).toContain('keyword = jacket');
    expect(steps[2]).toContain('Enter');
  });

  /** A pause is the one place a person is meant to step in, so it must be visible as one. */
  it('says when a step will stop and ask the tester', () => {
    render(<EventTree sheet={sheetWith('Enter the registered Email, then click Login.')} />);

    expect(screen.getByText(/ask the tester for their email/i)).toBeInTheDocument();
  });

  /**
   * Right for a webhook, wrong for a sentence that describes clicking something — and the reader
   * is told which, rather than being shown an empty space to interpret.
   */
  it('says plainly when nothing was read, rather than showing nothing', () => {
    render(
      <EventTree
        sheet={sheetWith('BACKEND / SHOPIFY WEBHOOK — does not fire from any storefront click.')}
      />,
    );

    expect(screen.getByText(/Nothing to do was read out of this/)).toBeInTheDocument();
  });

  it('shows no trigger block for an event the sheet says nothing about', () => {
    render(<EventTree sheet={sheetWith(undefined)} />);

    expect(screen.queryByText(/Nothing to do was read/)).toBeNull();
  });
});

/**
 * Checking the steps against the page as it is now.
 *
 * The step that comes out of a client's sentence is a *claim* — "there is something here called
 * search" — and the cheapest moment to find out it is wrong is before a run rather than halfway
 * through one. Nothing is clicked.
 */
describe('checking a trigger against the page', () => {
  const PROSE = "Click the search icon, then click 'Logout'.";

  function driverSaying(replies: readonly AutomationReply[]): PageDriver {
    const remaining = [...replies];
    return { send: () => Promise.resolve(remaining.shift() ?? { kind: 'error', message: 'x' }) };
  }

  const FOUND: AutomationReply = {
    kind: 'resolved',
    resolution: { kind: 'found', match: { selector: '#s', label: 'Search', risk: 'safe' } },
  };
  const NONE: AutomationReply = { kind: 'resolved', resolution: { kind: 'none' } };

  it('offers the check only when a page is being driven', () => {
    render(<EventTree sheet={sheetWith(PROSE)} />);

    expect(screen.queryByRole('button', { name: /on the page now/ })).toBeNull();
  });

  it('says which controls are there and which are not', async () => {
    render(<EventTree sheet={sheetWith(PROSE)} driver={driverSaying([FOUND, NONE])} />);

    fireEvent.click(screen.getByRole('button', { name: /on the page now/ }));

    expect(await screen.findByText(/found/)).toBeInTheDocument();
    expect(await screen.findByText('not on this page')).toBeInTheDocument();
  });

  /** A pause was never going to be on the page, and must not read as a missing control. */
  it('does not report a pause as missing', async () => {
    render(
      <EventTree
        sheet={sheetWith('Enter the registered Email, then click Login.')}
        driver={driverSaying([FOUND])}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /on the page now/ }));

    expect(await screen.findByText('waits for you')).toBeInTheDocument();
  });
});
