import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AutomationReply, PageDriver } from '../../automation/commands';
import type { CaptureStats, CapturedPayload, PayloadSource } from '../../shared/payload';
import {
  HOSTNAME_EXPRESSION,
  type EvaluationOutcome,
  type PageEvaluator,
} from '../../shared/sdk';
import type { NavigationSource } from './chrome-navigation';
import { App } from './App';

const quietNavigation: NavigationSource = { subscribe: () => () => undefined };

const noWait = (): Promise<void> => Promise.resolve();
const FIXED_NOW = 1_735_689_600_000;

/** The panel's browser dependencies are injected, so no chrome.* stub is needed here. */
function evaluator(sdkOutcome: EvaluationOutcome): PageEvaluator {
  return {
    evaluate(expression: string): Promise<EvaluationOutcome> {
      if (expression === HOSTNAME_EXPRESSION) {
        return Promise.resolve({ kind: 'value', value: 'shop.example.com' });
      }
      return Promise.resolve(sdkOutcome);
    },
  };
}

interface ControllablePayloadSource extends PayloadSource {
  emit(payload: CapturedPayload): void;
}

function fakePayloadSource(): ControllablePayloadSource {
  const listeners = new Set<(payload: CapturedPayload) => void>();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeStats(_listener: (stats: CaptureStats) => void) {
      return () => undefined;
    },
    emit(payload) {
      for (const listener of listeners) {
        listener(payload);
      }
    },
  };
}

/** Answers nothing useful; the runner is exercised properly in TestRunner.test.tsx. */
const idleDriver: PageDriver = {
  send: (): Promise<AutomationReply> =>
    Promise.resolve({ kind: 'error', message: 'not driven in this test' }),
};

function renderApp(source: PayloadSource = fakePayloadSource()) {
  return render(
    <App
      evaluator={evaluator({ kind: 'value', value: 'enabled' })}
      wait={noWait}
      payloadSource={source}
      driver={idleDriver}
      navigation={quietNavigation}
      now={() => FIXED_NOW}
      download={() => undefined}
    />,
  );
}

const CSV = [
  'Event Name,Payload,Payload Data Type,Attribute,Attribute Data Type,Mandatory,Description,Example Value',
  'add_to_cart,product_id,String,prid,String,Yes,Product SKU,SKU123',
  ',price,Number,pr,Number,Yes,Unit price,499.00',
].join('\n');

const DEBUG_LINE = "[Smartech Debugger] Firing EVT: 'Add to Cart' with payload: ";

const CAPTURED: CapturedPayload = {
  id: 'p1',
  at: FIXED_NOW,
  eventName: 'Add to Cart',
  args: [DEBUG_LINE, { name: 'Add to Cart', product_id: 'SKU123' }],
  raw: JSON.stringify([DEBUG_LINE, { name: 'Add to Cart', product_id: 'SKU123' }]),
  origin: 'intercepted',
};

