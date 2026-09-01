import type { DataType } from '../event-sheet/types';
import type { TransferableValue } from '../shared/payload';

export type ValidationStatus = 'PASS' | 'FAIL' | 'WARNING';

/**
 * Why a single expected field did not check out.
 *
 * `undefined` is kept distinct from `missing` because Phase 2 preserves that difference: a key
 * explicitly set to undefined was written by the site and dropped by the SDK, which is a
 * different defect from a key never being set at all.
 */
export type FieldStatus =
  | 'ok'
  | 'missing'
  | 'undefined'
  | 'null'
  | 'empty'
  | 'type-mismatch'
  /**
   * The sheet's key is absent, but the payload carries the value under a key that plainly means
   * the same thing — `prid` for `product_id`. The data arrived; the two sides disagree about what
   * to call it. A naming disagreement, not a missing field.
   */
  | 'renamed'
  /**
   * The captured value is a placeholder left by our own serialiser — a cycle, or something
   * clipped by the depth and breadth bounds. The site may be perfectly correct here; we simply
   * cannot tell. Reporting it as a mismatch would manufacture a defect that does not exist, so
   * it warns instead of failing.
   */
  | 'unverifiable';

export interface TypeMismatch {
  readonly path: string;
  readonly expected: DataType;
  readonly actual: string;
}

/** One expected field of the Event Sheet, checked against the observed payload. */
export interface FieldResult {
  readonly path: string;
  readonly status: FieldStatus;
  readonly required: boolean;
  readonly expectedType: DataType;
  readonly actualType: string;
  readonly value: TransferableValue | undefined;
  /** Set only for `renamed`: the payload key the value was actually found under. */
  readonly foundAs?: string;
}

/** What to do about payload fields the Event Sheet does not describe. */
export type ExtraFieldPolicy = 'ignore' | 'warn' | 'fail';

export interface ValidationOptions {
  readonly extraFields: ExtraFieldPolicy;
}

/**
 * Extra fields are ignored by default: analytics payloads routinely carry SDK-added and
 * site-specific keys the Event Sheet was never meant to describe, so warning on them buries the
 * warnings that matter. Still reported as data — the policy governs the verdict, not the record.
 */
export const DEFAULT_VALIDATION_OPTIONS: ValidationOptions = { extraFields: 'ignore' };

export interface ValidationResult {
  readonly status: ValidationStatus;
  readonly eventName: string;
  /** Every expected path absent from the payload, whether required or not. */
  readonly missing: readonly string[];
  /** Payload paths the Event Sheet does not describe. */
  readonly extra: readonly string[];
  /** Expected keys the payload spelled differently, and what it spelled them as. */
  readonly renamed: readonly { readonly path: string; readonly foundAs: string }[];
  readonly nullValues: readonly string[];
  readonly emptyValues: readonly string[];
  readonly typeMismatches: readonly TypeMismatch[];
  /** Itemised per-field results, in Event Sheet order. */
  readonly fields: readonly FieldResult[];
  /** The payload exactly as captured. */
  readonly raw: TransferableValue;
  readonly timestamp: number;
}
