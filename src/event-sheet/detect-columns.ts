import { isBlankRow } from './grid';
import {
  COLUMN_ROLES,
  FIELD_NAME_ROLES,
  REQUIRED_ROLES,
  type ColumnCandidates,
  type ColumnDetection,
  type ColumnMapping,
  type ColumnRole,
  type SheetGrid,
} from './types';

/** How far into the sheet to look for a header row before giving up. */
const HEADER_SEARCH_DEPTH = 30;

/**
 * Header synonyms per role, matched flexibly rather than by exact header text.
 *
 * "Optional" is deliberately absent from `required`: a column headed "Optional" inverts the
 * meaning of its Yes/No values, and silently reading it as `required` would flip every field.
 * Leaving it undetected sends the user to manual mapping instead.
 */
const ROLE_SYNONYMS: Readonly<Record<ColumnRole, readonly string[]>> = {
  eventName: ['event name', 'event id', 'event key', 'event title', 'action name', 'event'],
  payloadName: ['payload name', 'payload key', 'payload field', 'payload parameter', 'debug payload', 'payload'],
  payloadType: ['payload data type', 'payload datatype', 'payload type', 'payload format'],
  attributeName: [
    'attribute name',
    'network attribute',
    'attribute key',
    'attribute field',
    'form attribute',
    'parameter name',
    'property name',
    'field name',
    'attribute',
    'parameter',
    'property',
    'param',
  ],
  attributeType: ['attribute data type', 'attribute datatype', 'attribute type', 'network attribute type', 'attribute format'],
  required: ['is mandatory', 'is required', 'mandatory', 'required', 'req'],
  description: ['description', 'desc', 'definition', 'notes', 'note', 'comments', 'comment', 'remarks'],
  example: ['example value', 'sample value', 'example values', 'sample data', 'example', 'sample'],
};

/**
 * Type headers that name no channel. They score for both type roles, producing a deliberate
 * tie that `resolveGenericTypeColumns` breaks by adjacency — in practice a bare "Data Type"
 * column sits immediately right of the name column it belongs to.
 */
const GENERIC_TYPE_SYNONYMS: readonly string[] = ['data type', 'datatype', 'type', 'format'];

const TYPE_ROLES: readonly ColumnRole[] = ['payloadType', 'attributeType'];

/** Lowercases and reduces punctuation to single spaces so "Event_Name" matches "event name". */
export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Finds the header row and maps each role to a column.
 *
 * Resolves only when every role that matched did so unambiguously, the event-name column is
 * present, and at least one of the payload/attribute name columns is present. Anything else
 * returns `ambiguous` with the candidates found, which is what drives the manual mapping UI.
 */
export function detectColumns(grid: SheetGrid): ColumnDetection {
  const headerRow = findHeaderRow(grid);
  const headers = grid[headerRow] ?? [];
  const candidates = resolveGenericTypeColumns(collectCandidates(headers));

  const mapping: Partial<Record<ColumnRole, number>> = {};
  const contested = new Set<ColumnRole>();

  for (const role of COLUMN_ROLES) {
    const columns = candidates[role];
    if (columns.length === 1) {
      mapping[role] = columns[0];
    } else if (columns.length > 1) {
      contested.add(role);
    }
  }

  // One column claimed by two roles is just as ambiguous as one role claiming two columns —
  // an unbroken "Data Type" tie leaves a single column sitting on both type roles.
  for (const roles of rolesByColumn(mapping).values()) {
    if (roles.length > 1) {
      for (const role of roles) {
        contested.add(role);
        delete mapping[role];
      }
    }
  }

  const missing = missingRoles(mapping);
  const { eventName } = mapping;

  if (eventName === undefined || missing.length > 0 || contested.size > 0) {
    return {
      kind: 'ambiguous',
      headerRow,
      headers,
      candidates,
      missing: [...missing, ...contested],
    };
  }

  return {
    kind: 'resolved',
    headerRow,
    headers,
    mapping: withOptionalRoles(eventName, mapping),
  };
}

export type MappingResult =
  | { readonly kind: 'ok'; readonly mapping: ColumnMapping }
  | { readonly kind: 'incomplete'; readonly missing: readonly ColumnRole[] };

/** Builds a mapping from manual user choices, rejecting one that lacks a required role. */
export function buildMapping(
  selection: Readonly<Partial<Record<ColumnRole, number>>>,
): MappingResult {
  const missing = missingRoles(selection);
  const { eventName } = selection;

  if (eventName === undefined || missing.length > 0) {
    return { kind: 'incomplete', missing };
  }

  return { kind: 'ok', mapping: withOptionalRoles(eventName, selection) };
}

