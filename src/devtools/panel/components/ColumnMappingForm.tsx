import { useState } from 'react';
import { buildMapping } from '../../../event-sheet/detect-columns';
import {
  COLUMN_ROLES,
  FIELD_NAME_ROLES,
  REQUIRED_ROLES,
  type ColumnCandidates,
  type ColumnMapping,
  type ColumnRole,
} from '../../../event-sheet/types';

const ROLE_LABELS: Readonly<Record<ColumnRole, string>> = {
  eventName: 'Event name',
  payloadName: 'Payload',
  payloadType: 'Payload type',
  attributeName: 'Attribute',
  attributeType: 'Attribute type',
  required: 'Mandatory',
  description: 'Description',
  example: 'Example value',
};

const NO_COLUMN = '';

export interface ColumnMappingFormProps {
  readonly headers: readonly string[];
  readonly candidates: ColumnCandidates;
  readonly missing: readonly ColumnRole[];
  readonly onSubmit: (mapping: ColumnMapping) => void;
}

/** Rendered only when detection is ambiguous — a resolved sheet never shows this form. */
export function ColumnMappingForm({
  headers,
  candidates,
  missing,
  onSubmit,
}: ColumnMappingFormProps) {
  const [selection, setSelection] = useState<Readonly<Partial<Record<ColumnRole, number>>>>(
    () => preselect(candidates),
  );
  const [error, setError] = useState<string | undefined>(undefined);

  return (
    <form
      className="mapping"
      onSubmit={(event) => {
        event.preventDefault();
        const result = buildMapping(selection);
        if (result.kind === 'incomplete') {
          setError(`Choose a column for: ${result.missing.map((role) => ROLE_LABELS[role]).join(', ')}.`);
          return;
        }
        setError(undefined);
        onSubmit(result.mapping);
      }}
    >
      <h2>Confirm the columns</h2>
      <p className="mapping__why">
        {missing.length > 0
          ? `Could not resolve automatically: ${missing.map((role) => ROLE_LABELS[role]).join(', ')}.`
          : 'Could not resolve the columns automatically.'}
      </p>

      {COLUMN_ROLES.map((role) => (
        <label key={role} className="mapping__row">
          <span>
            {ROLE_LABELS[role]}
            {REQUIRED_ROLES.includes(role) ? ' *' : ''}
            {FIELD_NAME_ROLES.includes(role) ? ' †' : ''}
          </span>
          <select
            value={selection[role] ?? NO_COLUMN}
            onChange={(event) => {
              const raw = event.target.value;
              setSelection((current) => ({
                ...current,
                [role]: raw === NO_COLUMN ? undefined : Number(raw),
              }));
            }}
          >
            <option value={NO_COLUMN}>— not in this sheet —</option>
            {headers.map((header, column) => (
              <option key={column} value={column}>
                {header.trim() === '' ? `Column ${column + 1}` : header}
              </option>
            ))}
          </select>
        </label>
      ))}

      <p className="mapping__legend">* required · † at least one of these</p>

      {error !== undefined ? (
        <p className="mapping__error" role="alert">
          {error}
        </p>
      ) : null}

      <button type="submit">Use these columns</button>
    </form>
  );
}

/** A role with exactly one candidate is pre-filled; contested roles start empty. */
function preselect(candidates: ColumnCandidates): Partial<Record<ColumnRole, number>> {
  const selection: Partial<Record<ColumnRole, number>> = {};

  for (const role of COLUMN_ROLES) {
    const columns = candidates[role];
    if (columns.length === 1) {
      selection[role] = columns[0];
    }
  }

  return selection;
}
