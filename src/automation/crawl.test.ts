import { describe, expect, it } from 'vitest';
import type { CapturedPayload } from '../shared/payload';
import type { AutomationCommand, AutomationReply, PageDriver } from './commands';
import { crawlSite, newGroupMemory, sweepPage, withStableKeys, type SweepDeps } from './crawl';

const NOW = 4_000_000;

interface Scripted {
  readonly driver: PageDriver;
  readonly sent: AutomationCommand[];
}

/** A page that answers whatever the script says, recording everything it was asked. */
function scriptedPage(reply: (command: AutomationCommand) => AutomationReply): Scripted {
  const sent: AutomationCommand[] = [];
  return {
    sent,
    driver: {
      send: (command) => {
        sent.push(command);
        return Promise.resolve(reply(command));
      },
    },
  };
}

function deps(driver: PageDriver, overrides: Partial<SweepDeps> = {}): SweepDeps {
  return {
    driver,
    now: () => NOW,
    settleMs: 0,
    payloadsSince: () => [],
    onProgress: () => undefined,
    allowed: (risk) => risk === 'safe',
    showPointer: false,
    // Off by default so each test opts in and the command sequences stay readable.
    hoverMs: 0,
    dwellMs: 0,
    isCancelled: () => false,
    ...overrides,
  };
}

describe('sweepPage', () => {
  it('clicks each control once', async () => {
    const page = scriptedPage((command) =>
      command.kind === 'clickables'
        ? {
            kind: 'clickables',
            clickables: [
              { selector: '#a', label: 'A', risk: 'safe', group: '#a-kind' },
              { selector: '#b', label: 'B', risk: 'safe', group: '#b-kind' },
            ],
          }
        : command.kind === 'click'
          ? { kind: 'clicked' }
          : { kind: 'dismissed' },
    );

    const outcome = await sweepPage(deps(page.driver));

    expect(outcome.observations.map((entry) => entry.label)).toEqual(['A', 'B']);
  });

  it('leaves risky controls alone', async () => {
    const page = scriptedPage((command) =>
      command.kind === 'clickables'
        ? {
            kind: 'clickables',
            clickables: [
              { selector: '#pay', label: 'Pay', risk: 'destructive', group: '#pay-kind' },
              { selector: '#out', label: 'Out', risk: 'navigates', group: '#out-kind' },
            ],
          }
        : { kind: 'clicked' },
    );

    const outcome = await sweepPage(deps(page.driver));

    expect(outcome.observations).toEqual([]);
    expect(page.sent.some((command) => command.kind === 'click')).toBe(false);
  });
});

describe('hover and dwell', () => {
  function oneControl(): Scripted {
    return scriptedPage((command) =>
      command.kind === 'clickables'
        ? {
            kind: 'clickables',
            clickables: [
              { selector: '#banner', label: 'Banner', risk: 'safe', group: '#banner-kind' },
            ],
          }
        : command.kind === 'click'
          ? { kind: 'clicked' }
          : command.kind === 'hover'
            ? { kind: 'hovered' }
            : { kind: 'dismissed' },
    );
  }

  it('rests the pointer on a control before clicking it', async () => {
    const page = oneControl();

    await sweepPage(deps(page.driver, { hoverMs: 700 }));

    const order = page.sent
      .filter((command) => command.kind === 'hover' || command.kind === 'click')
      .map((command) => command.kind);
    expect(order).toEqual(['hover', 'click']);
    expect(page.sent).toContainEqual({ kind: 'hover', selector: '#banner', dwellMs: 700 });
  });

  it('does not hover when hovering is switched off', async () => {
    const page = oneControl();

    await sweepPage(deps(page.driver, { hoverMs: 0 }));

    expect(page.sent.some((command) => command.kind === 'hover')).toBe(false);
  });

  /**
   * A `hover_time` fires on the way out of the hover, before the click. If the capture window
   * opened after hovering, that payload would be lost and the control would look silent.
   */
  it('credits the control with what its hover fired, not only its click', async () => {
    const page = oneControl();
    const hoverFired = {
      id: 'p1',
      at: NOW,
      eventName: 'Banner',
      args: [],
      raw: '[]',
      origin: 'intercepted' as const,
    };

    const outcome = await sweepPage(
      deps(page.driver, { hoverMs: 700, payloadsSince: (from) => (from <= NOW ? [hoverFired] : []) }),
    );

    expect(outcome.observations).toEqual([{ label: 'Banner', eventNames: ['Banner'] }]);
  });

  it('carries the dwell into the scroll pass', async () => {
    const page = oneControl();

    await sweepPage(deps(page.driver, { dwellMs: 1_200 }));

    expect(page.sent).toContainEqual({ kind: 'scroll', dwellMs: 1_200 });
  });
});

describe('repeated controls', () => {
  function grid(count: number): { driver: PageDriver; clicks: () => number } {
    let clicks = 0;
    return {
      clicks: () => clicks,
      driver: {
        send: (command) => {
          if (command.kind === 'clickables') {
            return Promise.resolve({
              kind: 'clickables',
              clickables: Array.from({ length: count }, (_unused, index) => ({
                selector: `#tile${index}`,
                label: `Product ${index}`,
                risk: 'safe' as const,
                // Every tile in a grid is the same kind of control.
                group: 'a.product-tile',
              })),
            });
          }
          if (command.kind === 'click') {
            clicks += 1;
          }
          return Promise.resolve({ kind: 'clicked' });
        },
      },
    };
  }

  function payload(at: number): CapturedPayload {
    return { id: `p${at}`, at, eventName: 'product_view', args: [], raw: '[]', origin: 'intercepted' };
  }

  it('stops clicking a grid once its tiles stop producing anything new', async () => {
    const page = grid(40);
    let clock = NOW;

    const outcome = await sweepPage(
      deps(page.driver, {
        now: () => (clock += 1),
        payloadsSince: () => [payload(clock)],
      }),
    );

    // Forty product tiles all firing product_view tell us nothing forty times over. Two clicks
    // is the cap on how often one event is worth producing: the first is the verdict, the second
    // guards against a first-load special case, and the rest re-confirm what is already in hand.
    expect(page.clicks()).toBe(2);
    expect(outcome.skippedAsRepeats).toBe(38);
  });

  it('keeps clicking a group while each control fires a different event', async () => {
    // Regression, ethniq.com: a row of profile tabs is one component, so retiring the group at
    // the first success meant clicking `Order History` and never trying `My Subscriptions`,
    // `My Cards` or `Recently Viewed`. Each tab is a different event; that is the whole point.
    const page = grid(5);
    let clock = NOW;
    let tab = 0;

    await sweepPage(
      deps(page.driver, {
        now: () => (clock += 1),
        payloadsSince: () => {
          tab += 1;
          return [{ ...payload(clock), eventName: `tab_${tab}_clicked` }];
        },
      }),
    );

    expect(page.clicks()).toBe(5);
  });

  it('gives a silent group a couple of tries before writing it off', async () => {
    const page = grid(40);

    await sweepPage(deps(page.driver, { payloadsSince: () => [] }));

    expect(page.clicks()).toBe(2);
  });

  it('still clicks controls of different kinds', async () => {
    let clicks = 0;
    const driver: PageDriver = {
      send: (command) => {
        if (command.kind === 'clickables') {
          return Promise.resolve({
            kind: 'clickables',
            clickables: [
              { selector: '#a', label: 'A', risk: 'safe', group: 'button.one' },
              { selector: '#b', label: 'B', risk: 'safe', group: 'button.two' },
            ],
          });
        }
        if (command.kind === 'click') {
          clicks += 1;
        }
        return Promise.resolve({ kind: 'clicked' });
      },
    };
    let clock = NOW;

    await sweepPage(
      deps(driver, { now: () => (clock += 1), payloadsSince: () => [payload(clock)] }),
    );

    expect(clicks).toBe(2);
  });
});

