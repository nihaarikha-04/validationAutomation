import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  HOSTNAME_EXPRESSION,
  type EvaluationOutcome,
  type PageEvaluator,
} from '../../shared/sdk';
import { App } from './App';

const noWait = (): Promise<void> => Promise.resolve();

/** The panel's only browser dependency is injected, so no chrome.* stub is needed here. */
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

const CSV = [
  'Event Name,Payload,Payload Data Type,Attribute,Attribute Data Type,Mandatory,Description,Example Value',
  'add_to_cart,product_id,String,prid,String,Yes,Product SKU,SKU123',
  ',price,Number,pr,Number,Yes,Unit price,499.00',
].join('\n');

describe('App', () => {
  it('renders the panel heading', () => {
    render(<App evaluator={evaluator({ kind: 'value', value: 'enabled' })} wait={noWait} />);

    expect(
      screen.getByRole('heading', { name: 'Smartech Event Validator', level: 1 }),
    ).toBeInTheDocument();
  });

  it('shows the inspected hostname and a detected SDK', async () => {
    render(<App evaluator={evaluator({ kind: 'value', value: 'enabled' })} wait={noWait} />);

    expect(await screen.findByText('shop.example.com')).toBeInTheDocument();
    expect(await screen.findByText('🟢 detected')).toBeInTheDocument();
    expect(await screen.findByText('🟢 enabled')).toBeInTheDocument();
  });

  it('reports a diagnostic when the SDK never appears', async () => {
    render(<App evaluator={evaluator({ kind: 'value', value: 'missing' })} wait={noWait} />);

    expect(await screen.findByText('🔴 not detected')).toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent('never defined');
  });

  it('renders the event tree after a CSV upload', async () => {
    render(<App evaluator={evaluator({ kind: 'value', value: 'enabled' })} wait={noWait} />);

    const input = screen.getByLabelText('Event Sheet');
    fireEvent.change(input, {
      target: { files: [new File([CSV], 'sheet.csv', { type: 'text/csv' })] },
    });

    expect(await screen.findByText('add_to_cart')).toBeInTheDocument();
    expect(await screen.findByText('1 event')).toBeInTheDocument();
    expect(await screen.findByText('product_id')).toBeInTheDocument();
    expect(await screen.findByText('prid')).toBeInTheDocument();
  });
});
