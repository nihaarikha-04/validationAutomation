import { CAPTURE_EVENT, CAPTURE_MARKER, toTransferable, type CaptureMessage } from '../shared/payload';

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

/** Smartech prefixes its debug output; anything else on the console is none of our business. */
const SMARTECH_PREFIX = /^\s*\[\s*smartech\b/i;
const EVENT_NAME = /firing\s+evt\s*:\s*['"]([^'"]+)['"]/i;

const WATCHED = ['log', 'info', 'debug', 'warn'] as const;

let sequence = 0;

function eventNameFrom(line: string): string | undefined {
  const match = EVENT_NAME.exec(line);
  return match?.[1];
}

function capture(args: readonly unknown[]): void {
  const first = args[0];
  if (typeof first !== 'string' || !SMARTECH_PREFIX.test(first)) {
    return;
  }

  const at = Date.now();
  sequence += 1;

  const transferable = args.map((argument) => toTransferable(argument));
  const eventName = eventNameFrom(first);
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

if (Reflect.get(window, INSTALLED) !== true) {
  Object.defineProperty(window, INSTALLED, { value: true, configurable: true });

  for (const method of WATCHED) {
    const original = console[method].bind(console);

    console[method] = (...args: unknown[]): void => {
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
  }
}
