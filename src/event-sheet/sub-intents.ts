/**
 * The client's trigger sentence, read as an ordered list of things to do.
 *
 * Every real sheet writes this column as prose, and that prose is an instruction rather than a
 * note: *"Click the search icon in the header, type a keyword (e.g. 'jacket'), then press Enter"*
 * is a verb, a thing, and a value, three times over. It is also the only description of the action
 * anybody has written down, so reading it properly is the difference between driving an event and
 * guessing at it from the event's name.
 *
 * **What this does not do.** It produces *intents* — what to do and what it is called in the
 * client's words — not steps bound to elements. Nothing here has seen a page, and "the search
 * icon" is not a selector. Resolving an intent to a control is a separate stage with its own
 * failure modes.
 *
 * Pure: no DOM, no network, no model. This generalises across verticals for the simple reason
 * that every sheet has prose, which is exactly what DOM heuristics could not manage.
 */

/** What a sub-intent asks for. Deliberately small; anything not here is not inferred. */
export type IntentKind = 'click' | 'fill' | 'select' | 'navigate' | 'ask';

/**
 * A value only a person can supply.
 *
 * A closed set, and that is the safety property rather than a convenience: an open one lets a
 * flow ask for something nobody can answer and then wait for ever. These are the things a real
 * signup or login genuinely requires from a real user.
 */
export type HumanValueKind =
  | 'email'
  | 'phone'
  | 'password'
  | 'otp'
  | 'name'
  | 'address'
  | 'file';

export interface SubIntent {
  readonly kind: IntentKind;
  /** What the control is called, in the client's words. Not a selector. */
  readonly target: string;
  /** For `fill`: the value the sentence supplied. For `navigate`: the path. */
  readonly value?: string;
  /** For `ask`: what a person has to be asked for. */
  readonly valueKind?: HumanValueKind;
  /** The clause this came from, so a failure can quote the client rather than paraphrase them. */
  readonly source: string;
}

/**
 * Verbs mapped to what they ask for, using the words clients actually write.
 *
 * `press` and `enter` are deliberately absent as bare verbs: "press Submit" is a click and "press
 * Enter" is a keystroke; "Enter OTP" is a field and "Enter" is a key. Both are decided below by
 * what follows them, not by the verb alone.
 */
const VERBS: Readonly<Record<string, IntentKind>> = {
  click: 'click',
  clicks: 'click',
  tap: 'click',
  taps: 'click',
  hit: 'click',
  open: 'click',
  opens: 'click',
  visit: 'navigate',
  visits: 'navigate',
  navigate: 'navigate',
  select: 'select',
  selects: 'select',
  choose: 'select',
  chooses: 'select',
  pick: 'select',
  picks: 'select',
  type: 'fill',
  types: 'fill',
  fill: 'fill',
  fills: 'fill',
  input: 'fill',
};

/** `press` and `enter` are clicks only when something follows them to be acted on. */
const AMBIGUOUS: Readonly<Record<string, IntentKind>> = {
  press: 'click',
  presses: 'click',
  enter: 'fill',
  enters: 'fill',
  request: 'fill',
  requests: 'fill',
  go: 'navigate',
  goes: 'navigate',
};

/**
 * Clause openers that set the scene instead of asking for anything.
 *
 * "On a product detail page", "While logged in", "From the home page" each describe the
 * circumstances. Executed as steps they click things that are not controls.
 */
const SCENE = /^(on|while|from|in|at|once|after|before|when|if|under|usually|given)\b/i;

/** A conditional tail: "if one is required", "when prompted". A circumstance, not a name. */
const CONDITION = /\s+\b(if|when|unless|whenever|provided)\b\s+.*$/i;

/**
 * An alternative: "press Enter **or click the search button**".
 *
 * One of the two is enough and the first is the one the client put first. Without this the target
 * becomes a control called "Enter or click the search", which is nothing. It also improves a field
 * name: "the registered Email or Mobile number" becomes "registered Email".
 */
const ALTERNATIVE = /\s+\bor\b\s+.*$/i;