describe('frames', () => {
  it('clicks controls that live inside an iframe, in that frame', async () => {
    const clicks: { frameId: number; selector: string }[] = [];

    const driver: PageDriver = {
      send: (command) =>
        Promise.resolve(
          command.kind === 'location'
            ? ({ kind: 'location', url: 'https://shop.test/', stamp: 'doc' } as AutomationReply)
            : ({ kind: 'acknowledged' } as AutomationReply),
        ),
      sendAll: (command) =>
        Promise.resolve(
          command.kind === 'clickables'
            ? [
                {
                  frameId: 0,
                  reply: {
                    kind: 'clickables',
                    clickables: [
                      { selector: '#top', label: 'Top', risk: 'safe' as const, group: 'button.top' },
                    ],
                  } as AutomationReply,
                },
                {
                  frameId: 7,
                  reply: {
                    kind: 'clickables',
                    clickables: [
                      { selector: '#inner', label: 'Inner', risk: 'safe' as const, group: 'button.inner' },
                    ],
                  } as AutomationReply,
                },
              ]
            : [],
        ),
      sendTo: (frameId, command) => {
        if (command.kind === 'click') {
          clicks.push({ frameId, selector: command.selector });
        }
        return Promise.resolve({ kind: 'clicked' });
      },
    };

    await sweepPage(deps(driver));

    // A control inside a frame must be clicked in that frame; the top document cannot reach it.
    // The frame goes first: like an overlay, a frame's contents can be replaced out from under
    // the sweep, while the top document is not going anywhere.
    expect(clicks).toEqual([
      { frameId: 7, selector: '#inner' },
      { frameId: 0, selector: '#top' },
    ]);
  });

  it('tells identically-named controls in different frames apart', async () => {
    const clicks: number[] = [];
    const framed = (frameId: number): { frameId: number; reply: AutomationReply } => ({
      frameId,
      reply: {
        kind: 'clickables',
        // The same selector in two documents: ids are per-document, so they can collide.
        clickables: [{ selector: '#a', label: 'A', risk: 'safe' as const, group: `g${frameId}` }],
      },
    });

    const driver: PageDriver = {
      send: (command) =>
        Promise.resolve(
          command.kind === 'location'
            ? ({ kind: 'location', url: 'https://shop.test/', stamp: 'doc' } as AutomationReply)
            : ({ kind: 'acknowledged' } as AutomationReply),
        ),
      sendAll: (command) =>
        Promise.resolve(command.kind === 'clickables' ? [framed(0), framed(3)] : []),
      sendTo: (frameId, command) => {
        if (command.kind === 'click') {
          clicks.push(frameId);
        }
        return Promise.resolve({ kind: 'clicked' });
      },
    };

    await sweepPage(deps(driver));

    // Frame first, top document second — the ordering, not just the identity, is deliberate.
    expect(clicks).toEqual([3, 0]);
  });

  it('reports how many frames answered', async () => {
    const driver: PageDriver = {
      send: (command) =>
        Promise.resolve(
          command.kind === 'location'
            ? ({ kind: 'location', url: 'https://shop.test/', stamp: 'doc' } as AutomationReply)
            : ({ kind: 'acknowledged' } as AutomationReply),
        ),
      sendAll: () =>
        Promise.resolve([
          { frameId: 0, reply: { kind: 'clickables', clickables: [] } as AutomationReply },
          { frameId: 4, reply: { kind: 'clickables', clickables: [] } as AutomationReply },
        ]),
      sendTo: () => Promise.resolve({ kind: 'clicked' }),
    };

    const outcome = await sweepPage(deps(driver));

    // "top frame only" is how a discovery failure shows itself, rather than silently
    // covering less of the page.
    expect(outcome.framesSeen).toBe(2);
  });

  it('still works against a driver that knows nothing about frames', async () => {
    const clicked: string[] = [];
    const driver: PageDriver = {
      send: (command) => {
        if (command.kind === 'clickables') {
          return Promise.resolve({
            kind: 'clickables',
            clickables: [{ selector: '#a', label: 'A', risk: 'safe' as const, group: 'g' }],
          });
        }
        if (command.kind === 'click') {
          clicked.push(command.selector);
        }
        if (command.kind === 'location') {
          return Promise.resolve({ kind: 'location', url: 'https://shop.test/', stamp: 'doc' });
        }
        return Promise.resolve({ kind: 'clicked' });
      },
    };

    await sweepPage(deps(driver));

    expect(clicked).toEqual(['#a']);
  });
});

describe('new tabs', () => {
  it('asks the page to keep navigation in this tab before sweeping', async () => {
    const sent: AutomationCommand[] = [];
    const driver: PageDriver = {
      send: (command) => {
        sent.push(command);
        if (command.kind === 'clickables') {
          return Promise.resolve({ kind: 'clickables', clickables: [] });
        }
        if (command.kind === 'location') {
          return Promise.resolve({ kind: 'location', url: 'https://shop.test/', stamp: 'doc' });
        }
        return Promise.resolve({ kind: 'acknowledged' });
      },
    };

    await sweepPage(deps(driver));

    // A click that opens a new tab lands where DevTools cannot follow, and the sweep would look
    // like it stopped for no reason.
    const sameTab = sent.find((command) => command.kind === 'same-tab');
    expect(sameTab).toEqual({ kind: 'same-tab', on: true });
    expect(sent.indexOf(sameTab!)).toBeLessThan(
      sent.findIndex((command) => command.kind === 'clickables'),
    );
  });
});

