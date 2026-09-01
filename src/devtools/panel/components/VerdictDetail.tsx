import type { CaptureVerdict } from '../../../validation/from-capture';

export interface VerdictDetailProps {
  readonly verdict: CaptureVerdict;
}

/** The per-field table behind a verdict badge. Renders state; decides nothing. */
export function VerdictDetail({ verdict }: VerdictDetailProps) {
  if (verdict.kind === 'unnamed') {
    return <p className="verdict__note">This debug line did not name an event.</p>;
  }

  if (verdict.kind === 'no-payload') {
    return <p className="verdict__note">This line named an event but carried no payload object.</p>;
  }

  if (verdict.kind === 'unknown-event') {
    return (
      <p className="verdict__note">
        <code>{verdict.eventName}</code> is not in the Event Sheet. It knows:{' '}
        {verdict.knownEvents.length === 0 ? 'nothing yet' : verdict.knownEvents.join(', ')}.
      </p>
    );
  }

  const { result } = verdict;

  return (
    <>
      {verdict.firedAs === undefined ? null : (
        <p className="verdict__note">
          The site calls this <code>{verdict.firedAs}</code>; the Event Sheet calls it{' '}
          <code>{result.eventName}</code>.{' '}
          {verdict.matchReason === 'synonym'
            ? 'Different words for the same thing — validated against the sheet, but the names disagree.'
            : 'Same words, formatted differently — validated against the sheet, but the names disagree.'}
        </p>
      )}
    <table className="verdict__table">
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">Expected</th>
          <th scope="col">Actual</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {result.fields.map((field) => (
          <tr key={field.path} className={`verdict__row verdict__row--${field.status}`}>
            <td>
              <code>{field.path}</code>
              {field.required ? <span className="verdict__required"> *</span> : null}
            </td>
            <td>{field.expectedType}</td>
            <td>{field.actualType}</td>
            <td>
              {field.status}
              {field.foundAs === undefined ? null : (
                <>
                  {' as '}
                  <code>{field.foundAs}</code>
                </>
              )}
            </td>
          </tr>
        ))}
        {result.extra.map((path) => (
          <tr key={`extra-${path}`} className="verdict__row verdict__row--extra">
            <td>
              <code>{path}</code>
            </td>
            <td>—</td>
            <td>not in sheet</td>
            <td>extra</td>
          </tr>
        ))}
      </tbody>
    </table>
    </>
  );
}
