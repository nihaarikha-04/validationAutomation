import type { Clickable, ClickHit, FrameNote } from './sweep';
import type { ActionCandidate, ActionTarget } from './types';
import type { TargetResolution } from './find-target';

/**
 * The panel↔page protocol for automation. Kept in its own module so neither side has to import
 * the other's entry point, which would drag side effects across the boundary.
 */
export type AutomationCommand =
  | { readonly kind: 'detect'; readonly target: ActionTarget }
  | { readonly kind: 'click'; readonly selector: string; readonly show?: boolean }
  | { readonly kind: 'pick' }
  | { readonly kind: 'cancel-pick' }
  | { readonly kind: 'clickables' }
  | { readonly kind: 'dismiss' }
  | { readonly kind: 'links' }
  /**
   * Dwells on the element with the pointer over it, then moves off.
   *
   * Events like a banner's `hover_time` are produced by the mouse arriving and staying, and no
   * amount of clicking will ever fire one. `dwellMs` is how long the pointer stays.
   */
  | { readonly kind: 'hover'; readonly selector: string; readonly dwellMs: number }
  /** `dwellMs` is the pause at each step — long enough for view- and dwell-triggered events. */
  | { readonly kind: 'scroll'; readonly dwellMs: number }
  | { readonly kind: 'same-tab'; readonly on: boolean }
  /** Asks every frame to report itself, so the panel learns which frames exist. */
  | { readonly kind: 'announce' }
  | { readonly kind: 'form-needs'; readonly selector: string }
  | { readonly kind: 'location' }
  | { readonly kind: 'navigate'; readonly url: string }
  /**
   * Where the control a sub-intent names is, if it is in this frame.
   *
   * Deliberately separate from acting on it: asking every frame where a target is, and only then
   * telling the frame that answered to act, is what lets a step work inside an iframe without a
   * second execution path.
   */
  | { readonly kind: 'resolve'; readonly wanted: string };

export type AutomationReply =
  | {
      readonly kind: 'candidates';
      readonly platform: string;
      readonly candidates: readonly ActionCandidate[];
    }
  /** `hit` is absent from replies that did not measure it — the targeted runner's, and fakes. */
  | { readonly kind: 'clicked'; readonly hit?: ClickHit }
  /**
   * The click was refused: a visitor could not have made it. `element.click()` would have fired
   * anyway, which is how a sweep clicked the page behind an open dialog for round after round.
   */
  | { readonly kind: 'unclickable'; readonly hit: ClickHit }
  /** The selector no longer matches anything — the page changed, but it is still alive. */
  | { readonly kind: 'not-found' }
  | { readonly kind: 'dismissed' }
  | { readonly kind: 'scrolled' }
  | { readonly kind: 'hovered' }
  | {
      readonly kind: 'form-needs';
      readonly isSubmit: boolean;
      readonly fields: readonly string[];
    }
  | { readonly kind: 'acknowledged' }
  | { readonly kind: 'links'; readonly urls: readonly string[] }
  | { readonly kind: 'location'; readonly url: string; readonly stamp: string }
  | { readonly kind: 'navigating' }
  | { readonly kind: 'picked'; readonly candidate: ActionCandidate }
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'clickables';
      readonly clickables: readonly Clickable[];
      /** Frames we could not see into, so coverage gaps are reported rather than silent. */
      readonly unreachableFrames?: number;
      /** Every iframe element, readable or not — answered by the top frame only. */
      readonly iframes?: readonly FrameNote[];
      /** Controls inside open shadow roots, which the listing does not include. */
      readonly shadowControls?: number;
      /** What the page is telling its visitor right now — toasts, alerts, status messages. */
      readonly notices?: readonly string[];
    }
  | { readonly kind: 'resolved'; readonly resolution: TargetResolution }
  | { readonly kind: 'error'; readonly message: string };

export interface FrameReply {
  readonly frameId: number;
  readonly reply: AutomationReply;
}

export interface KnownFrame {
  readonly frameId: number;
  readonly url: string;
}

/**
 * Drives the inspected page. Implemented by the panel against chrome.tabs.
 *
 * `send` addresses the top frame. `sendAll` and `sendTo` exist because a page's controls can live
 * inside iframes, which are separate documents with their own content scripts — a single reply
 * would only ever describe one of them. Both are optional: a driver that knows nothing about
 * frames still works, it just sees the top document only.
 */
export interface PageDriver {
  send(command: AutomationCommand): Promise<AutomationReply>;
  sendAll?(command: AutomationCommand): Promise<readonly FrameReply[]>;
  sendTo?(frameId: number, command: AutomationCommand): Promise<AutomationReply>;
  /** Which frames answered, for reporting. Guessing why iframes are missed is not diagnosis. */
  knownFrames?(): readonly KnownFrame[];
}
