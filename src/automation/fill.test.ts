import { afterEach, describe, expect, it } from 'vitest';
import { formNeeds } from './fill';

function pageWith(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

afterEach(() => {
  document.body.innerHTML = '';
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
