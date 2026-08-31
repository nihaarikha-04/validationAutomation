import type { CapturedPayload } from '../shared/payload';

export interface AssociationWindow {
  /** Identifies the run, so a payload can be traced back to what triggered it. */
  readonly testId: string;
  /** When the click happened. Anything captured earlier belongs to something else. */
  readonly startedAt: number;
  readonly expectedEvent: string;
  readonly windowMs: number;
}

export type Association =
  | {
      readonly kind: 'matched';
      readonly testId: string;
      readonly payload: CapturedPayload;
      /** Further payloads for the same event inside the window — a double-fire. */
      readonly duplicates: readonly CapturedPayload[];
    }
  | { readonly kind: 'none'; readonly testId: string; readonly considered: number };

/**
 * Picks the payload a run actually caused.
 *
 * Time alone is not enough: a page_view often fires in the same instant as an add_to_cart, and
 * attributing the wrong one would validate the wrong payload against the wrong schema. So the
 * event name must match exactly as well, and only payloads captured after the click are eligible.
 *
 * Extra matches are returned rather than discarded — an event firing twice per click is a real
 * defect worth reporting, not noise to hide.
 */
export function associatePayload(
  payloads: readonly CapturedPayload[],
  window: AssociationWindow,
): Association {
  const withinWindow = payloads.filter(
    (payload) =>
      payload.at >= window.startedAt && payload.at <= window.startedAt + window.windowMs,
  );

  const matching = withinWindow
    .filter((payload) => payload.eventName === window.expectedEvent)
    .sort((a, b) => a.at - b.at);

  const [first, ...duplicates] = matching;
  if (first === undefined) {
    return { kind: 'none', testId: window.testId, considered: withinWindow.length };
  }

  return { kind: 'matched', testId: window.testId, payload: first, duplicates };
}
