import type { AutomationReply, KnownFrame, PageDriver } from './commands';
import type { CapturedPayload } from '../shared/payload';
import type { FieldRule } from './fill';
import type { Clickable, ClickRisk } from './sweep';

/** A control plus the frame it lives in, so the click goes back to the right document. */
interface FrameClickable extends Clickable {
  readonly frameId: number;
}

/** Consecutive unreachable replies that mean the page has gone, rather than one element. */
const GIVE_UP_AFTER = 3;

/**
 * Clicks to spend on one kind of control before accepting it does nothing.
 *
 * A grid of forty product tiles that fire nothing should cost three clicks, not forty.
 */
const TRIES_PER_GROUP = 3;

/** How long to wait for a content script to come back after a navigation. */
const PAGE_READY_TIMEOUT_MS = 15_000;
const PAGE_POLL_MS = 400;

export interface Observation {
  readonly label: string;
  readonly eventNames: readonly string[];
}

export interface SweepDeps {
  readonly driver: PageDriver;
  readonly now: () => number;
  readonly settleMs: number;
  /** Payloads captured at or after the given moment. Injected so this stays testable. */
  readonly payloadsSince: (from: number) => readonly CapturedPayload[];
  readonly onProgress: (message: string) => void;
  readonly allowed: (risk: ClickRisk) => boolean;
  /** Animate a pointer to each element before clicking it, so the run can be watched. */
  readonly showPointer: boolean;
  /**
   * How long to rest the pointer on a control before clicking it. `0` skips hovering.
   *
   * Hover-triggered events — a banner reporting `hover_time` — cannot be produced by a click,
   * so without this they are unreachable no matter how much of the site is swept. Hovering the
   * control we are about to click is also what a real visitor does on the way to clicking it.
   */
  readonly hoverMs: number;
  /**
   * How long to rest at each step of the scroll pass. `0` scrolls straight through.
   *
   * View- and dwell-triggered events need the page to stop where they are; a scroll that only
   * exists to load lazy content moves too fast to fire any of them.
   */
  readonly dwellMs: number;
  /**
   * Checked at every step. With no click or page limits, this is the only way to end a run, so
   * it is not optional.
   */
  readonly isCancelled: () => boolean;
  /**
   * Values to type into fields before clicking.
   *
   * A search box left empty produces no search event and a login form no sign-in, so those events
   * are unreachable by clicking alone however thorough the sweep is.
   */
  readonly fieldRules: readonly FieldRule[];
  /**
   * Called when a control would submit a form with empty fields.
   *
   * The sweep stops there and hands the form to whoever is watching: a tester knows what the site
   * is asking for, and no set of pre-written values ever will. Resolving with `continue` clicks
   * it, `skip` moves on, `stop` ends the run.
   */
  readonly onNeedsInput?: (request: InputRequest) => Promise<InputDecision>;
}

export interface InputRequest {
  /** The control that is waiting. */
  readonly label: string;
  /** The fields that are still blank, named the way the page names them. */
  readonly fields: readonly string[];
}

export type InputDecision = 'continue' | 'skip' | 'stop';

export interface SweepOutcome {
  readonly observations: readonly Observation[];
  readonly captured: readonly CapturedPayload[];
  /** Set when the sweep ended early, with the reason. */
  readonly stopped: string | undefined;
  /** Controls left unclicked because another of their kind had already been tried. */
  readonly skippedAsRepeats: number;
  /** Where a click took us, when one navigated. That page has not been swept yet. */
  readonly navigatedTo: string | undefined;
  /**
   * Routes the page showed without loading — quick-views and overlays that push a URL. Their
   * controls were swept in place, but they are worth naming, and worth visiting properly later
   * since a full load of the same route can fire different events.
   */
  readonly routesSeen: readonly string[];
  /** Cross-origin frames we could not see into — a coverage gap worth naming, not hiding. */
  readonly unreachableFrames: number;
  /** How many frames answered. One means only the top document was reached. */
  readonly framesSeen: number;
  /** Every frame that answered, so a missing iframe can be identified rather than guessed at. */
  readonly frames: readonly KnownFrame[];
}

