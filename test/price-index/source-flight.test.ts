import assert from 'node:assert/strict';
import test from 'node:test';

import {
  asElement,
  FlightError,
  joinPayload,
  JsonNumber,
  parseJson,
  readFlightRows,
  walk,
  type JsonValue,
} from '../../packages/price-index/src/sources/youfundceo/flight.ts';

// E11.6-05: the reader of the source's embedded React Server Components
// payload. Its JSON tokenizer keeps every number as text, so a price never
// passes through a float on its way to the money module (epic rule 3).

test('numbers keep their exact source text, never a float', () => {
  const value = parseJson(
    '{"amount":932.5,"big":9007199254740993.01,"usd":16.78,"zero":0,"exp":1e-7}',
  ) as Record<string, JsonValue>;
  for (const [key, text] of [
    ['amount', '932.5'],
    ['big', '9007199254740993.01'],
    ['usd', '16.78'],
    ['zero', '0'],
    ['exp', '1e-7'],
  ]) {
    assert.ok(value[key] instanceof JsonNumber, key);
    assert.equal((value[key] as JsonNumber).text, text, key);
  }
});

test('strings, literals, arrays and nested objects read exactly', () => {
  const value = parseJson(
    ' ["kr\\u00a0169", "a\\"b\\\\c\\n", true, false, null, [], {}, {"a":[1,{"b":"c"}]}] ',
  );
  assert.ok(Array.isArray(value));
  assert.equal(value[0], 'kr 169');
  assert.equal(value[1], 'a"b\\c\n');
  assert.deepEqual(value.slice(2, 5), [true, false, null]);
  assert.deepEqual(value[5], []);
  assert.equal(Object.keys(value[6] as object).length, 0);
  const nested = value[7] as Record<string, JsonValue[]>;
  assert.equal((nested.a[0] as JsonNumber).text, '1');
  assert.equal((nested.a[1] as Record<string, string>).b, 'c');
});

test('a key named __proto__ is an own property, not a prototype', () => {
  const value = parseJson('{"__proto__":{"polluted":true}}') as Record<
    string,
    JsonValue
  >;
  assert.ok(Object.hasOwn(value, '__proto__'));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('malformed JSON is refused with a FlightError', () => {
  for (const text of [
    '',
    '{',
    '[1,]',
    '{"a" 1}',
    '{"a":1,"a":2}',
    '"unterminated',
    '[1] trailing',
    'NaN',
    '01',
  ]) {
    assert.throws(() => parseJson(text), FlightError, JSON.stringify(text));
  }
});

test('the payload is joined from push scripts only, skipping the bootstrap and other scripts', () => {
  const payload = joinPayload([
    '(self.__next_f=self.__next_f||[]).push([0])',
    'self.__next_f.push([1,"1:\\"a\\"\\n"])',
    'self.__next_f.push([2,"form state"])',
    'window.other = 1',
    'self.__next_f.push([1,"2:[\\"$\\",\\"li\\",\\"k\\",{}]\\n"])',
  ]);
  assert.equal(payload, '1:"a"\n2:["$","li","k",{}]\n');
});

test('rows are split by id, text rows by their UTF-8 byte length, other tags skipped', () => {
  // "é" is two UTF-8 bytes and "€" three, so `T9,` is "é€a" plus "bcd";
  // a text row is not followed by a newline.
  const rows = readFlightRows(
    '1:I[1,["$2"],"Price"]\n:HL["/a.css","style"]\n2:T9,é€abcd3:{"p":1}\n4:X\n1a:300\n',
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ['2', '3', '1a'],
  );
  assert.equal(rows[0].value, 'é€abcd');
  assert.equal(
    ((rows[1].value as Record<string, JsonValue>).p as JsonNumber).text,
    '1',
  );
  assert.equal((rows[2].value as JsonNumber).text, '300');
});

test('a malformed payload is refused', () => {
  for (const payload of [
    'nocolon',
    'zz:{"a":1}\n',
    '1:T5,ab',
    '1:Tzz,abc',
    '1:{"a":1}2:{}',
  ]) {
    assert.throws(() => readFlightRows(payload), FlightError, payload);
  }
  // A two-byte character cut by the length is refused, not split.
  assert.throws(() => readFlightRows('1:T1,é'), FlightError);
});

test('walk visits in document order and follows a row reference once', () => {
  const rows = readFlightRows(
    '5:["$","li","b-month",{"data-name":"b"}]\n6:["$","ol",null,{"children":[["$","li","a-month",{"data-name":"a"}],"$L5","$5","$undefined"]}]\n',
  );
  const byId = new Map(rows.map((row) => [row.id, row.value]));
  const keys: (string | null)[] = [];
  walk(byId.get('6') as JsonValue, byId, (value) => {
    const element = asElement(value);
    if (element?.type === 'li') {
      keys.push(element.key);
    }
  });
  assert.deepEqual(keys, ['a-month', 'b-month']);
});

test('asElement recognises only ["$", type, key, props]', () => {
  const element = asElement(parseJson('["$","li","k",{"a":"b"}]'));
  assert.equal(element?.type, 'li');
  assert.equal(element?.key, 'k');
  assert.equal(element?.props.a, 'b');
  assert.equal(asElement(parseJson('["$","li","k"]')), null);
  assert.equal(asElement(parseJson('["x","li","k",{}]')), null);
  assert.equal(asElement(parseJson('["$","li",1,{}]')), null);
});
