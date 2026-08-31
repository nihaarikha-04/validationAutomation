import { useState } from 'react';
import { parseDebugText } from '../../../shared/parse-debug-text';
import type { TransferableValue } from '../../../shared/payload';

export interface PastePayloadsProps {
  readonly onParsed: (values: readonly TransferableValue[]) => void;
}

/**
 * Fallback for pages where interception cannot run — paste debug objects straight from the
 * console. Parsing never evaluates the text; see parse-debug-text.ts.
 */
export function PastePayloads({ onParsed }: PastePayloadsProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  return (
    <details className="paste">
      <summary>Paste debug output</summary>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          const result = parseDebugText(text);

          if (result.kind === 'failed') {
            setError(`${result.message} (at character ${result.position + 1})`);
            return;
          }

          setError(undefined);
          setText('');
          onParsed(result.values);
        }}
      >
        <textarea
          className="paste__input"
          rows={6}
          value={text}
          spellCheck={false}
          placeholder={"{event: 'add_to_cart', product_id: 'SKU123'}"}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />

        <p className="paste__hint">
          Accepts JSON and console-style objects — unquoted keys, single quotes, trailing commas.
          Several objects in one paste are read as separate payloads.
        </p>

        {error !== undefined ? (
          <p className="paste__error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" disabled={text.trim() === ''}>
          Add payloads
        </button>
      </form>
    </details>
  );
}
