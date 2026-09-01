import { documentsIn } from './sweep';

/** "If a field looks like `match`, type `value` into it." */
export interface FieldRule {
  readonly match: string;
  readonly value: string;
}

/**
 * Sensible starting values. A search box that is empty produces no search event, and a login
 * form with no phone number produces no sign-in — those events are unreachable by clicking alone.
 *
 * Passwords are deliberately absent: filling one and clicking submit is how an automated sweep
 * signs itself into, or out of, a real account.
 */
export const DEFAULT_FIELD_RULES: readonly FieldRule[] = [
  { match: 'search', value: 'shoes' },
  { match: 'query', value: 'shoes' },
  { match: 'email', value: 'qa.test@example.com' },
  { match: 'phone', value: '9876543210' },
  { match: 'mobile', value: '9876543210' },
  { match: 'pincode', value: '560001' },
  { match: 'zip', value: '560001' },
  { match: 'name', value: 'QA Test' },
  { match: 'city', value: 'Bengaluru' },
];

const FILLABLE =
  'input[type="text"], input[type="search"], input[type="email"], input[type="tel"], ' +
  'input[type="number"], input[type="url"], input:not([type]), textarea, select';

/**
 * Types the supplied values into whatever fields look like they want them.
 *
 * Values are set through the native property setter and followed by input/change events, because
 * frameworks track their own value and ignore a plain assignment — the field would look filled
 * and submit empty.
 */
export function fillFields(root: Document, rules: readonly FieldRule[]): number {
  let filled = 0;

  for (const document of documentsIn(root)) {
    for (const field of document.querySelectorAll(FILLABLE)) {
      if (!isFillable(field) || describes(field) === '') {
        continue;
      }

      const rule = rules.find((entry) => matches(field, entry.match));
      if (rule === undefined) {
        continue;
      }

      if (applyValue(field, rule.value)) {
        filled += 1;
      }
    }
  }

  return filled;
}

function isFillable(field: Element): boolean {
  if (field.hasAttribute('disabled') || field.hasAttribute('readonly')) {
    return false;
  }
  // Never a password: filling one and submitting is how a sweep signs into a real account.
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

/** Everything about a field that hints at what belongs in it. */
function describes(field: Element): string {
  const parts = [
    field.getAttribute('name'),
    field.getAttribute('id'),
    field.getAttribute('placeholder'),
    field.getAttribute('aria-label'),
    field.getAttribute('type'),
    field.closest('label')?.textContent,
  ];

  return parts
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matches(field: Element, needle: string): boolean {
  const haystack = ` ${describes(field)} `;
  const wanted = needle.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return wanted !== '' && haystack.includes(` ${wanted} `);
}

function applyValue(field: Element, value: string): boolean {
  if (field instanceof HTMLSelectElement) {
    const option = [...field.options].find((entry) => entry.value !== '');
    if (option === undefined) {
      return false;
    }
    field.value = option.value;
    notify(field);
    return true;
  }

  if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLTextAreaElement)) {
    return false;
  }

  // Through the prototype's setter, so a framework's own value tracking sees the change.
  const prototype =
    field instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

  if (setter === undefined) {
    field.value = value;
  } else {
    setter.call(field, value);
  }

  notify(field);
  return true;
}

function notify(field: Element): void {
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

/** What a control would submit, and whether anything is still blank. */
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

/** Parses the panel's "search: shoes" lines into rules. */
export function parseFieldRules(text: string): readonly FieldRule[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && line.includes(':'))
    .map((line) => {
      const separator = line.indexOf(':');
      return {
        match: line.slice(0, separator).trim(),
        value: line.slice(separator + 1).trim(),
      };
    })
    .filter((rule) => rule.match !== '' && rule.value !== '');
}

export function formatFieldRules(rules: readonly FieldRule[]): string {
  return rules.map((rule) => `${rule.match}: ${rule.value}`).join('\n');
}
