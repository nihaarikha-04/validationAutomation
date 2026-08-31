import { detectAction, rank } from '../automation/detect-action';
import { detectPlatform, findByPlatform } from '../automation/platforms/adapters';
import { selectorFor } from '../automation/selector';
import type { AutomationCommand, AutomationReply } from '../automation/commands';

/**
 * Runs in the extension's isolated world at document_start.
 *
 * Two jobs, both requiring `chrome.*` and the page's DOM:
 *  1. forward captured debug payloads from the page's world to the panel;
 *  2. answer the panel's automation commands — find, click, and let the user point at an element.
 *
 * The handoff from the capture script is a private DOM event rather than `window.postMessage`,
 * so nothing we do reaches a page's own message listeners. See docs/decisions.md D12.
 */

const CAPTURE_EVENT = 'smartech-validator:payload';
const CAPTURE_MARKER = 'smartech-validator/payload';

document.addEventListener(CAPTURE_EVENT, (event: Event) => {
  const detail: unknown = (event as CustomEvent<unknown>).detail;
  if (typeof detail !== 'string') {
    return;
  }

  const message: unknown = JSON.parse(detail);
  if (
    typeof message !== 'object' ||
    message === null ||
    (message as { marker?: unknown }).marker !== CAPTURE_MARKER
  ) {
    return;
  }

  chrome.runtime.sendMessage(message, () => {
    // No panel open means no receiver. Reading lastError marks it handled so Chrome does not
    // log "Receiving end does not exist" on every captured event.
    void chrome.runtime.lastError;
  });
});

let cancelPick: (() => void) | undefined;

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (reply: AutomationReply) => void): boolean => {
    const command = message as AutomationCommand | undefined;

    switch (command?.kind) {
      case 'detect': {
        const adapter = detectPlatform(document);
        const candidates = rank([
          ...findByPlatform(document, adapter, command.intent),
          ...detectAction(document, command.intent),
        ]);
        sendResponse({ kind: 'candidates', platform: adapter.name, candidates });
        return false;
      }

      case 'click': {
        const element = document.querySelector(command.selector);
        if (element === null) {
          sendResponse({ kind: 'error', message: `Nothing matches ${command.selector} any more.` });
          return false;
        }
        // Scroll first: a click on an off-screen element is accepted by the DOM but is not what
        // a user would have done, and some sites only bind handlers once visible.
        element.scrollIntoView({ block: 'center' });
        (element as HTMLElement).click();
        sendResponse({ kind: 'clicked' });
        return false;
      }

      case 'pick':
        startPicking(sendResponse);
        // The reply comes when the user clicks, so the channel stays open.
        return true;

      case 'cancel-pick':
        cancelPick?.();
        sendResponse({ kind: 'cancelled' });
        return false;

      default:
        return false;
    }
  },
);

/**
 * Lets the user point at the element themselves when detection could not.
 *
 * The click is swallowed rather than passed through: this gesture selects a target, it does not
 * run the test. Execution happens afterwards, deliberately.
 */
function startPicking(sendResponse: (reply: AutomationReply) => void): void {
  cancelPick?.();

  const onClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    stop();

    const target = event.target;
    if (!(target instanceof Element)) {
      sendResponse({ kind: 'error', message: 'That was not an element.' });
      return;
    }

    sendResponse({
      kind: 'picked',
      candidate: {
        selector: selectorFor(target),
        label: (target.textContent ?? '').trim() || target.nodeName.toLowerCase(),
        strategy: 'manual',
        confidence: 1,
      },
    });
  };

  const stop = (): void => {
    document.removeEventListener('click', onClick, true);
    document.documentElement.style.cursor = '';
    cancelPick = undefined;
  };

  cancelPick = stop;
  document.documentElement.style.cursor = 'crosshair';
  document.addEventListener('click', onClick, true);
}
