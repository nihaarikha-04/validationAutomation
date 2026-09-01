import { afterEach, describe, expect, it } from 'vitest';
import { fillFields, formatFieldRules, formNeeds, parseFieldRules, type FieldRule } from './fill';

function pageWith(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

afterEach(() => {
  document.body.innerHTML = '';
});

const RULES: readonly FieldRule[] = [
  { match: 'search', value: 'shoes' },
  { match: 'phone', value: '9876543210' },
];

describe('fillFields', () => {
  it('fills a field by its name', () => {
    const page = pageWith('<input name="search">');

    expect(fillFields(page, RULES)).toBe(1);
    expect(page.querySelector('input')?.value).toBe('shoes');
  });

  it('fills a field by its placeholder', () => {
    const page = pageWith('<input placeholder="Search products">');

    fillFields(page, RULES);
    expect(page.querySelector('input')?.value).toBe('shoes');
  });

  it('fills a field by its aria-label', () => {
    const page = pageWith('<input aria-label="Phone number">');

    fillFields(page, RULES);
    expect(page.querySelector('input')?.value).toBe('9876543210');
  });

  it('leaves a field the user already filled alone', () => {
    const page = pageWith('<input name="search" value="already here">');

    expect(fillFields(page, RULES)).toBe(0);
    expect(page.querySelector('input')?.value).toBe('already here');
  });

  it('never fills a password', () => {
    // Filling one and submitting is how a sweep signs itself into a real account.
    const page = pageWith('<input type="password" name="search">');

    expect(fillFields(page, RULES)).toBe(0);
  });

  it('skips hidden and disabled fields', () => {
    expect(fillFields(pageWith('<input name="search" style="display:none">'), RULES)).toBe(0);
    expect(fillFields(pageWith('<input name="search" disabled>'), RULES)).toBe(0);
  });

  it('leaves fields no rule describes', () => {
    expect(fillFields(pageWith('<input name="coupon">'), RULES)).toBe(0);
  });

  it('tells the page the value changed', () => {
    const page = pageWith('<input name="search">');
    const field = page.querySelector('input');
    const seen: string[] = [];
    field?.addEventListener('input', () => seen.push('input'));
    field?.addEventListener('change', () => seen.push('change'));

    fillFields(page, RULES);

    // A plain assignment is ignored by frameworks that track their own value.
    expect(seen).toEqual(['input', 'change']);
  });

  it('chooses a real option in a select', () => {
    const page = pageWith(
      '<select name="search"><option value="">Pick</option><option value="a">A</option></select>',
    );

    fillFields(page, RULES);
    expect(page.querySelector('select')?.value).toBe('a');
  });
});

describe('formNeeds', () => {
  function control(html: string): Element {
    const page = pageWith(html);
    const found = page.querySelector('[data-target]');
    if (found === null) {
      throw new Error('no control');
    }
    return found;
  }

  it('names the empty fields a submit would leave blank', () => {
    const needs = formNeeds(
      control(
        '<form><input placeholder="Phone number"><input placeholder="OTP">' +
          '<button data-target type="submit">Verify</button></form>',
      ),
    );

    // A tester cannot list these in advance; every site asks for something different.
    expect(needs.isSubmit).toBe(true);
    expect(needs.fields).toEqual(['Phone number', 'OTP']);
  });

  it('does not ask about a form that is already filled in', () => {
    const needs = formNeeds(
      control('<form><input placeholder="Phone" value="123"><button data-target>Go</button></form>'),
    );

    expect(needs.fields).toEqual([]);
  });

  it('recognises a submit by its wording, outside a form', () => {
    expect(formNeeds(control('<div><input placeholder="Search"><button data-target>Search</button></div>')).isSubmit).toBe(true);
  });

  it('does not treat an ordinary control as a submit', () => {
    expect(formNeeds(control('<div><button data-target>Close</button></div>')).isSubmit).toBe(false);
  });
});

describe('parseFieldRules', () => {
  it('reads the panel\'s lines', () => {
    expect(parseFieldRules('search: shoes\nphone: 12345')).toEqual([
      { match: 'search', value: 'shoes' },
      { match: 'phone', value: '12345' },
    ]);
  });

  it('ignores blank and malformed lines', () => {
    expect(parseFieldRules('\n  \nnonsense\nsearch: shoes')).toEqual([
      { match: 'search', value: 'shoes' },
    ]);
  });

  it('keeps colons inside the value', () => {
    expect(parseFieldRules('url: https://example.com')).toEqual([
      { match: 'url', value: 'https://example.com' },
    ]);
  });

  it('round-trips', () => {
    expect(parseFieldRules(formatFieldRules(RULES))).toEqual(RULES);
  });
});

describe('forms not worth stopping for', () => {
  function scope(html: string): Element {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.append(host);
    const control = host.querySelector('button');
    if (control === null) {
      throw new Error('the fixture needs a button');
    }
    return control;
  }

  /**
   * The cart drawer that blocked a live run: an Apply button beside an optional DISCOUNT CODE
   * box stopped the sweep on every cart, before any of the drawer's own controls were clicked.
   */
  it('does not stop for a discount code', () => {
    const needs = formNeeds(
      scope('<input placeholder="DISCOUNT CODE" /><button>Apply</button>'),
    );

    expect(needs.fields).toEqual([]);
  });

  it('still stops for a field the page marks required', () => {
    const needs = formNeeds(
      scope('<input required placeholder="OTP" /><button type="submit">Verify</button>'),
    );

    expect(needs.fields).toEqual(['OTP']);
  });

  /** Where something is required, the optional boxes beside it are noise. */
  it('names only the required fields when the page marks any', () => {
    const needs = formNeeds(
      scope(
        '<input required placeholder="Phone number" /><input placeholder="Coupon" /><button type="submit">Continue</button>',
      ),
    );

    expect(needs.fields).toEqual(['Phone number']);
  });

  /** Plenty of sites mark nothing required, and an address form still has to stop the run. */
  it('falls back to every blank field when the page marks nothing', () => {
    const needs = formNeeds(
      scope('<input placeholder="Pincode" /><button type="submit">Save address</button>'),
    );

    expect(needs.fields).toEqual(['Pincode']);
  });
});
