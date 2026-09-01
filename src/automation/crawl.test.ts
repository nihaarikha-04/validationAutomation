import { describe, expect, it } from 'vitest';
import type { CapturedPayload } from '../shared/payload';
import type { AutomationCommand, AutomationReply, PageDriver } from './commands';
import { crawlSite, sweepPage, type SweepDeps } from './crawl';

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

    // Forty product tiles all firing product_view tell us nothing forty times over — but it takes
    // a repeat to know they are repeats, so one click proves nothing and two confirm it.
    expect(page.clicks()).toBe(3);
    expect(outcome.skippedAsRepeats).toBe(37);
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
    expect(clicks).toEqual([
      { frameId: 0, selector: '#top' },
      { frameId: 7, selector: '#inner' },
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

    expect(clicks).toEqual([0, 3]);
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
    let navigations = 0;
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
            navigations += 1;
            here = command.url;
            return Promise.resolve({ kind: 'navigating' });
          default:
            return Promise.resolve({ kind: 'dismissed' });
        }
      },
    };

    await crawlSite({ ...deps(driver), maxPages: 2, clicksPerPage: 0 });

    // Reloading a page we are already on would lose whatever state the click produced.
    expect(navigations).toBe(0);
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
