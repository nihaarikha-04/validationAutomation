import type { AutomationCommand, AutomationReply, PageDriver } from '../../automation/commands';

/**
 * Sends automation commands to the content script in the inspected tab.
 *
 * Translates Chrome's callback-and-lastError convention into a reply the run logic can branch
 * on — most usefully, "the content script is not there", which happens whenever the page has
 * not been reloaded since the extension was installed.
 */
export function createChromePageDriver(): PageDriver {
  return {
    send(command: AutomationCommand): Promise<AutomationReply> {
      return new Promise((resolve) => {
        chrome.tabs.sendMessage(
          chrome.devtools.inspectedWindow.tabId,
          command,
          (reply: AutomationReply | undefined) => {
            const failure = chrome.runtime.lastError;
            if (failure !== undefined) {
              resolve({
                kind: 'error',
                message: `${failure.message ?? 'No response from the page.'} Reload the page and try again.`,
              });
              return;
            }
            resolve(reply ?? { kind: 'error', message: 'The page returned nothing.' });
          },
        );
      });
    },
  };
}
