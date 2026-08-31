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
    ['add_to_cart', { name: 'add_to_cart', fields: [field('product_id', true)] }],
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
        ['add_to_cart', { name: 'add_to_cart', fields: [field('product_id', true)] }],
        ['purchase', { name: 'purchase', fields: [field('order_id', true)] }],
        ['newsletter_signup', { name: 'newsletter_signup', fields: [] }],
      ]),
      warnings: [],
    };

    renderRunner({ driver: driverReturning(candidates(candidate(0.95))), sheet: multi });

    fireEvent.click(screen.getByRole('button', { name: 'Run all from sheet' }));

    // Money-spending and unmappable events are listed as skipped rather than quietly dropped.
    expect(await screen.findByText('Spends money — run this one on its own.')).toBeInTheDocument();
    expect(
      await screen.findByText('No page action maps to this event name — trigger it yourself.'),
    ).toBeInTheDocument();
    // add_to_cart is the one it can drive, and it started on its own.
    await waitFor(() => {
      expect(screen.getByText(/add_to_cart:/)).toBeInTheDocument();
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