describe('forms that need a person', () => {
  function formPage(fields: readonly string[]): PageDriver {
    return {
      send: (command) =>
        Promise.resolve(
          command.kind === 'clickables'
            ? ({
                kind: 'clickables',
                clickables: [
                  { selector: '#go', label: 'Verify', risk: 'safe' as const, group: 'button.go' },
                ],
              } as AutomationReply)
            : command.kind === 'form-needs'
              ? ({ kind: 'form-needs', isSubmit: true, fields } as AutomationReply)
              : command.kind === 'location'
                ? ({ kind: 'location', url: 'https://shop.test/', stamp: 'doc' } as AutomationReply)
                : ({ kind: 'clicked' } as AutomationReply),
        ),
    };
  }

  it('asks before submitting a form with empty fields', async () => {
    const asked: string[][] = [];

    await sweepPage(
      deps(formPage(['Phone number', 'OTP']), {
        onNeedsInput: (request) => {
          asked.push([...request.fields]);
          return Promise.resolve('skip');
        },
      }),
    );

    expect(asked).toEqual([['Phone number', 'OTP']]);
  });

  it('clicks once the person says they have filled it', async () => {
    const clicked: string[] = [];
    const driver = formPage(['Phone number']);
    const spied: PageDriver = {
      send: (command) => {
        if (command.kind === 'click') {
          clicked.push(command.selector);
        }
        return driver.send(command);
      },
    };

    await sweepPage(deps(spied, { onNeedsInput: () => Promise.resolve('continue') }));

    expect(clicked).toEqual(['#go']);
  });

  it('does not ask when the form has nothing blank', async () => {
    let asked = 0;

    await sweepPage(
      deps(formPage([]), {
        onNeedsInput: () => {
          asked += 1;
          return Promise.resolve('continue');
        },
      }),
    );

    expect(asked).toBe(0);
  });

  it('ends the run when the person says stop', async () => {
    const outcome = await sweepPage(
      deps(formPage(['Phone']), { onNeedsInput: () => Promise.resolve('stop') }),
    );

    expect(outcome.stopped).toBe('Stopped.');
  });
});

describe('overlays', () => {
  it('keeps sweeping when an overlay changes the URL without loading a page', async () => {
    let url = 'https://shop.test/';
    let overlayOpen = false;
    const clicked: string[] = [];

    const driver: PageDriver = {
      send: (command) => {
        if (command.kind === 'location') {
          // Same document throughout: a quick-view pushes a route, it does not load a page.
          return Promise.resolve({ kind: 'location', url, stamp: 'doc-1' });
        }
        if (command.kind === 'clickables') {
          return Promise.resolve({
            kind: 'clickables',
            clickables: overlayOpen
              ? [
                  { selector: '#tile', label: 'Tile', risk: 'safe' as const, group: 'a.tile' },
                  { selector: '#atc', label: 'Add to Cart', risk: 'safe' as const, group: 'button.atc' },
                ]
              : [{ selector: '#tile', label: 'Tile', risk: 'safe' as const, group: 'a.tile' }],
          });
        }
        if (command.kind === 'click') {
          clicked.push(command.selector);
          if (command.selector === '#tile') {
            overlayOpen = true;
            url = 'https://shop.test/?quickview=1';
          }
          return Promise.resolve({ kind: 'clicked' });
        }
        return Promise.resolve({ kind: 'dismissed' });
      },
    };

    const outcome = await sweepPage(deps(driver));

    // Stopping here abandoned the whole sweep the moment any overlay opened.
    expect(clicked).toEqual(['#tile', '#atc']);
    expect(outcome.navigatedTo).toBeUndefined();
  });

  it('clicks what a modal contains before closing it', async () => {
    const order: string[] = [];
    let modalOpen = false;

    const driver: PageDriver = {
      send: (command) => {
        if (command.kind === 'clickables') {
          return Promise.resolve({
            kind: 'clickables',
            clickables: modalOpen
              ? [
                  { selector: '#tile', label: 'Product', risk: 'safe' as const, group: 'a.tile' },
                  { selector: '#atc', label: 'Add to Cart', risk: 'safe' as const, group: 'button.atc' },
                  { selector: '#close', label: 'Close', risk: 'safe' as const, group: 'button.close' },
                ]
              : [{ selector: '#tile', label: 'Product', risk: 'safe' as const, group: 'a.tile' }],
          });
        }
        if (command.kind === 'click') {
          order.push(command.selector);
          if (command.selector === '#tile') {
            modalOpen = true;
          }
          return Promise.resolve({ kind: 'clicked' });
        }
        if (command.kind === 'dismiss') {
          order.push('dismiss');
          modalOpen = false;
        }
        return Promise.resolve({ kind: 'dismissed' });
      },
    };

    await sweepPage(deps(driver));

    // The overlay's own buttons are the point; closing it first would test nothing.
    expect(order.indexOf('#atc')).toBeGreaterThan(order.indexOf('#tile'));
    expect(order.indexOf('#atc')).toBeLessThan(order.indexOf('dismiss'));
  });

  it('closes an overlay once it is exhausted, to reach the page beneath', async () => {
    let covered = true;
    const clicked: string[] = [];

    const driver: PageDriver = {
      send: (command) => {
        if (command.kind === 'clickables') {
          return Promise.resolve({
            kind: 'clickables',
            clickables: covered
              ? [{ selector: '#in-modal', label: 'In modal', risk: 'safe' as const, group: 'button.m' }]
              : [
                  { selector: '#in-modal', label: 'In modal', risk: 'safe' as const, group: 'button.m' },
                  { selector: '#beneath', label: 'Beneath', risk: 'safe' as const, group: 'button.b' },
                ],
          });
        }
        if (command.kind === 'click') {
          clicked.push(command.selector);
        }
        if (command.kind === 'dismiss') {
          covered = false;
        }
        return Promise.resolve({ kind: 'clicked' });
      },
    };

    await sweepPage(deps(driver));

    expect(clicked).toEqual(['#in-modal', '#beneath']);
  });
});

