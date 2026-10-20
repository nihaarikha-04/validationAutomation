import { describe, expect, it } from 'vitest';
import { resolveTarget } from './find-target';

function page(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

/** Gives one element a real size, so the on-screen rule has something to prefer. */
function size(selector: string, width = 24, height = 24): void {
  const element = document.querySelector(selector);
  if (element === null) throw new Error(`fixture: ${selector}`);
  element.getBoundingClientRect = () => ({ width, height }) as DOMRect;
}

describe('resolveTarget', () => {
  it('finds a button by its own words', () => {
    const resolved = resolveTarget(page('<button>Add to Cart</button>'), 'Add to Cart');

    expect(resolved.kind).toBe('found');
    if (resolved.kind !== 'found') return;
    expect(resolved.match.label).toBe('Add to Cart');
  });

  /**
   * The live failure this exists for: the sheet says "the search icon", and an icon button has no
   * visible words at all. Its `aria-label` is the only thing naming it.
   */
  it('finds a control that has a label but no words', () => {
    expect(resolveTarget(page('<button aria-label="Search">🔍</button>'), 'Search').kind).toBe(
      'found',
    );
  });

  it.each([
    ['a placeholder', '<input placeholder="Mobile number">'],
    ['a title', '<button title="Logout"></button>'],
    ['a name', '<input name="Logout">'],
    ['a wrapping label', '<label>Logout<input></label>'],
    ['an associated label', '<label for="x">Logout</label><input id="x">'],
  ])('finds a control named by %s', (_how, html) => {
    const wanted = html.includes('Mobile') ? 'Mobile number' : 'Logout';

    expect(resolveTarget(page(html), wanted).kind).toBe('found');
  });

  it('is case- and punctuation-insensitive', () => {
    expect(resolveTarget(page('<button>CHECK ELIGIBILITY!</button>'), 'Check eligibility').kind).toBe(
      'found',
    );
  });

  it('says nothing was found rather than inventing something', () => {
    expect(resolveTarget(page('<button>Add to Cart</button>'), 'Logout')).toEqual({ kind: 'none' });
  });

  it('says nothing was found for an empty name', () => {
    expect(resolveTarget(page('<button>Add to Cart</button>'), '  ')).toEqual({ kind: 'none' });
  });

  /**
   * A page carrying both "Apply" and "Apply for a loan" makes every containment match ambiguous,
   * and neither could be targeted at all.
   */
  it('takes an exact match over a longer one that merely contains it', () => {
    const resolved = resolveTarget(
      page('<button>Apply</button><button>Apply for a loan</button>'),
      'Apply',
    );

    expect(resolved.kind).toBe('found');
    if (resolved.kind !== 'found') return;
    expect(resolved.match.label).toBe('Apply');
  });

  it('falls back to containment when nothing matches exactly', () => {
    const resolved = resolveTarget(page('<button>Apply for a loan</button>'), 'Apply');

    expect(resolved.kind).toBe('found');
  });

  describe('narrowing several matches', () => {
    it('prefers the control over a wrapper that merely describes it', () => {
      const resolved = resolveTarget(
        page('<div aria-label="search"><button aria-label="search">go</button></div>'),
        'search',
      );

      expect(resolved.kind).toBe('found');
    });

    it('prefers the innermost when both are controls', () => {
      const resolved = resolveTarget(
        page('<a href="/s" aria-label="search"><button aria-label="search">go</button></a>'),
        'search',
      );

      expect(resolved.kind).toBe('found');
    });

    /**
     * A responsive site carries a mobile header and a desktop header in the same document and
     * shows one. `display` and `visibility` cannot see this; a measurement can.
     */
    it('prefers the one that occupies space', () => {
      const root = page(
        '<button id="mobile" aria-label="search">a</button>' +
          '<button id="desktop" aria-label="search">b</button>',
      );
      size('#desktop');

      expect(resolveTarget(root, 'search').kind).toBe('found');
    });

    /** Every element measures 0×0 in a headless DOM, so the rule must skip itself there. */
    it('ignores size entirely when nothing has any', () => {
      expect(resolveTarget(page('<button aria-label="search">x</button>'), 'search').kind).toBe(
        'found',
      );
    });

    /** Two interchangeable controls are a question for a person, not a coin toss. */
    it('stays ambiguous when two real controls are side by side', () => {
      const resolved = resolveTarget(
        page('<button aria-label="search">a</button><button aria-label="search">b</button>'),
        'search',
      );

      expect(resolved.kind).toBe('ambiguous');
      if (resolved.kind !== 'ambiguous') return;
      expect(resolved.count).toBe(2);
    });

    /** Three identical words say nothing about why they competed; the tags say it at a glance. */
    it('names the competing matches with their tags', () => {
      const resolved = resolveTarget(
        page('<button aria-label="search">a</button><button aria-label="search">b</button>'),
        'search',
      );

      expect(resolved.kind).toBe('ambiguous');
      if (resolved.kind !== 'ambiguous') return;
      expect(resolved.describing[0]).toBe('button "search"');
    });
  });

  describe('what is never a target', () => {
    /** A label's whole job is to name a different element, so it competes with the field. */
    it('never matches a label element itself', () => {
      const resolved = resolveTarget(page('<label for="x">Logout</label><input id="x">'), 'Logout');

      expect(resolved.kind).toBe('found');
      if (resolved.kind !== 'found') return;
      expect(resolved.match.selector).toContain('x');
    });

    it.each([
      ['hidden', '<button hidden>Logout</button>'],
      ['aria-hidden', '<button aria-hidden="true">Logout</button>'],
      ['display:none', '<button style="display:none">Logout</button>'],
    ])('never matches a control that is %s', (_how, html) => {
      expect(resolveTarget(page(html), 'Logout')).toEqual({ kind: 'none' });
    });
  });

  /** A report should be able to say what it is about to act on, before it acts. */
  it('reports what it matched and how risky acting on it is', () => {
    const resolved = resolveTarget(page('<button>Place order</button>'), 'Place order');

    expect(resolved.kind).toBe('found');
    if (resolved.kind !== 'found') return;
    expect(resolved.match.risk).toBe('destructive');
  });
});
