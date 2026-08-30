export type EvaluationOutcome =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'error'; readonly message: string };

/** Runs an expression in the inspected page. Implemented by the panel against chrome.*. */
export interface PageEvaluator {
  evaluate(expression: string): Promise<EvaluationOutcome>;
}

export type Wait = (milliseconds: number) => Promise<void>;

/**
 * Detection and debug-enable in one call (docs/decisions.md D2), with the `typeof` guard
 * added so an absent SDK is distinguishable from an SDK that threw — the plan asks for a
 * diagnostic on failure, and "it threw" and "it isn't there" need different advice.
 *
 * Caveat carried into Phase 2: a queuing stub also answers 'enabled'. That proves a callable
 * exists, not that the SDK initialised. Only a real debug event confirms that.
 */
export const SMARTECH_DEBUG_EXPRESSION =
  "typeof smartech === 'function' ? (smartech('debug','1'), 'enabled') : 'missing'";

export const HOSTNAME_EXPRESSION = 'location.hostname';

export interface SdkDetectionOptions {
  readonly attempts: number;
  readonly retryDelayMs: number;
}

/** ~3s of polling: the Smartech snippet loads async, so absence at t=0 proves nothing. */
export const DEFAULT_SDK_DETECTION: SdkDetectionOptions = {
  attempts: 10,
  retryDelayMs: 300,
};

export type SdkStatus =
  | { readonly kind: 'ready'; readonly attempts: number }
  | { readonly kind: 'absent'; readonly attempts: number; readonly diagnostic: string };

export async function detectAndEnableDebug(
  evaluator: PageEvaluator,
  wait: Wait,
  options: SdkDetectionOptions = DEFAULT_SDK_DETECTION,
): Promise<SdkStatus> {
  let diagnostic = 'window.smartech was never defined while the panel was watching.';

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const outcome = await evaluator.evaluate(SMARTECH_DEBUG_EXPRESSION);

    if (outcome.kind === 'error') {
      diagnostic = `The page threw while enabling debug mode: ${outcome.message}`;
    } else if (outcome.value === 'enabled') {
      return { kind: 'ready', attempts: attempt };
    } else if (outcome.value !== 'missing') {
      diagnostic = `Unexpected probe result: ${JSON.stringify(outcome.value)}`;
    }

    if (attempt < options.attempts) {
      await wait(options.retryDelayMs);
    }
  }

  return { kind: 'absent', attempts: options.attempts, diagnostic };
}
