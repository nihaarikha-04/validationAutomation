import type { AutomationReply, KnownFrame, PageDriver } from './commands';
import type { CapturedPayload } from '../shared/payload';
import type { Clickable, ClickRisk } from './sweep';
import { urlShape } from './url-shape';

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
/** Fruitless clicks on one kind of control before moving on. */
const BARREN_TRIES = 2;

/**
 * A hard ceiling per kind of control, however much it keeps producing.
 *
 * Only a pathological page reaches it — the run's click budget and time limit bound a sweep long
 * before this does — but a list of two hundred distinct controls should not eat an entire run.
 */
const MAX_TRIES_PER_GROUP = 12;

/**
 * How many times one event is worth producing.
 *
 * A verdict needs one payload; a second is worth having because the first can be a first-load
 * special case — an empty cart, a cold session. A third tells us nothing the first two did not,
 * and a site where forty controls all fire `product_viewed` would otherwise spend a whole run
 * re-confirming it while the events that never fired stay untested.
 */
const MAX_PER_EVENT = 2;

/**
 * Pages of one kind to visit before deciding the kind has nothing left to give.
 *
 * Two, for the same reason a control gets two clicks: the first shows what the template does, the
 * second confirms it was not a first-load special case.
 */
const VISITS_PER_SHAPE = 2;

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
 * What a sweep remembers between visits.
 *
 * `clickedHere` belongs to one page: which of its controls have been spent, by an identity that
 * survives the page being left and reopened. `groups` belongs to the **whole crawl**, and that
 * distinction is the point — a navbar is the same component on every page, so learning that its
 * links produce nothing new has to carry from one page to the next.
 *
 * Held as mutable collections the crawler owns and passes in, rather than copied back and forth
 * through the outcome. There is one writer at a time; a sweep never runs concurrently with another.
 */
export interface GroupMemory {
  /** Distinct events each kind of control has produced, anywhere on the site. */
  readonly produced: Map<string, Set<string>>;
  /** Consecutive clicks on a kind of control that produced nothing new. */
  readonly barren: Map<string, number>;
  /** Clicks spent on each kind of control. */
  readonly tried: Map<string, number>;
  /** How many times each event has been produced, anywhere on the site. */
  readonly firedCounts: Map<string, number>;
}

export function newGroupMemory(): GroupMemory {
  return { produced: new Map(), barren: new Map(), tried: new Map(), firedCounts: new Map() };
}

