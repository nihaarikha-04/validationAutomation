import { describe, expect, it } from 'vitest';
import { subIntentsFrom, type SubIntent } from './sub-intents';

/** Compact rendering, so a test reads roughly the way the client's sentence does. */
function asText(prose: string): readonly string[] {
  return subIntentsFrom(prose).map((intent: SubIntent) => {
    switch (intent.kind) {
      case 'fill':
        return `fill ${intent.target} = ${intent.value}`;
      case 'ask':
        return `ask ${intent.target} for ${intent.valueKind}`;
      case 'navigate':
        return `navigate ${intent.value}`;
      default:
        return `${intent.kind} ${intent.target}`;
    }
  });
}

/**
 * Every sentence below is from a real client sheet (levisons.co.za). They are instructions — a
 * verb, a thing, in order — and the only description of the action anybody wrote down.
 */
describe('subIntentsFrom', () => {
  it('reads a three-part search instruction', () => {
    expect(
      asText(
        "Click the search icon in the header, type a keyword (e.g. 'jacket'), then press Enter or click the search button.",
      ),
    ).toEqual(['click search', 'fill keyword = jacket', 'click Enter']);
  });

  it('drops the part that sets the scene rather than asking for anything', () => {
    expect(
      asText(
        "From the home page, click any category link in the top navigation (e.g. 'Women', 'Men', 'Accessories').",
      ),
    ).toEqual(['click Women']);
  });

  it('reads a single instruction', () => {
    expect(asText('On a product detail page, click the wishlist / heart icon.')).toEqual([
      'click wishlist',
    ]);
  });

  it('takes a quoted name exactly', () => {
    expect(asText("While logged in, click the Account icon, then click 'Logout'.")).toEqual([
      'click Account',
      'click Logout',
    ]);
  });

  it('reads a numbered list as steps in order', () => {
    expect(asText('1. Click Sign Up. 2. Fill in Pincode. 3. Click Submit.')).toEqual([
      'click Sign Up',
      'ask Pincode for address',
      'click Submit',
    ]);
  });

  describe('values only a person can give', () => {
    it('turns personal details into pauses rather than guesses', () => {
      const steps = asText(
        'Click the Account/Login icon. Enter the registered Email or Mobile number, request the OTP, then click Login.',
      );

      expect(steps).toContain('ask registered Email for email');
      expect(steps.some((step) => step.includes('for otp'))).toBe(true);
    });

    it('never invents a password', () => {
      expect(asText('Enter the password, then click Submit.')[0]).toBe(
        'ask password for password',
      );
    });

    it('asks for an upload rather than skipping it', () => {
      expect(asText('Enter the PAN card document.')[0]).toBe('ask PAN card document for file');
    });

    /** The sheet supplied "jacket"; asking a person for it would be absurd. */
    it('uses the value the sentence already gave', () => {
      expect(asText("Type a keyword (e.g. 'jacket')")).toEqual(['fill keyword = jacket']);
    });
  });

  describe('what is not part of a control’s name', () => {
    it.each([
      ['Click the search icon', 'click search'],
      ['Click the search button', 'click search'],
      ['Click the Account icon', 'click Account'],
      ['Open the cart page', 'click cart'],
    ])('reads "%s" as %s', (prose, expected) => {
      expect(asText(prose)).toEqual([expected]);
    });

    /** A step aimed at "icon" is worse than no step, so the noun goes only if a name is left. */
    it('drops a clause that is nothing but the kind of control', () => {
      expect(asText('Click the icon.')).toEqual([]);
    });

    it('stops at an alternative rather than targeting both', () => {
      expect(asText('press Enter or click the search button')).toEqual(['click Enter']);
    });

    it('drops a conditional tail', () => {
      expect(asText('select size and color if one is required')).toEqual([
        'select size and color',
      ]);
    });
  });

  describe('splitting', () => {
    /** "size and color" is one instruction; splitting it clicks the word "color". */
    it('does not split on a bare and', () => {
      expect(asText('select size and color')).toHaveLength(1);
    });

    /** Splitting at the stop in "e.g." lost the value the sheet had already supplied. */
    it('does not split inside an abbreviation', () => {
      expect(asText("Type a keyword (e.g. 'jacket')")).toHaveLength(1);
    });
  });

  describe('clauses that ask for nothing', () => {
    it('says nothing about a backend event', () => {
      expect(
        asText('BACKEND / SHOPIFY WEBHOOK — does not fire from any storefront click.'),
      ).toEqual([]);
    });

    it('says nothing about an empty cell', () => {
      expect(subIntentsFrom('')).toEqual([]);
    });

    it('says nothing about a description of when something happens', () => {
      expect(
        asText('Fires automatically when the cart page loads with at least one item in it.'),
      ).toEqual([]);
    });

    /** "Go to the site" names no address — scene-setting with a verb in front of it. */
    it('does not treat a vague go-to as navigation', () => {
      expect(asText('Go to the site')).toEqual([]);
    });
  });

  it('reads a real path as navigation', () => {
    expect(asText('Go to /refer-a-friend')).toEqual(['navigate /refer-a-friend']);
  });

  it('keeps the client’s own clause, so a failure can quote them', () => {
    const [first] = subIntentsFrom('On a product detail page, click the wishlist icon.');

    expect(first?.source).toBe('click the wishlist icon');
  });
});
