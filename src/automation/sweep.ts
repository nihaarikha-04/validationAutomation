/**
 * Marks a control so it can be found again after the page re-renders.
 *
 * Structural selectors (`body > div > div:nth-of-type(3)`) are not stable: one click that
 * re-renders the page changes the path of every element, so a sweep could not tell which
 * controls it had already clicked and kept re-clicking the first few — in practice, the navbar.
 * An attribute travels with the element instead.
 */
const ID_ATTRIBUTE = 'data-sv-id';

/**
 * Ids must be unique across page loads, not just within one.
 *
 * The counter restarts at 1 on every page, so a sweep that navigated found the new page's
 * elements already in its "already clicked" set and skipped nearly all of them. Stamping the
 * load makes ids from different pages incomparable.
 */
const PAGE_STAMP = Date.now().toString(36);

/**
 * Identifies this document. It changes only when the page actually reloads, which is how a real
 * navigation is told apart from a single-page route change — an overlay that pushes a URL is
 * still the same document, and the sweep must carry on through it.
 */
export const pageStamp = (): string => PAGE_STAMP;
let counter = 0;

/**
 * Why a control might not be safe to click blindly.
 *
 * `destructive` spends money, ends a session or removes something. `navigates` leaves the page,
 * which ends a sweep — every remaining candidate belongs to a document that no longer exists.
 */
export type ClickRisk = 'safe' | 'navigates' | 'destructive';

export interface Clickable {
  readonly selector: string;
  readonly label: string;
  readonly risk: ClickRisk;
  /**
   * Controls that are the same kind of thing — every product tile in a grid, every "Add" button
   * in a list. A sweep clicks one of a group and skips the rest once it knows what they do.
   */
  readonly group: string;
}

const CLICKABLE_SELECTOR =
  'button, a, input[type="submit"], input[type="button"], [role="button"], [onclick]';

/**
 * Labels that mean a click cannot be taken back — it spends money, ends the session, or destroys
 * an account. Matched on the visible text, aria-label and href, since any of the three can be the
 * only honest signal.
 *
 * **Phrases, not bare words.** The first version matched `order`, `remove`, `delete`, `cancel`
 * and `subscribe` on their own, which quietly skipped a large part of every site: "Order
 * Details", "Order Tracking", "Reorder" and "My Orders" all contain `order`; a cart's remove
 * button contains `remove`; "Newsletter Subscribe" contains `subscribe`; and every dialog's
 * Cancel button contains `cancel`. Those are ordinary controls, and several of them produce
 * events the Event Sheet asks for — so the guard was hiding exactly what a run was meant to find.
 *
 * Same reasoning as the `sign in` / `sign out` split in match-event: the distinction lives in
 * the phrase, and collapsing it to a word is worse than not matching at all.
 */
const DESTRUCTIVE = new RegExp(
  [
    // Spends money.
    '\\bpay\\b', 'payment', '\\bbuy\\b', 'purchase', 'checkout', 'check out', 'donate',
    'place (the )?order', 'confirm (the )?order', 'complete (the )?order', 'proceed to pay',
    // Ends the session.
    'logout', 'log ?out', 'signout', 'sign ?out',
    // Destroys an account or a paid commitment.
    'delete (my )?account', 'close account', 'deactivate', 'unsubscribe',
    'cancel (my )?(subscription|plan|order|membership)',
  ].join('|'),
);

/**
 * Every control on the page worth clicking, in document order, each labelled with its risk.
 *
 * Hidden and disabled controls are left out: clicking them tells us nothing, and a hidden
 * element is usually behind a menu the user has not opened.
 */
export function findClickables(document: Document): readonly Clickable[] {
  const seen = new Set<string>();
  const found: Clickable[] = [];

  for (const element of documentsIn(document).flatMap((doc) => [
    ...doc.querySelectorAll(CLICKABLE_SELECTOR),
  ])) {
    if (!isUsable(element)) {
      continue;
    }

    const selector = stableSelector(element);
    if (seen.has(selector)) {
      continue;
    }
    seen.add(selector);

    found.push({
      selector,
      label: labelOf(element),
      risk: riskOf(element),
      group: groupOf(element),
    });
  }

  return found;
}

/**
 * This document and every same-origin frame inside it.
 *
 * Content scripts run in the top frame only, so anything inside an iframe was invisible —
 * never enumerated, never clicked. Where the frame shares our origin we can reach into it
 * directly. Cross-origin frames return `null` for `contentDocument` and stay out of reach;
 * `crossOriginFrames` counts those so the gap is reported rather than silent.
 */
