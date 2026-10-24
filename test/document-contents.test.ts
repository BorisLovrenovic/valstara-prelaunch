import assert from 'node:assert/strict';
import test from 'node:test';

import { contentsFromRenderedHtml } from '../src/server/content/contents.ts';

test('every second-level heading with an id becomes one contents entry, in order', () => {
  assert.deepEqual(
    contentsFromRenderedHtml(
      '<h1 id="title">Title</h1><p>Intro</p><h2 id="first">First</h2><h3 id="deep">Deep</h3><h2 id="second">Second</h2>',
    ),
    [
      { id: 'first', text: 'First' },
      { id: 'second', text: 'Second' },
    ],
  );
});

test('a heading without an anchor is never given one', () => {
  assert.deepEqual(
    contentsFromRenderedHtml(
      '<h2>No anchor</h2><h2 class="x">Still none</h2><h2 id="kept">Kept</h2>',
    ),
    [{ id: 'kept', text: 'Kept' }],
  );
  assert.deepEqual(
    contentsFromRenderedHtml('<h1 id="t">Only a title</h1>'),
    [],
  );
  assert.deepEqual(contentsFromRenderedHtml(''), []);
});

test('heading text drops inline markup and decodes entities', () => {
  assert.deepEqual(
    contentsFromRenderedHtml(
      '<h2 id="6-if-a-product-isnt-available">6. If a product isn&#x27;t <em>available</em></h2>' +
        '<h2 id="terms-&amp;-conditions">Terms &amp; conditions &#8212;\n  in&nbsp;full</h2>',
    ),
    [
      {
        id: '6-if-a-product-isnt-available',
        text: "6. If a product isn't available",
      },
      { id: 'terms-&-conditions', text: 'Terms & conditions — in full' },
    ],
  );
});

test('an empty heading produces no entry', () => {
  assert.deepEqual(
    contentsFromRenderedHtml('<h2 id="empty"> <span></span></h2>'),
    [],
  );
});
