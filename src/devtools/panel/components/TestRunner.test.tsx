import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AutomationCommand, AutomationReply, PageDriver } from '../../../automation/commands';
import type { ActionCandidate } from '../../../automation/types';
import type { EventSchema, EventSheet, FieldSchema } from '../../../event-sheet/types';
import type { CapturedPayload } from '../../../shared/payload';
import { TestRunner } from './TestRunner';

const NOW = 2_000_000;

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
  ]),
  warnings: [],
};

function driverReturning(reply: AutomationReply, onSend?: (c: AutomationCommand) => void): PageDriver {
  return {
    send: (command) => {
      onSend?.(command);
      if (command.kind === 'click') {
        return Promise.resolve({ kind: 'clicked' });
      }
      return Promise.resolve(reply);
    },
  };
}

function candidate(confidence: number): ActionCandidate {
  return { selector: '#atc', label: 'Add to Cart', strategy: 'semantic', confidence };
}

function candidates(...found: readonly ActionCandidate[]): AutomationReply {
  return { kind: 'candidates', platform: 'generic', candidates: found };
}

function renderRunner(options: {
  driver: PageDriver;
  sheet?: EventSheet | undefined;
  payloads?: readonly CapturedPayload[];
}) {
  return render(
    <TestRunner
      driver={options.driver}
      sheet={'sheet' in options ? options.sheet : SHEET}
      payloads={options.payloads ?? []}
      sdkReady
      sdkDiagnostic={undefined}
      now={() => NOW}
    />,
  );
}

