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
  /**
   * What a pointer would hit at this control's centre when the page was listed.
   *
   * Optional because drivers and fakes that do not measure leave it out, and that is read as
   * "not known to be blocked".
   */
  readonly reach?: ClickHit;
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
    ...scriptedControls(doc),
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
      reach: hitAt(element),
    });
  }

  return found;
}

/**
 * Elements a site made clickable with script alone: a `<div>` given a click handler and nothing
 * in the markup to say so — no tag, no role, no `onclick`.
 *
 * A Fynd storefront's "Remove Item" dialog is built entirely this way, so its REMOVE and MOVE TO
 * WISHLIST were never listed and the sweep could only click the page behind it. Component
 * frameworks produce these on every kind of site. Listeners are invisible to a content script, so
 * this reads the signal the site gives its own visitors: the pointer cursor.
 *
 * Only where the pointer *starts*, because the cursor is inherited and every child of a clickable
 * card reports it too; and never in or around a real control, which already stands for it.
 */
function scriptedControls(document: Document): readonly Element[] {
  const view = document.defaultView;
  if (view === null || document.body === null) {
    return [];
  }
  const pointer = (element: Element): boolean => view.getComputedStyle(element).cursor === 'pointer';

  return [...document.body.querySelectorAll('*')].filter(
    (element) =>
      pointer(element) &&
      (element.parentElement === null || !pointer(element.parentElement)) &&
      element.closest(CLICKABLE_SELECTOR) === null &&
      element.querySelector(CLICKABLE_SELECTOR) === null,
  );
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

/**
 * One `<iframe>` element as the page holding it sees it.
 *
 * A frame our content script never loads in cannot announce itself, so counting the frames that
 * answered says nothing about it — a live run reported "1 frame" throughout while a dialog's
 * buttons sat in a frame nothing listed. This describes every frame element instead.
 */
export interface FrameNote {
  /** The `src` as written, or `srcdoc` / `about:blank` when there is none. */
  readonly source: string;
  /** Whether its document can be read from here — same origin. */
  readonly readable: boolean;
  readonly width: number;
  readonly height: number;
}

export function describeFrames(root: Document): readonly FrameNote[] {
  return documentsIn(root).flatMap((document) =>
    [...document.querySelectorAll('iframe')].map((frame) => {
      const box = frame.getBoundingClientRect();
      return {
        source:
          frame.getAttribute('src') ?? (frame.hasAttribute('srcdoc') ? 'srcdoc' : 'about:blank'),
        readable: frame.contentDocument !== null,
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    }),
  );
}

/**
 * Controls inside open shadow roots, which `querySelectorAll` does not reach.
 *
 * Counted rather than listed: a dialog built as a web component shows in the Elements panel as a
 * nested document, looks like an iframe, and its buttons are as invisible to the sweep as a
 * cross-origin frame's. Closed shadow roots cannot be seen from outside at all.
 */
export function controlsInShadow(root: Document): number {
  let count = 0;
  const visit = (scope: Document | ShadowRoot): void => {
    for (const element of scope.querySelectorAll('*')) {
      if (element.shadowRoot !== null) {
        count += element.shadowRoot.querySelectorAll(CLICKABLE_SELECTOR).length;
        visit(element.shadowRoot);
      }
    }
  };
  for (const document of documentsIn(root)) {
    visit(document);
  }
  return count;
}

/**
 * Where a page tells its visitor something happened: ARIA live regions, and the class names toast
 * libraries use when a site adds no ARIA at all.
 *
 * For the run log only. A click that fires no event can be the tool's fault or the site's — "this
 * item is unavailable" — and only what the page said tells the two apart. A live Add to Cart that
 * fired nothing left one extra element on the page and no way to read it.
 */
const NOTICE_SELECTOR = [
  '[role="alert"]',
  '[role="status"]',
  '[aria-live="polite"]',
  '[aria-live="assertive"]',
  '[class*="toast" i]',
  '[class*="snackbar" i]',
  '[class*="notification" i]',
].join(', ');

/** Longest notice kept; a toast is a sentence, and a region this long is a page section. */
const NOTICE_MAX = 120;

export function noticesIn(root: Document): readonly string[] {
  const texts = documentsIn(root).flatMap((document) =>
    [...document.querySelectorAll(NOTICE_SELECTOR)]
      // The innermost one speaks: a toast container holds its toasts and would repeat them all.
      .filter((element) => element.querySelector(NOTICE_SELECTOR) === null && isUsable(element))
      .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter((text) => text !== '' && text.length <= NOTICE_MAX),
  );
  return [...new Set(texts)];
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

  if (DISMISS_LABEL.test(labelOf(element).trim())) {
    return true;
  }

  // An overlay's X is very often just a picture: no text, no aria-label, no title. Found on a
  // Fynd storefront's "Remove Item" dialog, where it came first in document order and would have
  // closed the dialog before REMOVE or MOVE TO WISHLIST was ever tried.
  return iconOnly(element) && inOverlay(element);
}

/** A control that says nothing in words and shows only an icon. */
function iconOnly(element: Element): boolean {
  return (
    (element.textContent ?? '').trim() === '' &&
    (element.getAttribute('aria-label') ?? '').trim() === '' &&
    (element.getAttribute('title') ?? '').trim() === '' &&
    element.querySelector('svg, img') !== null
  );
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

/**
 * What a real pointer would have hit at the control's centre, at the moment it was clicked.
 *
 * `element.click()` fires on an element even when a modal is drawn over it, so a sweep can
 * "click" the page behind an open dialog indefinitely while nothing a visitor could do happens.
 * A live run on levisons.co.za did exactly that, behind both a "Remove Item" dialog and an open
 * navigation menu.
 *
 * Only the element's own document is tested: a dialog in the top document laid over an iframe
 * is invisible from inside the frame.
 */
export type ClickHit =
  | { readonly kind: 'self' }
  /**
   * Something sits on top, but it is the control's own dressing — an icon drawn over a cart
   * row's X as a sibling rather than a child. A visitor pressing there reaches the same control.
   */
  | { readonly kind: 'decoration'; readonly by: string }
  | { readonly kind: 'covered'; readonly by: string }
  /** Outside the viewport; scrolling it into view may or may not uncover it. */
  | { readonly kind: 'off-screen' }
  /** Takes up no space — a closed drawer's contents, the hidden half of a responsive header. */
  | { readonly kind: 'no-size' }
  /** The browser would not say what is on top. */
  | { readonly kind: 'unmeasured' };

/**
 * Whether a visitor could not press this control as things stand, asked once it has been scrolled
 * to. Off-screen then means it could not be brought into view — a dialog that locks scrolling holds
 * the page behind it still, and clicking there anyway reached the page behind the dialog.
 */
export function blocksClick(hit: ClickHit): boolean {
  return hit.kind === 'covered' || hit.kind === 'no-size' || hit.kind === 'off-screen';
}

/**
 * How close something on top must be, in the tree, to count as the control's own dressing.
 *
 * Its parent or grandparent. A cart row's icon sits beside its button; a navigation menu or a
 * dialog over the same spot shares nothing nearer than the page's main wrapper.
 */
const DECORATION_DEPTH = 2;

function isDecoration(element: Element, top: Element): boolean {
  if (top.closest(OVERLAY_SELECTOR) !== element.closest(OVERLAY_SELECTOR)) {
    return false;
  }
  let ancestor = element.parentElement;
  for (let depth = 0; depth < DECORATION_DEPTH && ancestor !== null; depth += 1) {
    if (ancestor.contains(top)) {
      return true;
    }
    ancestor = ancestor.parentElement;
  }
  return false;
}

export function hitAt(element: Element): ClickHit {
  const view = element.ownerDocument.defaultView;
  if (view === null) {
    return { kind: 'unmeasured' };
  }
  const box = element.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) {
    return { kind: 'no-size' };
  }

  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) {
    return { kind: 'off-screen' };
  }

  const top = element.ownerDocument.elementFromPoint(x, y);
  if (top === null) {
    return { kind: 'unmeasured' };
  }
  if (top === element || element.contains(top)) {
    return { kind: 'self' };
  }
  const overlay = top.closest(OVERLAY_SELECTOR) === null ? '' : ' (in a dialog)';
  const by = `${top.nodeName.toLowerCase()} "${labelOf(top)}"${overlay}`;
  return isDecoration(element, top) ? { kind: 'decoration', by } : { kind: 'covered', by };
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