describe('App', () => {
  it('renders the panel heading', () => {
    renderApp();

    expect(
      screen.getByRole('heading', { name: 'Smartech Event Validator', level: 1 }),
    ).toBeInTheDocument();
  });

  it('shows the inspected hostname and a detected SDK', async () => {
    renderApp();

    expect(await screen.findByText('shop.example.com')).toBeInTheDocument();
    expect(await screen.findByText('🟢 detected')).toBeInTheDocument();
    expect(await screen.findByText('🟢 enabled')).toBeInTheDocument();
  });

  it('reports a diagnostic when the SDK never appears', async () => {
    render(
      <App
        evaluator={evaluator({ kind: 'value', value: 'missing' })}
        wait={noWait}
        payloadSource={fakePayloadSource()}
        driver={idleDriver}
        navigation={quietNavigation}
        now={() => FIXED_NOW}
      download={() => undefined}
      />,
    );

    expect(await screen.findByText('🔴 not detected')).toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent('never defined');
  });

  it('renders the event tree after a CSV upload', async () => {
    renderApp();

    fireEvent.change(screen.getByLabelText('Event Sheet'), {
      target: { files: [new File([CSV], 'sheet.csv', { type: 'text/csv' })] },
    });

    expect(await screen.findByText('1 event')).toBeInTheDocument();
    // The runner's event dropdown also lists add_to_cart, so match the tree's <code> entry.
    expect(
      (await screen.findAllByText('add_to_cart')).some((node) => node.tagName === 'CODE'),
    ).toBe(true);
    expect(await screen.findByText('product_id')).toBeInTheDocument();
    expect(await screen.findByText('prid')).toBeInTheDocument();
  });

  it('starts with an empty payload stream', () => {
    renderApp();

    expect(screen.getByText('0 payloads')).toBeInTheDocument();
  });

  it('appends a captured payload to the stream', () => {
    const source = fakePayloadSource();
    renderApp(source);

    act(() => {
      source.emit(CAPTURED);
    });

    expect(screen.getByText('1 payload')).toBeInTheDocument();
    expect(screen.getByText('Add to Cart')).toBeInTheDocument();
  });

  it('clears the stream on request', () => {
    const source = fakePayloadSource();
    renderApp(source);

    act(() => {
      source.emit(CAPTURED);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.getByText('0 payloads')).toBeInTheDocument();
  });

  it('adds pasted debug objects to the same stream', () => {
    renderApp();

    // The sweep's field-values editor is a textbox too, so this must be specific.
    fireEvent.change(screen.getByPlaceholderText(/add_to_cart/), {
      target: { value: "{event: 'add_to_cart'} {event: 'purchase'}" },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add payloads' }));

    expect(screen.getByText('2 payloads')).toBeInTheDocument();
    expect(screen.getAllByText('pasted')).toHaveLength(2);
  });

  it('shows no verdict until an Event Sheet is loaded', () => {
    const source = fakePayloadSource();
    renderApp(source);

    act(() => {
      source.emit(CAPTURED);
    });

    expect(screen.queryByText('PASS')).not.toBeInTheDocument();
    expect(screen.queryByText('FAIL')).not.toBeInTheDocument();
  });

  // End to end across three phases: sheet parsing → capture → validation.
  it('passes a captured payload that matches the uploaded sheet', async () => {
    const source = fakePayloadSource();
    renderApp(source);

    fireEvent.change(screen.getByLabelText('Event Sheet'), {
      target: { files: [new File([CSV], 'sheet.csv', { type: 'text/csv' })] },
    });
    expect(await screen.findByText('1 event')).toBeInTheDocument();

    act(() => {
      source.emit({
        ...CAPTURED,
        eventName: 'add_to_cart',
        args: [DEBUG_LINE, { product_id: 'SKU123', price: 499 }],
      });
    });

    expect(screen.getByText('PASS')).toBeInTheDocument();
  });

  it('fails a captured payload missing a required field', async () => {
    const source = fakePayloadSource();
    renderApp(source);

    fireEvent.change(screen.getByLabelText('Event Sheet'), {
      target: { files: [new File([CSV], 'sheet.csv', { type: 'text/csv' })] },
    });
    expect(await screen.findByText('1 event')).toBeInTheDocument();

    act(() => {
      source.emit({
        ...CAPTURED,
        eventName: 'add_to_cart',
        args: [DEBUG_LINE, { product_id: 'SKU123' }],
      });
    });

    expect(screen.getByText('FAIL')).toBeInTheDocument();
    // The per-field table names what went wrong, not just the verdict.
    expect(screen.getByText('missing')).toBeInTheDocument();
  });

  it('marks an event the sheet does not describe as unknown', async () => {
    const source = fakePayloadSource();
    renderApp(source);

    fireEvent.change(screen.getByLabelText('Event Sheet'), {
      target: { files: [new File([CSV], 'sheet.csv', { type: 'text/csv' })] },
    });
    expect(await screen.findByText('1 event')).toBeInTheDocument();

    act(() => {
      source.emit({ ...CAPTURED, eventName: 'checkout' });
    });

    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
  });

  it('reports a parse failure without adding anything', () => {
    renderApp();

    fireEvent.change(screen.getByPlaceholderText(/add_to_cart/), {
      target: { value: '{event: }' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add payloads' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Unexpected character');
    expect(screen.getByText('0 payloads')).toBeInTheDocument();
  });
});
