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
      /**
       * The latest report from each frame, because the manifest injects into all of them.
       *
       * Every frame reports every two seconds, so passing each message straight through meant the
       * panel showed whichever frame happened to report last — an idle ad or payment iframe
       * overwriting the main frame with "Watched 0 console lines" while capture was working
       * normally. Summing across frames is the only number that describes the page.
       */
      const byFrame = new Map<number, CaptureStats>();

      const handler = (message: unknown, sender: chrome.runtime.MessageSender): void => {
        if (sender.tab?.id !== chrome.devtools.inspectedWindow.tabId) {
          return;
        }
        if (!isStatsMessage(message)) {
          return;
        }

        byFrame.set(sender.frameId ?? 0, message.stats);

        const frames = [...byFrame.values()];
        listener({
          seen: frames.reduce((total, frame) => total + frame.seen, 0),
          matched: frames.reduce((total, frame) => total + frame.matched, 0),
          // Only frames that matched nothing have anything to explain; a frame that is capturing
          // fine contributes noise, not evidence.
          recent: frames.filter((frame) => frame.matched === 0).flatMap((frame) => frame.recent),
        });
      };

      chrome.runtime.onMessage.addListener(handler);
      return () => {
        chrome.runtime.onMessage.removeListener(handler);
      };
    },
  };
}
