import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AutomationCommand, AutomationReply, PageDriver } from '../../../automation/commands';
import type { Clickable } from '../../../automation/sweep';
import type { EventSchema, EventSheet, FieldSchema } from '../../../event-sheet/types';
import type { CapturedPayload } from '../../../shared/payload';
import type { NavigationSource } from '../chrome-navigation';
import { PageSweep } from './PageSweep';

/** Never fires, so tests drive the sweep themselves. */
const quietNavigation: NavigationSource = { subscribe: () => () => undefined };

const NOW = 3_000_000;

function field(payloadName: string, required: boolean): FieldSchema {
  return {
    payloadName,
    payloadType: 'string',
    attributeName: '',
    attributeType: 'unknown',
    required,
    description: '',
    example: '',
  };
}

const SHEET: EventSheet = {
  events: new Map<string, EventSchema>([
    ['add_to_cart', { name: 'add_to_cart', fields: [field('product_id', true)], source: 'unknown' }],
    ['never_fires', { name: 'never_fires', fields: [], source: 'unknown' }],
  ]),
  warnings: [],
};

const CLICKABLES: readonly Clickable[] = [
  { selector: '#atc', label: 'Add to Cart', risk: 'safe', group: '#atc-kind' },
  { selector: '#pay', label: 'Place order', risk: 'destructive', group: '#pay-kind' },
  { selector: '#about', label: 'About us', risk: 'navigates', group: '#about-kind' },
];

function driverWith(onSend: (command: AutomationCommand) => void): PageDriver {
  return {
    send: (command) => {
      onSend(command);
      if (command.kind === 'clickables') {
        return Promise.resolve({ kind: 'clickables', clickables: CLICKABLES } as AutomationReply);
      }
      return Promise.resolve({ kind: 'clicked' } as AutomationReply);
    },
  };
}

function payload(eventName: string): CapturedPayload {
  const args = ['[Smartech Debugger]', { product_id: 'SKU123' }];
  return { id: eventName, at: NOW, eventName, args, raw: JSON.stringify(args), origin: 'intercepted' };
}