export interface SweepMemory {
  readonly clickedHere: Set<string>;
  readonly groups: GroupMemory;
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
  memory: SweepMemory = { clickedHere: new Set(), groups: newGroupMemory() },
): Promise<SweepOutcome> {
  const observations: Observation[] = [];
  const captured: CapturedPayload[] = [];
  /** Element ids, exact within this page load — the precise check while the document lives. */
  const visited = new Set<string>();
  const spent = memory.clickedHere;
  const { produced, barren, tried, firedCounts } = memory.groups;
  let unreachable = 0;
  let skippedAsRepeats = 0;
  const routesSeen = new Set<string>();
  let unreachableFrames = 0;
  let framesSeen = 1;
  let frames: readonly KnownFrame[] = [];
  /** Whether the last thing we did was close an overlay, so we do not loop closing nothing. */
  let justDismissed = false;

  /**
   * Whether another control of this kind is still worth clicking.
   *
   * Stopping at the first success — which this used to do — assumes every control of a kind does
   * the same thing. True of a product grid, where tile two fires the same `product_viewed` as
   * tile one. False of the controls coverage actually depends on: a row of profile tabs is one
   * component, so clicking `Order History` retired `My Subscriptions`, `My Cards` and
   * `Recently Viewed` before they were ever tried. What exhausts a group is running out of *new*
   * events, not producing one.
   */
  /**
   * Whether this kind of control still has anything to teach us.
   *
   * Three ways to be finished: it stopped producing anything new, it hit the per-kind ceiling, or
   * — the one that matters most for coverage — everything it produces has already been captured
   * as often as it is worth capturing.
   */
  const exhausted = (group: string): boolean => {
    if ((barren.get(group) ?? 0) >= BARREN_TRIES) {
      return true;
    }
    if ((tried.get(group) ?? 0) >= MAX_TRIES_PER_GROUP) {
      return true;
    }

    const events = produced.get(group);
    if (events === undefined || events.size === 0) {
      return false;
    }
    // Every event this control produces is already in hand. Clicking it again re-fires events we
    // have and finds nothing we do not.
    return [...events].every((name) => (firedCounts.get(name) ?? 0) >= MAX_PER_EVENT);
  };

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

    const keyed = withStableKeys(listing.clickables);
    const available = keyed.filter(
      (entry) =>
        deps.allowed(entry.risk) &&
        // Two identities, deliberately. The element id is exact while this document lives; the
        // stable key is the only thing that survives navigating away and coming back.
        !visited.has(frameKey(entry)) &&
        !spent.has(entry.stableKey),
    );
    const worthClicking = available.filter((entry) => !exhausted(entry.group));

    /**
     * What to click next, in the order the page's own structure argues for.
     *
     * 1. **Overlays and iframes first.** A modal, a cart drawer or a widget in a frame is
     *    transient — it is dismissed by the next Escape, or replaced when the page re-renders —
     *    while the page underneath is not going anywhere. Clicking the page first meant an
     *    overlay's contents regularly disappeared before their turn came.
     * 2. **Then the rest of the page's own controls.** Document order alone put the navbar first
     *    on every page, and a navbar link navigates, which ends the sweep — so each page spent its
     *    clicks walking the header away and never reached its own body: no Add to Cart, no
     *    quantity control, no tab, no accordion.
     * 3. **Anything that closes an overlay after both**, so a modal is explored before it is shut.
     * 4. **Links last**, since following one is what hands the crawl to another page, and this one
     *    should be finished first.
     */
    const stays = worthClicking.filter((entry) => entry.risk !== 'navigates');
    // A control that closes what it is in goes last of all: an overlay's X sits first in document
    // order, so taking it in turn meant opening a modal and immediately closing it again without
    // touching a single one of the controls it was opened to reach.
    const keeps = stays.filter((entry) => entry.dismisses !== true);
    const next =
      keeps.find((entry) => entry.inOverlay === true || entry.frameId !== 0) ??
      keeps[0] ??
      stays[0] ??
      worthClicking[0];
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
    spent.add(next.stableKey);
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
    const seenForGroup = produced.get(next.group) ?? new Set<string>();
    const novel = fired.filter((payload) => {
      const name = payload.eventName;
      return name !== undefined && !seenForGroup.has(name);
    });
    for (const payload of novel) {
      if (payload.eventName !== undefined) {
        seenForGroup.add(payload.eventName);
      }
    }
    produced.set(next.group, seenForGroup);

    // Count every firing, not only the novel ones: the cap is on how often an event is produced
    // across the whole run, whichever control produced it.
    for (const payload of fired) {
      if (payload.eventName !== undefined) {
        firedCounts.set(payload.eventName, (firedCounts.get(payload.eventName) ?? 0) + 1);
      }
    }

    // A click that turns up something new earns this kind of control another go.
    barren.set(next.group, novel.length > 0 ? 0 : (barren.get(next.group) ?? 0) + 1);
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
  /**
   * Pages left unopened because another page of the same kind had already been swept and produced
   * nothing new. Counted rather than hidden — a crawl that quietly skipped half a site would look
   * identical to one that never found it.
   */
  readonly skippedAsSameKind: number;
}

/**
 * Sweeps the current page, then walks the site's own links doing the same on each.
 *
 * Navigation is deliberate rather than incidental: outbound-link clicking stays switched off
 * during a sweep, so the only way the crawler leaves a page is by choosing to.
 */
/**
 * Sweeps a site depth-first, finishing every page it opens before returning to the one that
 * opened it.
 *
 * The previous shape abandoned a page the moment a click navigated: the new page went to the
 * front of the queue and the old one, already in `seen`, was never opened again. On a storefront
 * the first link click navigates, so almost every page contributed exactly one click before being
 * dropped — which is why a crawl looked like it was barely moving.
 *
 * Now a page that navigates is pushed onto a stack. The page it landed on is swept to exhaustion,
 * then popped, and the page underneath resumes from the control after the one that took it away.
 * Resumption works because `sweepPage` is handed the reload-stable keys of everything already
 * clicked there — see `withStableKeys`.
 */
