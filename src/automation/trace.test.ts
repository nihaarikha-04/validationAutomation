import { describe, expect, it } from 'vitest';
import { traceLine } from './trace';

describe('traceLine', () => {
  it('says when a click landed on something drawn over the control', () => {
    expect(
      traceLine({
        kind: 'clicked',
        round: 4,
        label: 'Add to bag',
        frameId: 0,
        inOverlay: false,
        hit: { kind: 'covered', by: 'div "Remove Item" (in a dialog)' },
        fired: [],
        url: 'https://example.test/cart',
      }),
    ).toBe(
      '#4 click "Add to bag" [frame 0] → COVERED by div "Remove Item" (in a dialog) · fired: ' +
        'nothing · at https://example.test/cart',
    );
  });

  it('says when a round found the page exactly as the last one left it', () => {
    expect(
      traceLine({
        kind: 'listed',
        round: 5,
        controls: 40,
        frames: 1,
        inOverlay: 3,
        covered: 37,
        coveredBy: [],
        candidates: 12,
        change: 'same',
        stalls: 2,
        newNotices: ['This item is unavailable'],
      }),
    ).toBe(
      '#5 listed 40 controls in 1 frame · 3 in an overlay · 37 covered · 12 left to try · ' +
        'page unchanged since last round · 2 stalled in a row · page says: "This item is unavailable"',
    );
  });

  it('tells a restart the tool began itself from one the tester asked for', () => {
    expect(traceLine({ kind: 'started', trigger: 'page-changed' })).toContain('restarted on its own');
    expect(traceLine({ kind: 'started', trigger: 'button' })).toContain('from the button');
  });

  it('names why a sweep ended, including when nothing said so', () => {
    expect(
      traceLine({ kind: 'ended', clicks: 3, stopped: undefined, navigatedTo: 'https://x.test/b' }),
    ).toBe('── sweep ended after 3 clicks: a click navigated to https://x.test/b');
    expect(traceLine({ kind: 'ended', clicks: 9, stopped: undefined, navigatedTo: undefined })).toBe(
      '── sweep ended after 9 clicks: nothing left to click, or the click limit was reached',
    );
  });

  it('distinguishes a click that never landed from one that did', () => {
    expect(
      traceLine({
        kind: 'missed',
        round: 2,
        label: 'Close',
        frameId: 3,
        reply: 'not-found',
        hit: undefined,
      }),
    ).toBe('#2 click "Close" [frame 3] → did not land: not-found');
    expect(
      traceLine({
        kind: 'missed',
        round: 3,
        label: 'Women',
        frameId: 0,
        reply: 'unclickable',
        hit: { kind: 'covered', by: 'div "Remove Item" (in a dialog)' },
      }),
    ).toBe(
      '#3 click "Women" [frame 0] → did not land: unclickable (COVERED by div "Remove Item" (in a dialog))',
    );
  });
});

describe('traceLine frames', () => {
  it('names a frame that cannot be read, and controls hidden in shadow DOM', () => {
    expect(
      traceLine({
        kind: 'frames',
        round: 8,
        answered: 1,
        iframes: [{ source: 'https://widgets.test/dialog', readable: false, width: 600, height: 400 }],
        shadowControls: 3,
      }),
    ).toBe(
      '#8 frames: 1 answered · [NOT readable — other origin] https://widgets.test/dialog 600×400 · ' +
        '3 controls inside shadow DOM, not listed',
    );
  });
});