describe('PageSweep', () => {
  it('clicks only safe controls by default', async () => {
    const sent: AutomationCommand[] = [];
    render(
      <PageSweep driver={driverWith((c) => sent.push(c))} sheet={SHEET} payloads={[]} now={() => NOW} navigation={quietNavigation} site="shop.test" sheetName="sheet.csv" sdkReady onExport={() => undefined} settleMs={0} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sweep page' }));

    await waitFor(() => {
      const clicks = sent.filter((command) => command.kind === 'click');
      expect(clicks).toHaveLength(1);
    });
    // Place order and the outbound link are left alone unless explicitly allowed.
    expect(sent.filter((c) => c.kind === 'click').map((c) => c.selector)).toEqual(['#atc']);
  });

  it('includes money-spending controls only when explicitly allowed', async () => {
    const sent: AutomationCommand[] = [];
    render(
      <PageSweep driver={driverWith((c) => sent.push(c))} sheet={SHEET} payloads={[]} now={() => NOW} navigation={quietNavigation} site="shop.test" sheetName="sheet.csv" sdkReady onExport={() => undefined} settleMs={0} />,
    );

    fireEvent.click(screen.getByLabelText(/Include Pay \/ Delete \/ Sign out/));
    fireEvent.click(screen.getByRole('button', { name: 'Sweep page' }));

    await waitFor(() => {
      expect(sent.filter((c) => c.kind === 'click').map((c) => c.selector)).toEqual(['#atc', '#pay']);
    });
  });

  it('reports which sheet events fired and which never did', async () => {
    render(
      <PageSweep
        driver={driverWith(() => undefined)}
        sheet={SHEET}
        payloads={[payload('add_to_cart')]}
        now={() => NOW}
        navigation={quietNavigation} site="shop.test" sheetName="sheet.csv" sdkReady onExport={() => undefined}
        settleMs={0}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sweep page' }));

    expect(await screen.findByText('PASS')).toBeInTheDocument();
    expect(await screen.findByText('NOT SEEN')).toBeInTheDocument();
  });

  it('reports on events captured before the sweep began', async () => {
    // Regression, ethniq.com: the report was built only from what the sweep itself triggered, so
    // a tester who logged in and clicked through by hand got "5 passed, 0 failed" while the
    // stream held seven passes and a failing event fired a minute earlier.
    const earlier: CapturedPayload = { ...payload('add_to_cart'), at: NOW - 60_000 };

    render(
      <PageSweep
        driver={driverWith(() => undefined)}
        sheet={SHEET}
        payloads={[earlier]}
        now={() => NOW}
        navigation={quietNavigation} site="shop.test" sheetName="sheet.csv" sdkReady onExport={() => undefined}
        settleMs={0}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sweep page' }));

    expect(await screen.findByText('PASS')).toBeInTheDocument();
  });

  it('credits a sheet event fired under a differently formatted name', async () => {
    const sheet: EventSheet = {
      events: new Map<string, EventSchema>([
        ['Add to Cart', { name: 'Add to Cart', fields: [field('product_id', true)], source: 'unknown' }],
      ]),
      warnings: [],
    };

    render(
      <PageSweep
        driver={driverWith(() => undefined)}
        sheet={sheet}
        payloads={[payload('add_to_cart')]}
        now={() => NOW}
        navigation={quietNavigation} site="shop.test" sheetName="sheet.csv" sdkReady onExport={() => undefined}
        settleMs={0}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sweep page' }));

    // Counted as covered, but the disagreement between sheet and site stays visible.
    expect(await screen.findByText('PASS')).toBeInTheDocument();
    expect(await screen.findByText(/same words, different formatting/)).toBeInTheDocument();
  });

  it('credits a sheet event fired under a synonymous name', async () => {
    const sheet: EventSheet = {
      events: new Map<string, EventSchema>([
        ['Sign in', { name: 'Sign in', fields: [field('product_id', true)], source: 'unknown' }],
      ]),
      warnings: [],
    };

    render(
      <PageSweep
        driver={driverWith(() => undefined)}
        sheet={sheet}
        payloads={[payload('login')]}
        now={() => NOW}
        navigation={quietNavigation} site="shop.test" sheetName="sheet.csv" sdkReady onExport={() => undefined}
        settleMs={0}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sweep page' }));

    // "login" is not "Sign in", but reporting it as unknown would be unhelpful and wrong.
    expect(await screen.findByText(/synonymous name/)).toBeInTheDocument();
  });

  it('names events the site fires that the sheet does not describe', async () => {
    render(
      <PageSweep
        driver={driverWith(() => undefined)}
        sheet={SHEET}
        payloads={[payload('undocumented_event')]}
        now={() => NOW}
        navigation={quietNavigation} site="shop.test" sheetName="sheet.csv" sdkReady onExport={() => undefined}
        settleMs={0}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sweep page' }));

    expect(await screen.findByText('undocumented_event')).toBeInTheDocument();
  });

  it('skips an element that vanished and keeps going', async () => {
    const clicked: string[] = [];
    const driver: PageDriver = {
      send: (command) => {
        if (command.kind === 'clickables') {
          return Promise.resolve({
            kind: 'clickables',
            clickables: [
              { selector: '#gone', label: 'Gone', risk: 'safe', group: '#gone-kind' },
              { selector: '#here', label: 'Here', risk: 'safe', group: '#here-kind' },
            ],
          } as AutomationReply);
        }
        if (command.kind === 'click') {
          clicked.push(command.selector);
          return Promise.resolve(
            (command.selector === '#gone' ? { kind: 'not-found' } : { kind: 'clicked' }) as AutomationReply,
          );
        }
        return Promise.resolve({ kind: 'dismissed' } as AutomationReply);
      },
    };
    render(<PageSweep driver={driver} sheet={SHEET} payloads={[]} now={() => NOW} navigation={quietNavigation} site="shop.test" sheetName="sheet.csv" sdkReady onExport={() => undefined} settleMs={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sweep page' }));

    // A missing element means the page changed, not that it died — the sweep must continue.
    await waitFor(() => {
      expect(clicked).toEqual(['#gone', '#here']);
    });
  });

  it('re-lists the page each round so a re-render does not end the sweep', async () => {
    const clicked: string[] = [];
    let listings = 0;
    const driver: PageDriver = {
      send: (command) => {
        if (command.kind === 'clickables') {
          listings += 1;
          // The page renders a different control after the first click.
          return Promise.resolve({
            kind: 'clickables',
            clickables:
              listings === 1
                ? [{ selector: '#first', label: 'First', risk: 'safe', group: '#first-kind' }]
                : [
                    { selector: '#first', label: 'First', risk: 'safe', group: '#first-kind' },
                    { selector: '#appeared', label: 'Appeared', risk: 'safe', group: '#appeared-kind' },
                  ],
          } as AutomationReply);
        }
        if (command.kind === 'click') {
          clicked.push(command.selector);
        }
        return Promise.resolve(
          (command.kind === 'click' ? { kind: 'clicked' } : { kind: 'dismissed' }) as AutomationReply,
        );
      },
    };
    render(<PageSweep driver={driver} sheet={SHEET} payloads={[]} now={() => NOW} navigation={quietNavigation} site="shop.test" sheetName="sheet.csv" sdkReady onExport={() => undefined} settleMs={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sweep page' }));

    await waitFor(() => {
      expect(clicked).toEqual(['#first', '#appeared']);
    });
  });

  it('closes whatever a click opened before the next one', async () => {
    const sent: AutomationCommand[] = [];
    render(
      <PageSweep driver={driverWith((c) => sent.push(c))} sheet={SHEET} payloads={[]} now={() => NOW} navigation={quietNavigation} site="shop.test" sheetName="sheet.csv" sdkReady onExport={() => undefined} settleMs={0} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sweep page' }));

    await waitFor(() => {
      expect(sent.some((command) => command.kind === 'dismiss')).toBe(true);
    });
  });

  it('carries on by itself when the page changes', async () => {
    let announce: ((url: string) => void) | undefined;
    const navigation: NavigationSource = {
      subscribe: (listener) => {
        announce = listener;
        return () => undefined;
      },
    };
    const sent: AutomationCommand[] = [];

    render(
      <PageSweep
        driver={driverWith((command) => sent.push(command))}
        sheet={SHEET}
        payloads={[]}
        now={() => NOW}
        navigation={navigation}
        site="shop.test"
        sheetName="sheet.csv"
        sdkReady
        onExport={() => undefined}
        settleMs={0}
      />,
    );

    // No button pressed: landing on a new page is enough.
    act(() => {
      announce?.('https://shop.test/next');
    });

    await waitFor(() => {
      expect(sent.some((command) => command.kind === 'clickables')).toBe(true);
    });
  });

  it('stops when the page stops responding', async () => {
    const driver: PageDriver = {
      send: (command) =>
        Promise.resolve(
          command.kind === 'clickables'
            ? ({ kind: 'clickables', clickables: [
                { selector: '#a', label: 'A', risk: 'safe', group: '#a-kind' },
                { selector: '#b', label: 'B', risk: 'safe', group: '#b-kind' },
                { selector: '#c', label: 'C', risk: 'safe', group: '#c-kind' },
              ] } as AutomationReply)
            : ({ kind: 'error', message: 'gone' } as AutomationReply),
        ),
    };
    render(<PageSweep driver={driver} sheet={SHEET} payloads={[]} now={() => NOW} navigation={quietNavigation} site="shop.test" sheetName="sheet.csv" sdkReady onExport={() => undefined} settleMs={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sweep page' }));

    // A click that navigates kills the page; carrying on would report nonsense.
    expect(await screen.findByRole('alert')).toHaveTextContent('stopped responding');
  });
});

vi.useRealTimers();

describe('PageSweep, reporting without a fresh sweep', () => {
  it('builds a report from the captured stream on demand', async () => {
    // A ten-minute crawl produced 241 payloads and no report, because the sheet was being
    // re-mapped while it ran. The payloads were never the problem.
    render(
      <PageSweep
        driver={driverWith(() => undefined)}
        sheet={SHEET}
        payloads={[payload('add_to_cart')]}
        now={() => NOW}
        navigation={quietNavigation} site="shop.test" sheetName="sheet.csv" sdkReady onExport={() => undefined}
        settleMs={0}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Report on what was captured/ }));

    expect(await screen.findByText('PASS')).toBeInTheDocument();
  });

  it('says why there is no report when no sheet is loaded', async () => {
    render(
      <PageSweep
        driver={driverWith(() => undefined)}
        sheet={undefined}
        payloads={[payload('add_to_cart')]}
        now={() => NOW}
        navigation={quietNavigation} site="shop.test" sheetName="sheet.csv" sdkReady onExport={() => undefined}
        settleMs={0}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Report on what was captured/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No Event Sheet is loaded');
  });

  it('offers nothing to report when the stream is empty', () => {
    render(
      <PageSweep
        driver={driverWith(() => undefined)}
        sheet={SHEET}
        payloads={[]}
        now={() => NOW}
        navigation={quietNavigation} site="shop.test" sheetName="sheet.csv" sdkReady onExport={() => undefined}
        settleMs={0}
      />,
    );

    expect(screen.getByRole('button', { name: /Report on what was captured/ })).toBeDisabled();
  });
});