export async function crawlSite(deps: CrawlDeps): Promise<CrawlOutcome> {
  const start = await deps.driver.send({ kind: 'location' });
  if (start.kind !== 'location') {
    return {
      pages: [],
      captured: [],
      stopped: 'Could not read the current page address.',
      skippedAsSameKind: 0,
    };
  }

  /** Pages found but not yet opened, in the order they were found. */
  const queue: string[] = [];
  const queued = new Set<string>([normalise(start.url)]);
  /** Pages opened and not yet exhausted, deepest last. */
  const stack: string[] = [start.url];
  const onStack = new Set<string>([normalise(start.url)]);
  /**
   * Clicks already spent per page, surviving the page being left and reopened. Keyed by page
   * rather than by stack entry so a cycle — A opens B, B opens A — resumes A rather than
   * restarting it, which would otherwise loop forever.
   */
  const spentPerPage = new Map<string, Set<string>>();
  /** How many pages of each kind have been swept, and what those sweeps produced. */
  const shapeVisits = new Map<string, number>();
  const shapeEvents = new Map<string, Set<string>>();
  let skippedAsSameKind = 0;
  /**
   * What each kind of control is worth, learned once for the whole crawl.
   *
   * Rebuilt per sweep, this was the reason a crawl circled the navbar: every page — and every
   * resumed visit to a page — started with an empty record, so a navbar's links were clicked in
   * full again and again, each one costing a navigation away and a navigation back. Carrying it
   * means the group retires after a couple of barren tries and stays retired.
   */
  const groups = newGroupMemory();
  /** One result per page, merged across however many visits it took to exhaust it. */
  const results = new Map<string, PageResult>();
  const captured: CapturedPayload[] = [];
  let currentUrl = start.url;

  const pageLimit = deps.maxPages > 0 ? deps.maxPages : Number.POSITIVE_INFINITY;
  const clickLimit = deps.clicksPerPage > 0 ? deps.clicksPerPage : Number.POSITIVE_INFINITY;

  /**
   * Whether another page of this kind is still worth opening.
   *
   * Evidence, not guesswork: a kind is only written off once pages of it have actually been swept
   * and everything they produced is already captured as often as it is worth capturing. A shape
   * that is too broad therefore costs nothing — it keeps being visited while it keeps producing.
   */
  const exhaustedShape = (shape: string): boolean => {
    if ((shapeVisits.get(shape) ?? 0) < VISITS_PER_SHAPE) {
      return false;
    }

    // An empty set means pages of this kind produced nothing at all, twice. More of them will not
    // produce anything either.
    const seen = shapeEvents.get(shape) ?? new Set<string>();
    return [...seen].every((name) => (groups.firedCounts.get(name) ?? 0) >= MAX_PER_EVENT);
  };

  /** The next queued page whose kind still has something to teach us. */
  const nextWorthOpening = (): string | undefined => {
    for (let candidate = queue.shift(); candidate !== undefined; candidate = queue.shift()) {
      if (!exhaustedShape(urlShape(candidate))) {
        return candidate;
      }
      skippedAsSameKind += 1;
    }
    return undefined;
  };

  const enqueue = (urls: readonly string[]): void => {
    for (const found of urls) {
      const key = normalise(found);
      if (!queued.has(key)) {
        queued.add(key);
        queue.push(found);
      }
    }
  };

  while (stack.length > 0 || queue.length > 0) {
    if (deps.isCancelled()) {
      return { pages: [...results.values()], captured, stopped: 'Stopped.', skippedAsSameKind };
    }

    // Nothing part-finished, so start the next page we know about — provided we may open another.
    if (stack.length === 0) {
      if (results.size >= pageLimit) {
        break;
      }
      const next = nextWorthOpening();
      if (next === undefined) {
        break;
      }
      stack.push(next);
      onStack.add(normalise(next));
    }

    const url = stack[stack.length - 1];
    if (url === undefined) {
      break;
    }
    const key = normalise(url);

    // Only navigate if we are not already there — a click may have taken us to this very page,
    // and reloading would throw away the state that click produced.
    const arrivedAt = deps.now();
    let justNavigated = false;

    if (key !== normalise(currentUrl)) {
      const resuming = spentPerPage.has(key);
      deps.onProgress(
        resuming
          ? `Returning to ${url} to finish it`
          : `Opening page ${results.size + 1}${describeLimit(pageLimit)}: ${url}`,
      );
      justNavigated = true;
      await deps.driver.send({ kind: 'navigate', url });

      if (!(await waitForPage(deps))) {
        return {
          pages: [...results.values()],
          captured,
          stopped: `Gave up waiting for ${url} to load.`,
          skippedAsSameKind,
        };
      }
    }
    currentUrl = url;

    /**
     * What the page fired simply by loading.
     *
     * `product_view` and `page_view` are produced by arriving, not by clicking, and the sweep only
     * ever samples after a click — so these were captured by nobody and belonged to no page. That
     * also blinded the "same kind of page" rule, which decides on what a kind of page produces:
     * with page-load events invisible, every product page looked like it produced nothing.
     *
     * Only after a real navigation. Sampling when we are already here would re-attribute events
     * the previous sweep has already counted.
     */
    const onLoad = justNavigated ? deps.payloadsSince(arrivedAt) : [];
    captured.push(...onLoad);
    for (const payload of onLoad) {
      if (payload.eventName !== undefined) {
        groups.firedCounts.set(
          payload.eventName,
          (groups.firedCounts.get(payload.eventName) ?? 0) + 1,
        );
      }
    }

    // Links are read *before* clicking anything. A click can navigate or break the page, and
    // collecting the queue afterwards meant one bad click ended the whole crawl at page one.
    const links = await deps.driver.send({ kind: 'links' });
    let linksFound = 0;
    if (links.kind === 'links') {
      linksFound = links.urls.length;
      enqueue(links.urls);
    }

    let clickedHere = spentPerPage.get(key);
    if (clickedHere === undefined) {
      clickedHere = new Set<string>();
      spentPerPage.set(key, clickedHere);
    }

    deps.onProgress(`Sweeping ${url}`);
    // The sweep adds to both sets as it goes: this page's spent controls, and the crawl-wide
    // record of what each kind of control is worth clicking.
    const outcome = await sweepPage(deps, clickLimit, { clickedHere, groups });
    captured.push(...outcome.captured);

    const shape = urlShape(url);
    shapeVisits.set(shape, (shapeVisits.get(shape) ?? 0) + 1);
    const producedHere = shapeEvents.get(shape) ?? new Set<string>();
    for (const payload of [...onLoad, ...outcome.captured]) {
      if (payload.eventName !== undefined) {
        producedHere.add(payload.eventName);
      }
    }
    shapeEvents.set(shape, producedHere);

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
    results.set(key, mergeResult(results.get(key), { url, linksFound, outcome }));

    // A page that died mid-sweep is recorded and dropped, not fatal: one broken page must not
    // end a crawl that still has a queue. Cancellation is caught by the check at the top of the
    // loop instead, which is the only thing that should stop everything.
    if (outcome.stopped !== undefined) {
      stack.pop();
      onStack.delete(key);
      continue;
    }

    if (outcome.navigatedTo === undefined) {
      // Every control here has been clicked. Drop it and let whatever opened it resume.
      stack.pop();
      onStack.delete(key);
      continue;
    }

    currentUrl = outcome.navigatedTo;
    const landed = normalise(outcome.navigatedTo);

    // Descend, unless we have looped back onto a page already part-finished further up the stack
    // — in which case this page stays put and the next round navigates back to it.
    if (!onStack.has(landed) && results.size < pageLimit) {
      stack.push(outcome.navigatedTo);
      onStack.add(landed);
      queued.add(landed);
    }
  }

  return { pages: [...results.values()], captured, stopped: undefined, skippedAsSameKind };
}

