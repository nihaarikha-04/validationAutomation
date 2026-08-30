import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './panel.css';

// Composition root for the panel surface. Everything the panel depends on is
// constructed here and passed down; nothing below this file reaches for chrome.*
// or the DOM on its own.
const container = document.getElementById('root');
if (container === null) {
  throw new Error('Panel cannot mount: #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