/**
 * Clicks everything clickable on the current page and records what each click produced.
 *
 * The page is re-listed every round rather than enumerated once: the first click often opens a
 * menu or re-renders, which would invalidate every selector captured beforehand.
 */
export async function sweepPage(
  deps: SweepDeps,
  budget: number = Number.POSITIVE_INFINITY,
): Promise<SweepOutcome> {
  const observations: Observation[] = [];
  const captured: CapturedPayload[] = [];
  const visited = new Set<string>();
  /** Events each kind of control has already produced. */
  const produced = new Map<string, number>();
  /** Clicks already spent on each kind of control. */
  const tried = new Map<string, number>();
  let unreachable = 0;
  let skippedAsRepeats = 0;
  const routesSeen = new Set<string>();
  let unreachableFrames = 0;
  let framesSeen = 1;
  let frames: readonly KnownFrame[] = [];
  /** Whether the last thing we did was close an overlay, so we do not loop closing nothing. */
  let justDismissed = false;

  // Once one product tile has fired product_view, the other thirty-nine tell us nothing new.
  const exhausted = (group: string): boolean =>
    (produced.get(group) ?? 0) > 0 || (tried.get(group) ?? 0) >= TRIES_PER_GROUP;

  // Where we began, so a click that navigates can be noticed.
  const opened = await deps.driver.send({ kind: 'location' });
  const startedIn = opened.kind === 'location' ? opened.stamp : undefined;
  const startedUrl = opened.kind === 'location' ? opened.url : undefined;

  // Keep anything a click opens inside the tab DevTools is attached to; otherwise it lands in a
  // tab we cannot see and the sweep appears to stop for no reason.
  await deps.driver.send({ kind: 'same-tab', on: true });

  // Load whatever appears on scroll before taking stock of the page, resting at each step so
  // anything that fires on becoming visible gets the chance to.
  await deps.driver.send({ kind: 'scroll', dwellMs: deps.dwellMs });

  // Fill anything that wants a value, so submit buttons have something to submit.
  if (deps.fieldRules.length > 0) {
    await fillEveryFrame(deps);
  }

  for (let round = 0; round < budget; round += 1) {
    if (deps.isCancelled()) {
      return {
        observations,
        captured,
        stopped: 'Stopped.',
        skippedAsRepeats,
        navigatedTo: undefined,
        routesSeen: [...routesSeen],
        unreachableFrames,
        framesSeen,
        frames,
      };
    }

    const listing = await listClickables(deps);
    const listed = listing.reply;
    if (listed.kind !== 'clickables') {
      return {
        observations,
        captured,
        skippedAsRepeats,
        navigatedTo: undefined,
        routesSeen: [...routesSeen],
        unreachableFrames,
        framesSeen,
        frames,
        stopped:
          round === 0
            ? listed.kind === 'error'
              ? listed.message
              : 'The page did not answer.'
            : `Stopped after ${visited.size} clicks — the page stopped responding, which usually means a click navigated away.`,
      };
    }

    unreachableFrames = Math.max(unreachableFrames, listing.unreachableFrames);
    framesSeen = Math.max(framesSeen, listing.framesSeen);
    frames = deps.driver.knownFrames?.() ?? [];

    const available = listing.clickables.filter(
      (entry) => deps.allowed(entry.risk) && !visited.has(frameKey(entry)),
    );
    const next = available.find((entry) => !exhausted(entry.group));
    if (next === undefined) {
      // Nothing left to click here. If a click opened an overlay, closing it may reveal the page
      // underneath — so try that once, then stop if it changes nothing.
      if (!justDismissed) {
        justDismissed = true;
        await deps.driver.send({ kind: 'dismiss' });
        continue;
      }
      skippedAsRepeats += available.length;
      break;
    }
    justDismissed = false;
    visited.add(frameKey(next));
    tried.set(next.group, (tried.get(next.group) ?? 0) + 1);
    deps.onProgress(`Click ${visited.size}: ${next.label}`);

    // A form nobody has filled in submits nothing useful, so ask before clicking it.
    if (deps.onNeedsInput !== undefined) {
      const needs = await askFormNeeds(deps, next);

      if (needs !== undefined && needs.isSubmit && needs.fields.length > 0) {
        const decision = await deps.onNeedsInput({ label: next.label, fields: needs.fields });

        if (decision === 'stop') {
          return {
            observations,
            captured,
            stopped: 'Stopped.',
            skippedAsRepeats,
            navigatedTo: undefined,
            routesSeen: [...routesSeen],
            unreachableFrames,
            framesSeen,
            frames,
          };
        }
        if (decision === 'skip') {
          continue;
        }
      }
    }

    // Opened before the hover, not after: an event fired by the pointer arriving belongs to this
    // control just as much as one fired by the click, and must land in the same capture window.
    const from = deps.now();

    if (deps.hoverMs > 0) {
      const hoverCommand = {
        kind: 'hover' as const,
        selector: next.selector,
        dwellMs: deps.hoverMs,
      };
      await (deps.driver.sendTo === undefined
        ? deps.driver.send(hoverCommand)
        : deps.driver.sendTo(next.frameId, hoverCommand));
    }

    const clickCommand = {
      kind: 'click' as const,
      selector: next.selector,
      show: deps.showPointer,
    };
    const clicked =
      deps.driver.sendTo === undefined
        ? await deps.driver.send(clickCommand)
        : await deps.driver.sendTo(next.frameId, clickCommand);

    // The element went away between listing and clicking. The page is fine; skip it.
    if (clicked.kind === 'not-found') {
      continue;
    }
    if (clicked.kind !== 'clicked') {
      unreachable += 1;
      if (unreachable >= GIVE_UP_AFTER) {
        return {
          observations,
          captured,
          skippedAsRepeats,
          navigatedTo: undefined,
          routesSeen: [...routesSeen],
        unreachableFrames,
        framesSeen,
        frames,
          stopped: `Stopped after ${visited.size} clicks — the page stopped responding. Reload and try again.`,
        };
      }
      continue;
    }
    unreachable = 0;

    await delay(deps.settleMs);
    const fired = deps.payloadsSince(from);
    captured.push(...fired);
    if (fired.length > 0) {
      produced.set(next.group, (produced.get(next.group) ?? 0) + fired.length);
    }
    observations.push({
      label: next.label,
      eventNames: [...new Set(fired.map(describeEvent))],
    });

    // Only a genuine page load ends this sweep. A URL change within the same document — which is
    // what a single-page overlay or quick-view does — leaves every remaining control right where
    // it was, so stopping there abandoned the sweep for no reason.
    const here = await deps.driver.send({ kind: 'location' });
    if (here.kind === 'location' && here.url !== startedUrl) {
      routesSeen.add(here.url);
    }
    if (here.kind === 'location' && startedIn !== undefined && here.stamp !== startedIn) {
      return {
        observations,
        captured,
        stopped: undefined,
        skippedAsRepeats,
        navigatedTo: here.url,
        routesSeen: [...routesSeen],
        unreachableFrames,
        framesSeen,
        frames,
      };
    }

    // Deliberately no dismiss here. A click that opens a modal puts its buttons in the DOM, and
    // the next round enumerates and clicks them — closing it immediately would mean an overlay's
    // contents were never tested at all. It is closed later, once nothing clickable remains.
  }

  return {
    observations,
    captured,
    stopped: undefined,
    skippedAsRepeats,
    navigatedTo: undefined,
    routesSeen: [...routesSeen],
    unreachableFrames,
    framesSeen,
    frames,
  };
}

