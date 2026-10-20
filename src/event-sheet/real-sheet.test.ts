import { describe, expect, it } from 'vitest';
import { subIntentsFrom } from './sub-intents';

/**
 * The Levison's sheet's trigger column, verbatim, read end to end.
 *
 * Not a unit test of any one rule — a check that the sentences a real client actually wrote come
 * out as something a run could act on, and that the ones which ask for nothing stay empty.
 */
const SHEET: readonly { readonly event: string; readonly prose: string }[] = [
  {
    event: 'Sign out',
    prose: "While logged in, click the Account icon, then click 'Logout'.",
  },
  {
    event: 'Product Search',
    prose:
      "Click the search icon in the header, type a keyword (e.g. 'jacket'), then press Enter or click the search button.",
  },
  {
    event: 'Category Viewed',
    prose:
      "From the home page, click any category link in the top navigation (e.g. 'Women', 'Men', 'Accessories').",
  },
  {
    event: 'Add to wishlist',
    prose: 'On a product detail page, click the wishlist / heart icon.',
  },
  {
    event: 'Checkout',
    prose: "From the cart page, click 'Checkout' / 'Proceed to Checkout'.",
  },
  {
    event: 'Sign in',
    prose:
      "Click the Account/Login icon. Enter the registered Email or Mobile number, request the OTP (or enter the password, depending on which login method is enabled on the account), then click 'Login' / 'Verify'.",
  },
  {
    event: 'order cancelled',
    prose:
      'BACKEND / SHOPIFY WEBHOOK — does not fire from any storefront click. To reproduce, cancel a test order from the Shopify/store admin panel, not from the website itself.',
  },
];

describe('the Levison’s trigger column, read whole', () => {
  it.each(SHEET.filter((row) => row.event !== 'order cancelled'))(
    'gets something runnable out of $event',
    ({ prose }) => {
      const intents = subIntentsFrom(prose);

      expect(intents.length).toBeGreaterThan(0);
      // Every intent names something. An intent with an empty target is worse than no intent.
      for (const intent of intents) {
        expect(intent.target).not.toBe('');
      }
    },
  );

  /** A backend webhook asks for nothing, and inventing steps for it sends a tester nowhere. */
  it('gets nothing out of an event that cannot come from a browser', () => {
    const webhook = SHEET.find((row) => row.event === 'order cancelled');
    if (webhook === undefined) throw new Error('fixture');

    expect(subIntentsFrom(webhook.prose)).toEqual([]);
  });

  it('reads Sign in as a flow that pauses for the person twice', () => {
    const signIn = SHEET.find((row) => row.event === 'Sign in');
    if (signIn === undefined) throw new Error('fixture');

    const kinds = subIntentsFrom(signIn.prose).map((intent) => intent.valueKind);

    expect(kinds).toContain('email');
    expect(kinds).toContain('otp');
  });
});
