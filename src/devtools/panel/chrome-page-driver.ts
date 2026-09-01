import type {
  AutomationCommand,
  AutomationReply,
  FrameReply,
  KnownFrame,
  PageDriver,
} from '../../automation/commands';
import { HELLO_MARKER } from '../../shared/payload';

/** A reply must always arrive; a hung command otherwise stalls the run until its stage times out. */
const REPLY_TIMEOUT_MS = 3_000;

/** A click that navigates tears down the content script; the new page re-injects it shortly after. */
const RETRY_DELAY_MS = 750;

const TRANSIENT = /receiving end does not exist|message channel closed|no reply/i;

/** Long enough for every frame on a page to answer a broadcast. */
const FRAME_DISCOVERY_MS = 250;

/**
 * Sends automation commands to the content script in the inspected tab.
 *
 * Translates Chrome's callback-and-lastError convention into a reply the run logic can branch on,
 * and retries once when the failure looks like a page mid-navigation — observed live, where one
 * test's click navigated and every later command in the batch failed against a dead content script.
 */
export function createChromePageDriver(): PageDriver {
  // Frames announce themselves on load; the id arrives on the sender, which is the only way a
  // panel can learn to address a frame without the webNavigation permission.
  const frames = new Map<number, string>([[0, 'top frame']]);

  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.tab?.id !== chrome.devtools.inspectedWindow.tabId) {
      return;
    }
    const hello = message as { marker?: unknown; url?: unknown } | null;
    if (hello?.marker === HELLO_MARKER) {
      frames.set(sender.frameId ?? 0, typeof hello.url === 'string' ? hello.url : 'unknown');
    }
  });

  return {
    async sendTo(frameId: number, command: AutomationCommand): Promise<AutomationReply> {
      return sendOnce(command, frameId);
    },

    knownFrames(): readonly KnownFrame[] {
      return [...frames].map(([frameId, url]) => ({ frameId, url }));
    },

    /** Every frame answers for itself; one reply could only ever describe one document. */
    async sendAll(command: AutomationCommand): Promise<readonly FrameReply[]> {
      await discoverFrames();

      const replies = await Promise.all(
        [...frames.keys()].map(async (frameId) => ({
          frameId,
          reply: await sendOnce(command, frameId),
        })),
      );

      // A frame that has gone is not an error worth reporting; it simply contributes nothing.
      return replies.filter((entry) => entry.reply.kind !== 'error');
    },

    async send(command: AutomationCommand): Promise<AutomationReply> {
      const first = await sendOnce(command);
      if (!(first.kind === 'error' && TRANSIENT.test(first.message))) {
        return first;
      }

      await delay(RETRY_DELAY_MS);
      const second = await sendOnce(command);
      if (second.kind === 'error' && TRANSIENT.test(second.message)) {
        return {
          kind: 'error',
          message: 'The page is not reachable — it may have navigated. Reload it and try again.',
        };
      }
      return second;
    },
  };
}

/**
 * Asks every frame to say who it is, then waits briefly for the answers.
 *
 * A frame's load-time announcement is missed whenever the page loaded before the panel opened —
 * which is most of the time — so relying on it alone left the driver knowing only the top frame.
 * The request goes to all frames at once; each replies with its own message, because a broadcast
 * `sendResponse` only ever delivers one answer.
 */
function discoverFrames(): Promise<void> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      chrome.devtools.inspectedWindow.tabId,
      { kind: 'announce' },
      () => {
        void chrome.runtime.lastError;
      },
    );
    setTimeout(resolve, FRAME_DISCOVERY_MS);
  });
}

function sendOnce(command: AutomationCommand, frameId = 0): Promise<AutomationReply> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reply: AutomationReply): void => {
      if (!settled) {
        settled = true;
        resolve(reply);
      }
    };

    // A picked element waits on a human, so that command is allowed to take as long as it likes.
    if (command.kind !== 'pick') {
      setTimeout(() => finish({ kind: 'error', message: 'No reply from the page.' }), REPLY_TIMEOUT_MS);
    }

    chrome.tabs.sendMessage(
      chrome.devtools.inspectedWindow.tabId,
      command,
      { frameId },
      (reply: AutomationReply | undefined) => {
        const failure = chrome.runtime.lastError;
        if (failure !== undefined) {
          finish({ kind: 'error', message: failure.message ?? 'No reply from the page.' });
          return;
        }
        finish(reply ?? { kind: 'error', message: 'The page returned nothing.' });
      },
    );
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
