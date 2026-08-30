import type { EvaluationOutcome, PageEvaluator } from '../../shared/sdk';

/**
 * Adapts chrome.devtools.inspectedWindow.eval — a callback API that reports failures on a
 * second argument rather than by throwing — to the promise-and-outcome shape the detection
 * logic expects. This is the only file in the panel that touches chrome.*.
 *
 * eval runs in the inspected page's own world, which is why Phase 1 needs no permissions
 * and no content script.
 */
export function createChromePageEvaluator(): PageEvaluator {
  return {
    evaluate(expression: string): Promise<EvaluationOutcome> {
      return new Promise((resolve) => {
        chrome.devtools.inspectedWindow.eval(expression, (result, exceptionInfo) => {
          if (exceptionInfo !== undefined && (exceptionInfo.isError || exceptionInfo.isException)) {
            resolve({ kind: 'error', message: describeException(exceptionInfo) });
            return;
          }
          resolve({ kind: 'value', value: result });
        });
      });
    },
  };
}

function describeException(info: {
  readonly isError?: boolean;
  readonly isException?: boolean;
  readonly value?: string;
  readonly description?: string;
  readonly code?: string;
}): string {
  if (info.isException === true && info.value !== undefined) {
    return info.value;
  }
  return info.description ?? info.code ?? 'The page could not be evaluated.';
}
