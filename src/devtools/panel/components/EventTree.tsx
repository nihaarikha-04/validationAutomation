import { useState } from 'react';
import { checkSteps, type CheckedStep } from '../../../automation/check-steps';
import type { PageDriver } from '../../../automation/commands';
import { fieldIdentity } from '../../../event-sheet/normalize';
import { subIntentsFrom, type SubIntent } from '../../../event-sheet/sub-intents';
import type { EventSheet } from '../../../event-sheet/types';

export interface EventTreeProps {
  readonly sheet: EventSheet;
  /**
   * Drives the inspected page, so the steps read from a sentence can be checked against it.
   *
   * Optional because the tree is also rendered where no page is being driven, and a sheet is
   * worth reading without one.
   */
  readonly driver?: PageDriver;
}

export function EventTree({ sheet, driver }: EventTreeProps) {
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
                  <Trigger prose={event.trigger.source} driver={driver} />
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
function Trigger({
  prose,
  driver,
}: {
  readonly prose: string;
  readonly driver: PageDriver | undefined;
}) {
  const intents = subIntentsFrom(prose);
  const [checked, setChecked] = useState<readonly CheckedStep[] | undefined>(undefined);
  const [checking, setChecking] = useState(false);

  const check = async (): Promise<void> => {
    if (driver === undefined) {
      return;
    }
    setChecking(true);
    try {
      setChecked(await checkSteps(intents, driver));
    } finally {
      setChecking(false);
    }
  };

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
        <>
          <ol className="tree__intents">
            {intents.map((intent, index) => (
              <li key={`${index}-${intent.source}`}>
                <span className="tree__kind">{intent.kind}</span>
                <code>{describe(intent)}</code>
                {checked === undefined ? null : <Outcome step={checked[index]} />}
              </li>
            ))}
          </ol>

          {driver === undefined ? null : (
            <div>
              <button type="button" disabled={checking} onClick={() => void check()}>
                {checking ? 'Looking…' : 'Is this on the page now?'}
              </button>
              {' '}
              <span className="tree__none">
                Looks for each control on the page as it is right now. Nothing is clicked.
              </span>
            </div>
          )}
        </>
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

/**
 * What the page said about one step's control.
 *
 * Each outcome is a different thing and none of them is "it failed": a control that is not here
 * may simply belong to a later screen, and a pause was never going to be on the page at all.
 */
function Outcome({ step }: { readonly step: CheckedStep | undefined }) {
  if (step === undefined) {
    return null;
  }

  switch (step.check.kind) {
    case 'here':
      return (
        <span className="tree__here">
          found{step.check.frameId === 0 ? '' : ` in a frame`} — &ldquo;{step.check.label}&rdquo;
        </span>
      );
    case 'missing':
      return <span className="tree__gone">not on this page</span>;
    case 'no-answer':
      return (
        <span className="tree__gone">
          the page did not answer ({step.check.detail}) — reload the page, then try again
        </span>
      );
    case 'ambiguous':
      return (
        <span className="tree__gone">
          {step.check.count} matches ({step.check.describing.join(', ')})
        </span>
      );
    case 'asks':
      return <span className="tree__none">waits for you</span>;
    case 'not-a-control':
      return <span className="tree__none">an address, not a control</span>;
  }
}
