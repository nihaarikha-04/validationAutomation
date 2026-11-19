import { afterEach, describe, expect, it } from 'vitest';
import {
  blocksClick,
  controlsInShadow,
  crossOriginFrames,
  describeFrames,
  findAcrossFrames,
  findClickables,
  hitAt,
  noticesIn,
  riskOf,
} from './sweep';

/**
 * The live document, not a DOMParser one: a parsed document has no `defaultView`, so
 * `getComputedStyle` is unreachable and the visibility check would never run.
 */
function pageWith(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

afterEach(() => {
  document.body.innerHTML = '';
});

function only(html: string): Element {
  const element = pageWith(html).body.firstElementChild;
  if (element === null) {
    throw new Error('no element');
  }
  return element;
}

describe('crossOriginFrames', () => {
  it('counts frames it cannot see into, rather than pretending they are not there', () => {
    // jsdom gives a same-origin document for a plain iframe, so this is the reachable case.
    expect(crossOriginFrames(pageWith('<iframe></iframe>'))).toBe(0);
  });
});

describe('riskOf', () => {
  it.each([
    ['<button>Place order</button>', 'destructive'],
    ['<button>Pay now</button>', 'destructive'],
    ['<a href="/logout">Sign out</a>', 'destructive'],
    ['<button>Delete my account</button>', 'destructive'],
    ['<button>Cancel subscription</button>', 'destructive'],
    // Removing a cart line is reversible, and `Remove from Cart` is an event the sheet asks for.
    // While `remove` matched on its own, the guard skipped the control that produces it.
    ['<button>Remove item</button>', 'safe'],
    ['<button aria-label="Remove">🗑</button>', 'safe'],
    // "Order" appears all over an account area. Matching it bare skipped the whole order history.
    ['<a href="/orders">Order Details</a>', 'navigates'],
    ['<button>Order Tracking</button>', 'safe'],
    ['<button>Reorder</button>', 'safe'],
    ['<button>Subscribe to newsletter</button>', 'safe'],
    ['<button>Cancel</button>', 'safe'],
    // Was 'safe', to stop the guard skipping the events these produce. It deleted a real saved
    // address on a live account. Reaching `Address Deleted` now costs an explicit opt-in, which
    // is the right price.
    ['<button>Delete address</button>', 'destructive'],
    ['<a href="/about">About us</a>', 'navigates'],
    ['<a href="/x" target="_blank">Docs</a>', 'navigates'],
    ['<a href="#section">Jump</a>', 'safe'],
    ['<a href="javascript:void(0)">Filter</a>', 'safe'],
    ['<button>Search</button>', 'safe'],
  ])('classifies %s as %s', (html, risk) => {
    expect(riskOf(only(html))).toBe(risk);
  });
});

describe('findClickables', () => {
  it('finds buttons, links and anything with a click handler', () => {
    const found = findClickables(
      pageWith('<button>A</button><a href="#x">B</a><div onclick="go()">C</div>'),
    );

    expect(found.map((entry) => entry.label)).toEqual(['A', 'B', 'C']);
  });

  it('skips disabled controls', () => {
    expect(findClickables(pageWith('<button disabled>A</button>'))).toEqual([]);
  });

  it('skips anything hidden from assistive tech', () => {
    expect(findClickables(pageWith('<button aria-hidden="true">A</button>'))).toEqual([]);
  });

  it('skips anything the page has hidden', () => {
    expect(findClickables(pageWith('<button style="display:none">A</button>'))).toEqual([]);
    expect(findClickables(pageWith('<button hidden>A</button>'))).toEqual([]);
  });

  it('names a wrapper by its own text, not everything inside it', () => {
    // Seen live: a card reported as "Mary JaneView CartFree Shipping unlocked 🎉2".
    const [found] = findClickables(
      pageWith('<a>Close<span>View Cart</span><span>Free Shipping unlocked</span></a>'),
    );

    expect(found?.label).toBe('Close');
  });

  it('falls back to inner text when a control has no text of its own', () => {
    const [found] = findClickables(pageWith('<button><span>Add to Cart</span></button>'));

    expect(found?.label).toBe('Add to Cart');
  });

  it('labels an icon-only control from its aria-label', () => {
    const [found] = findClickables(pageWith('<button aria-label="Open menu"><svg/></button>'));

    expect(found?.label).toBe('Open menu');
  });

  it('does not list the same element twice', () => {
    // A <button role="button"> matches the selector twice over.
    const found = findClickables(pageWith('<button role="button" id="a">A</button>'));

    expect(found).toHaveLength(1);
  });

  it('gives each control a selector that survives the page re-rendering', () => {
    const page = pageWith('<div><button>A</button><button>B</button></div>');
    const [first] = findClickables(page);

    // A click re-renders: same buttons, different position in the tree.
    page.body.innerHTML = `<header></header>${page.body.innerHTML}`;

    // The structural path has changed, but the tag travelled with the element.
    expect(page.querySelector(first?.selector ?? '')).not.toBeNull();
  });

  it('stamps ids so two page loads cannot collide', () => {
    const [found] = findClickables(pageWith('<button>A</button>'));

    // Ids restarted at 1 on every page, so after navigating, a new page's elements looked
    // already-visited and were skipped.
    // A per-load stamp before the counter, so ids from different pages are incomparable.
    expect(found?.selector).toMatch(/data-sv-id="[a-z0-9]+-\d+"/);
  });

  it('recognises a control it has already seen', () => {
    const page = pageWith('<button>A</button>');
    const before = findClickables(page)[0]?.selector;
    const after = findClickables(page)[0]?.selector;

    // Otherwise a sweep re-clicks the first few controls forever and never reaches the page.
    expect(after).toBe(before);
  });

  it('groups controls that are the same kind of thing', () => {
    const found = findClickables(
      pageWith(
        '<a class="tile card">One</a><a class="card tile">Two</a><button class="buy">Buy</button>',
      ),
    );

    // Class order should not matter; the two tiles are one kind, the button another.
    expect(found[0]?.group).toBe(found[1]?.group);
    expect(found[2]?.group).not.toBe(found[0]?.group);
  });

  it('uses the parent for context when a control has no classes of its own', () => {
    const found = findClickables(
      pageWith('<nav><button>A</button></nav><footer><button>B</button></footer>'),
    );

    // Otherwise every unadorned button on the page would look like one group.
    expect(found[0]?.group).not.toBe(found[1]?.group);
  });

  it('reaches controls inside a same-origin frame', () => {
    const page = pageWith('<button>Outside</button><iframe id="f"></iframe>');
    const frame = page.querySelector('iframe');
    const inner = frame instanceof HTMLIFrameElement ? frame.contentDocument : null;
    if (inner === null) {
      throw new Error('no frame document');
    }
    inner.body.innerHTML = '<button>Inside</button>';

    // Content scripts run in the top frame only, so iframe contents were invisible entirely.
    expect(findClickables(page).map((entry) => entry.label)).toEqual(['Outside', 'Inside']);
  });

  it('finds a tagged control that lives inside a frame', () => {
    const page = pageWith('<iframe id="f"></iframe>');
    const frame = page.querySelector('iframe');
    const inner = frame instanceof HTMLIFrameElement ? frame.contentDocument : null;
    if (inner === null) {
      throw new Error('no frame document');
    }
    inner.body.innerHTML = '<button>Inside</button>';

    const [found] = findClickables(page);
    // The top document cannot resolve it, so clicking has to search frames too.
    expect(page.querySelector(found?.selector ?? '')).toBeNull();
    expect(findAcrossFrames(page, found?.selector ?? '')).not.toBeNull();
  });

  it('carries the risk through', () => {
    const found = findClickables(pageWith('<button>Pay now</button><button>Search</button>'));

    expect(found.map((entry) => entry.risk)).toEqual(['destructive', 'safe']);
  });
});

describe('riskOf, controls that destroy a stored record', () => {
  function link(label: string): Element {
    const element = document.createElement('button');
    element.textContent = label;
    return element;
  }

  it('treats a bare Delete as destructive', () => {
    // Regression, ethniq.com: the sweep clicked the Delete beside a saved address on a live
    // account and deleted it. The list only covered "delete account".
    expect(riskOf(link('Delete'))).toBe('destructive');
    expect(riskOf(link('Delete address'))).toBe('destructive');
  });

  it('treats removing a stored record as destructive', () => {
    expect(riskOf(link('Remove card'))).toBe('destructive');
    expect(riskOf(link('Remove this address'))).toBe('destructive');
  });

  it('still allows a reversible remove', () => {
    // Removing a cart line is an event the sheet wants tested, and it undoes itself.
    expect(riskOf(link('Remove from cart'))).toBe('safe');
    expect(riskOf(link('Remove filter'))).toBe('safe');
  });
});

describe('riskOf, removing a cart line', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('treats a bare bin icon inside the cart as safe', () => {
    // Regression: making a bare "Delete" destructive protected saved addresses but also blocked
    // `Remove from Cart`, which the sheet asks for and which undoes itself.
    document.body.innerHTML =
      '<div class="cart-line"><button aria-label="Delete">🗑</button></div>';
    const button = document.querySelector('button');
    if (button === null) throw new Error('no button');

    expect(riskOf(button)).toBe('safe');
  });

  it('treats removal wording as safe wherever it sits', () => {
    document.body.innerHTML = '<button>Remove from cart</button><button>Remove item</button>';
    const [first, second] = [...document.querySelectorAll('button')];
    if (first === undefined || second === undefined) throw new Error('missing');

    expect(riskOf(first)).toBe('safe');
    expect(riskOf(second)).toBe('safe');
  });

  it('still protects a saved address outside the cart', () => {
    document.body.innerHTML =
      '<div class="address-book"><button aria-label="Delete">🗑</button></div>';
    const button = document.querySelector('button');
    if (button === null) throw new Error('no button');

    expect(riskOf(button)).toBe('destructive');
  });
});

