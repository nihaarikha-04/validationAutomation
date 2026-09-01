/** What clicking a control would submit, and what of it is still blank. */
export interface FormNeeds {
  readonly isSubmit: boolean;
  readonly fields: readonly string[];
}

const SUBMIT_WORDS =
  /\b(submit|search|find|apply|continue|next|send|go|login|log in|sign in|sign up|register|verify|check|update|save)\b/;

/**
 * Whether clicking this control would submit a form, and which of that form's fields are empty.
 *
 * A tester cannot list a form's fields in advance — every site asks for something different — so
 * the sweep stops and hands the form over rather than guessing at values.
 */
export function formNeeds(control: Element): FormNeeds {
  const form = control.closest('form');
  const label = `${control.textContent ?? ''} ${control.getAttribute('aria-label') ?? ''} ${control.getAttribute('value') ?? ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');

  const isSubmit =
    control.getAttribute('type') === 'submit' || SUBMIT_WORDS.test(` ${label.trim()} `);

  const scope = form ?? control.closest('[role="dialog"]') ?? control.ownerDocument.body;
  const blank = [...scope.querySelectorAll(FILLABLE)]
    .filter((field) => isFillable(field))
    .map((field) => ({ name: nameFor(field), required: isMarkedRequired(field) }))
    .filter((field) => field.name !== '');

  return { isSubmit: isSubmit || form !== null, fields: [...new Set(worthStopping(blank))] };
}

/** Fields nobody has to fill for the control to do its job. */
const OPTIONAL_BY_NAME = /\b(discount|coupon|promo|voucher|gift ?card|referral|offer code)\b/;

/**
 * The blank fields actually worth stopping a run for.
 *
 * A cart drawer has a DISCOUNT CODE box next to an Apply button, so the sweep stopped and asked
 * a human to fill in a field that is optional by definition — on every cart, before any of the
 * drawer's own controls had been clicked. That one pause was enough to block the whole overlay.
 *
 * Where the page marks fields required, those are the only ones that matter and the rest are
 * noise. Where it marks nothing — plenty of sites do not — fall back to every blank field except
 * the ones whose name says they are optional, so an OTP or address form still stops the run.
 */
function worthStopping(
  blank: readonly { readonly name: string; readonly required: boolean }[],
): readonly string[] {
  const required = blank.filter((field) => field.required);
  if (required.length > 0) {
    return required.map((field) => field.name);
  }

  return blank
    .filter((field) => !OPTIONAL_BY_NAME.test(field.name.toLowerCase()))
    .map((field) => field.name);
}

function isMarkedRequired(field: Element): boolean {
  return field.hasAttribute('required') || field.getAttribute('aria-required') === 'true';
}

/** What a human would call this field. */
function nameFor(field: Element): string {
  const label =
    field.getAttribute('aria-label') ??
    field.getAttribute('placeholder') ??
    field.closest('label')?.textContent ??
    field.getAttribute('name') ??
    field.getAttribute('id') ??
    '';

  return label.replace(/\s+/g, ' ').trim().slice(0, 40);
}

const FILLABLE =
  'input[type="text"], input[type="search"], input[type="email"], input[type="tel"], ' +
  'input[type="number"], input[type="url"], input:not([type]), textarea, select';

/** Whether this field is one a person could still be expected to type into. */
function isFillable(field: Element): boolean {
  if (field.hasAttribute('disabled') || field.hasAttribute('readonly')) {
    return false;
  }
  // A password field is never counted: the sweep must not invite anyone to sign into a real
  // account as a side effect of clicking around.
  if (field.getAttribute('type') === 'password') {
    return false;
  }

  const view = field.ownerDocument.defaultView;
  if (view !== null) {
    const style = view.getComputedStyle(field);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
  }

  // Leave anything the user already filled alone.
  const current = 'value' in field ? String((field as { value?: unknown }).value ?? '') : '';
  return current.trim() === '';
}
