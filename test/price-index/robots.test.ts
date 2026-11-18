import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parseRobots } from '../../packages/price-index/src/http/robots.ts';
import { isPathOpenable } from '../../packages/price-index/src/http/request-rule.ts';

// E11.6-04: robots.txt is read for the `*` group only (founder decision 2 of
// 2026-11-17), with longest-match rules and Crawl-delay.

const capturedRobots = new URL(
  '../../packages/price-index/test/fixtures/youfundceo/raw/robots.txt',
  import.meta.url,
);

test("the source's captured robots.txt: the * group allows / and disallows /api/ and /go/", async () => {
  const robots = parseRobots(await readFile(capturedRobots, 'utf8'));
  assert.deepEqual(robots.rules, [
    { allow: true, pattern: '/' },
    { allow: false, pattern: '/api/' },
    { allow: false, pattern: '/go/' },
  ]);
  assert.equal(robots.crawlDelayMilliseconds, null);
  for (const path of [
    '/',
    '/countries/sweden',
    '/services/netflix/sweden',
    '/price-moves',
  ]) {
    assert.equal(robots.isAllowed(path), true, path);
  }
  for (const path of ['/api/prices', '/api/', '/go/netflix', '/go/']) {
    assert.equal(robots.isAllowed(path), false, path);
  }
  // The named AI-agent group disallows everything; it is not the tool's group.
  assert.equal(robots.isAllowed('/countries'), true);
});

test('only the * group applies, even when a named group comes first or shares lines', () => {
  const robots = parseRobots(
    [
      'User-agent: ClaudeBot',
      'Disallow: /',
      '',
      'User-agent: PriceIndexBot',
      'User-agent: *',
      'Disallow: /private/',
      'Crawl-delay: 2.5',
      '',
      'User-agent: GPTBot',
      'Disallow: /services/',
      'Crawl-delay: 99',
    ].join('\n'),
  );
  assert.deepEqual(robots.rules, [{ allow: false, pattern: '/private/' }]);
  assert.equal(robots.crawlDelayMilliseconds, 2500);
  assert.equal(robots.isAllowed('/services/netflix'), true);
  assert.equal(robots.isAllowed('/private/x'), false);
});

test('two * groups combine, and the longer Crawl-delay is kept', () => {
  const robots = parseRobots(
    'User-agent: *\nDisallow: /a/\nCrawl-delay: 5\n\nUser-agent: *\nDisallow: /b/\nCrawl-delay: 30\n',
  );
  assert.equal(robots.isAllowed('/a/1'), false);
  assert.equal(robots.isAllowed('/b/1'), false);
  assert.equal(robots.crawlDelayMilliseconds, 30_000);
});

test('the longest match wins, an Allow wins a tie, and * and $ are honoured', () => {
  const robots = parseRobots(
    [
      'User-agent: *',
      'Disallow: /services/',
      'Allow: /services/netflix',
      'Disallow: /*.json$',
      'Disallow: /tie',
      'Allow: /tie',
      'Disallow: /search?q=*&page=',
    ].join('\n'),
  );
  assert.equal(robots.isAllowed('/services/spotify'), false);
  assert.equal(robots.isAllowed('/services/netflix/sweden'), true);
  assert.equal(robots.isAllowed('/data/prices.json'), false);
  assert.equal(robots.isAllowed('/data/prices.json?x=1'), true);
  assert.equal(robots.isAllowed('/tie'), true);
  assert.equal(robots.isAllowed('/search?q=a&page=2'), false);
  assert.equal(robots.isAllowed('/search?q=a'), true);
});

test('comments, CRLF, case-insensitive keys and an empty Disallow are handled', () => {
  const robots = parseRobots(
    'USER-AGENT: * # everyone\r\nDISALLOW:\r\ndisallow: /x/ # private\r\nCrawl-Delay: soon\r\n',
  );
  assert.deepEqual(robots.rules, [{ allow: false, pattern: '/x/' }]);
  assert.equal(
    robots.crawlDelayMilliseconds,
    null,
    'an unreadable delay is ignored',
  );
  assert.equal(robots.isAllowed('/y'), true);
});

test('percent-encoding compares case-insensitively', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /%7euser/\n');
  assert.equal(robots.isAllowed('/%7Euser/page'), false);
});

test('/api/ and /go/ are never openable, even with no robots.txt or one that allows them', () => {
  const permissive = parseRobots('User-agent: *\nAllow: /api/\nAllow: /go/\n');
  for (const robots of [null, permissive]) {
    assert.equal(isPathOpenable(robots, '/api/x'), false);
    assert.equal(isPathOpenable(robots, '/go/netflix?country=se'), false);
    assert.equal(isPathOpenable(robots, '/countries'), true);
  }
  assert.equal(
    isPathOpenable(
      parseRobots('User-agent: *\nDisallow: /countries/\n'),
      '/countries/sweden',
    ),
    false,
  );
});