describe('findClickables and overlays', () => {
  /**
   * Built in the live document rather than a detached one: the fixed-position check reads computed
   * style, and a document made by `createHTMLDocument` has no window to compute against — the same
   * reason `isUsable` treats a viewless document as visible.
   */
  function overlayFlagFor(html: string): boolean | undefined {
    document.body.innerHTML = html;
    return findClickables(document).find((entry) => entry.label === 'Target')?.inOverlay;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('marks a control inside a dialog', () => {
    expect(overlayFlagFor('<div role="dialog"><button>Target</button></div>')).toBe(true);
  });

  it('marks a control inside a fixed-position drawer that carries no role', () => {
    expect(overlayFlagFor('<div style="position: fixed"><button>Target</button></div>')).toBe(true);
  });

  it('leaves an ordinary control alone', () => {
    expect(overlayFlagFor('<main><button>Target</button></main>')).toBe(false);
  });
});

describe('controls that close what they are in', () => {
  function only(html: string): boolean | undefined {
    document.body.innerHTML = html;
    return findClickables(document).find((entry) => entry.label !== 'Keep')?.dismisses;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it.each([
    '<button>×</button>',
    '<button>X</button>',
    '<button>Close</button>',
    '<button aria-label="Close">✕</button>',
    '<button data-dismiss="modal">Done</button>',
    '<button>No thanks</button>',
  ])('recognises %s as a dismiss', (html) => {
    expect(only(html)).toBe(true);
  });

  /** Whole-label matches only: these are ordinary controls that merely contain the word. */
  it.each([
    '<button>Close my account</button>',
    '<button>Cancel subscription</button>',
    '<button>Add to Cart</button>',
    '<button>Back to shopping and checkout</button>',
  ])('leaves %s alone', (html) => {
    expect(only(html)).toBe(false);
  });
});

describe('hitAt', () => {
  /** jsdom lays nothing out, so a box and the topmost element have to be supplied. */
  function laidOut(element: Element, topmost: Element): void {
    element.getBoundingClientRect = () => new DOMRect(10, 10, 80, 30);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => topmost,
    });
  }

  afterEach(() => {
    Reflect.deleteProperty(document, 'elementFromPoint');
  });

  it('reports what is drawn over the control, and that it is a dialog', () => {
    pageWith(
      '<button id="behind">Add</button>' +
        '<div role="dialog"><div id="cover">Remove Item</div></div>',
    );
    const behind = document.getElementById('behind');
    const cover = document.getElementById('cover');
    if (behind === null || cover === null) {
      throw new Error('fixture missing');
    }
    laidOut(behind, cover);

    expect(hitAt(behind)).toEqual({ kind: 'covered', by: 'div "Remove Item" (in a dialog)' });
  });

  it('counts a hit on the control’s own contents as reaching it', () => {
    const button = only('<button><span>Add</span></button>');
    const inner = button.firstElementChild;
    if (inner === null) {
      throw new Error('fixture missing');
    }
    laidOut(button, inner);

    expect(hitAt(button)).toEqual({ kind: 'self' });
  });

  it('says a control that takes up no space could not be pressed', () => {
    expect(hitAt(only('<button>Add</button>'))).toEqual({ kind: 'no-size' });
  });

  it('treats an icon drawn beside the control, over it, as part of the control', () => {
    pageWith('<div class="row"><button id="x"></button><svg id="icon"></svg></div>');
    const button = document.getElementById('x');
    const icon = document.getElementById('icon');
    if (button === null || icon === null) {
      throw new Error('fixture missing');
    }
    laidOut(button, icon);

    expect(hitAt(button)).toEqual({ kind: 'decoration', by: 'svg "svg"' });
    expect(blocksClick(hitAt(button))).toBe(false);
  });

  it('does not excuse a menu from elsewhere in the page as decoration', () => {
    pageWith(
      '<main><section><div><button id="bag">Bag</button></div></section></main>' +
        '<nav><ul><li id="women">Women</li></ul></nav>',
    );
    const bag = document.getElementById('bag');
    const women = document.getElementById('women');
    if (bag === null || women === null) {
      throw new Error('fixture missing');
    }
    laidOut(bag, women);

    expect(hitAt(bag)).toEqual({ kind: 'covered', by: 'li "Women"' });
    expect(blocksClick(hitAt(bag))).toBe(true);
  });
});

