import { useState } from 'react';
import { buildMapping } from '../../../event-sheet/detect-columns';
import {
  COLUMN_ROLES,
  FIELD_NAME_ROLES,
  REQUIRED_ROLES,
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
  source: 'Source (frontend / API)',
};

const NO_COLUMN = '';

export interface ColumnMappingFormProps {
  readonly headers: readonly string[];
  /** Which column each role starts on — detection's guess, or the mapping already in use. */
  readonly selected: Readonly<Partial<Record<ColumnRole, number>>>;
  /** Why the form is on screen: detection gave up, or the user asked to see the columns. */
  readonly note: string;
  readonly onSubmit: (mapping: ColumnMapping) => void;
}

/**
 * Shown when detection cannot resolve the columns, and whenever the user wants to check or
 * change the ones in use. Mapping a role one column off silently produces a schema of the wrong
 * field names, so the choice has to stay visible after it is made, not only before.
 */
export function ColumnMappingForm({ headers, selected, note, onSubmit }: ColumnMappingFormProps) {
  const [selection, setSelection] =
    useState<Readonly<Partial<Record<ColumnRole, number>>>>(selected);
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
      <p className="mapping__why">{note}</p>

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