/** Inverts a mapping so collisions — one column serving several roles — become visible. */
function rolesByColumn(
  mapping: Readonly<Partial<Record<ColumnRole, number>>>,
): Map<number, ColumnRole[]> {
  const byColumn = new Map<number, ColumnRole[]>();

  for (const role of COLUMN_ROLES) {
    const column = mapping[role];
    if (column === undefined) {
      continue;
    }
    const roles = byColumn.get(column) ?? [];
    roles.push(role);
    byColumn.set(column, roles);
  }

  return byColumn;
}

/** Missing required roles, plus both field-name roles when neither channel is named. */
function missingRoles(selection: Readonly<Partial<Record<ColumnRole, number>>>): ColumnRole[] {
  const missing = REQUIRED_ROLES.filter((role) => selection[role] === undefined);
  const hasFieldName = FIELD_NAME_ROLES.some((role) => selection[role] !== undefined);

  return hasFieldName ? missing : [...missing, ...FIELD_NAME_ROLES];
}

function withOptionalRoles(
  eventName: number,
  selection: Readonly<Partial<Record<ColumnRole, number>>>,
): ColumnMapping {
  return {
    eventName,
    payloadName: selection.payloadName,
    payloadType: selection.payloadType,
    attributeName: selection.attributeName,
    attributeType: selection.attributeType,
    required: selection.required,
    description: selection.description,
    example: selection.example,
  };
}

/**
 * A column claimed by both type roles is a generic "Data Type" header. Give it to whichever
 * name column it immediately follows; if it follows neither, leave the tie for the user.
 */
function resolveGenericTypeColumns(candidates: ColumnCandidates): ColumnCandidates {
  const contested = candidates.payloadType.filter((column) =>
    candidates.attributeType.includes(column),
  );

  if (contested.length === 0) {
    return candidates;
  }

  const payloadNameColumn = onlyColumn(candidates.payloadName);
  const attributeNameColumn = onlyColumn(candidates.attributeName);

  const claimedByPayload = new Set<number>();
  const claimedByAttribute = new Set<number>();

  for (const column of contested) {
    if (payloadNameColumn !== undefined && column === payloadNameColumn + 1) {
      claimedByPayload.add(column);
    } else if (attributeNameColumn !== undefined && column === attributeNameColumn + 1) {
      claimedByAttribute.add(column);
    }
  }

  return {
    ...candidates,
    payloadType: candidates.payloadType.filter(
      (column) => !claimedByAttribute.has(column),
    ),
    attributeType: candidates.attributeType.filter(
      (column) => !claimedByPayload.has(column),
    ),
  };
}

function onlyColumn(columns: readonly number[]): number | undefined {
  return columns.length === 1 ? columns[0] : undefined;
}

/** The row matching the most roles wins; ties go to the earliest row. */
function findHeaderRow(grid: SheetGrid): number {
  const depth = Math.min(grid.length, HEADER_SEARCH_DEPTH);
  let bestRow = 0;
  let bestScore = 0;

  for (let row = 0; row < depth; row += 1) {
    const cells = grid[row];
    if (cells === undefined || isBlankRow(cells)) {
      continue;
    }

    const candidates = collectCandidates(cells);
    const score = COLUMN_ROLES.filter((role) => candidates[role].length > 0).length;

    if (score > bestScore) {
      bestScore = score;
      bestRow = row;
    }
  }

  return bestRow;
}

/**
 * Assigns each column to the role it scores highest for, so "Payload Data Type" lands on
 * `payloadType` rather than being claimed by `payloadName` on a partial match. A column that
 * ties across roles is recorded under each, which surfaces as ambiguity unless a later pass
 * can break the tie.
 */
function collectCandidates(headers: readonly string[]): ColumnCandidates {
  const candidates: Record<ColumnRole, number[]> = {
    eventName: [],
    payloadName: [],
    payloadType: [],
    attributeName: [],
    attributeType: [],
    required: [],
    description: [],
    example: [],
  };

  headers.forEach((header, column) => {
    const normalized = normalizeHeader(header);
    if (normalized === '') {
      return;
    }

    const scores = COLUMN_ROLES.map((role) => scoreHeader(normalized, role));
    const best = Math.max(...scores);
    if (best === 0) {
      return;
    }

    COLUMN_ROLES.forEach((role, index) => {
      if (scores[index] === best) {
        candidates[role].push(column);
      }
    });
  });

  return candidates;
}

/** 3 = exact header, 2 = header begins or ends with the synonym, 1 = contains it. */
function scoreHeader(normalized: string, role: ColumnRole): number {
  const synonyms = TYPE_ROLES.includes(role)
    ? [...ROLE_SYNONYMS[role], ...GENERIC_TYPE_SYNONYMS]
    : ROLE_SYNONYMS[role];

  let best = 0;

  for (const synonym of synonyms) {
    if (normalized === synonym) {
      return 3;
    }
    if (normalized.startsWith(`${synonym} `) || normalized.endsWith(` ${synonym}`)) {
      best = Math.max(best, 2);
    } else if (normalized.includes(synonym)) {
      best = Math.max(best, 1);
    }
  }

  return best;
}
