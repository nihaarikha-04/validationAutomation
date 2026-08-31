import { rank } from '../detect-action';
import { selectorFor } from '../selector';
import { STRATEGY_CONFIDENCE, type ActionCandidate, type ActionIntent } from '../types';

/**
 * A platform adapter contributes selectors it knows are right for that storefront, plus a way
 * to recognise the storefront.
 *
 * The plan named five `findX` methods. Each would have been a one-line forward to the same
 * lookup with a different selector list — a wrapper by any measure — so the adapter exposes the
 * selectors directly and one shared function does the finding. Same capability, no ceremony.
 */
export interface PlatformAdapter {
  readonly name: string;
  detect(document: Document): boolean;
  readonly selectors: Readonly<Record<ActionIntent, readonly string[]>>;
}

const NO_SELECTORS: Readonly<Record<ActionIntent, readonly string[]>> = {
  product: [],
  'add-to-cart': [],
  cart: [],
  'remove-from-cart': [],
  checkout: [],
};

/** The fallback. Recognises everything and knows nothing, so generic strategies decide. */
export const genericAdapter: PlatformAdapter = {
  name: 'generic',
  detect: () => true,
  selectors: NO_SELECTORS,
};

export const shopifyAdapter: PlatformAdapter = {
  name: 'shopify',
  detect: (document) =>
    document.querySelector('meta[name="shopify-digital-wallet"]') !== null ||
    document.querySelector('[data-shopify]') !== null ||
    document.querySelector('script[src*="cdn.shopify.com"]') !== null,
  selectors: {
    product: ['a[href*="/products/"]'],
    'add-to-cart': [
      'form[action*="/cart/add"] [type="submit"]',
      'button[name="add"]',
      '.product-form__submit',
    ],
    cart: ['a[href$="/cart"]', 'form[action$="/cart"] [type="submit"]'],
    'remove-from-cart': ['a[href*="/cart/change"]', '[data-cart-remove]'],
    checkout: ['button[name="checkout"]', 'input[name="checkout"]', 'a[href*="/checkout"]'],
  },
};

export const magentoAdapter: PlatformAdapter = {
  name: 'magento',
  detect: (document) =>
    document.querySelector('[data-mage-init]') !== null ||
    document.body?.classList.contains('catalog-product-view') === true ||
    document.querySelector('script[src*="/mage/"]') !== null,
  selectors: {
    product: ['a.product-item-link'],
    'add-to-cart': ['#product-addtocart-button', 'button.tocart', '[data-role="tocart"]'],
    cart: ['a.showcart', 'a[href*="checkout/cart"]'],
    'remove-from-cart': ['a.action-delete', '[data-role="delete"]'],
    checkout: ['button[data-role="proceed-to-checkout"]', 'a[href*="checkout/onepage"]'],
  },
};

/** Specific platforms are tried before the generic fallback, which always matches. */
export const ADAPTERS: readonly PlatformAdapter[] = [
  shopifyAdapter,
  magentoAdapter,
  genericAdapter,
];

export function detectPlatform(document: Document): PlatformAdapter {
  return ADAPTERS.find((adapter) => adapter.detect(document)) ?? genericAdapter;
}

/** Candidates from the adapter's own selectors, scored as platform evidence. */
export function findByPlatform(
  document: Document,
  adapter: PlatformAdapter,
  intent: ActionIntent,
): readonly ActionCandidate[] {
  const found = adapter.selectors[intent].flatMap((selector) =>
    [...document.querySelectorAll(selector)].map((element) => ({
      selector: selectorFor(element),
      label: (element.textContent ?? '').trim() === ''
        ? `${adapter.name}: ${selector}`
        : (element.textContent ?? '').trim(),
      strategy: 'platform' as const,
      confidence: STRATEGY_CONFIDENCE.platform,
    })),
  );

  return rank(found);
}