async function startRun(): Promise<void> {
  fireEvent.change(screen.getByLabelText('Expected event'), { target: { value: 'add_to_cart' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
}

describe('TestRunner', () => {
  it('asks for an Event Sheet before running anything', async () => {
    renderRunner({ driver: driverReturning(candidates(candidate(0.95))), sheet: undefined });

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    expect(await screen.findByText('Upload an Event Sheet first.')).toBeInTheDocument();
  });

  it('clicks without asking when detection is confident', async () => {
    const sent: AutomationCommand[] = [];
    renderRunner({
      driver: driverReturning(candidates(candidate(0.95)), (command) => sent.push(command)),
    });

    await startRun();

    await waitFor(() => {
      expect(sent.some((command) => command.kind === 'click')).toBe(true);
    });
    expect(screen.queryByRole('button', { name: 'Click it' })).not.toBeInTheDocument();
  });

  it('asks before clicking a weak candidate', async () => {
    const sent: AutomationCommand[] = [];
    renderRunner({
      driver: driverReturning(candidates(candidate(0.6)), (command) => sent.push(command)),
    });

    await startRun();

    expect(await screen.findByRole('button', { name: 'Click it' })).toBeInTheDocument();
    // Nothing is clicked until the user says so.
    expect(sent.some((command) => command.kind === 'click')).toBe(false);
  });

  it('always confirms an action that spends money, however confident', async () => {
    renderRunner({ driver: driverReturning(candidates(candidate(0.99))) });

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'checkout' } });
    await startRun();

    expect(await screen.findByText(/can place a real order/)).toBeInTheDocument();
  });

  it('offers the manual picker when nothing was found', async () => {
    renderRunner({ driver: driverReturning(candidates()) });

    await startRun();

    expect(
      await screen.findByRole('button', { name: 'Pick element on the page' }),
    ).toBeInTheDocument();
  });

  it('reports a page that never answered', async () => {
    renderRunner({
      driver: { send: () => Promise.resolve({ kind: 'error', message: 'No response from the page.' }) },
    });

    await startRun();

    expect(await screen.findByRole('alert')).toHaveTextContent('No response from the page.');
  });

  it('validates the captured payload and passes', async () => {
    const driver = driverReturning(candidates(candidate(0.95)));
    const { rerender } = renderRunner({ driver });

    await startRun();
    await waitFor(() => {
      expect(screen.getByText(/Waiting for the event/)).toBeInTheDocument();
    });

    const captured: CapturedPayload = {
      id: 'p1',
      at: NOW + 10,
      eventName: 'add_to_cart',
      args: ['[Smartech Debugger] …', { product_id: 'SKU123' }],
      raw: '[]',
      origin: 'intercepted',
    };

    rerender(
      <TestRunner
        driver={driver}
        sheet={SHEET}
        payloads={[captured]}
        sdkReady
        sdkDiagnostic={undefined}
        now={() => NOW}
      />,
    );

    expect(await screen.findByText('PASS — add_to_cart')).toBeInTheDocument();
  });

  it('runs every automatable event from the sheet without being told which', async () => {
    const multi: EventSheet = {
      events: new Map<string, EventSchema>([
        ['add_to_cart', { name: 'add_to_cart', fields: [field('product_id', true)], source: 'unknown' }],
        ['purchase', { name: 'purchase', fields: [field('order_id', true)], source: 'unknown' }],
        ['page_viewed', { name: 'page_viewed', fields: [], source: 'unknown' }],
      ]),
      warnings: [],
    };

    renderRunner({ driver: driverReturning(candidates(candidate(0.95))), sheet: multi });

    fireEvent.click(screen.getByRole('button', { name: 'Run all from sheet' }));

    // Money-spending and unmappable events are listed as skipped rather than quietly dropped.
    expect(
      await screen.findByText('Spends money or cannot be undone — run this one on its own.'),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        'Nothing on a page can be clicked to produce this — trigger it yourself.',
      ),
    ).toBeInTheDocument();
    // add_to_cart is the one it can drive, and it started on its own.
    await waitFor(() => {
      expect(screen.getByText(/add_to_cart:/)).toBeInTheDocument();
    });
  });

  it('keeps the captured debug log with the run that caused it', async () => {
    const driver = driverReturning(candidates(candidate(0.95)));
    const { rerender } = renderRunner({ driver });

    await startRun();
    await waitFor(() => {
      expect(screen.getByText(/Waiting for the event/)).toBeInTheDocument();
    });

    const captured: CapturedPayload = {
      id: 'p1',
      at: NOW + 10,
      eventName: 'add_to_cart',
      args: ['[Smartech Debugger] Firing EVT:', { product_id: 'SKU123' }],
      raw: JSON.stringify(['[Smartech Debugger] Firing EVT:', { product_id: 'SKU123' }]),
      origin: 'intercepted',
    };

    rerender(
      <TestRunner
        driver={driver}
        sheet={SHEET}
        payloads={[captured]}
        sdkReady
        sdkDiagnostic={undefined}
        now={() => NOW}
      />,
    );

    // The run's own debug log is kept with its result, not just left in the global stream.
    expect(await screen.findByText('PASS')).toBeInTheDocument();
    expect(screen.getByText(/Smartech Debugger/)).toBeInTheDocument();
    expect(screen.getByText('product_id')).toBeInTheDocument();
  });

  it('says when a run produced no debug log at all', async () => {
    renderRunner({
      driver: { send: () => Promise.resolve({ kind: 'error', message: 'No reply from the page.' }) },
    });

    await startRun();

    // Recording happens in an effect, so the results list lands on a later render than the
    // state line — await the list itself rather than the first "FAIL" to appear.
    expect(
      await screen.findByText('No debug log was captured for this run.'),
    ).toBeInTheDocument();
  });

  it('names the events that did fire when the expected one did not', async () => {
    const driver = driverReturning(candidates(candidate(0.95)));
    const { rerender } = renderRunner({ driver });

    await startRun();
    await waitFor(() => {
      expect(screen.getByText(/Waiting for the event/)).toBeInTheDocument();
    });

    // Something fired, just not what the sheet called it — the most useful thing to be told.
    rerender(
      <TestRunner
        driver={driver}
        sheet={SHEET}
        payloads={[
          {
            id: 'other',
            at: NOW + 5,
            eventName: 'ATC',
            args: [],
            raw: '[]',
            origin: 'intercepted',
          },
        ]}
        sdkReady
        sdkDiagnostic={undefined}
        now={() => NOW + 20_000}
      />,
    );

    expect(await screen.findByText('ATC')).toBeInTheDocument();
  });

  it('clicks an unsure match when told to, so a log is actually produced', async () => {
    const sent: AutomationCommand[] = [];
    renderRunner({
      driver: driverReturning(candidates(candidate(0.54)), (command) => sent.push(command)),
    });

    fireEvent.click(screen.getByLabelText('Click best match even when unsure'));
    await startRun();

    // Without the toggle this run would stop at a dialog and capture nothing.
    await waitFor(() => {
      expect(sent.some((command) => command.kind === 'click')).toBe(true);
    });
  });

  it('does not let one ambiguous element stall the rest of the batch', async () => {
    const multi: EventSheet = {
      events: new Map<string, EventSchema>([
        ['add_to_cart', { name: 'add_to_cart', fields: [field('product_id', true)], source: 'unknown' }],
        ['newsletter_signup', { name: 'newsletter_signup', fields: [], source: 'unknown' }],
      ]),
      warnings: [],
    };

    // Every detection comes back weak, so every run wants confirmation.
    renderRunner({ driver: driverReturning(candidates(candidate(0.6))), sheet: multi });

    fireEvent.click(screen.getByRole('button', { name: 'Run all from sheet' }));

    // Seen live: the batch stopped on the first dialog and everything after it failed.
    await waitFor(() => {
      expect(screen.getAllByText('NEEDS REVIEW')).toHaveLength(2);
    });
  });

  it('fails when the SDK is absent', async () => {
    render(
      <TestRunner
        driver={driverReturning(candidates(candidate(0.95)))}
        sheet={SHEET}
        payloads={[]}
        sdkReady={false}
        sdkDiagnostic="never defined"
        now={() => NOW}
      />,
    );

    await startRun();

    expect(await screen.findByRole('alert')).toHaveTextContent('never defined');
  });
});

// The tick interval would otherwise keep the fake timers running between tests.
vi.useRealTimers();