export function documentsIn(root: Document): readonly Document[] {
  const documents: Document[] = [root];

  for (const frame of root.querySelectorAll('iframe')) {
    const inner = frame instanceof HTMLIFrameElement ? frame.contentDocument : null;
    if (inner !== null) {
      documents.push(...documentsIn(inner));
    }
  }

  return documents;
}

/** Frames we cannot see into, so the panel can say so instead of quietly covering less. */
export function crossOriginFrames(root: Document): number {
  let count = 0;

  for (const frame of root.querySelectorAll('iframe')) {
    const inner = frame instanceof HTMLIFrameElement ? frame.contentDocument : null;
    if (inner === null) {
      count += 1;
    } else {
      count += crossOriginFrames(inner);
    }
  }

  return count;
}

/** Finds a tagged element anywhere we can reach, including inside same-origin frames. */
export function findAcrossFrames(root: Document, selector: string): Element | null {
  for (const document of documentsIn(root)) {
    const found = document.querySelector(selector);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/**
 * A signature shared by controls of the same kind.
 *
 * Class lists are what component frameworks give identical elements, so they identify a repeated
 * tile or row well. Where an element has no classes, its parent supplies the context instead —
 * otherwise every unadorned `<button>` on the page would look like one group.
 */
export function groupOf(element: Element): string {
  const tag = element.nodeName.toLowerCase();
  const classes = [...element.classList].sort().join('.');

  if (classes !== '') {
    return `${tag}.${classes}`;
  }

  const parent = element.parentElement;
  if (parent === null) {
    return tag;
  }

  const parentClasses = [...parent.classList].sort().join('.');
  return `${tag}@${parent.nodeName.toLowerCase()}${parentClasses === '' ? '' : `.${parentClasses}`}`;
}

/** Tags the element on first sight; the tag is what makes it findable later. */
function stableSelector(element: Element): string {
  const existing = element.getAttribute(ID_ATTRIBUTE);
  if (existing !== null && existing !== '') {
    return `[${ID_ATTRIBUTE}="${existing}"]`;
  }

  counter += 1;
  const id = `${PAGE_STAMP}-${counter}`;
  element.setAttribute(ID_ATTRIBUTE, id);
  return `[${ID_ATTRIBUTE}="${id}"]`;
}

function isUsable(element: Element): boolean {
  if (element.hasAttribute('disabled') || element.getAttribute('aria-hidden') === 'true') {
    return false;
  }
  // Our own pointer overlay must never become a thing the sweep tries to click.
  if (element.closest('[data-smartech-validator]') !== null) {
    return false;
  }
  if (element.hasAttribute('hidden')) {
    return false;
  }

  // Computed style rather than layout rects: rects are empty in every headless DOM, so a
  // layout-based check would have been impossible to test and would have excluded everything.
  const view = element.ownerDocument.defaultView;
  if (view === null) {
    return true;
  }

  const style = view.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function labelOf(element: Element): string {
  const aria = element.getAttribute('aria-label');
  if (aria !== null && aria.trim() !== '') {
    return aria.trim();
  }

  // A card or row that wraps other elements concatenates all of their text — "Mary JaneView
  // CartFree Shipping unlocked 🎉2" — which names nothing. Its own text nodes are what it says.
  const ownText = [...element.childNodes]
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (ownText !== '') {
    return ownText.slice(0, 60);
  }

  const allText = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (allText !== '') {
    return allText.slice(0, 60);
  }

  return (
    element.getAttribute('title') ??
    element.getAttribute('value') ??
    element.nodeName.toLowerCase()
  );
}

export function riskOf(element: Element): ClickRisk {
  const href = element.getAttribute('href') ?? '';
  const words = `${labelOf(element)} ${element.getAttribute('aria-label') ?? ''} ${href}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');

  if (DESTRUCTIVE.test(words)) {
    return 'destructive';
  }
  if (leavesPage(element, href)) {
    return 'navigates';
  }
  return 'safe';
}

/**
 * A link that goes somewhere else. In-page anchors and javascript: hrefs stay put, and those are
 * usually the ones wired to analytics.
 */
function leavesPage(element: Element, href: string): boolean {
  if (element.nodeName.toLowerCase() !== 'a' || href === '') {
    return false;
  }
  if (element.getAttribute('target') === '_blank') {
    return true;
  }
  return !href.startsWith('#') && !href.toLowerCase().startsWith('javascript:');
}
