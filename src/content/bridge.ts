import { detectAction, rank } from '../automation/detect-action';
import { detectPlatform, findByPlatform } from '../automation/platforms/adapters';
import { selectorFor } from '../automation/selector';
import { formNeeds } from '../automation/fill';
import { crossOriginFrames, findAcrossFrames, findClickables, pageStamp } from '../automation/sweep';
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
const STATS_MARKER = 'smartech-validator/stats';
const CONTROL_EVENT = 'smartech-validator:control';
const HELLO_MARKER = 'smartech-validator/hello';

/**
 * Announce this frame so the panel can address it; the panel reads the id off the sender.
 *
 * Sent on load *and* on request. The load-time one is missed whenever the page loaded before the
 * panel opened, which is the usual case — so the panel asks again when it needs to know.
 */
function announce(): void {
  chrome.runtime.sendMessage({ marker: HELLO_MARKER, url: location.href }, () => {
    void chrome.runtime.lastError;
  });
}

announce();

document.addEventListener(CAPTURE_EVENT, (event: Event) => {
  const detail: unknown = (event as CustomEvent<unknown>).detail;
  if (typeof detail !== 'string') {
    return;
  }

  const message: unknown = JSON.parse(detail);
  const marker = (message as { marker?: unknown } | null)?.marker;
  if (typeof message !== 'object' || message === null) {
    return;
  }
  if (marker !== CAPTURE_MARKER && marker !== STATS_MARKER) {
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
          ...(command.target.kind === 'intent'
            ? findByPlatform(document, adapter, command.target.intent)
            : []),
          ...detectAction(document, command.target),
        ]);
        sendResponse({ kind: 'candidates', platform: adapter.name, candidates });
        return false;
      }

      case 'click': {
        const element = findAcrossFrames(document, command.selector);
        if (element === null) {
          // Distinct from an error: the page is fine, this particular element has gone. A sweep
          // must skip it and carry on rather than concluding the page is dead.
          sendResponse({ kind: 'not-found' });
          return false;
        }

        // Scroll first: a click on an off-screen element is accepted by the DOM but is not what
        // a user would have done, and some sites only bind handlers once visible.
        element.scrollIntoView({ block: 'center', behavior: 'smooth' });

        void clickVisibly(element, command.show !== false).then(() => {
          sendResponse({ kind: 'clicked' });
        });
        // The reply waits for the pointer animation, so the channel stays open.
        return true;
      }

      case 'pick':
        startPicking(sendResponse);
        // The reply comes when the user clicks, so the channel stays open.
        return true;

      case 'dismiss': {
        // Overlays opened by a previous click sit over everything else. Escape is what a user
        // would press, and closes most modals and menus.
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }),
        );
        sendResponse({ kind: 'dismissed' });
        return false;
      }

      case 'form-needs': {
        const control = findAcrossFrames(document, command.selector);
        sendResponse(
          control === null
            ? { kind: 'form-needs', isSubmit: false, fields: [] }
            : { kind: 'form-needs', ...formNeeds(control) },
        );
        return false;
      }

      case 'announce':
        announce();
        sendResponse({ kind: 'acknowledged' });
        return false;

      case 'same-tab':
        document.dispatchEvent(
          new CustomEvent(CONTROL_EVENT, { detail: command.on ? 'same-tab' : 'restore' }),
        );
        sendResponse({ kind: 'acknowledged' });
        return false;

      case 'hover': {
        const element = findAcrossFrames(document, command.selector);
        if (element === null) {
          sendResponse({ kind: 'not-found' });
          return false;
        }

        void hoverAndDwell(element, command.dwellMs).then(() => {
          sendResponse({ kind: 'hovered' });
        });
        // The reply waits for the dwell, so the channel stays open.
        return true;
      }

      case 'scroll':
        // Walk the page top to bottom so anything that loads on scroll is in the DOM before we
        // enumerate. Without this a sweep only ever sees what was rendered above the fold.
        void scrollThrough(command.dwellMs).then(() => {
          sendResponse({ kind: 'scrolled' });
        });
        return true;

      case 'location':
        sendResponse({ kind: 'location', url: location.href, stamp: pageStamp() });
        return false;

      case 'links':
        sendResponse({ kind: 'links', urls: sameOriginLinks() });
        return false;

      case 'navigate':
        // The reply is sent first: navigating tears this script down, and a reply sent
        // afterwards would never arrive.
        sendResponse({ kind: 'navigating' });
        setTimeout(() => location.assign(command.url), 0);
        return false;

      case 'clickables':
        sendResponse({
          kind: 'clickables',
          clickables: findClickables(document),
          unreachableFrames: crossOriginFrames(document),
        });
        return false;

      case 'cancel-pick':
        cancelPick?.();
        sendResponse({ kind: 'cancelled' });
        return false;

      default:
        return false;
    }
  },
);

