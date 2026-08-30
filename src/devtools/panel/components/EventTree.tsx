import { fieldIdentity } from '../../../event-sheet/normalize';
import type { EventSheet } from '../../../event-sheet/types';

export interface EventTreeProps {
  readonly sheet: EventSheet;
}

export function EventTree({ sheet }: EventTreeProps) {
  const events = [...sheet.events.values()];

  return (
    <section className="tree">
      <h2>
        {events.length} {events.length === 1 ? 'event' : 'events'}
      </h2>

      {sheet.warnings.length > 0 ? (
        <details className="tree__warnings">
          <summary>
            {sheet.warnings.length} {sheet.warnings.length === 1 ? 'warning' : 'warnings'}
          </summary>
          <ul>
            {sheet.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {events.length === 0 ? (
        <p>No events were found in this sheet.</p>
      ) : (
        <ul className="tree__events">
          {events.map((event) => (
            <li key={event.name}>
              <details>
                <summary>
                  <code>{event.name}</code>
                  <span className="tree__count">{event.fields.length} fields</span>
                </summary>
                <table className="tree__table">
                  <thead>
                    <tr>
                      <th scope="col">Payload</th>
                      <th scope="col">Type</th>
                      <th scope="col">Attribute</th>
                      <th scope="col">Type</th>
                      <th scope="col">Required</th>
                    </tr>
                  </thead>
                  <tbody>
                    {event.fields.map((field) => (
                      <tr key={fieldIdentity(field)}>
                        <td>{field.payloadName === '' ? '—' : <code>{field.payloadName}</code>}</td>
                        <td>{field.payloadType}</td>
                        <td>{field.attributeName === '' ? '—' : <code>{field.attributeName}</code>}</td>
                        <td>{field.attributeType}</td>
                        <td>{field.required ? 'required' : 'optional'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
