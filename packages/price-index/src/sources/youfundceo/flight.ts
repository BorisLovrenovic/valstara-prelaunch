// Reads the React Server Components payload that a Next.js App Router page
// embeds in its `self.__next_f.push([1, "…"])` scripts (E11.6-05; the format
// is described in docs/features/price-index-source-findings.md#the-embedded-data).
//
// The payload is a list of rows, `<hex id>:<value>`. A JSON row ends at a
// newline. A text row, `<id>:T<hex byte length>,<text>`, is exactly that many
// UTF-8 bytes and is not followed by a newline. Any other tagged row (`I`,
// `HL`, `X`, `C`, …) runs to the end of its line and is not read.
//
// JSON is read by a tokenizer of our own that **keeps every number as its
// source text** (`JsonNumber`), so a price such as `932.5` is never turned
// into a float on its way to the money module (epic rule 3).

export class JsonNumber {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

export type JsonValue =
  null | boolean | string | JsonNumber | JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** The payload could not be read; the page fails as `parse_failed`. */
export class FlightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlightError';
  }
}

const numberPattern = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const whitespace = new Set([' ', '\t', '\n', '\r']);

function skipWhitespace(text: string, index: number): number {
  let position = index;
  while (position < text.length && whitespace.has(text[position])) {
    position += 1;
  }
  return position;
}

function readString(text: string, start: number): [string, number] {
  let position = start + 1;
  while (position < text.length) {
    const character = text[position];
    if (character === '\\') {
      position += 2;
      continue;
    }
    if (character === '"') {
      // A JSON string literal holds no number, so the built-in parser is safe
      // here and handles every escape exactly.
      const literal = text.slice(start, position + 1);
      try {
        return [JSON.parse(literal) as string, position + 1];
      } catch {
        throw new FlightError(`a malformed string at ${start}`);
      }
    }
    position += 1;
  }
  throw new FlightError(`an unterminated string at ${start}`);
}

/**
 * Reads one JSON value starting at `start` (after optional whitespace) and
 * returns it with the index just past it. Numbers keep their text.
 */
export function readJsonValue(
  text: string,
  start: number,
): [JsonValue, number] {
  const position = skipWhitespace(text, start);
  const character = text[position];
  if (character === '"') {
    return readString(text, position);
  }
  if (character === '[') {
    const items: JsonValue[] = [];
    let cursor = skipWhitespace(text, position + 1);
    if (text[cursor] === ']') {
      return [items, cursor + 1];
    }
    for (;;) {
      const [item, next] = readJsonValue(text, cursor);
      items.push(item);
      cursor = skipWhitespace(text, next);
      if (text[cursor] === ',') {
        cursor += 1;
        continue;
      }
      if (text[cursor] === ']') {
        return [items, cursor + 1];
      }
      throw new FlightError(`expected , or ] at ${cursor}`);
    }
  }
  if (character === '{') {
    const object: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;
    let cursor = skipWhitespace(text, position + 1);
    if (text[cursor] === '}') {
      return [object, cursor + 1];
    }
    for (;;) {
      if (text[cursor] !== '"') {
        throw new FlightError(`expected a key at ${cursor}`);
      }
      const [key, afterKey] = readString(text, cursor);
      cursor = skipWhitespace(text, afterKey);
      if (text[cursor] !== ':') {
        throw new FlightError(`expected : at ${cursor}`);
      }
      const [value, afterValue] = readJsonValue(text, cursor + 1);
      if (Object.hasOwn(object, key)) {
        throw new FlightError(`a duplicate key ${JSON.stringify(key)}`);
      }
      object[key] = value;
      cursor = skipWhitespace(text, afterValue);
      if (text[cursor] === ',') {
        cursor = skipWhitespace(text, cursor + 1);
        continue;
      }
      if (text[cursor] === '}') {
        return [object, cursor + 1];
      }
      throw new FlightError(`expected , or } at ${cursor}`);
    }
  }
  for (const [word, value] of [
    ['true', true],
    ['false', false],
    ['null', null],
  ] as const) {
    if (text.startsWith(word, position)) {
      return [value, position + word.length];
    }
  }
  numberPattern.lastIndex = position;
  const match = numberPattern.exec(text);
  if (match) {
    return [new JsonNumber(match[0]), position + match[0].length];
  }
  throw new FlightError(`an unexpected character at ${position}`);
}

/** Parses a whole JSON document, keeping numbers as text. */
export function parseJson(text: string): JsonValue {
  const [value, end] = readJsonValue(text, 0);
  if (skipWhitespace(text, end) !== text.length) {
    throw new FlightError('trailing content after the JSON value');
  }
  return value;
}

const pushPattern = /^\s*self\.__next_f\.push\(([\s\S]*)\)\s*;?\s*$/;
const initPattern =
  /^\s*\(self\.__next_f\s*=\s*self\.__next_f\s*\|\|\s*\[\]\)\.push\(\[0\]\)\s*;?\s*$/;

