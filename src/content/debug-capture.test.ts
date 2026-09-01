import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPTURE_EVENT, CAPTURE_MARKER, type CaptureMessage } from '../shared/payload';

const captured: CaptureMessage[] = [];
const pageMessages: unknown[] = [];

function collect(event: Event): void {
  const detail: unknown = (event as CustomEvent<unknown>).detail;
  if (typeof detail !== 'string') {
    return;
  }

  const message: unknown = JSON.parse(detail);
  if (
    typeof message === 'object' &&
    message !== null &&
    (message as { marker?: unknown }).marker === CAPTURE_MARKER
  ) {
    captured.push(message as CaptureMessage);
  }
}

function collectPageMessage(event: MessageEvent): void {
  pageMessages.push(event.data);
}

/** Installs on import, so each test needs a fresh module and a pristine console. */
async function install(): Promise<void> {
  vi.resetModules();
  await import('./debug-capture');
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const original = {
  log: console.log,
  info: console.info,
  debug: console.debug,
  warn: console.warn,
};

const LINE = "[Smartech Debugger] Firing EVT: 'Add to Cart' with payload: ";

beforeEach(() => {
  captured.length = 0;
  pageMessages.length = 0;
  Reflect.deleteProperty(window, '__smartechValidatorInstalled');
  document.addEventListener(CAPTURE_EVENT, collect);
  window.addEventListener('message', collectPageMessage);
});

afterEach(async () => {
  await flush();
  document.removeEventListener(CAPTURE_EVENT, collect);
  window.removeEventListener('message', collectPageMessage);
  Object.assign(console, original);
});

describe('debug-capture', () => {
  it('never touches window.smartech', async () => {
    const sdk = Object.assign(() => 'real', { q: ['queued'] });
    Reflect.set(window, 'smartech', sdk);

    await install();

    // The whole point of D10: the site's own object stays exactly where it was, queue intact.
    expect(Reflect.get(window, 'smartech')).toBe(sdk);
    expect(Reflect.get(window, 'smartech')).toHaveProperty('q', ['queued']);
    Reflect.deleteProperty(window, 'smartech');
  });

  it('captures a Smartech debug line and its payload', async () => {
    await install();

    console.log(LINE, { name: 'Add to Cart', product_id: 'SKU123' });
    await flush();

    expect(captured).toHaveLength(1);
    expect(captured[0]?.payload.eventName).toBe('Add to Cart');
    expect(captured[0]?.payload.args[1]).toEqual({ name: 'Add to Cart', product_id: 'SKU123' });
  });

  it('still writes the line to the real console', async () => {
    const seen: unknown[][] = [];
    console.log = (...args: unknown[]) => {
      seen.push(args);
    };
    await install();

    console.log(LINE, { a: 1 });

    expect(seen).toEqual([[LINE, { a: 1 }]]);
  });

  it('ignores console output that is not Smartech', async () => {
    await install();

    console.log('some unrelated app log', { a: 1 });
    console.info('[OtherSDK] Firing EVT:', {});
    await flush();

    expect(captured).toEqual([]);
  });

  it('captures across the console methods Smartech may use', async () => {
    await install();

    console.info(LINE, { a: 1 });
    console.debug('[Smartech] something', { b: 2 });
    console.warn('[Smartech Debugger] warning', { c: 3 });
    await flush();

    expect(captured).toHaveLength(3);
  });

  it('captures a line with no payload object', async () => {
    await install();

    console.log('[Smartech Debugger] initialised');
    await flush();

    expect(captured).toHaveLength(1);
    expect(captured[0]?.payload.eventName).toBeUndefined();
  });

  it('stores raw JSON that round-trips to the parsed args', async () => {
    await install();

    console.log(LINE, { a: 1 });
    await flush();

    const payload = captured[0]?.payload;
    expect(JSON.parse(payload?.raw ?? 'null')).toEqual(payload?.args);
  });

  it('reads the event name whatever quoting the line uses', async () => {
    await install();

    console.log('[Smartech Debugger] Firing EVT: "purchase" with payload: ', {});
    await flush();

    expect(captured[0]?.payload.eventName).toBe('purchase');
  });

  it('never puts traffic on the page\'s message channel', async () => {
    await install();

    console.log(LINE, { a: 1 });
    await flush();

    // A live site overrode postMessage and threw "Invalid Origin" at us. Our handoff must not
    // touch a channel other pages listen on.
    expect(captured).toHaveLength(1);
    expect(pageMessages).toEqual([]);
  });

  it('survives a page that has broken window.postMessage', async () => {
    const realPostMessage = window.postMessage.bind(window);
    Object.defineProperty(window, 'postMessage', {
      configurable: true,
      value: () => {
        throw new Error('Invalid Origin');
      },
    });

    try {
      await install();
      expect(() => console.log(LINE, { a: 1 })).not.toThrow();
      await flush();
      expect(captured).toHaveLength(1);
    } finally {
      Object.defineProperty(window, 'postMessage', {
        configurable: true,
        value: realPostMessage,
      });
    }
  });

  it('captures a bare "Smartech debug" line, with no brackets', async () => {
    await install();

    // The real shape on a live client site. Requiring brackets rejected every one of these.
    console.info('Smartech debug', { eventName: 'Add to Cart', product_id: 'SKU123' });
    await flush();

    expect(captured).toHaveLength(1);
    expect(captured[0]?.payload.eventName).toBe('Add to Cart');
  });

  it('reads the event name from the payload when the message does not name it', async () => {
    await install();

    console.info('Smartech debug', { event_name: 'purchase', total: 499 });
    await flush();

    expect(captured[0]?.payload.eventName).toBe('purchase');
  });

  it('finds an event name nested inside the payload', async () => {
    await install();

    console.info('Smartech debug', { data: { evtName: 'Sign in' } });
    await flush();

    expect(captured[0]?.payload.eventName).toBe('Sign in');
  });

  it('prefers the name in the message over one in the payload', async () => {
    await install();

    console.log(LINE, { eventName: 'something else' });
    await flush();

    expect(captured[0]?.payload.eventName).toBe('Add to Cart');
  });

  it('still ignores other libraries that log objects', async () => {
    await install();

    console.log('Firebase: Firebase App named [DEFAULT] already exists', { eventName: 'nope' });
    await flush();

    expect(captured).toEqual([]);
  });

  it('does not advertise itself to libraries that sniff console', async () => {
    const before = console.log.toString();
    await install();

    // Libraries check this and can go quiet when they think they are being watched.
    expect(console.log.toString()).toBe(before);
    expect(console.log.toString()).not.toContain('capture(');
    expect(console.log.name).toBe('log');
  });

  it('turns Smartech debug output on by itself', async () => {
    const calls: unknown[][] = [];
    Reflect.set(window, 'smartech', (...args: unknown[]) => {
      calls.push(args);
    });

    await install();
    // The SDK is polled for, so give the first tick a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 400));

    // The panel used to do this once on open, so a navigation silently lost debug mode.
    expect(calls).toContainEqual(['debug', '1']);
    Reflect.deleteProperty(window, 'smartech');
  });

  it('keeps waiting when the SDK has not loaded yet', async () => {
    await install();
    await new Promise((resolve) => setTimeout(resolve, 400));

    const calls: unknown[][] = [];
    Reflect.set(window, 'smartech', (...args: unknown[]) => {
      calls.push(args);
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    // The snippet loads asynchronously, so absence at document_start proves nothing.
    expect(calls).toContainEqual(['debug', '1']);
    Reflect.deleteProperty(window, 'smartech');
  });

  it('sends window.open into this tab when asked, and restores it after', async () => {
    await install();
    const native = window.open;

    document.dispatchEvent(new CustomEvent('smartech-validator:control', { detail: 'same-tab' }));
    expect(window.open).not.toBe(native);

    // Rewriting a page's navigation has no business being on when nobody is testing.
    document.dispatchEvent(new CustomEvent('smartech-validator:control', { detail: 'restore' }));
    expect(window.open).toBe(native);
  });

  it('installs only once', async () => {
    await install();
    const wrapped = console.log;
    await install();

    expect(console.log).toBe(wrapped);
  });

  it('tags a payload it cannot serialise rather than losing the line', async () => {
    await install();

    const hostile = {
      get boom(): string {
        throw new Error('nope');
      },
    };
    console.log(LINE, hostile);
    await flush();

    expect(JSON.stringify(captured)).toContain('nope');
  });
});
