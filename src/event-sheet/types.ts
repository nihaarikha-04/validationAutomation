/** A sheet reduced to raw text cells. Parsers pad every row to the widest row. */
export type SheetRow = readonly string[];
export type SheetGrid = readonly SheetRow[];

export const COLUMN_ROLES = [
  'eventName',
  'payloadName',
  'payloadType',
  'attributeName',
  'attributeType',
  'required',
  'description',
  'example',
  'source',
] as const;

export type ColumnRole = (typeof COLUMN_ROLES)[number];

/** Without an event name nothing can be grouped, so this role is always required. */
export const REQUIRED_ROLES: readonly ColumnRole[] = ['eventName'];

/**
 * A sheet must name its fields in at least one channel. Sheets that only describe debug
 * payloads are common; sheets that only describe network attributes are legal too.
 */
export const FIELD_NAME_ROLES: readonly ColumnRole[] = ['payloadName', 'attributeName'];

export interface ColumnMapping {
  readonly eventName: number;
  readonly payloadName?: number;
  readonly payloadType?: number;
  readonly attributeName?: number;
  readonly attributeType?: number;
  readonly required?: number;
  readonly description?: number;
  readonly example?: number;
  readonly source?: number;
}

export type ColumnCandidates = Readonly<Record<ColumnRole, readonly number[]>>;

export type ColumnDetection =
  | {
      readonly kind: 'resolved';
      readonly headerRow: number;
      readonly headers: readonly string[];
      readonly mapping: ColumnMapping;
    }
  | {
      readonly kind: 'ambiguous';
      readonly headerRow: number;
      readonly headers: readonly string[];
      readonly candidates: ColumnCandidates;
      readonly missing: readonly ColumnRole[];
    };

export type DataType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object'
  | 'date'
  | 'unknown';

/**
 * One logical field of an event, as the Event Sheet declares it.
 *
 * The same field is observed through two channels with different names and, occasionally,
 * different types: `payloadName`/`payloadType` in the Smartech debug log, and
 * `attributeName`/`attributeType` in the form-encoded network call. Either side may be
 * absent when the sheet only documents one channel — see docs/decisions.md D4.
 */
export interface FieldSchema {
  readonly payloadName: string;
  readonly payloadType: DataType;
  readonly attributeName: string;
  readonly attributeType: DataType;
  readonly required: boolean;
  readonly description: string;
  readonly example: string;
}

/**
 * Where an event is fired from, which decides whether this tool can ever see it.
 *
 * An `api` event is sent server-to-server and never touches the page, so it cannot be captured
 * from the browser however thoroughly a site is exercised. Reporting one as NOT SEEN alongside a
 * frontend event that genuinely failed to fire states two very different things in the same
 * words. `unknown` when the sheet does not say.
 */
export type EventSource = 'frontend' | 'api' | 'unknown';

export interface EventSchema {
  readonly name: string;
  readonly fields: readonly FieldSchema[];
  readonly source: EventSource;
  /**
   * The event this one was folded into, exactly as the sheet spelled it, when the sheet says it
   * must not fire separately.
   *
   * Its fields are then expected inside the parent's payload rather than under their own event
   * name, so the parent's payload is where they have to be checked. Unresolved on purpose: the
   * sheet writes `"Product Viewed"` where the event is called `Product Viewed (Front End)`, and
   * reconciling those two is the matcher's job, not the parser's.
   */
  readonly mergeInto?: string;
}

export interface EventSheet {
  /** Keyed by exact event name — Phase 3 matches on exact name, never an alias. */
  readonly events: ReadonlyMap<string, EventSchema>;
  readonly warnings: readonly string[];
}
