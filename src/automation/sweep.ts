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
  /**
   * Whether this control sits inside a modal, drawer or other overlay.
   *
   * Optional because it is a hint about ordering, not part of a control's identity: absent means
   * "not known to be in one", which is how every control looked before this existed.
   */
  readonly inOverlay?: boolean;
  /**
   * Whether clicking this closes what it is in — an X, a Cancel, a backdrop dismiss.
   *
   * Optional for the same reason as `inOverlay`: it orders the sweep, it does not identify the
   * control.
   */
  readonly dismisses?: boolean;
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
    // Destroys a stored record. A bare "Delete" next to a saved address is the whole label a
    // site gives that button, and treating it as safe deleted a real address on a live account.
    '\\bdelete\\b', '\\bdestroy\\b',
    // `remove` alone is usually reversible — a cart line, a filter — and those are worth testing.
    // Paired with a stored record it is not.
    'remove (this |the |saved )?(address|card|payment|account|profile|review|photo|image)',
  ].join('|'),
);

/** Wording that names something a site restores by adding it again. */
const REVERSIBLE = new RegExp(
  [
    '(remove|delete)( this| the)?( item| product| line| entry)?( from)? (cart|bag|basket)',
    'remove (item|product|line|filter|coupon|promo)',
    'clear (filter|filters|search)',
  ].join('|'),
);

/** Whether this control lives inside the cart, where removing a line is routine rather than lost data. */
function inCart(element: Element): boolean {
  return element.closest('[class*="cart" i], [id*="cart" i], [data-testid*="cart" i]') !== null;
}

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
      inOverlay: inOverlay(element),
      dismisses: dismisses(element),
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

/**
 * Labels that mean "close this".
 *
 * Whole-label matches, not substrings: a button reading exactly `×` or `Close` shuts the modal,
 * while "Close my account" and "Cancel subscription" are something else entirely — and the second
 * of those is already handled as destructive.
 */
const DISMISS_LABEL = /^(x|×|✕|✖|✗|⨯|close|dismiss|cancel|back|close modal|close dialog|no thanks|not now|maybe later|skip)$/i;

/**
 * Whether this control closes the thing it sits in.
 *
 * Asked so a modal's X is clicked *last*. It is almost always first in document order — top-right
 * of the dialog — so the sweep opened a modal, immediately closed it again, and never touched the
 * controls it was opened to reach. Every other control has to be spent before the one that throws
 * the overlay away.
 */
function dismisses(element: Element): boolean {
  if (element.hasAttribute('data-dismiss') || element.hasAttribute('data-bs-dismiss')) {
    return true;
  }

  const aria = (element.getAttribute('aria-label') ?? '').trim();
  if (DISMISS_LABEL.test(aria)) {
    return true;
  }

  return DISMISS_LABEL.test(labelOf(element).trim());
}

/** Containers that announce themselves as an overlay. */
const OVERLAY_SELECTOR = 'dialog, [role="dialog"], [aria-modal="true"]';

/**
 * Whether the control is inside something laid over the page.
 *
 * Asked so an overlay's contents can be clicked before the page underneath: a modal or cart
 * drawer is transient, and the page beneath it is not going anywhere. Anything opened by a click
 * would otherwise wait behind the rest of the page and often be dismissed before its turn came.
 *
 * Two signals, because sites split evenly between them. The semantic one is definitive. The
 * layout one — a `fixed` ancestor — is what an overlay actually *is*, and catches the cart
 * drawers and slide-overs that carry no role at all.
 */
function inOverlay(element: Element): boolean {
  if (element.closest(OVERLAY_SELECTOR) !== null) {
    return true;
  }

  const view = element.ownerDocument.defaultView;
  if (view === null) {
    return false;
  }

  for (
    let ancestor: Element | null = element;
    ancestor !== null;
    ancestor = ancestor.parentElement
  ) {
    if (view.getComputedStyle(ancestor).position === 'fixed') {
      return true;
    }
  }
  return false;
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

  // Emptying a cart line undoes itself, and `Remove from Cart` is an event the sheet asks for.
  // The button is often a bare bin icon labelled "Delete", which reads as destructive on its own
  // wording — so where it sits decides it. Checked before the destructive list, never after.
  if (REVERSIBLE.test(words) || inCart(element)) {
    return 'safe';
  }

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
