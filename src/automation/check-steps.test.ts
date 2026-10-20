import { describe, expect, it, vi } from 'vitest';
import { checkSteps } from './check-steps';
import type { AutomationCommand, AutomationReply, FrameReply, PageDriver } from './commands';
import type { SubIntent } from '../event-sheet/sub-intents';

function click(target: string): SubIntent {
  return { kind: 'click', target, source: `click ${target}` };
}

function found(label: string): AutomationReply {
  return {
    kind: 'resolved',
    resolution: { kind: 'found', match: { selector: '#x', label, risk: 'safe' } },
  };
}

const NONE: AutomationReply = { kind: 'resolved', resolution: { kind: 'none' } };

function driverSaying(byFrame: ReadonlyMap<number, AutomationReply>): PageDriver {
  return {
    send: () => Promise.resolve(byFrame.get(0) ?? NONE),
    sendAll: (): Promise<readonly FrameReply[]> =>
      Promise.resolve([...byFrame].map(([frameId, reply]) => ({ frameId, reply }))),
  };
}

describe('checkSteps', () => {
  it('says where a control was found', async () => {
    const checked = await checkSteps([click('search')], driverSaying(new Map([[0, found('Search')]])));

    expect(checked[0]?.check).toEqual({ kind: 'here', label: 'Search', frameId: 0 });
  });

  it('says when nothing on the page is called that', async () => {
    const checked = await checkSteps([click('search')], driverSaying(new Map([[0, NONE]])));

    expect(checked[0]?.check).toEqual({ kind: 'missing' });
  });

  /** The control a sheet names often lives in a quick-view panel, which is its own document. */
  it('finds a control that is only in a frame', async () => {
    const checked = await checkSteps(
      [click('Add to Cart')],
      driverSaying(new Map([[0, NONE], [7, found('ADD TO CART')]])),
    );

    expect(checked[0]?.check).toEqual({ kind: 'here', label: 'ADD TO CART', frameId: 7 });
  });

  /**
   * Two frames each finding one match is still ambiguous — a panel duplicating a control from the
   * page behind it looks unambiguous to each document and is not.
   */
  it('is ambiguous when two frames each found one', async () => {
    const checked = await checkSteps(
      [click('Add to Cart')],
      driverSaying(new Map([[0, found('Add to Cart')], [7, found('ADD TO CART')]])),
    );

    expect(checked[0]?.check.kind).toBe('ambiguous');
    if (checked[0]?.check.kind !== 'ambiguous') return;
    expect(checked[0].check.count).toBe(2);
  });

  it('passes on what a frame said was contested', async () => {
    const contested: AutomationReply = {
      kind: 'resolved',
      resolution: { kind: 'ambiguous', count: 5, describing: ['button "search"', 'div "search"'] },
    };
    const checked = await checkSteps([click('search')], driverSaying(new Map([[0, contested]])));

    expect(checked[0]?.check).toEqual({
      kind: 'ambiguous',
      count: 5,
      describing: ['button "search"', 'div "search"'],
    });
  });

  /** A pause waits on a person, so there is nothing on the page to look for. */
  it('does not go looking for a step that asks the tester', async () => {
    const send = vi.fn(() => Promise.resolve(NONE));
    const intent: SubIntent = {
      kind: 'ask',
      target: 'OTP',
      valueKind: 'otp',
      source: 'request the OTP',
    };

    const checked = await checkSteps([intent], { send });

    expect(checked[0]?.check).toEqual({ kind: 'asks', valueKind: 'otp' });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not go looking for an address', async () => {
    const intent: SubIntent = {
      kind: 'navigate',
      target: '/cart',
      value: '/cart',
      source: 'go to /cart',
    };

    const checked = await checkSteps([intent], driverSaying(new Map()));

    expect(checked[0]?.check).toEqual({ kind: 'not-a-control' });
  });

  it('checks every step, in order', async () => {
    const asked: AutomationCommand[] = [];
    const driver: PageDriver = {
      send: (command) => {
        asked.push(command);
        return Promise.resolve(NONE);
      },
    };

    await checkSteps([click('one'), click('two')], driver);

    expect(asked.map((command) => (command.kind === 'resolve' ? command.wanted : ''))).toEqual([
      'one',
      'two',
    ]);
  });

  /** A driver that knows nothing about frames still works; it just sees the top document. */
  it('works without frame support', async () => {
    const driver: PageDriver = { send: () => Promise.resolve(found('Search')) };

    const checked = await checkSteps([click('search')], driver);

    expect(checked[0]?.check.kind).toBe('here');
  });
});

/**
 * A page that did not answer is not a page missing the control.
 *
 * Reloading the extension leaves an already-open page without a content script until it is
 * reloaded too, and the two read identically — "not on this page" sends a reader looking at the
 * client's markup for a problem that is in their browser.
 */
describe('when the page does not answer', () => {
  it('says so rather than reporting the control missing', async () => {
    const driver: PageDriver = {
      send: () => Promise.resolve({ kind: 'error', message: 'No response from the page.' }),
    };

    const checked = await checkSteps([click('search')], driver);

    expect(checked[0]?.check).toEqual({
      kind: 'no-answer',
      detail: 'No response from the page.',
    });
  });

  it('says so when no frame replies at all', async () => {
    const driver: PageDriver = {
      send: () => Promise.resolve({ kind: 'acknowledged' }),
      sendAll: () => Promise.resolve([]),
    };

    const checked = await checkSteps([click('search')], driver);

    expect(checked[0]?.check.kind).toBe('no-answer');
  });

  /** One frame answering is enough; a silent sibling must not mask a real answer. */
  it('still reports a find when only some frames answered', async () => {
    const driver: PageDriver = {
      send: () => Promise.resolve(NONE),
      sendAll: () =>
        Promise.resolve([
          { frameId: 0, reply: { kind: 'error', message: 'gone' } as AutomationReply },
          { frameId: 7, reply: found('Search') },
        ]),
    };

    const checked = await checkSteps([click('search')], driver);

    expect(checked[0]?.check).toEqual({ kind: 'here', label: 'Search', frameId: 7 });
  });
});
