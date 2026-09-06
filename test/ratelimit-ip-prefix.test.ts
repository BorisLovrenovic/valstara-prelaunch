import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  hashedIpPrefix,
  truncatedIpPrefix,
} from '../src/server/ratelimit/ip-prefix.ts';

const pepper = 'ip-prefix-unit-test-pepper';

test('IPv4 is truncated to its /24 network before hashing', () => {
  assert.equal(truncatedIpPrefix('198.51.100.42'), '198.51.100.0/24');
  // Two hosts in the same /24 share one key; a third /24 does not.
  assert.equal(
    hashedIpPrefix('198.51.100.42', pepper),
    hashedIpPrefix('198.51.100.7', pepper),
  );
  assert.notEqual(
    hashedIpPrefix('198.51.100.42', pepper),
    hashedIpPrefix('203.0.113.42', pepper),
  );
});

test('IPv6 is truncated to its /64 network before hashing', () => {
  assert.equal(
    truncatedIpPrefix('2001:db8:1234:5678:9abc:def0:1234:5678'),
    '2001:db8:1234:5678::/64',
  );
  assert.equal(
    hashedIpPrefix('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd', pepper),
    hashedIpPrefix('2001:db8:1234:5678:1111:2222:3333:4444', pepper),
  );
});

test('a non-IP input yields null rather than a key', () => {
  assert.equal(truncatedIpPrefix('not-an-ip'), null);
  assert.equal(truncatedIpPrefix(''), null);
  assert.equal(hashedIpPrefix('not-an-ip', pepper), null);
});

test('the key is the HMAC of the truncated prefix — never the full address', () => {
  const full = '198.51.100.42';
  const key = hashedIpPrefix(full, pepper);
  assert.equal(
    key,
    createHmac('sha256', pepper).update('198.51.100.0/24').digest('hex'),
  );
  // The pepper changes the key; a full address never appears in it.
  assert.notEqual(key, hashedIpPrefix(full, 'a-different-pepper'));
  assert.doesNotMatch(key ?? '', /198\.51\.100\.42/u);
});
