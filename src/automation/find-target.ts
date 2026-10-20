import { selectorFor } from './selector';
import { documentsIn, riskOf, type ClickRisk } from './sweep';

/**
 * Finding the one control a sub-intent is talking about.
 *
 * The intent arrives as the client's words — "search", "Add to Cart", "Logout" — not as a
 * selector. Nothing upstream has seen the page, so this is where a sentence meets a document, and
 * it is the single place most likely to be wrong.
 *
 * Runs in the page, so it is the content script's half of a step. It reports a count rather than
 * assuming it has seen everything: cross-origin frames each have their own content script and
 * answer for themselves.
 *
 * **It refuses to guess.** Several equally good matches is a question for a person, not a coin
 * toss — picking one silently is how a run clicks the wrong thing and then reports a defect in
 * the client's site.
 */

export interface TargetMatch {
  readonly selector: string;
  /** What the matched control is called, so a report can say what it is about to act on. */
  readonly label: string;
  readonly risk: ClickRisk;
}

export type TargetResolution =
  | { readonly kind: 'found'; readonly match: TargetMatch }
  | { readonly kind: 'none' }
  /** Several equally good matches, named with their tags so a reader can see what they are. */
  | {
      readonly kind: 'ambiguous';
      readonly count: number;
      readonly describing: readonly string[];
    };

/** How many competing matches are worth naming before the message stops being readable. */
const NAMED_IN_ERROR = 3;

/** Structural and invisible elements are never what a step means. */
const NEVER = new Set(['SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'TITLE', 'HTML', 'BODY']);

/**
 * Controls, as opposed to things that talk about them.
 *
 * A step acts on something a person can press or type into. A `<div>` carrying an `aria-label` is
 * a wrapper; the `<button>` inside it is the control.
 */
const ACTIONABLE =
  'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="tab"], ' +
  '[contenteditable="true"], [onclick]';

export function resolveTarget(root: Document, wanted: string): TargetResolution {
  const want = normalise(wanted);
  if (want === '') {
    return { kind: 'none' };
  }

  /*
   * Exact first, and only then by containment.
   *
   * A page carrying both "Apply" and "Apply for a loan" makes every containment match ambiguous,
   * and neither could be targeted at all. An exact header match is not in doubt merely because
   * weaker partial matches exist alongside it.
   */
  const exact = matching(root, (name) => normalise(name) === want);
  const found = narrow(exact.length > 0 ? exact : matching(root, (name) => normalise(name).includes(want)));

  const [only, second] = found;
  if (only === undefined) {
    return { kind: 'none' };
  }
  if (second !== undefined) {
    return {
      kind: 'ambiguous',
      count: found.length,
      /*
       * Named with their tags, not only their labels.
       *
       * Three identical-looking words say nothing about why they competed; `button "search"`,
       * `div "search"`, `form "search"` says it at a glance — and tells a reader whether the
       * narrowing below ran at all.
       */
      describing: found
        .slice(0, NAMED_IN_ERROR)
        .map((element) => `${element.nodeName.toLowerCase()} "${nameOf(element)}"`),
    };
  }

  return {
    kind: 'found',
    match: { selector: selectorFor(only), label: nameOf(only), risk: riskOf(only) },
  };
}

function matching(root: Document, wants: (name: string) => boolean): readonly Element[] {
  return documentsIn(root).flatMap((document) =>
    [...document.querySelectorAll('*')].filter(
      (element) => isPossible(element) && namesOf(element).some(wants),
    ),
  );
}

/**
 * Narrows several matches to the one a step means, without guessing.
 *
 * Each rule is a fact about the elements rather than a preference, so none can pick a wrong one
 * where a right one exists. All three came from a live site where "search" matched five things.
 */
function narrow(elements: readonly Element[]): readonly Element[] {
  if (elements.length <= 1) {
    return elements;
  }

  // 1. A control beats a description of one.
  const controls = elements.filter((element) => element.matches(ACTIONABLE));
  const worth = controls.length > 0 ? controls : elements;

  // 2. The innermost wins: an element containing another match is its container.
  const innermost = worth.filter(
    (element) => !worth.some((other) => other !== element && element.contains(other)),
  );
  const inner = innermost.length > 0 ? innermost : worth;

  /*
   * 3. It has to be on screen.
   *
   * A responsive site carries a mobile header and a desktop header in the same document and shows
   * one of them. `display` and `visibility` cannot see this — an off-canvas header sets neither —
   * so both matched and the step failed as ambiguous while the real button sat in the header.
   *
   * Skipped entirely when nothing has a size. That is not defensive padding: every element in a
   * headless DOM measures 0×0, so without the guard this would discard every candidate in every
   * test.
   */
  const onScreen = inner.filter(hasSize);

  return onScreen.length > 0 ? onScreen : inner;
}

function hasSize(element: Element): boolean {
  const box = element.getBoundingClientRect();

  return box.width > 0 && box.height > 0;
}

/**
 * The names this element answers to.
 *
 * All the ways a page can say what a control is called, because the client's sentence does not
 * know which one this site used. A control the sheet calls "the search icon" has no visible words
 * at all; its `aria-label` is the only thing that names it.
 */
function namesOf(element: Element): readonly string[] {
  const id = element.getAttribute('id');
  const labelled =
    id === null || id === ''
      ? null
      : element.ownerDocument.querySelector(`label[for="${escapeId(id)}"]`);

  return [
    element.getAttribute('aria-label') ?? '',
    labelled?.textContent ?? '',
    element.closest('label')?.textContent ?? '',
    element.getAttribute('placeholder') ?? '',
    element.getAttribute('title') ?? '',
    element.getAttribute('value') ?? '',
    element.getAttribute('name') ?? '',
    ownText(element),
  ].filter((name) => name.trim() !== '');
}

/** The first of those names that exists, for reporting what was matched. */
function nameOf(element: Element): string {
  return namesOf(element)[0]?.replace(/\s+/g, ' ').trim() ?? element.nodeName.toLowerCase();
}

/**
 * What this element says for itself, ignoring what its children say.
 *
 * `textContent` concatenates every descendant, so a card wrapping a button reads as everything
 * inside it and matches nothing — while making both the card and the button candidates for the
 * same words. Own text lands on the innermost element, which is also the one a person clicks.
 */
function ownText(element: Element): string {
  return [...element.childNodes]
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A `<label>` is never what a step means.
 *
 * Its whole job is to name a different element, so it matches its own words as readily as the
 * field does — which makes every labelled field ambiguous with the label above it.
 */
function isPossible(element: Element): boolean {
  if (NEVER.has(element.nodeName) || element.nodeName === 'LABEL') {
    return false;
  }
  if (element.getAttribute('aria-hidden') === 'true' || element.hasAttribute('hidden')) {
    return false;
  }

  const view = element.ownerDocument.defaultView;
  if (view === null) {
    return true;
  }
  const style = view.getComputedStyle(element);

  return style.display !== 'none' && style.visibility !== 'hidden';
}

/** Case- and punctuation-insensitive, so "Check eligibility" matches "CHECK ELIGIBILITY!". */
function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Minimal escaping, enough for the ids a `label[for]` lookup sees. */
function escapeId(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