describe('crawlSite', () => {
  it('collects links again after sweeping, so an overlay\'s links are followed', async () => {
    let overlayOpen = false;
    const driver: PageDriver = {
      send: (command) => {
        switch (command.kind) {
          case 'location':
            return Promise.resolve({
              kind: 'location',
              url: overlayOpen ? 'https://shop.test/?qv=1' : 'https://shop.test/',
              stamp: 'doc-1',
            });
          case 'links':
            // The overlay reveals a link that was not on the page beforehand.
            return Promise.resolve({
              kind: 'links',
              urls: overlayOpen ? ['https://shop.test/from-overlay'] : [],
            });
          case 'clickables':
            return Promise.resolve({
              kind: 'clickables',
              clickables: overlayOpen
                ? []
                : [{ selector: '#tile', label: 'Tile', risk: 'safe' as const, group: 'a.tile' }],
            });
          case 'click':
            overlayOpen = true;
            return Promise.resolve({ kind: 'clicked' });
          case 'navigate':
            return Promise.resolve({ kind: 'navigating' });
          default:
            return Promise.resolve({ kind: 'dismissed' });
        }
      },
    };

    const outcome = await crawlSite({ ...deps(driver), maxPages: 2, clicksPerPage: 0 });

    expect(outcome.pages.map((page) => page.url)).toContain('https://shop.test/from-overlay');
  });

  it('queues an overlay route for a proper visit and names it on the page', async () => {
    let overlayOpen = false;
    const driver: PageDriver = {
      send: (command) => {
        switch (command.kind) {
          case 'location':
            return Promise.resolve({
              kind: 'location',
              url: overlayOpen ? 'https://shop.test/product/1' : 'https://shop.test/',
              stamp: 'doc-1',
            });
          case 'links':
            return Promise.resolve({ kind: 'links', urls: [] });
          case 'clickables':
            return Promise.resolve({
              kind: 'clickables',
              clickables: overlayOpen
                ? []
                : [{ selector: '#tile', label: 'Tile', risk: 'safe' as const, group: 'a.tile' }],
            });
          case 'click':
            overlayOpen = true;
            return Promise.resolve({ kind: 'clicked' });
          case 'navigate':
            return Promise.resolve({ kind: 'navigating' });
          default:
            return Promise.resolve({ kind: 'dismissed' });
        }
      },
    };

    const outcome = await crawlSite({ ...deps(driver), maxPages: 2, clicksPerPage: 0 });

    // Shown as a panel, but the same URL loaded as a page can fire different events.
    expect(outcome.pages[0]?.routesSeen).toContain('https://shop.test/product/1');
    expect(outcome.pages.map((page) => page.url)).toContain('https://shop.test/product/1');
  });

  it('sweeps the current page, then each page it links to', async () => {
    let listings = 0;
    const page = scriptedPage((command) => {
      switch (command.kind) {
        case 'location':
          return { kind: 'location', url: 'https://shop.test/', stamp: 'doc' };
        case 'clickables':
          listings += 1;
          // One control per page, so each sweep ends after a single click.
          return listings % 2 === 1
            ? { kind: 'clickables', clickables: [{ selector: '#a', label: 'A', risk: 'safe', group: '#a-kind' }] }
            : { kind: 'clickables', clickables: [] };
        case 'links':
          return { kind: 'links', urls: ['https://shop.test/products'] };
        case 'navigate':
          return { kind: 'navigating' };
        case 'click':
          return { kind: 'clicked' };
        default:
          return { kind: 'dismissed' };
      }
    });

    const outcome = await crawlSite({ ...deps(page.driver), maxPages: 2, clicksPerPage: 20 });

    expect(outcome.pages.map((entry) => entry.url)).toEqual([
      'https://shop.test/',
      'https://shop.test/products',
    ]);
    expect(page.sent.some((command) => command.kind === 'navigate')).toBe(true);
  });

  it('sweeps the page a click landed on, before the rest of the queue', async () => {
    const swept: string[] = [];
    let here = 'https://shop.test/';
    let document = 'doc-1';
    let listings = 0;

    const driver: PageDriver = {
      send: (command) => {
        switch (command.kind) {
          case 'location':
            return Promise.resolve({ kind: 'location', url: here, stamp: document });
          case 'links':
            swept.push(here);
            return Promise.resolve({ kind: 'links', urls: ['https://shop.test/about'] });
          case 'clickables':
            listings += 1;
            // One tile on the listing page; the product page it opens has nothing.
            return Promise.resolve(
              here === 'https://shop.test/' && listings === 1
                ? ({
                    kind: 'clickables',
                    clickables: [
                      { selector: '#tile', label: 'Product', risk: 'safe', group: 'a.tile' },
                    ],
                  } as AutomationReply)
                : ({ kind: 'clickables', clickables: [] } as AutomationReply),
            );
          case 'click':
            // Clicking the tile loads a new document, as a real product tile does.
            here = 'https://shop.test/product/1';
            document = 'doc-2';
            return Promise.resolve({ kind: 'clicked' });
          case 'navigate':
            here = command.url;
            return Promise.resolve({ kind: 'navigating' });
          default:
            return Promise.resolve({ kind: 'dismissed' });
        }
      },
    };

    const outcome = await crawlSite({ ...deps(driver), maxPages: 3, clicksPerPage: 0 });

    // Otherwise a product page is opened and then abandoned, so its Add to Cart is never clicked.
    expect(outcome.pages.map((page) => page.url)).toContain('https://shop.test/product/1');
    expect(swept).toContain('https://shop.test/product/1');
  });

  it('does not navigate when a click already took it to the next page', async () => {
    let here = 'https://shop.test/';
    let document = 'doc-1';
    const navigatedTo: string[] = [];
    let clicked = false;

    const driver: PageDriver = {
      send: (command) => {
        switch (command.kind) {
          case 'location':
            return Promise.resolve({ kind: 'location', url: here, stamp: document });
          case 'links':
            return Promise.resolve({ kind: 'links', urls: [] });
          case 'clickables':
            return Promise.resolve(
              clicked
                ? ({ kind: 'clickables', clickables: [] } as AutomationReply)
                : ({
                    kind: 'clickables',
                    clickables: [
                      { selector: '#go', label: 'Go', risk: 'safe', group: 'a.go' },
                    ],
                  } as AutomationReply),
            );
          case 'click':
            clicked = true;
            here = 'https://shop.test/next';
            document = 'doc-2';
            return Promise.resolve({ kind: 'clicked' });
          case 'navigate':
            navigatedTo.push(command.url);
            here = command.url;
            return Promise.resolve({ kind: 'navigating' });
          default:
            return Promise.resolve({ kind: 'dismissed' });
        }
      },
    };

    await crawlSite({ ...deps(driver), maxPages: 2, clicksPerPage: 0 });

    // Reloading a page we are already on would lose whatever state the click produced, so the
    // page the click landed on is swept in place. Navigating *back* to finish the first page is
    // expected and is what makes the crawl depth-first.
    expect(navigatedTo).not.toContain('https://shop.test/next');
  });

  it('never visits the same page twice', async () => {
    const page = scriptedPage((command) => {
      switch (command.kind) {
        case 'location':
          return { kind: 'location', url: 'https://shop.test/', stamp: 'doc' };
        case 'clickables':
          return { kind: 'clickables', clickables: [] };
        case 'links':
          // The site links back to itself, with and without a trailing slash and a fragment.
          return {
            kind: 'links',
            urls: ['https://shop.test/', 'https://shop.test', 'https://shop.test/#top'],
          };
        default:
          return { kind: 'dismissed' };
      }
    });

    const outcome = await crawlSite({ ...deps(page.driver), maxPages: 5, clicksPerPage: 20 });

    expect(outcome.pages).toHaveLength(1);
  });

  it('collects links before clicking, so a page-breaking click cannot end the crawl', async () => {
    const order: string[] = [];
    let listings = 0;
    const driver: PageDriver = {
      send: (command) => {
        order.push(command.kind);
        switch (command.kind) {
          case 'location':
            return Promise.resolve({ kind: 'location', url: 'https://shop.test/', stamp: 'doc' });
          case 'links':
            return Promise.resolve({ kind: 'links', urls: ['https://shop.test/next'] });
          case 'clickables':
            listings += 1;
            // After the first listing the page is dead — as if a click navigated.
            return Promise.resolve(
              listings === 1
                ? ({ kind: 'clickables', clickables: [{ selector: '#a', label: 'A', risk: 'safe', group: '#a-kind' }] } as AutomationReply)
                : ({ kind: 'error', message: 'gone' } as AutomationReply),
            );
          default:
            return Promise.resolve({ kind: 'clicked' } as AutomationReply);
        }
      },
    };

    const outcome = await crawlSite({ ...deps(driver), maxPages: 2, clicksPerPage: 5 });

    expect(order.indexOf('links')).toBeLessThan(order.indexOf('click'));
    // The second page was still reached despite the first page dying mid-sweep.
    expect(outcome.pages.map((page) => page.url)).toContain('https://shop.test/next');
  });

  it('spends only its click budget on each page', async () => {
    let clicks = 0;
    const driver: PageDriver = {
      send: (command) => {
        if (command.kind === 'location') {
          return Promise.resolve({ kind: 'location', url: 'https://shop.test/', stamp: 'doc' });
        }
        if (command.kind === 'links') {
          return Promise.resolve({ kind: 'links', urls: [] });
        }
        if (command.kind === 'clickables') {
          return Promise.resolve({
            kind: 'clickables',
            clickables: Array.from({ length: 40 }, (_unused, index) => ({
              selector: `#e${index}`,
              label: `E${index}`,
              risk: 'safe' as const,
              group: `kind-${index}`,
            })),
          });
        }
        if (command.kind === 'click') {
          clicks += 1;
        }
        return Promise.resolve({ kind: 'clicked' });
      },
    };

    await crawlSite({ ...deps(driver), maxPages: 1, clicksPerPage: 6 });

    // Otherwise one busy page absorbs the entire run and it looks like it never navigates.
    expect(clicks).toBe(6);
  });

  it('keeps going with no page limit until the site runs out', async () => {
    let page = 0;
    const driver: PageDriver = {
      send: (command) => {
        if (command.kind === 'location') {
          page += 1;
          return Promise.resolve({ kind: 'location', url: `https://shop.test/${page}`, stamp: 'doc' });
        }
        if (command.kind === 'links') {
          // Only the first page offers anything onward, so the crawl ends naturally.
          return Promise.resolve({
            kind: 'links',
            urls: page === 1 ? ['https://shop.test/a', 'https://shop.test/b'] : [],
          });
        }
        if (command.kind === 'clickables') {
          return Promise.resolve({ kind: 'clickables', clickables: [] });
        }
        return Promise.resolve({ kind: 'navigating' });
      },
    };

    const outcome = await crawlSite({ ...deps(driver), maxPages: 0, clicksPerPage: 0 });

    expect(outcome.pages).toHaveLength(3);
  });

  it('stops when asked, even with no limits', async () => {
    let stop = false;
    const driver: PageDriver = {
      send: (command) => {
        if (command.kind === 'location') {
          return Promise.resolve({ kind: 'location', url: 'https://shop.test/', stamp: 'doc' });
        }
        if (command.kind === 'links') {
          // An endless supply of pages: only cancellation can end this.
          return Promise.resolve({
            kind: 'links',
            urls: [`https://shop.test/${Math.random()}`],
          });
        }
        if (command.kind === 'clickables') {
          stop = true;
          return Promise.resolve({ kind: 'clickables', clickables: [] });
        }
        return Promise.resolve({ kind: 'navigating' });
      },
    };

    const outcome = await crawlSite({
      ...deps(driver),
      maxPages: 0,
      clicksPerPage: 0,
      isCancelled: () => stop,
    });

    expect(outcome.stopped).toBe('Stopped.');
  });

  it('stops at the page limit', async () => {
    let page = 0;
    const driver: PageDriver = {
      send: (command) => {
        if (command.kind === 'location') {
          page += 1;
          return Promise.resolve({ kind: 'location', url: `https://shop.test/${page}`, stamp: 'doc' });
        }
        if (command.kind === 'links') {
          return Promise.resolve({
            kind: 'links',
            urls: [`https://shop.test/next-${page}`, `https://shop.test/other-${page}`],
          });
        }
        if (command.kind === 'clickables') {
          return Promise.resolve({ kind: 'clickables', clickables: [] });
        }
        return Promise.resolve({ kind: 'dismissed' });
      },
    };

    const outcome = await crawlSite({ ...deps(driver), maxPages: 3, clicksPerPage: 20 });

    expect(outcome.pages).toHaveLength(3);
  });

  it('gives up when a page never comes back', async () => {
    let asked = 0;
    const driver: PageDriver = {
      send: (command) => {
        if (command.kind === 'location') {
          asked += 1;
          // The first read succeeds; after navigating, the page never answers again.
          return Promise.resolve(
            asked === 1
              ? ({ kind: 'location', url: 'https://shop.test/', stamp: 'doc' } as AutomationReply)
              : ({ kind: 'error', message: 'gone' } as AutomationReply),
          );
        }
        if (command.kind === 'clickables') {
          return Promise.resolve({ kind: 'clickables', clickables: [] });
        }
        if (command.kind === 'links') {
          return Promise.resolve({ kind: 'links', urls: ['https://shop.test/dead'] });
        }
        return Promise.resolve({ kind: 'navigating' });
      },
    };

    const outcome = await crawlSite({
      ...deps(driver),
      // Advance the clock so the readiness wait expires instead of spinning.
      now: (() => {
        let clock = NOW;
        return () => (clock += 10_000);
      })(),
      maxPages: 3,
      clicksPerPage: 20,
    });

    expect(outcome.stopped).toContain('Gave up waiting');
  });
});