/** Where a control is, not what it is called: "in the header", "on the page". */
const LOCATION = /\s+\b(in|on|from|under|at|within|inside|near|beside)\b\s+(the|a|an|its|your)\s+.*$/i;

/** Words that are never part of a control's name. */
const LEADING = /^(to|on|in|at|the|a|an|any|your|its|this|that|some|all|each|first|last|random)\s+/i;

/**
 * Nouns naming what *kind* of control it is, never what it is called.
 *
 * "Click the search icon" — the control is called Search; "icon" is the sentence saying it has a
 * picture on it rather than words. A target of "search icon" matches nothing.
 */
const KINDS =
  'icon|button|link|field|box|symbol|image|tab|menu|option|control|element|page|screen|panel|drawer';
const KIND_TAIL = new RegExp(`\\s+\\b(${KINDS})s?$`, 'i');
/** A name that is only the kind of control names nothing: "Click the icon" targets nothing. */
const BARE_KIND = new RegExp(`^(${KINDS})s?$`, 'i');

/** A phrase in quotes names a control exactly. Curly quotes too — spreadsheets make them. */
const QUOTED = /["“‘']([^"”’']{2,60})["”’']/;

/** An example the sentence offers: "(e.g. 'jacket')". */
const EXAMPLE = /\(\s*e\.?g\.?\s*[:,]?\s*["“‘']?([^)"”’']{1,40})["”’']?\s*\)/i;

/** Abbreviations whose full stop does not end a sentence. Splitting on it loses the example. */
const ABBREVIATIONS = /\b(e\.g\.|i\.e\.|etc\.)/gi;
const HIDDEN_DOT = '\u0000';

/**
 * A page address, not a sentence about one.
 *
 * It must *start* like one. "no spaces" alone is not enough: "Go to the site" reduces to the
 * single word "site", which has no spaces and is not an address — it is scene-setting with a verb
 * in front of it, and handing it to the browser fails at runtime with nothing anybody can act on.
 */
const PATHLIKE = /^(\/|https?:\/\/|\?)\S*$/;

/** Longer than this is a sentence about a control, not its name. */
const LONGEST = 60;

/**
 * What a field is asking a *person* for, by the words used for it.
 *
 * An email, a mobile number or a one-time code cannot be invented — a fabricated value burns the
 * attempt and sometimes the account — so these become a pause rather than a guess.
 */
const PERSONAL: readonly { readonly pattern: RegExp; readonly kind: HumanValueKind }[] = [
  { pattern: /\bo\.?t\.?p\b|one[- ]time (code|password|pin)/i, kind: 'otp' },
  { pattern: /\bpassword\b/i, kind: 'password' },
  { pattern: /\be-?mail\b/i, kind: 'email' },
  { pattern: /\b(mobile|phone|contact)\b/i, kind: 'phone' },
  { pattern: /\b(pin ?code|post ?code|zip ?code|address|city|location)\b/i, kind: 'address' },
  { pattern: /\b(upload|document|photo|id proof|pan card|passport)\b/i, kind: 'file' },
  { pattern: /\bname\b/i, kind: 'name' },
];

export function subIntentsFrom(prose: string): readonly SubIntent[] {
  return clausesOf(prose)
    .map(intentFrom)
    .filter((intent): intent is SubIntent => intent !== undefined);
}

/**
 * The sentence broken into the things it asks for, in order.
 *
 * Split on sentence ends, `;`, "then", numbered markers and commas — the ways a client separates
 * one instruction from the next. **Not on a bare "and"**: "select size and color" is one
 * instruction, and splitting it yields a step that clicks the word "color".
 */
function clausesOf(prose: string): readonly string[] {
  const masked = prose.replace(ABBREVIATIONS, (found) => found.replace(/\./g, HIDDEN_DOT));

  return masked
    .split(/[.;]|\bthen\b|\band then\b|\bafter that\b|^\s*\d+[).]\s*|,/gim)
    .map((clause) => clause.split(HIDDEN_DOT).join('.').trim())
    .filter((clause) => clause !== '');
}

