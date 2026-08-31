import type { TransferableValue } from './payload';

export type ParseDebugTextResult =
  | { readonly kind: 'ok'; readonly values: readonly TransferableValue[] }
  | { readonly kind: 'failed'; readonly message: string; readonly position: number };

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;

const KEYWORDS: Readonly<Record<string, TransferableValue>> = {
  true: true,
  false: false,
  null: null,
  undefined: { __special: 'undefined' },
  NaN: { __special: 'unserialisable', detail: 'NaN' },
  Infinity: { __special: 'unserialisable', detail: 'Infinity' },
};

class ParseFailure extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
    this.name = 'ParseFailure';
  }
}

/**
 * Parses pasted debug output into the same shape the interceptor produces.
 *
 * Deliberately hand-written rather than `eval`/`new Function`: pasted text is untrusted, and
 * executing it inside the panel would run arbitrary code with extension privileges. Accepts
 * real JSON plus the JS-object dialect DevTools prints — unquoted keys, single quotes,
 * trailing commas — and several top-level objects in one paste.
 */
export function parseDebugText(text: string): ParseDebugTextResult {
  const reader = new Reader(text);

  try {
    const values = reader.readTopLevel();
    if (values.length === 0) {
      return { kind: 'failed', message: 'Nothing to parse.', position: 0 };
    }
    return { kind: 'ok', values };
  } catch (error) {
    if (error instanceof ParseFailure) {
      return { kind: 'failed', message: error.message, position: error.position };
    }
    throw error;
  }
}

/** Holds the cursor into the source text; genuine mutable state, hence a class. */
class Reader {
  private index = 0;

  constructor(private readonly text: string) {}

  readTopLevel(): TransferableValue[] {
    const values: TransferableValue[] = [];

    this.skipSeparators();
    while (this.index < this.text.length) {
      values.push(this.readValue());
      this.skipSeparators();
    }

    return values;
  }

  private readValue(): TransferableValue {
    this.skipWhitespace();
    const char = this.peek();
    this.rejectPlaceholder(char);

    if (char === '{') {
      return this.readObject();
    }
    if (char === '[') {
      return this.readArray();
    }
    if (char === '"' || char === "'" || char === '`') {
      return this.readString(char);
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      return this.readNumber();
    }
    if (IDENT_START.test(char)) {
      return this.readKeyword();
    }

    throw new ParseFailure(`Unexpected character "${char}".`, this.index);
  }

  private readObject(): TransferableValue {
    this.expect('{');
    const result: Record<string, TransferableValue> = {};

    for (;;) {
      this.skipWhitespace();
      if (this.peek() === '}') {
        this.index += 1;
        return result;
      }

      const key = this.readKey();
      this.skipWhitespace();
      this.expect(':');
      result[key] = this.readValue();

      this.skipWhitespace();
      const next = this.peek();
      if (next === ',') {
        this.index += 1;
      } else if (next !== '}') {
        throw new ParseFailure(`Expected "," or "}" after the value for "${key}".`, this.index);
      }
    }
  }

  private readArray(): TransferableValue {
    this.expect('[');
    const result: TransferableValue[] = [];

    for (;;) {
      this.skipWhitespace();
      if (this.peek() === ']') {
        this.index += 1;
        return result;
      }

      result.push(this.readValue());

      this.skipWhitespace();
      const next = this.peek();
      if (next === ',') {
        this.index += 1;
      } else if (next !== ']') {
        throw new ParseFailure('Expected "," or "]" in the array.', this.index);
      }
    }
  }

  private readKey(): string {
    const char = this.peek();
    this.rejectPlaceholder(char);
    if (char === '"' || char === "'" || char === '`') {
      const key = this.readString(char);
      return typeof key === 'string' ? key : '';
    }

    if (!IDENT_START.test(char)) {
      throw new ParseFailure(`Expected a property name, found "${char}".`, this.index);
    }

    const start = this.index;
    while (this.index < this.text.length && IDENT_PART.test(this.text.charAt(this.index))) {
      this.index += 1;
    }
    return this.text.slice(start, this.index);
  }

  private readString(quote: string): TransferableValue {
    this.index += 1;
    let value = '';

    while (this.index < this.text.length) {
      const char = this.text.charAt(this.index);

      if (char === '\\') {
        value += this.readEscape();
        continue;
      }
      if (char === quote) {
        this.index += 1;
        return value;
      }

      value += char;
      this.index += 1;
    }

    throw new ParseFailure('Unterminated string.', this.index);
  }

  private readEscape(): string {
    const code = this.text.charAt(this.index + 1);
    this.index += 2;

    switch (code) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'u': {
        const hex = this.text.slice(this.index, this.index + 4);
        this.index += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      case 'x': {
        const hex = this.text.slice(this.index, this.index + 2);
        this.index += 2;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        return code;
    }
  }

  private readNumber(): TransferableValue {
    const match = NUMBER.exec(this.text.slice(this.index));
    if (match === null) {
      throw new ParseFailure('Malformed number.', this.index);
    }

    this.index += match[0].length;
    return Number(match[0]);
  }

  private readKeyword(): TransferableValue {
    const start = this.index;
    while (this.index < this.text.length && IDENT_PART.test(this.text.charAt(this.index))) {
      this.index += 1;
    }

    const word = this.text.slice(start, this.index);
    const value = KEYWORDS[word];
    if (value === undefined) {
      throw new ParseFailure(
        `"${word}" is not a value.`,
        start,
      );
    }

    return value;
  }

  /**
   * DevTools prints collapsed objects as {…} and truncated arrays as (…). Pasting that is a
   * common mistake, and "unexpected character" would not tell the user what to do about it.
   */
  private rejectPlaceholder(char: string): void {
    if (char === '\u2026' || this.text.startsWith('...', this.index)) {
      throw new ParseFailure(
        'This looks like a collapsed DevTools placeholder (…). Expand the object in the console and copy it in full.',
        this.index,
      );
    }
  }

  private expect(char: string): void {
    if (this.peek() !== char) {
      throw new ParseFailure(`Expected "${char}".`, this.index);
    }
    this.index += 1;
  }

  private peek(): string {
    if (this.index >= this.text.length) {
      throw new ParseFailure('Unexpected end of input.', this.index);
    }
    return this.text.charAt(this.index);
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length && /\s/.test(this.text.charAt(this.index))) {
      this.index += 1;
    }
  }

  /** Between top-level values, commas and semicolons are noise rather than structure. */
  private skipSeparators(): void {
    while (this.index < this.text.length && /[\s,;]/.test(this.text.charAt(this.index))) {
      this.index += 1;
    }
  }
}