describe('finishing a page after a click leaves it', () => {
  /**
   * Two pages. The home page has three controls; the second navigates away. The site the crawl
   * lands on has one control of its own.
   *
   * What a correct crawl does: click Home-1, click Home-2 (which navigates), sweep the whole of
   * /product, come back to home, and click Home-3.
   */
  function twoPageSite() {
    const clicks: string[] = [];
    const navigatedTo: string[] = [];
    let here = 'https://shop.test/';
    let document = 'doc-home';

    const controlsFor = (url: string) =>
      url === 'https://shop.test/'
        ? [
            { selector: '#h1', label: 'Home 1', risk: 'safe' as const, group: 'button.home' },
            { selector: '#h2', label: 'Home 2', risk: 'safe' as const, group: 'button.home' },
            { selector: '#h3', label: 'Home 3', risk: 'safe' as const, group: 'button.home' },
          ]
        : [{ selector: '#p1', label: 'Product 1', risk: 'safe' as const, group: 'button.pdp' }];

    const driver: PageDriver = {
      send: (command) => {
        switch (command.kind) {
          case 'location':
            return Promise.resolve({ kind: 'location', url: here, stamp: document });
          case 'links':
            return Promise.resolve({ kind: 'links', urls: [] });
          case 'clickables':
            return Promise.resolve({ kind: 'clickables', clickables: controlsFor(here) });
          case 'click': {
            const label = controlsFor(here).find((c) => c.selector === command.selector)?.label;
            clicks.push(label ?? command.selector);
            if (label === 'Home 2') {
              here = 'https://shop.test/product';
              document = 'doc-product';
            }
            return Promise.resolve({ kind: 'clicked' });
          }
          case 'navigate':
            navigatedTo.push(command.url);
            here = command.url;
            document = command.url === 'https://shop.test/' ? 'doc-home-2' : 'doc-product-2';
            return Promise.resolve({ kind: 'navigating' });
          default:
            return Promise.resolve({ kind: 'dismissed' });
        }
      },
    };

    /** A distinct event per click, so no control group is retired as barren mid-test. */
    const payloadsSince = (): readonly CapturedPayload[] => [
      {
        id: `p${clicks.length}`,
        at: NOW,
        eventName: `evt-${clicks.length}`,
        args: [],
        raw: '[]',
        origin: 'intercepted',
      },
    ];

    return { driver, payloadsSince, clicks: () => clicks, navigatedTo: () => navigatedTo };
  }

  it('sweeps the page a click landed on, then returns and finishes the first', async () => {
    const site = twoPageSite();

    await crawlSite({ ...deps(site.driver, { payloadsSince: site.payloadsSince }), maxPages: 5, clicksPerPage: 0 });

    expect(site.clicks()).toEqual(['Home 1', 'Home 2', 'Product 1', 'Home 3']);
  });

  it('navigates back to the page it left, rather than abandoning it', async () => {
    const site = twoPageSite();

    await crawlSite({ ...deps(site.driver, { payloadsSince: site.payloadsSince }), maxPages: 5, clicksPerPage: 0 });

    expect(site.navigatedTo()).toContain('https://shop.test/');
  });

  /** Without reload-stable identity, returning to a page re-clicks the control that left it. */
  it('does not click a control twice across the return trip', async () => {
    const site = twoPageSite();

    await crawlSite({ ...deps(site.driver, { payloadsSince: site.payloadsSince }), maxPages: 5, clicksPerPage: 0 });

    const clicks = site.clicks();
    expect(new Set(clicks).size).toBe(clicks.length);
  });

  it('reports a page swept over several visits once, not once per visit', async () => {
    const site = twoPageSite();

    const outcome = await crawlSite({ ...deps(site.driver, { payloadsSince: site.payloadsSince }), maxPages: 5, clicksPerPage: 0 });

    expect(outcome.pages.map((page) => page.url)).toEqual([
      'https://shop.test/',
      'https://shop.test/product',
    ]);
  });
});

