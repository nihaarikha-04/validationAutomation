import type { InputDecision } from './crawl';
import type { ClickHit, FrameNote } from './sweep';

/** What began a sweep: the tester, or a navigation picked up by "Carry on automatically". */
export type SweepTrigger = 'button' | 'page-changed';

/** How the controls listed this round compare with the last round's. */
export type ListingChange = 'first' | 'same' | 'different';

/**
 * One line of a sweep's run log.
 *
 * Exists to settle what a stuck run is doing before anything is changed to stop it: whether
 * clicks land behind an open dialog, whether a frame never answered, whether rounds go by with
 * the page unchanged, and whether the same page is being swept again from scratch.
 */
export type TraceEntry =
  | { readonly kind: 'started'; readonly trigger: SweepTrigger }
  | { readonly kind: 'sweep'; readonly url: string | undefined }
  /** Every iframe element on the page and how many frames answered — logged when it changes. */
  | {
      readonly kind: 'frames';
      readonly round: number;
      readonly answered: number;
      readonly iframes: readonly FrameNote[];
      readonly shadowControls: number;
    }
  | {
      readonly kind: 'listed';
      readonly round: number;
      readonly controls: number;
      readonly frames: number;
      readonly inOverlay: number;
      /** Controls something else is drawn over, which a visitor could not press. */
      readonly covered: number;
      /** What sits on top of them, up to three distinct. */
      readonly coveredBy: readonly string[];
      /** Allowed, not yet clicked, pressable, and of a kind still worth clicking. */
      readonly candidates: number;
      readonly change: ListingChange;
      /** Rounds in a row that achieved nothing, counted up to this one. */
      readonly stalls: number;
      /** Messages the page started showing since last round — usually what the last click caused. */
      readonly newNotices: readonly string[];
    }
  | {
      readonly kind: 'clicked';
      readonly round: number;
      readonly label: string;
      readonly frameId: number;
      readonly inOverlay: boolean;
      readonly hit: ClickHit | undefined;
      readonly fired: readonly string[];
      readonly url: string | undefined;
    }
  /** The click was sent and did not land. `reply` is what the page said instead. */
  | {
      readonly kind: 'missed';
      readonly round: number;
      readonly label: string;
      readonly frameId: number;
      readonly reply: string;
      /** Set when the click was refused, saying what a visitor would have hit instead. */
      readonly hit: ClickHit | undefined;
    }
  /** A form would submit empty; the tester was asked, and this is what they chose. */
  | {
      readonly kind: 'asked';
      readonly round: number;
      readonly label: string;
      readonly fields: readonly string[];
      readonly decision: InputDecision;
    }
  /** A step taken to uncover the page: Escape, or clicking what opened the cover again. */
  | { readonly kind: 'recovering'; readonly round: number; readonly how: 'escape' }
  | {
      readonly kind: 'recovering';
      readonly round: number;
      readonly how: 'toggle';
      readonly label: string;
    }
  | {
      readonly kind: 'ended';
      readonly clicks: number;
      readonly stopped: string | undefined;
      readonly navigatedTo: string | undefined;
    };

export function traceLine(entry: TraceEntry): string {
  switch (entry.kind) {
    case 'started':
      return entry.trigger === 'button'
        ? '── sweep started from the button'
        : '── sweep restarted on its own: the page changed and "Carry on automatically" is on';
    case 'sweep':
      return `sweeping ${entry.url ?? '(the page did not say where it is)'}`;
    case 'frames':
      return framesText(entry);
    case 'listed':
      return (
        `#${entry.round} listed ${entry.controls} controls in ${entry.frames} ` +
        `frame${entry.frames === 1 ? '' : 's'} · ${entry.inOverlay} in an overlay · ` +
        `${entry.covered} covered${entry.coveredBy.length === 0 ? '' : ` (by ${entry.coveredBy.join(', ')})`} · ${entry.candidates} left to try · ${changeText(entry.change)}` +
        (entry.stalls === 0 ? '' : ` · ${entry.stalls} stalled in a row`) +
        (entry.newNotices.length === 0
          ? ''
          : ` · page says: ${entry.newNotices.map((text) => `"${text}"`).join(', ')}`)
      );
    case 'clicked':
      return (
        `#${entry.round} click "${entry.label}" [frame ${entry.frameId}` +
        `${entry.inOverlay ? ', overlay' : ''}] → ${hitText(entry.hit)} · fired: ` +
        `${entry.fired.length === 0 ? 'nothing' : entry.fired.join(', ')} · at ${entry.url ?? '?'}`
      );
    case 'missed':
      return (
        `#${entry.round} click "${entry.label}" [frame ${entry.frameId}] → did not land: ` +
        `${entry.reply}${entry.hit === undefined ? '' : ` (${hitText(entry.hit)})`}`
      );
    case 'asked':
      return (
        `#${entry.round} "${entry.label}" would submit empty (${entry.fields.join(', ')}) — ` +
        `tester chose ${entry.decision}`
      );
    case 'recovering':
      return entry.how === 'escape'
        ? `#${entry.round} trying to uncover the page — pressed Escape`
        : `#${entry.round} trying to uncover the page — clicked "${entry.label}" again, since it opened what is on top`;
    case 'ended':
      return `── sweep ended after ${entry.clicks} clicks: ${endText(entry)}`;
  }
}

function changeText(change: ListingChange): string {
  switch (change) {
    case 'first':
      return 'first look';
    case 'same':
      return 'page unchanged since last round';
    case 'different':
      return 'page changed since last round';
  }
}

function hitText(hit: ClickHit | undefined): string {
  if (hit === undefined) {
    return 'hit not measured';
  }
  switch (hit.kind) {
    case 'self':
      return 'reached it';
    case 'decoration':
      return `reached it through its own ${hit.by}`;
    case 'covered':
      return `COVERED by ${hit.by}`;
    case 'off-screen':
      return 'off-screen when clicked';
    case 'no-size':
      return 'takes up no space';
    case 'unmeasured':
      return 'could not measure';
  }
}

function endText(entry: { stopped: string | undefined; navigatedTo: string | undefined }): string {
  if (entry.stopped !== undefined) {
    return entry.stopped;
  }
  if (entry.navigatedTo !== undefined) {
    return `a click navigated to ${entry.navigatedTo}`;
  }
  return 'nothing left to click, or the click limit was reached';
}

function framesText(entry: {
  round: number;
  answered: number;
  iframes: readonly FrameNote[];
  shadowControls: number;
}): string {
  const frames =
    entry.iframes.length === 0
      ? 'no iframe elements'
      : entry.iframes
          .map(
            (frame) =>
              `[${frame.readable ? 'readable' : 'NOT readable — other origin'}] ${frame.source} ` +
              `${frame.width}×${frame.height}`,
          )
          .join('; ');
  const shadow =
    entry.shadowControls === 0
      ? ''
      : ` · ${entry.shadowControls} controls inside shadow DOM, not listed`;
  return `#${entry.round} frames: ${entry.answered} answered · ${frames}${shadow}`;
}
