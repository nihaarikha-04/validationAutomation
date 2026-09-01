import {
  CAPTURE_EVENT,
  CAPTURE_MARKER,
  CONTROL_EVENT,
  STATS_MARKER,
  toTransferable,
  type CaptureMessage,
  type StatsMessage,
} from '../shared/payload';

/**
 * Runs in the page's own world at document_start and reads Smartech's debug output.
 *
 * It deliberately does NOT touch `window.smartech`. Three live failures established that any
 * accessor or proxy over that global changes object identity the snippet depends on — the
 * queuing stub buffers calls on the function object itself, so when the real SDK assigns
 * itself the buffered `create`/`register` calls become unreachable and the SDK never
 * initialises. See docs/decisions.md D10.
 *
 * Wrapping console is inert by comparison: every call is forwarded untouched, and nothing the
 * SDK does depends on console's identity.
 *
 * This file is a composition root of its own — the only place that may read the clock, because
 * a payload's timestamp must be stamped as the page logs it.
 */

const INSTALLED = '__smartechValidatorInstalled';

/**
 * Smartech names itself at the start of its debug output, but the shape varies by integration:
 * `[Smartech Debugger] Firing EVT: 'x'` on one site, a bare `Smartech debug` on another. The
 * brackets are optional — requiring them silently rejected every line on a real client site.
 */
