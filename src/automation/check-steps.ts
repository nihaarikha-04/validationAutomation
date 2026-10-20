import type { FrameReply, PageDriver } from './commands';
import type { TargetResolution } from './find-target';
import type { SubIntent } from '../event-sheet/sub-intents';

/**
 * Asking the page, for each step of an event, whether the control it names is here.
 *
 * Nothing is clicked. This exists because the step that comes out of a client's sentence is a
 * *claim* — "there is something here called search" — and the cheapest moment to find out it is
 * wrong is before a run, not halfway through one. It also answers, per site, the only question
 * that decides whether a cleverer matcher is worth building: how many targets are found by name
 * alone.
 *
 * Every frame is asked and the answers are reconciled here, because a control can live in an
 * iframe and a single frame's reply only ever describes its own document.
 */

export type StepCheck =
  /** Found in exactly one frame. */
  | { readonly kind: 'here'; readonly label: string; readonly frameId: number }
  | { readonly kind: 'missing' }
  /**
   * No frame answered at all, which is not the same as the control being absent.
   *
   * The commonest cause is a content script that is not running — reloading the extension leaves
   * the already-open page without one until it is reloaded too. Reported separately because the
   * two read identically otherwise, and "not on this page" sends a reader looking at the client's
   * markup for a problem that is in their browser.
   */
  | { readonly kind: 'no-answer'; readonly detail: string }
  /** Several matches, in one frame or across frames. A question for a person. */
  | { readonly kind: 'ambiguous'; readonly count: number; readonly describing: readonly string[] }
  /** A pause: the step is waiting on a person, so there is nothing on the page to find. */
  | { readonly kind: 'asks'; readonly valueKind: string }
  /** Nothing to look for — a navigation names an address rather than a control. */
  | { readonly kind: 'not-a-control' };

export interface CheckedStep {
  readonly intent: SubIntent;
  readonly check: StepCheck;
}

export async function checkSteps(
  intents: readonly SubIntent[],
  driver: PageDriver,
): Promise<readonly CheckedStep[]> {
  const checked: CheckedStep[] = [];

  for (const intent of intents) {
    checked.push({ intent, check: await checkOne(intent, driver) });
  }

  return checked;
}

async function checkOne(intent: SubIntent, driver: PageDriver): Promise<StepCheck> {
  if (intent.kind === 'ask') {
    return { kind: 'asks', valueKind: intent.valueKind ?? 'value' };
  }
  if (intent.kind === 'navigate') {
    return { kind: 'not-a-control' };
  }

  return reconcile(await askEveryFrame(intent.target, driver));
}

/** A driver that knows nothing about frames still works; it just sees the top document. */
async function askEveryFrame(
  wanted: string,
  driver: PageDriver,
): Promise<readonly FrameReply[]> {
  if (driver.sendAll !== undefined) {
    return driver.sendAll({ kind: 'resolve', wanted });
  }

  return [{ frameId: 0, reply: await driver.send({ kind: 'resolve', wanted }) }];
}

/**
 * One answer out of every frame's.
 *
 * **Two frames each finding one match is still ambiguous**, and that is the case this function
 * exists for: a quick-view panel in an iframe duplicating a control from the page behind it looks
 * unambiguous to each document and is not. Guessing between them would act in the wrong one.
 */
function reconcile(replies: readonly FrameReply[]): StepCheck {
  const resolutions = replies.flatMap((entry) =>
    entry.reply.kind === 'resolved'
      ? [{ frameId: entry.frameId, resolution: entry.reply.resolution }]
      : [],
  );

  if (resolutions.length === 0) {
    const errored = replies.find((entry) => entry.reply.kind === 'error');

    return {
      kind: 'no-answer',
      detail:
        errored?.reply.kind === 'error'
          ? errored.reply.message
          : 'No frame on the page answered.',
    };
  }

  const found = resolutions.filter((entry) => entry.resolution.kind === 'found');
  const [only, second] = found;

  if (only !== undefined && second === undefined && only.resolution.kind === 'found') {
    return { kind: 'here', label: only.resolution.match.label, frameId: only.frameId };
  }

  if (found.length > 1) {
    return {
      kind: 'ambiguous',
      count: found.length,
      describing: found.flatMap((entry) =>
        entry.resolution.kind === 'found'
          ? [`"${entry.resolution.match.label}" in frame ${entry.frameId}`]
          : [],
      ),
    };
  }

  // Nothing was found anywhere. A frame that saw several is more informative than one that saw none.
  const contested = resolutions
    .map((entry) => entry.resolution)
    .find((resolution): resolution is Extract<TargetResolution, { kind: 'ambiguous' }> =>
      resolution.kind === 'ambiguous',
    );

  return contested === undefined
    ? { kind: 'missing' }
    : { kind: 'ambiguous', count: contested.count, describing: contested.describing };
}