function intentFrom(clause: string): SubIntent | undefined {
  const words = clause.split(/\s+/);
  const at = words.findIndex((word) => kindOf(word) !== undefined);
  if (at === -1) {
    return undefined;
  }

  const verb = bare(words[at] ?? '');
  const after = words.slice(at + 1).join(' ');
  const source = clause.replace(SCENE, '').trim() || clause;
  const kind = settle(verb, after);

  if (kind === 'navigate') {
    /*
     * Deliberately not `cleaned`: that strips punctuation to leave a control's name, and a path is
     * mostly punctuation — it would turn "/refer-a-friend" into "refer a friend".
     */
    const path = after.replace(/^to\s+/i, '').trim();
    return PATHLIKE.test(path) ? { kind, target: path, value: path, source } : undefined;
  }

  if (kind === 'fill') {
    return fieldIntent(after, clause, source);
  }

  const target = named(after, clause);
  return target === '' || target.length > LONGEST ? undefined : { kind, target, source };
}

/**
 * A `fill` with the value the sentence gave, or a pause when only a person can give it.
 *
 * The quoted phrase means different things either side of the verb: after *click* it names the
 * control, after *type* it is the value. The verb settles it, and getting that wrong turns
 * "type a keyword (e.g. 'jacket')" into a request for somebody to supply a keyword the sheet had
 * already written down.
 */
function fieldIntent(after: string, clause: string, source: string): SubIntent | undefined {
  const target = cleaned(after);
  if (target === '' || target.length > LONGEST) {
    return undefined;
  }

  const personal = PERSONAL.find((entry) => entry.pattern.test(target));
  if (personal !== undefined) {
    return { kind: 'ask', target, valueKind: personal.kind, source };
  }

  const example = EXAMPLE.exec(clause) ?? QUOTED.exec(clause);
  return example?.[1] === undefined
    ? // Nothing says what to type, and nothing here will invent it.
      { kind: 'ask', target, valueKind: 'name', source }
    : { kind: 'fill', target, value: example[1].trim(), source };
}

/** Which of the two `press`/`enter` readings this clause means, decided by what follows. */
function settle(verb: string, after: string): IntentKind {
  const plain = VERBS[verb];
  if (plain !== undefined) {
    return plain;
  }

  const ambiguous = AMBIGUOUS[verb] ?? 'click';

  /*
   * Asked of the raw words, not of `cleaned`.
   *
   * `cleaned` exists to leave a *control's name*, and among other things it splits on "/" to take
   * the first of "the wishlist / heart icon" — which empties a path like "/refer-a-friend" and
   * made "Go to /refer-a-friend" look like a verb with nothing after it, read as a click, and
   * dropped. Whether an object follows is a fact about the sentence, not about control names.
   */
  return after.trim() === '' ? 'click' : ambiguous;
}

function kindOf(word: string): IntentKind | undefined {
  const plain = bare(word);
  return VERBS[plain] ?? AMBIGUOUS[plain];
}

/** A quoted phrase names the control outright; otherwise the words after the verb, cleaned up. */
function named(after: string, clause: string): string {
  const quoted = QUOTED.exec(clause);

  return quoted?.[1] === undefined ? cleaned(after) : quoted[1].trim();
}

/** The words after the verb, with everything that is not part of a control's name removed. */
function cleaned(after: string): string {
  const withoutAsides = after
    .replace(/\([^)]*\)/g, ' ')
    .replace(CONDITION, '')
    .replace(ALTERNATIVE, '')
    .replace(LOCATION, '')
    .replace(LEADING, '');

  // "the wishlist / heart icon" is one control written two ways; the first is enough.
  const firstOfTwo = withoutAsides.split('/')[0] ?? '';

  return firstOfTwo
    .replace(/[^A-Za-z0-9'’&\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(KIND_TAIL, '')
    .trim()
    .replace(BARE_KIND, '');
}

function bare(word: string): string {
  return word.toLowerCase().replace(/[^a-z]/g, '');
}