const SMARTECH_PREFIX = /^\s*\[?\s*smartech\b/i;

/** Some builds put the event name in the message itself. */
const EVENT_NAME = /firing\s+evt\s*:\s*['"]([^'"]+)['"]/i;

/**
 * Where the event name hides when the message does not carry it, most specific first — a payload
 * carrying both `eventName` and `name` is read the way the SDK meant it.
 *
 * Keys are compared with case and punctuation removed, so one entry covers `eventName`,
 * `event_name` and `EVENTNAME` rather than needing a line each.
 */
const NAME_KEYS: readonly string[] = ['eventname', 'evtname', 'event', 'evt', 'name'];

function keyRank(key: string): number {
  return NAME_KEYS.indexOf(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

const WATCHED = ['log', 'info', 'debug', 'warn'] as const;

let sequence = 0;

/** Counters behind the panel's "what am I seeing" line. */
let linesSeen = 0;
let linesMatched = 0;
const recentUnmatched: string[] = [];
const RECENT_KEPT = 6;
const STATS_INTERVAL_MS = 2_000;

/**
 * Enabling Smartech's debug output is what makes anything capturable at all.
 *
 * It runs here, in the page, rather than from the panel. The panel enabled it once when it
 * opened — so a crawl that navigated, or a plain page reload, silently lost debug mode and
 * captured nothing from then on. This script loads on every page, so every page gets it.
 */
const DEBUG_ATTEMPTS = 40;
const DEBUG_INTERVAL_MS = 300;

/** From the message text if it says so, otherwise from a name-ish key on the logged payload. */
function eventNameFrom(line: string, args: readonly unknown[]): string | undefined {
  const inMessage = EVENT_NAME.exec(line)?.[1];
  if (inMessage !== undefined) {
    return inMessage;
  }

  for (const argument of args) {
    const found = nameWithin(argument);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function nameWithin(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  const named = Object.entries(record)
    .filter(([key, held]) => keyRank(key) >= 0 && typeof held === 'string' && held.trim() !== '')
    .sort(([a], [b]) => keyRank(a) - keyRank(b))[0];

  if (named !== undefined) {
    return String(named[1]).trim();
  }

  // Some builds nest the event under a wrapper, e.g. { data: { eventName } }.
  for (const nested of Object.values(record)) {
    const found = nameWithin(nested);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function capture(args: readonly unknown[]): void {
  linesSeen += 1;

  const first = args[0];
  if (typeof first !== 'string' || !SMARTECH_PREFIX.test(first)) {
    // Remember the shape of what we are rejecting: an unexpected prefix is the likeliest reason
    // a site produces no captures, and it took a hand-written probe to find that out once.
    const preview = typeof first === 'string' ? first.slice(0, 70) : `<${typeof first}>`;
    recentUnmatched.unshift(preview);
    recentUnmatched.length = Math.min(recentUnmatched.length, RECENT_KEPT);
    return;
  }

  linesMatched += 1;

  const at = Date.now();
  sequence += 1;

  const transferable = args.map((argument) => toTransferable(argument));
  const eventName = eventNameFrom(first, args.slice(1));
  const payload = {
    id: `${at}-${sequence}`,
    at,
    args: transferable,
    raw: JSON.stringify(transferable),
    origin: 'intercepted' as const,
    ...(eventName === undefined ? {} : { eventName }),
  };

  try {
    dispatch({ marker: CAPTURE_MARKER, payload });
  } catch (error) {
    // Bounds in toTransferable should prevent this, but a payload we still cannot serialise has
    // to surface as a visible gap rather than disappearing.
    const detail = error instanceof Error ? error.message : 'could not be transferred';
    dispatch({
      marker: CAPTURE_MARKER,
      payload: {
        id: payload.id,
        at,
        args: [{ __special: 'unserialisable', detail }],
        raw: '',
        origin: 'intercepted',
      },
    });
  }
}

/**
 * The detail is a JSON string rather than an object: the page and the extension run in separate
 * JavaScript heaps, and an object detail is not reliably readable from the other side.
 */
function dispatch(message: CaptureMessage): void {
  document.dispatchEvent(new CustomEvent(CAPTURE_EVENT, { detail: JSON.stringify(message) }));
}

/**
 * Polls until the SDK exists, then turns its debug output on. The snippet loads asynchronously,
 * so absence at document_start says nothing; ~12 seconds is long enough for a slow page and short
 * enough not to poll forever.
 */
function enableDebugWhenReady(): void {
  let attempts = 0;

  const timer = setInterval(() => {
    attempts += 1;
    const smartech: unknown = Reflect.get(window, 'smartech');

    if (typeof smartech === 'function') {
      clearInterval(timer);
      try {
        Reflect.apply(smartech, window, ['debug', '1']);
      } catch (error) {
        // Worth seeing: the SDK is present but refused to enable debug, which explains an empty
        // capture far better than silence would.
        setTimeout(() => {
          throw error;
        }, 0);
      }
      return;
    }

    if (attempts >= DEBUG_ATTEMPTS) {
      clearInterval(timer);
    }
  }, DEBUG_INTERVAL_MS);
}

/**
 * Redirects `window.open` into this tab while a sweep is running.
 *
 * Only while asked: rewriting a page's navigation is a real change to its behaviour, and it has
 * no business being on when nobody is testing.
 */
// The original reference, not a bound copy — restoring must put back exactly what was there, or
// a page checking window.open's identity would see it permanently changed.
const nativeOpen: typeof window.open = window.open;

const sameTabOpen: typeof window.open = (url) => {
  if (url !== undefined && url !== null && String(url) !== '') {
    location.assign(String(url));
  }
  return null;
};

document.addEventListener(CONTROL_EVENT, (event: Event) => {
  const detail: unknown = (event as CustomEvent<unknown>).detail;
  window.open = detail === 'same-tab' ? sameTabOpen : nativeOpen;
});

function reportStats(): void {
  document.dispatchEvent(
    new CustomEvent(CAPTURE_EVENT, {
      detail: JSON.stringify({
        marker: STATS_MARKER,
        stats: { seen: linesSeen, matched: linesMatched, recent: [...recentUnmatched] },
      } satisfies StatsMessage),
    }),
  );
}

if (Reflect.get(window, INSTALLED) !== true) {
  Object.defineProperty(window, INSTALLED, { value: true, configurable: true });

  for (const method of WATCHED) {
    const native = console[method];
    const original = native.bind(console);

    const wrapper = (...args: unknown[]): void => {
      try {
        capture(args);
      } catch (error) {
        // The page's own logging must survive our failure, so it happens regardless — but the
        // error is rethrown on a clean stack rather than swallowed.
        setTimeout(() => {
          throw error;
        }, 0);
      }

      original(...args);
    };

    // Report the original source when anything asks what this function is.
    //
    // Analytics libraries do check whether console has been tampered with, and some change
    // behaviour or go quiet when they think they are being watched — which would defeat the
    // point of observing them. This covers `console.log.toString()`, the usual check. It cannot
    // cover `Function.prototype.toString.call(console.log)`, which ignores an own property;
    // defeating that would mean patching Function.prototype for the whole page, which is far
    // more invasive than the problem warrants.
    Object.defineProperty(wrapper, 'toString', {
      value: () => Function.prototype.toString.call(native),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(wrapper, 'name', { value: method, configurable: true });

    console[method] = wrapper;
  }

  enableDebugWhenReady();
  setInterval(reportStats, STATS_INTERVAL_MS);
  reportStats();
}
