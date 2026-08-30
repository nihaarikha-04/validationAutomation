import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createChromePageEvaluator } from './chrome-page-evaluator';
import './panel.css';

// Composition root for the panel surface. chrome.* and timers are constructed here and
// passed down, so nothing below this file reaches for the browser on its own.
const container = document.getElementById('root');
if (container === null) {
  throw new Error('Panel cannot mount: #root is missing from index.html');
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

createRoot(container).render(
  <StrictMode>
    <App evaluator={createChromePageEvaluator()} wait={wait} />
  </StrictMode>,
);