const OVERLAY_ATTRIBUTE = 'data-smartech-validator';
const CURSOR_ID = '__smartechValidatorCursor';
const LABEL_ID = '__smartechValidatorLabel';

/** Long enough to follow with your eyes, short enough not to make a sweep tedious. */
const TRAVEL_MS = 320;
const LINGER_MS = 160;

/**
 * Moves a visible pointer to the element, names what it is about to click, then clicks.
 *
 * Automation that clicks invisibly is impossible to trust or debug — you cannot tell a wrong
 * click from no click. The overlay is inert (`pointer-events: none`) and marked so the sweep's
 * own enumeration skips it.
 */
async function clickVisibly(element: Element, show: boolean): Promise<void> {
  // A link that opens a new tab takes the click somewhere DevTools cannot follow, so for the
  // duration of the click it is asked to open here instead.
  const anchor = element.closest('a[target="_blank"]');
  const restoreTarget = anchor?.getAttribute('target') ?? undefined;
  anchor?.removeAttribute('target');

  const finish = (): void => {
    if (anchor !== null && anchor !== undefined && restoreTarget !== undefined) {
      anchor.setAttribute('target', restoreTarget);
    }
  };

  if (!show) {
    (element as HTMLElement).click();
    finish();
    return;
  }

  const box = element.getBoundingClientRect();
  const offset = frameOffset(element);
  const cursor = ensureCursor();
  const label = ensureLabel();

  label.textContent = (element.textContent ?? '').trim().slice(0, 60) ||
    element.getAttribute('aria-label') ||
    element.nodeName.toLowerCase();

  // The overlay lives in the top document, so an element inside a frame needs that frame's
  // position added or the pointer lands in the wrong place entirely.
  const x = box.left + box.width / 2 + offset.x;
  const y = box.top + box.height / 2 + offset.y;
  cursor.style.opacity = '1';
  cursor.style.transform = `translate(${x}px, ${y}px) scale(1)`;
  label.style.opacity = '1';
  label.style.transform = `translate(${x + 16}px, ${y + 12}px)`;

  const previousOutline = (element as HTMLElement).style.outline;
  (element as HTMLElement).style.outline = '2px solid rgba(230, 60, 40, 0.9)';

  await wait(TRAVEL_MS);
  // A quick squeeze at the moment of the click, so the click itself is visible too.
  cursor.style.transform = `translate(${x}px, ${y}px) scale(0.55)`;

  (element as HTMLElement).click();

  await wait(LINGER_MS);
  cursor.style.transform = `translate(${x}px, ${y}px) scale(1)`;
  (element as HTMLElement).style.outline = previousOutline;
  label.style.opacity = '0';
  finish();
}

/** How far this element's document sits from the top one, through any nesting of frames. */
function frameOffset(element: Element): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let view = element.ownerDocument.defaultView;

  while (view !== null && view.frameElement !== null) {
    const rect = view.frameElement.getBoundingClientRect();
    x += rect.left;
    y += rect.top;
    view = view.frameElement.ownerDocument.defaultView;
  }

  return { x, y };
}

function ensureCursor(): HTMLElement {
  const existing = document.getElementById(CURSOR_ID);
  if (existing !== null) {
    return existing;
  }

  const cursor = document.createElement('div');
  cursor.id = CURSOR_ID;
  cursor.setAttribute(OVERLAY_ATTRIBUTE, 'cursor');
  Object.assign(cursor.style, {
    position: 'fixed',
    left: '0px',
    top: '0px',
    width: '20px',
    height: '20px',
    marginLeft: '-10px',
    marginTop: '-10px',
    borderRadius: '50%',
    background: 'rgba(230, 60, 40, 0.85)',
    border: '2px solid #fff',
    boxShadow: '0 0 0 3px rgba(230, 60, 40, 0.35)',
    zIndex: '2147483647',
    pointerEvents: 'none',
    opacity: '0',
    transition: `transform ${TRAVEL_MS}ms ease-in-out, opacity 200ms linear`,
  });
  document.body.appendChild(cursor);
  return cursor;
}

