/**
 * A segment that is nothing but an identifier: all digits, or a uuid or hash.
 *
 * Deliberately not "contains a digit" — that flattens `/page-2` and `/level-3` into one shape,
 * and they are ordinary distinct pages. A slug like `easy-peasy-gut` is not caught here either;
 * it is handled by collapsing the last segment instead, since no rule on the text alone tells a
 * product slug from a page name.
 */
const IDENTIFIER = /^\d+$|^[0-9a-f]{8,}(-[0-9a-f]{4,}){0,4}$/i;

/**
 * The kind of page a URL points at, rather than which one.
 *
 * `/products/easy-peasy-gut` and `/products/gut-shot` are the same kind of page: they run the same
 * template and fire the same events. A crawl that visits both learns nothing the second time, and a
 * storefront links to hundreds of them — which is how a run ends up firing `product_view` forty
 * times while events that never fired at all stay untested.
 *
 * Two collapses, and no more:
 *
 * 1. Any segment that looks like an identifier — `/order/48898902917371` → `/order/*`.
 * 2. The last segment of a path with more than one, since that is where a template puts the thing
 *    it is showing — `/products/easy-peasy-gut` → `/products/*`.
 *
 * The second is blunt on purpose: it also collapses `/profile/orders` and `/profile/settings`,
 * which are genuinely different pages. That is safe because a shape is never acted on until the
 * crawl has watched pages of that shape and found they produce nothing new — an over-broad shape
 * corrects itself, while a too-narrow one would never stop the repetition it exists to stop.
 *
 * Query **keys** are kept and values dropped, so `?tab=orders` and `?tab=profile` share a shape
 * while `/shop` and `/shop?page=2` do not collapse into the bare path.
 */
export function urlShape(url: string): string {
  const parsed = safeParse(url);
  if (parsed === undefined) {
    // Not a URL we can reason about. Its own text is the most specific shape available, which
    // means it is never mistaken for another page.
    return url;
  }

  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
  const shaped = segments.map((segment, index) => {
    if (IDENTIFIER.test(segment)) {
      return '*';
    }
    return segments.length > 1 && index === segments.length - 1 ? '*' : segment;
  });

  const keys = [...new Set([...parsed.searchParams.keys()])].sort();
  const query = keys.length === 0 ? '' : `?${keys.join('&')}`;

  return `/${shaped.join('/')}${query}`;
}

function safeParse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    // A malformed href is the page's problem, not ours.
    return undefined;
  }
}