export interface CrawlDeps extends SweepDeps {
  /** Pages to visit at most. `0` means keep going until the site runs out or you stop it. */
  readonly maxPages: number;
  /** Clicks to spend per page. `0` means click everything the page offers. */
  readonly clicksPerPage: number;
}

export interface PageResult {
  readonly url: string;
  readonly observations: readonly Observation[];
  readonly stopped: string | undefined;
  /** How many onward links this page offered — zero explains a crawl that ends early. */
  readonly linksFound: number;
  /** Controls left alone because another of their kind had already been tried. */
  readonly skippedAsRepeats: number;
  /** Routes shown as overlays rather than loaded — swept in place, and queued for a real visit. */
  readonly routesSeen: readonly string[];
  /** Cross-origin frames we could not see into. */
  readonly unreachableFrames: number;
  /** How many frames answered on this page. */
  readonly framesSeen: number;
  /** Which frames answered, listed so a missing iframe is identifiable. */
  readonly frames: readonly KnownFrame[];
}

export interface CrawlOutcome {
  readonly pages: readonly PageResult[];
  readonly captured: readonly CapturedPayload[];
  readonly stopped: string | undefined;
}

/**
 * Sweeps the current page, then walks the site's own links doing the same on each.
 *
 * Navigation is deliberate rather than incidental: outbound-link clicking stays switched off
 * during a sweep, so the only way the crawler leaves a page is by choosing to.
 */