function ensureLabel(): HTMLElement {
  const existing = document.getElementById(LABEL_ID);
  if (existing !== null) {
    return existing;
  }

  const label = document.createElement('div');
  label.id = LABEL_ID;
  label.setAttribute(OVERLAY_ATTRIBUTE, 'label');
  Object.assign(label.style, {
    position: 'fixed',
    left: '0px',
    top: '0px',
    maxWidth: '260px',
    padding: '3px 7px',
    borderRadius: '4px',
    background: 'rgba(20, 20, 20, 0.88)',
    color: '#fff',
    font: '12px/1.4 system-ui, sans-serif',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    zIndex: '2147483647',
    pointerEvents: 'none',
    opacity: '0',
    transition: `transform ${TRAVEL_MS}ms ease-in-out, opacity 200ms linear`,
  });
  document.body.appendChild(label);
  return label;
}

/**
 * Moves the pointer onto the element, leaves it there, then moves it off.
 *
 * A whole class of events — a banner's \`hover_time\`, a tooltip's impression — is produced by the
 * mouse arriving and staying put, and is unreachable by clicking however thorough a sweep is.
 * Both the bubbling pair (over/out) and the non-bubbling pair (enter/leave) are sent, because a
 * page may listen for either, and coordinates are supplied since handlers commonly read them.
 */
async function hoverAndDwell(element: Element, dwellMs: number): Promise<void> {
  element.scrollIntoView({ block: 'center', behavior: 'smooth' });

  const box = element.getBoundingClientRect();
  const at = {
    bubbles: true,
    cancelable: true,
    clientX: box.left + box.width / 2,
    clientY: box.top + box.height / 2,
  };

  for (const type of ['pointerover', 'mouseover', 'mousemove']) {
    element.dispatchEvent(new MouseEvent(type, at));
  }
  element.dispatchEvent(new MouseEvent('mouseenter', { ...at, bubbles: false }));

  await wait(dwellMs);

  // Leaving matters as much as arriving: a hover_time is usually measured on the way out.
  element.dispatchEvent(new MouseEvent('mouseleave', { ...at, bubbles: false }));
  for (const type of ['mouseout', 'pointerout']) {
    element.dispatchEvent(new MouseEvent(type, at));
  }
}

/**
 * Steps down the page a viewport at a time, then returns to the top.
 *
 * \`dwellMs\` is how long to stay at each step. Anything driven by an IntersectionObserver with a
 * time threshold — a section dwell, a review scrolled into view — needs the page to actually
 * rest there; scrolling straight past fires nothing.
 */
async function scrollThrough(dwellMs: number): Promise<void> {
  const step = Math.max(200, window.innerHeight - 100);

  for (let position = 0; position < document.body.scrollHeight; position += step) {
    window.scrollTo({ top: position, behavior: 'auto' });
    await wait(dwellMs);
  }

  window.scrollTo({ top: 0, behavior: 'auto' });
  await wait(dwellMs);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Pages on this site worth visiting, deduplicated and stripped of fragments.
 *
 * Same-origin only: a crawl exists to cover the client's site, and following outbound links
 * would wander off into the internet.
 */
function sameOriginLinks(): readonly string[] {
  const here = new URL(location.href);
  const found = new Set<string>();

  for (const anchor of document.querySelectorAll('a[href]')) {
    const raw = anchor.getAttribute('href') ?? '';
    if (raw === '' || raw.startsWith('#') || raw.toLowerCase().startsWith('javascript:')) {
      continue;
    }

    try {
      const url = new URL(raw, here);
      if (url.origin !== here.origin) {
        continue;
      }
      url.hash = '';
      found.add(url.href);
    } catch {
      // A malformed href is the page's problem, not ours; skip it.
      continue;
    }
  }

  return [...found];
}

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
