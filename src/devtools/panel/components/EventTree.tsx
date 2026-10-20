import { fieldIdentity } from '../../../event-sheet/normalize';
import { subIntentsFrom, type SubIntent } from '../../../event-sheet/sub-intents';
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

                {event.trigger === undefined ? null : (
                  <Trigger prose={event.trigger.source} />
                )}
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

/**
 * What the sheet says about producing this event, and what was read out of it.
 *
 * Shown because the reading is a *claim about the client's sentence* that only a person can check,
 * and the alternative is finding out it was wrong several stages later as a step that clicked
 * nothing. The client's own words stay visible beside it, so the two can be compared without
 * leaving the panel.
 *
 * Read-only. Nothing here runs anything.
 */
function Trigger({ prose }: { readonly prose: string }) {
  const intents = subIntentsFrom(prose);

  return (
    <div className="tree__trigger">
      <p className="tree__prose">{prose}</p>

      {intents.length === 0 ? (
        <p className="tree__none">
          Nothing to do was read out of this. That is right for an event that fires on its own or
          comes from a server, and wrong for one that describes clicking something — if it is the
          latter, the sentence is worth passing on.
        </p>
      ) : (
        <ol className="tree__intents">
          {intents.map((intent, index) => (
            <li key={`${index}-${intent.source}`}>
              <span className="tree__kind">{intent.kind}</span>
              <code>{describe(intent)}</code>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Named in the client's words, because that is what a person can check it against. */
function describe(intent: SubIntent): string {
  switch (intent.kind) {
    case 'fill':
      return `${intent.target} = ${intent.value ?? ''}`;
    case 'ask':
      return `${intent.target} — ask the tester for their ${intent.valueKind}`;
    case 'navigate':
      return intent.value ?? intent.target;
    default:
      return intent.target;
  }
}