export async function crawlSite(deps: CrawlDeps): Promise<CrawlOutcome> {
  const start = await deps.driver.send({ kind: 'location' });
  if (start.kind !== 'location') {
    return { pages: [], captured: [], stopped: 'Could not read the current page address.' };
  }

  const queue: string[] = [start.url];
  const seen = new Set<string>([normalise(start.url)]);
  const pages: PageResult[] = [];
  const captured: CapturedPayload[] = [];
  let currentUrl = start.url;

  const pageLimit = deps.maxPages > 0 ? deps.maxPages : Number.POSITIVE_INFINITY;
  const clickLimit = deps.clicksPerPage > 0 ? deps.clicksPerPage : Number.POSITIVE_INFINITY;

  while (queue.length > 0 && pages.length < pageLimit) {
    if (deps.isCancelled()) {
      return { pages, captured, stopped: 'Stopped.' };
    }

    const url = queue.shift();
    if (url === undefined) {
      break;
    }

    // Only navigate if we are not already there — a click may have taken us to this very page.
    if (normalise(url) !== normalise(currentUrl)) {
      deps.onProgress(`Opening page ${pages.length + 1}${describeLimit(pageLimit)}: ${url}`);
      await deps.driver.send({ kind: 'navigate', url });

      if (!(await waitForPage(deps))) {
        return { pages, captured, stopped: `Gave up waiting for ${url} to load.` };
      }
    }
    currentUrl = url;

    // Links are read *before* clicking anything. A click can navigate or break the page, and
    // collecting the queue afterwards meant one bad click ended the whole crawl at page one.
    const enqueue = (urls: readonly string[]): void => {
      for (const found of urls) {
        const key = normalise(found);
        if (!seen.has(key)) {
          seen.add(key);
          queue.push(found);
        }
      }
    };

    const links = await deps.driver.send({ kind: 'links' });
    let linksFound = 0;
    if (links.kind === 'links') {
      linksFound = links.urls.length;
      enqueue(links.urls);
    }

    deps.onProgress(`Sweeping page ${pages.length + 1}${describeLimit(pageLimit)}: ${url}`);
    const outcome = await sweepPage(deps, clickLimit);
    captured.push(...outcome.captured);

    // Links again, now that the sweep has opened menus and overlays. Gathering only beforehand
    // meant everything an overlay revealed was invisible to the crawl.
    const after = await deps.driver.send({ kind: 'links' });
    if (after.kind === 'links') {
      linksFound = Math.max(linksFound, after.urls.length);
      enqueue(after.urls);
    }

    // A route the page showed as an overlay is worth loading properly: the same URL can behave
    // differently, and fire different events, when it is a page rather than a panel.
    enqueue(outcome.routesSeen);
    pages.push({
      url,
      observations: outcome.observations,
      stopped: outcome.stopped,
      linksFound,
      skippedAsRepeats: outcome.skippedAsRepeats,
      routesSeen: outcome.routesSeen,
      unreachableFrames: outcome.unreachableFrames,
      framesSeen: outcome.framesSeen,
      frames: outcome.frames,
    });

    // A click took us somewhere. Sweep it next, before working back through the queue — that is
    // how a product tile leads to the product page, and its Add to Cart button.
    if (outcome.navigatedTo !== undefined) {
      currentUrl = outcome.navigatedTo;
      const key = normalise(outcome.navigatedTo);
      if (!seen.has(key)) {
        seen.add(key);
        queue.unshift(outcome.navigatedTo);
      }
    }
  }

  return { pages, captured, stopped: undefined };
}

