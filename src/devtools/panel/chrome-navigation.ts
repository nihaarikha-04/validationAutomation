/** Tells the panel when the inspected page becomes a different page. */
export interface NavigationSource {
  subscribe(listener: (url: string) => void): () => void;
}

/**
 * DevTools reports navigations of the tab it is attached to, with no extra permission.
 *
 * This is what lets a sweep pick up wherever browsing goes next, rather than needing to be
 * started again by hand on every page.
 */
export function createChromeNavigationSource(): NavigationSource {
  return {
    subscribe(listener: (url: string) => void): () => void {
      const handler = (url: string): void => {
        listener(url);
      };

      chrome.devtools.network.onNavigated.addListener(handler);
      return () => {
        chrome.devtools.network.onNavigated.removeListener(handler);
      };
    },
  };
}