/**
 * Joins the payload chunks of a page's inline scripts. Scripts that are not
 * payload pushes are ignored; a push that is not `[1, "<text>"]` (the
 * bootstrap `[0]`, or form state `[2, …]`) carries no rows.
 */
export function joinPayload(scripts: readonly string[]): string {
  const chunks: string[] = [];
  for (const script of scripts) {
    if (initPattern.test(script)) {
      continue;
    }
    const match = pushPattern.exec(script);
    if (!match) {
      continue;
    }
    const argument = parseJson(match[1]);
    if (
      Array.isArray(argument) &&
      argument.length === 2 &&
      argument[0] instanceof JsonNumber &&
      argument[0].text === '1' &&
      typeof argument[1] === 'string'
    ) {
      chunks.push(argument[1]);
    }
  }
  return chunks.join('');
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) {
    return 1;
  }
  if (codePoint < 0x800) {
    return 2;
  }
  if (codePoint < 0x10000) {
    return 3;
  }
  return 4;
}

/** The index just past `byteLength` UTF-8 bytes of `text` from `start`. */
function advanceBytes(text: string, start: number, byteLength: number): number {
  let bytes = 0;
  let position = start;
  while (bytes < byteLength) {
    const codePoint = text.codePointAt(position);
    if (codePoint === undefined) {
      throw new FlightError('a text row runs past the end of the payload');
    }
    bytes += utf8Length(codePoint);
    position += codePoint > 0xffff ? 2 : 1;
  }
  if (bytes !== byteLength) {
    throw new FlightError('a text row ends inside a character');
  }
  return position;
}

export interface FlightRow {
  readonly id: string;
  readonly value: JsonValue;
}

const jsonStart = /[[{"0-9tfn-]/;

/**
 * Splits a payload into its rows and parses the JSON ones. Text rows are
 * returned as strings. Rows with any other tag are skipped.
 */
export function readFlightRows(payload: string): FlightRow[] {
  const rows: FlightRow[] = [];
  let position = 0;
  while (position < payload.length) {
    if (payload[position] === '\n') {
      position += 1;
      continue;
    }
    const colon = payload.indexOf(':', position);
    if (colon === -1) {
      throw new FlightError(`a row without an id at ${position}`);
    }
    const id = payload.slice(position, colon);
    if (!/^[0-9a-f]*$/.test(id)) {
      throw new FlightError(`a malformed row id ${JSON.stringify(id)}`);
    }
    const start = colon + 1;
    const tag = payload[start];
    if (tag === 'T') {
      const comma = payload.indexOf(',', start);
      const length = payload.slice(start + 1, comma);
      if (comma === -1 || !/^[0-9a-f]+$/.test(length)) {
        throw new FlightError(`a malformed text row ${JSON.stringify(id)}`);
      }
      const end = advanceBytes(payload, comma + 1, parseInt(length, 16));
      rows.push({ id, value: payload.slice(comma + 1, end) });
      position = end;
      continue;
    }
    if (tag !== undefined && jsonStart.test(tag)) {
      const [value, end] = readJsonValue(payload, start);
      if (end < payload.length && payload[end] !== '\n') {
        throw new FlightError(`row ${JSON.stringify(id)} does not end a line`);
      }
      rows.push({ id, value });
      position = end;
      continue;
    }
    const newline = payload.indexOf('\n', start);
    position = newline === -1 ? payload.length : newline + 1;
  }
  return rows;
}

/** A React element as the payload writes it: `["$", type, key, props]`. */
export interface FlightElement {
  readonly type: string;
  readonly key: string | null;
  readonly props: JsonObject;
}

export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof JsonNumber)
  );
}

export function asElement(value: JsonValue): FlightElement | null {
  if (
    Array.isArray(value) &&
    value.length === 4 &&
    value[0] === '$' &&
    typeof value[1] === 'string' &&
    (value[2] === null || typeof value[2] === 'string') &&
    isJsonObject(value[3])
  ) {
    return { type: value[1], key: value[2], props: value[3] };
  }
  return null;
}

const referencePattern = /^\$L?([0-9a-f]+)$/;

/**
 * Visits every value under `root` depth-first, in document order. A string
 * that references another row (`"$L3f"`, `"$33"`) is followed into that row,
 * once, so content split across rows is still found.
 */
export function walk(
  root: JsonValue,
  rows: ReadonlyMap<string, JsonValue>,
  visit: (value: JsonValue) => void,
): void {
  const followed = new Set<string>();
  const stack: JsonValue[] = [root];
  while (stack.length > 0) {
    const value = stack.pop() as JsonValue;
    visit(value);
    if (typeof value === 'string') {
      const reference = referencePattern.exec(value);
      if (reference && rows.has(reference[1]) && !followed.has(reference[1])) {
        followed.add(reference[1]);
        stack.push(rows.get(reference[1]) as JsonValue);
      }
    } else if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push(value[index]);
      }
    } else if (isJsonObject(value)) {
      const values = Object.values(value);
      for (let index = values.length - 1; index >= 0; index -= 1) {
        stack.push(values[index]);
      }
    }
  }
}