describe('withStableKeys', () => {
  const control = (label: string, group: string) => ({
    selector: '#x',
    label,
    group,
    risk: 'safe' as const,
    frameId: 0,
  });

  it('gives the same control the same key across two enumerations', () => {
    const first = withStableKeys([control('Add to Cart', 'button.add')]);
    const second = withStableKeys([control('Add to Cart', 'button.add')]);

    expect(first[0]?.stableKey).toBe(second[0]?.stableKey);
  });

  /** A grid of identical tiles must not collapse into one key, or the sweep would skip the rest. */
  it('separates repeats of the same kind by ordinal', () => {
    const keys = withStableKeys([
      control('Buy', 'button.tile'),
      control('Buy', 'button.tile'),
    ]).map((entry) => entry.stableKey);

    expect(new Set(keys).size).toBe(2);
  });

  it('separates controls that differ only by frame', () => {
    const keys = withStableKeys([
      { ...control('Pay', 'button.pay'), frameId: 0 },
      { ...control('Pay', 'button.pay'), frameId: 3 },
    ]).map((entry) => entry.stableKey);

    expect(new Set(keys).size).toBe(2);
  });
});

describe('the navbar no longer eats the crawl', () => {
  /** A header of links above a body of buttons — the shape of essentially every site. */
  const NAVBAR_PAGE = [
    { selector: '#n1', label: 'Shop', risk: 'navigates' as const, group: 'a.nav' },
    { selector: '#n2', label: 'Blog', risk: 'navigates' as const, group: 'a.nav' },
    { selector: '#n3', label: 'About', risk: 'navigates' as const, group: 'a.nav' },
    { selector: '#b1', label: 'Add to Cart', risk: 'safe' as const, group: 'button.cta' },
    { selector: '#b2', label: 'Size guide', risk: 'safe' as const, group: 'button.link' },
  ];

  function page() {
    const clicks: string[] = [];
    const driver: PageDriver = {
      send: (command) => {
        switch (command.kind) {
          case 'location':
            return Promise.resolve({ kind: 'location', url: 'https://shop.test/', stamp: 'doc' });
          case 'links':
            return Promise.resolve({ kind: 'links', urls: [] });
          case 'clickables':
            return Promise.resolve({ kind: 'clickables', clickables: NAVBAR_PAGE });
          case 'click':
            clicks.push(
              NAVBAR_PAGE.find((c) => c.selector === command.selector)?.label ?? command.selector,
            );
            return Promise.resolve({ kind: 'clicked' });
          default:
            return Promise.resolve({ kind: 'dismissed' });
        }
      },
    };
    return { driver, clicks: () => clicks };
  }

  it("clicks the page's own buttons before following any link", async () => {
    const site = page();

    await sweepPage(deps(site.driver, { allowed: () => true }));

    const clicks = site.clicks();
    const firstLink = clicks.indexOf('Shop');
    expect(clicks.indexOf('Add to Cart')).toBeLessThan(firstLink);
    expect(clicks.indexOf('Size guide')).toBeLessThan(firstLink);
  });

  /**
   * The navbar is the same component on every page. Once its links have produced nothing new a
   * couple of times, clicking the rest teaches nothing and costs a navigation each — which is what
   * made a crawl look like it was circling the header.
   */
  it('retires a barren group instead of clicking every member of it', async () => {
    const site = page();

    await sweepPage(deps(site.driver, { allowed: () => true }));

    expect(site.clicks().filter((label) => ['Shop', 'Blog', 'About'].includes(label)).length)
      .toBeLessThan(3);
  });

  it('carries what it learned about a group from one page to the next', async () => {
    const groups = newGroupMemory();
    const first = page();
    await sweepPage(deps(first.driver, { allowed: () => true }), undefined, {
      clickedHere: new Set(),
      groups,
    });

    const second = page();
    await sweepPage(deps(second.driver, { allowed: () => true }), undefined, {
      clickedHere: new Set(),
      groups,
    });

    // The second page inherits the first's verdict on `a.nav`, so it does not re-walk the header.
    expect(second.clicks()).not.toContain('About');
  });
});