/**
 * Every frame's controls, merged.
 *
 * Iframes are separate documents with their own content scripts, so asking only the top frame
 * describes only part of the page — a payment or product widget in a frame was invisible. A
 * driver that cannot address frames falls back to the top document alone.
 */
async function listClickables(deps: SweepDeps): Promise<{
  reply: AutomationReply;
  clickables: readonly FrameClickable[];
  unreachableFrames: number;
  framesSeen: number;
}> {
  if (deps.driver.sendAll === undefined) {
    const reply = await deps.driver.send({ kind: 'clickables' });
    return {
      reply,
      clickables:
        reply.kind === 'clickables'
          ? reply.clickables.map((entry) => ({ ...entry, frameId: 0 }))
          : [],
      unreachableFrames: reply.kind === 'clickables' ? (reply.unreachableFrames ?? 0) : 0,
      framesSeen: 1,
    };
  }

  const replies = await deps.driver.sendAll({ kind: 'clickables' });
  const clickables: FrameClickable[] = [];
  let unreachableFrames = 0;

  for (const { frameId, reply } of replies) {
    if (reply.kind !== 'clickables') {
      continue;
    }
    unreachableFrames += reply.unreachableFrames ?? 0;
    clickables.push(...reply.clickables.map((entry) => ({ ...entry, frameId })));
  }

  const top = replies.find((entry) => entry.frameId === 0)?.reply;
  return {
    reply: top ?? { kind: 'clickables', clickables: [] },
    clickables,
    unreachableFrames,
    // How many documents actually answered — one means frame discovery found nothing but the top.
    framesSeen: replies.length,
  };
}

/**
 * What to call a captured payload in the click log.
 *
 * "(unnamed)" said nothing about a payload we could not find a name in. Listing its fields at
 * least shows what arrived, and whether the name is hiding under a key we do not know about.
 */
function describeEvent(payload: CapturedPayload): string {
  if (payload.eventName !== undefined) {
    return payload.eventName;
  }

  const subject = payload.args.find(
    (argument) => typeof argument === 'object' && argument !== null && !Array.isArray(argument),
  );
  if (subject === undefined || subject === null || typeof subject !== 'object') {
    return 'unnamed, no payload';
  }

  const keys = Object.keys(subject).slice(0, 4);
  return keys.length === 0 ? 'unnamed, empty payload' : `unnamed {${keys.join(', ')}}`;
}

async function askFormNeeds(
  deps: SweepDeps,
  control: FrameClickable,
): Promise<{ isSubmit: boolean; fields: readonly string[] } | undefined> {
  const command = { kind: 'form-needs' as const, selector: control.selector };
  // Ask the frame the control lives in; the top document cannot see inside one.
  const reply =
    deps.driver.sendTo === undefined
      ? await deps.driver.send(command)
      : await deps.driver.sendTo(control.frameId, command);

  return reply.kind === 'form-needs' ? reply : undefined;
}

/** Fields can live in frames too, so every frame is asked. */
async function fillEveryFrame(deps: SweepDeps): Promise<void> {
  const command = { kind: 'fill' as const, rules: deps.fieldRules };

  if (deps.driver.sendAll === undefined) {
    await deps.driver.send(command);
    return;
  }
  await deps.driver.sendAll(command);
}

/** Ids are per-document, so a frame's number is part of a control's identity. */
function frameKey(entry: FrameClickable): string {
  return `${entry.frameId}:${entry.selector}`;
}

/** Polls until the content script on the new page answers, or the wait runs out. */
async function waitForPage(deps: SweepDeps): Promise<boolean> {
  const deadline = deps.now() + PAGE_READY_TIMEOUT_MS;

  while (deps.now() < deadline) {
    await delay(PAGE_POLL_MS);
    const here = await deps.driver.send({ kind: 'location' });
    if (here.kind === 'location') {
      return true;
    }
  }
  return false;
}

function describeLimit(limit: number): string {
  return Number.isFinite(limit) ? ` of ${limit}` : '';
}

/** Trailing slashes and fragments do not make a different page. */
function normalise(url: string): string {
  return url.replace(/#.*$/, '').replace(/\/$/, '');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
