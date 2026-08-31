import type { ActionCandidate, ActionIntent } from './types';

/**
 * The panel↔page protocol for automation. Kept in its own module so neither side has to import
 * the other's entry point, which would drag side effects across the boundary.
 */
export type AutomationCommand =
  | { readonly kind: 'detect'; readonly intent: ActionIntent }
  | { readonly kind: 'click'; readonly selector: string }
  | { readonly kind: 'pick' }
  | { readonly kind: 'cancel-pick' };

export type AutomationReply =
  | {
      readonly kind: 'candidates';
      readonly platform: string;
      readonly candidates: readonly ActionCandidate[];
    }
  | { readonly kind: 'clicked' }
  | { readonly kind: 'picked'; readonly candidate: ActionCandidate }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error'; readonly message: string };

/** Drives the inspected page. Implemented by the panel against chrome.tabs. */
export interface PageDriver {
  send(command: AutomationCommand): Promise<AutomationReply>;
}