describe('how often one event is worth producing', () => {
  /** Every control fires the same event, whatever its kind — a site-wide page_view, say. */
  function alwaysFires(controls: number, kindPerControl = false) {
    let clicks = 0;
    const driver: PageDriver = {
      send: (command) => {
        switch (command.kind) {
          case 'location':
            return Promise.resolve({ kind: 'location', url: 'https://shop.test/', stamp: 'doc' });
          case 'clickables':
            return Promise.resolve({
              kind: 'clickables',
              clickables: Array.from({ length: controls }, (_, index) => ({
                selector: `#c${index}`,
                label: `Control ${index}`,
                risk: 'safe' as const,
                group: kindPerControl ? `button.kind${index}` : 'button.same',
              })),
            });
          case 'click':
            clicks += 1;
            return Promise.resolve({ kind: 'clicked' });
          default:
            return Promise.resolve({ kind: 'dismissed' });
        }
      },
    };
    return { driver, clicks: () => clicks };
  }

  const firesPageView = () => [
    {
      id: 'p',
      at: NOW,
      eventName: 'page_view',
      args: [],
      raw: '[]',
      origin: 'intercepted' as const,
    },
  ];

  it('stops after two clicks on a kind of control whose event is already in hand', async () => {
    const page = alwaysFires(20);

    await sweepPage(deps(page.driver, { payloadsSince: firesPageView }));

    expect(page.clicks()).toBe(2);
  });

  /**
   * The honest limit of the cap. Twenty *different* kinds of control that all happen to fire the
   * same event cost one click each to find that out — nothing can know what a control does before
   * it is clicked. What the cap guarantees is that none of them is clicked a second time.
   */
  it('spends at most one click discovering each new kind of control', async () => {
    const page = alwaysFires(20, true);

    await sweepPage(deps(page.driver, { payloadsSince: firesPageView }));

    expect(page.clicks()).toBe(20);
  });

  it('carries the tally across pages, not just within one sweep', async () => {
    const groups = newGroupMemory();
    const payloadsSince = () => [
      { id: 'p', at: NOW, eventName: 'page_view', args: [], raw: '[]', origin: 'intercepted' as const },
    ];

    const first = alwaysFires(20);
    await sweepPage(deps(first.driver, { payloadsSince }), undefined, {
      clickedHere: new Set(),
      groups,
    });

    const second = alwaysFires(20);
    await sweepPage(deps(second.driver, { payloadsSince }), undefined, {
      clickedHere: new Set(),
      groups,
    });

    // The cap was already met on the first page; the second spends nothing re-confirming it.
    expect(second.clicks()).toBe(0);
  });

  it('keeps clicking while a control still turns up events it has not seen', async () => {
    const page = alwaysFires(6);
    let count = 0;

    await sweepPage(
      deps(page.driver, {
        payloadsSince: () => {
          count += 1;
          return [
            { id: `p${count}`, at: NOW, eventName: `event_${count}`, args: [], raw: '[]', origin: 'intercepted' },
          ];
        },
      }),
    );

    expect(page.clicks()).toBe(6);
  });
});

describe('overlays before the page underneath', () => {
  function pageWith(clickables: readonly { selector: string; label: string; group: string; inOverlay?: boolean }[]) {
    const clicked: string[] = [];
    const driver: PageDriver = {
      send: (command) => {
        switch (command.kind) {
          case 'location':
            return Promise.resolve({ kind: 'location', url: 'https://shop.test/', stamp: 'doc' });
          case 'clickables':
            return Promise.resolve({
              kind: 'clickables',
              clickables: clickables.map((entry) => ({ ...entry, risk: 'safe' as const })),
            });
          case 'click':
            clicked.push(command.selector);
            return Promise.resolve({ kind: 'clicked' });
          default:
            return Promise.resolve({ kind: 'dismissed' });
        }
      },
    };
    return { driver, clicked: () => clicked };
  }

  /**
   * A modal or cart drawer is transient — dismissed by the next Escape, or replaced when the page
   * re-renders. The page beneath it is not going anywhere, so it can wait.
   */
  it('clicks a modal’s controls before the page beneath it', async () => {
    const page = pageWith([
      { selector: '#page1', label: 'Page button', group: 'button.page' },
      { selector: '#modal1', label: 'In the modal', group: 'button.modal', inOverlay: true },
      { selector: '#page2', label: 'Another page button', group: 'button.page2' },
    ]);

    await sweepPage(deps(page.driver));

    expect(page.clicked()[0]).toBe('#modal1');
  });

  it('leaves ordering alone when nothing is overlaid', async () => {
    const page = pageWith([
      { selector: '#a', label: 'A', group: 'button.a' },
      { selector: '#b', label: 'B', group: 'button.b' },
    ]);

    await sweepPage(deps(page.driver));

    expect(page.clicked()).toEqual(['#a', '#b']);
  });
});

