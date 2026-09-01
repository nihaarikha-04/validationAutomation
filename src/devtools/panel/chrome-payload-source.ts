import {
  isCaptureMessage,
  isStatsMessage,
  type CaptureStats,
  type CapturedPayload,
  type PayloadSource,
} from '../../shared/payload';

/**
 * Receives captured payloads forwarded by the content-script bridge.
 *
 * Runtime messages reach every extension context that listens, so this filters on the sender's
 * tab: a panel must only ever show payloads from the page it is inspecting.
 */
export function createChromePayloadSource(): PayloadSource {
  return {
    subscribe(listener: (payload: CapturedPayload) => void): () => void {
      const handler = (message: unknown, sender: chrome.runtime.MessageSender): void => {
        if (sender.tab?.id !== chrome.devtools.inspectedWindow.tabId) {
          return;
        }
        if (!isCaptureMessage(message)) {
          return;
        }
        listener(message.payload);
      };

      chrome.runtime.onMessage.addListener(handler);
      return () => {
        chrome.runtime.onMessage.removeListener(handler);
      };
    },

    subscribeStats(listener: (stats: CaptureStats) => void): () => void {
      const handler = (message: unknown, sender: chrome.runtime.MessageSender): void => {
        if (sender.tab?.id !== chrome.devtools.inspectedWindow.tabId) {
          return;
        }
        if (isStatsMessage(message)) {
          listener(message.stats);
        }
      };

      chrome.runtime.onMessage.addListener(handler);
      return () => {
        chrome.runtime.onMessage.removeListener(handler);
      };
    },
  };
}
