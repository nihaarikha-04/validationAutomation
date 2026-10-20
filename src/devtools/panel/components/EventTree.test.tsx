import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EventTree } from './EventTree';
import type { EventSchema, EventSheet } from '../../../event-sheet/types';

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