describe('not walking the same kind of page twice over', () => {
  /**
   * A storefront: one shop page linking to many product pages, each firing `product_view` on load
   * and offering nothing to click.
   */
  function storefront(products: number) {
    const opened: string[] = [];
    let here = 'https://shop.test/shop';

    const driver: PageDriver = {
      send: (command) => {
        switch (command.kind) {
          case 'location':
            return Promise.resolve({ kind: 'location', url: here, stamp: here });
          case 'links':
            return Promise.resolve({
              kind: 'links',
              urls: Array.from({ length: products }, (_, i) => `https://shop.test/products/item-${i}`),
            });
          case 'clickables':
            return Promise.resolve({ kind: 'clickables', clickables: [] });
          case 'navigate':
            opened.push(command.url);
            here = command.url;
            return Promise.resolve({ kind: 'navigating' });
          default:
            return Promise.resolve({ kind: 'dismissed' });
        }
      },
    };

    /** Every product page fires the same event, the way a template does. */
    const payloadsSince = (): readonly CapturedPayload[] =>
      here.includes('/products/')
        ? [
            {
              id: here,
              at: NOW,
              eventName: 'product_view',
              args: [],
              raw: '[]',
              origin: 'intercepted',
            },
          ]
        : [];

    return { driver, payloadsSince, opened: () => opened };
  }

  it('opens two product pages, not forty', async () => {
    const site = storefront(40);

    const outcome = await crawlSite({
      ...deps(site.driver, { payloadsSince: site.payloadsSince }),
      maxPages: 0,
      clicksPerPage: 0,
    });

    expect(site.opened().filter((url) => url.includes('/products/'))).toHaveLength(2);
    expect(outcome.skippedAsSameKind).toBe(38);
  });

  /** Skipping half a site silently would look exactly like never having found it. */
  it('reports how many it left alone', async () => {
    const site = storefront(10);

    const outcome = await crawlSite({
      ...deps(site.driver, { payloadsSince: site.payloadsSince }),
      maxPages: 0,
      clicksPerPage: 0,
    });

    expect(outcome.skippedAsSameKind).toBe(8);
  });

  /**
   * The safety property that makes a blunt shape acceptable: a kind is only written off once it
   * has been watched and found to repeat itself.
   */
  it('keeps visiting pages of a kind while they still produce something new', async () => {
    const site = storefront(6);
    let count = 0;
    const payloadsSince = (): readonly CapturedPayload[] => {
      count += 1;
      return [
        {
          id: `p${count}`,
          at: NOW,
          eventName: `event_${count}`,
          args: [],
          raw: '[]',
          origin: 'intercepted',
        },
      ];
    };

    const outcome = await crawlSite({
      ...deps(site.driver, { payloadsSince }),
      maxPages: 0,
      clicksPerPage: 0,
    });

    expect(outcome.skippedAsSameKind).toBe(0);
  });
});

describe('events a page fires by loading', () => {
  function site() {
    let here = 'https://shop.test/shop';
    const driver: PageDriver = {
      send: (command) => {
        switch (command.kind) {
          case 'location':
            return Promise.resolve({ kind: 'location', url: here, stamp: here });
          case 'links':
            return Promise.resolve({ kind: 'links', urls: ['https://shop.test/products/one'] });
          case 'clickables':
            return Promise.resolve({ kind: 'clickables', clickables: [] });
          case 'navigate':
            here = command.url;
            return Promise.resolve({ kind: 'navigating' });
          default:
            return Promise.resolve({ kind: 'dismissed' });
        }
      },
    };
    return { driver, where: () => here };
  }

  /**
   * `product_view` is produced by arriving, not by clicking. The sweep only samples after a click,
   * so before this these belonged to no page and were captured by nobody.
   */
  it('captures what arriving on a page produced', async () => {
    const page = site();

    const outcome = await crawlSite({
      ...deps(page.driver, {
        payloadsSince: () =>
          page.where().includes('/products/')
            ? [
                {
                  id: 'p',
                  at: NOW,
                  eventName: 'product_view',
                  args: [],
                  raw: '[]',
                  origin: 'intercepted' as const,
                },
              ]
            : [],
      }),
      maxPages: 0,
      clicksPerPage: 0,
    });

    expect(outcome.captured.map((payload) => payload.eventName)).toContain('product_view');
  });

  /** Sampling again on a page we never left would count the same events twice. */
  it('does not re-attribute events when it did not navigate', async () => {
    const page = site();
    let samples = 0;

    await crawlSite({
      ...deps(page.driver, {
        payloadsSince: () => {
          samples += 1;
          return [];
        },
      }),
      maxPages: 0,
      clicksPerPage: 0,
    });

    // The starting page is swept without navigating to it, so only the second page is sampled.
    expect(samples).toBe(1);
  });
});

describe('exploring a modal before closing it', () => {
  /** A modal as sites build them: the X first in document order, the real controls after it. */
  const MODAL = [
    { selector: '#x', label: '×', group: 'button.close', inOverlay: true, dismisses: true },
    { selector: '#apply', label: 'Apply', group: 'button.apply', inOverlay: true },
    { selector: '#save', label: 'Save', group: 'button.save', inOverlay: true },
    { selector: '#page', label: 'Page button', group: 'button.page' },
  ];

  function page() {
    const clicked: string[] = [];
    const driver: PageDriver = {
      send: (command) => {
        switch (command.kind) {
          case 'location':
            return Promise.resolve({ kind: 'location', url: 'https://shop.test/', stamp: 'doc' });
          case 'links':
            return Promise.resolve({ kind: 'links', urls: [] });
          case 'clickables':
            return Promise.resolve({
              kind: 'clickables',
              clickables: MODAL.map((entry) => ({ ...entry, risk: 'safe' as const })),
            });
          case 'click':
            clicked.push(command.selector);
            return Promise.resolve({ kind: 'clicked' });
          default:
            return Promise.resolve({ kind: 'dismissed' });
        }
      },
    };
    return { driver, clicked: () => clicked };
  }

  it('clicks the modal’s own controls before its close button', async () => {
    const site = page();

    await sweepPage(deps(site.driver));

    const clicked = site.clicked();
    expect(clicked.indexOf('#apply')).toBeLessThan(clicked.indexOf('#x'));
    expect(clicked.indexOf('#save')).toBeLessThan(clicked.indexOf('#x'));
  });

  /** Closing throws the overlay away, so it comes after the page beneath as well. */
  it('leaves the close button until everything else has been spent', async () => {
    const site = page();

    await sweepPage(deps(site.driver));

    expect(site.clicked().at(-1)).toBe('#x');
  });
});