describe('describeFrames', () => {
  it('lists every iframe element, including ones with no src', () => {
    pageWith('<iframe src="https://widgets.test/dialog"></iframe><iframe srcdoc="<p>x</p>"></iframe>');

    expect(describeFrames(document).map((frame) => frame.source)).toEqual([
      'https://widgets.test/dialog',
      'srcdoc',
    ]);
  });
});

describe('controlsInShadow', () => {
  it('counts buttons a page hides in shadow DOM, which the listing cannot see', () => {
    pageWith('<div id="host"></div>');
    const host = document.getElementById('host');
    if (host === null) {
      throw new Error('fixture missing');
    }
    host.attachShadow({ mode: 'open' }).innerHTML = '<button>Remove</button><button>Move</button>';

    expect(controlsInShadow(document)).toBe(2);
    expect(findClickables(document).map((entry) => entry.label)).not.toContain('Remove');
  });
});

describe('blocksClick', () => {
  it('refuses a control still off-screen after scrolling to it', () => {
    expect(blocksClick({ kind: 'off-screen' })).toBe(true);
    expect(blocksClick({ kind: 'decoration', by: 'svg "svg"' })).toBe(false);
    expect(blocksClick({ kind: 'self' })).toBe(false);
  });
});

describe('findClickables on controls made clickable by script', () => {
  /** The Fynd "Remove Item" dialog as served, reduced to its structure and the styles that matter. */
  const DIALOG =
    '<style>.EuGuC{position:fixed}.V2ufu,.wWPBB,.Iwkzi,.card{cursor:pointer}.card span{cursor:pointer}</style>' +
    '<div class="EuGuC"><div class="W3hX9"><div><div>Remove Item</div>' +
    '<div>Are your sure you want to remove this item?</div></div>' +
    '<div class="V2ufu"><svg width="21" height="20"></svg></div></div>' +
    '<div class="dYdRJ"><div class="wWPBB">REMOVE</div><div class="Iwkzi">MOVE TO WISHLIST</div></div></div>';

  it('lists bare divs a visitor is shown as clickable', () => {
    const labels = findClickables(pageWith(DIALOG)).map((entry) => entry.label);

    expect(labels).toEqual(expect.arrayContaining(['REMOVE', 'MOVE TO WISHLIST']));
    expect(labels).not.toContain('Remove Item');
  });

  it('treats an overlay’s icon-only X as the thing that closes it, so it goes last', () => {
    const found = findClickables(pageWith(DIALOG));

    expect(found.filter((entry) => entry.dismisses === true).map((entry) => entry.selector)).toHaveLength(1);
    expect(found.find((entry) => entry.label === 'REMOVE')?.dismisses).toBe(false);
  });

  it('lists a clickable card once, not once per child that inherits its cursor', () => {
    const labels = findClickables(
      pageWith('<style>.card,.card span{cursor:pointer}</style><div class="card"><span>Polo</span></div>'),
    ).map((entry) => entry.label);

    expect(labels).toEqual(['Polo']);
  });

  it('leaves a wrapper around a real control to the control', () => {
    const found = findClickables(
      pageWith('<style>.tile{cursor:pointer}</style><div class="tile"><button>Add</button></div>'),
    );

    expect(found.map((entry) => entry.label)).toEqual(['Add']);
  });
});

describe('noticesIn', () => {
  it('reads what a toast says, once, from the innermost element that says it', () => {
    pageWith(
      '<div class="Toastify__toast-container"><div class="Toastify__toast" role="alert">' +
        'This item is   unavailable</div></div><div role="status">Added to bag</div>',
    );

    expect(noticesIn(document)).toEqual(['This item is unavailable', 'Added to bag']);
  });

  it('ignores hidden regions and anything too long to be a message', () => {
    pageWith(
      `<div role="alert" style="display:none">Hidden</div><div aria-live="polite">${'x'.repeat(200)}</div>`,
    );

    expect(noticesIn(document)).toEqual([]);
  });
});