/**
 * Folds a fresh visit into whatever the earlier visits to this page found.
 *
 * A page swept across three visits is still one page, and reporting it three times would make a
 * thorough crawl look like it was going in circles.
 */
function mergeResult(
  previous: PageResult | undefined,
  visit: { url: string; linksFound: number; outcome: SweepOutcome },
): PageResult {
  const { url, linksFound, outcome } = visit;

  return {
    url,
    observations: [...(previous?.observations ?? []), ...outcome.observations],
    stopped: outcome.stopped ?? previous?.stopped,
    linksFound: Math.max(previous?.linksFound ?? 0, linksFound),
    skippedAsRepeats: (previous?.skippedAsRepeats ?? 0) + outcome.skippedAsRepeats,
    routesSeen: [...new Set([...(previous?.routesSeen ?? []), ...outcome.routesSeen])],
    unreachableFrames: Math.max(previous?.unreachableFrames ?? 0, outcome.unreachableFrames),
    framesSeen: Math.max(previous?.framesSeen ?? 0, outcome.framesSeen),
    frames: outcome.frames.length > 0 ? outcome.frames : (previous?.frames ?? []),
  };
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

/** Ids are per-document, so a frame's number is part of a control's identity. */
function frameKey(entry: FrameClickable): string {
  return `${entry.frameId}:${entry.selector}`;
}

interface KeyedClickable extends FrameClickable {
  /** Identity derived from what the control *is*, so it survives a page reload. */
  readonly stableKey: string;
}

/**
 * Names each control by what it is rather than by the id we stamped on it.
 *
 * Frame, kind and label, plus an ordinal for the repeats a grid produces. Reloading a page hands
 * back the same DOM in the same order, so the same control gets the same key — which is what lets
 * a crawl leave a page, exhaust the one it landed on, and come back to finish the first.
 *
 * Deliberately used *alongside* the element id rather than instead of it: within one page load
 * the id is exact, and a re-render that reorders the list would make ordinals drift. The stable
 * key is only asked to survive a reload, which is the one thing the id cannot do.
 */
export function withStableKeys(
  clickables: readonly FrameClickable[],
): readonly KeyedClickable[] {
  const counts = new Map<string, number>();

  return clickables.map((entry) => {
    const base = `${entry.frameId}|${entry.group}|${entry.label}`;
    const ordinal = counts.get(base) ?? 0;
    counts.set(base, ordinal + 1);
    return { ...entry, stableKey: `${base}#${ordinal}` };
  });
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
