import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import {
  eventRegistry,
  validServerProperties,
  type ServerEventName,
} from '../src/server/analytics/registry.ts';
import { createAnalyticsService } from '../src/server/analytics/service.ts';
import { createReferralCaptureService } from '../src/server/referral/capture.ts';

const submitted = {
  source_bucket: 'direct',
  had_ref: false,
  marketing_opt_in: false,
} as const;

test('the whole registry has only finite server properties and the approved client fields', () => {
  assert.deepEqual(Object.keys(eventRegistry), [
    'page_view',
    'signup_submitted',
    'signup_rejected',
    'verified',
    'referral_confirmed',
    'survey_completed',
    'giveaway_entered',
    'unsubscribed',
  ]);
  assert.deepEqual(Object.keys(eventRegistry.page_view.properties), [
    'website',
    'hostname',
    'url',
    'referrer',
    'title',
    'language',
  ]);
  for (const [name, definition] of Object.entries(eventRegistry)) {
    assert.ok(['client', 'server'].includes(definition.source), name);
    for (const [key, property] of Object.entries(definition.properties)) {
      assert.doesNotMatch(
        key,
        /email|ip_address|referral_code|subscriber_id|token|utm|person/iu,
        `${name}.${key}`,
      );
      if (definition.source === 'client') {
        assert.equal(property.kind, 'public_context', `${name}.${key}`);
      } else {
        assert.ok(
          property.kind === 'boolean' || property.kind === 'category',
          `${name}.${key}`,
        );
        if ('allowed' in property) {
          assert.ok(property.allowed.length > 0, `${name}.${key}`);
          assert.equal(
            new Set(property.allowed).size,
            property.allowed.length,
            `${name}.${key}`,
          );
          for (const value of property.allowed) {
            assert.match(value, /^[a-z0-9_-]+$/u, `${name}.${key}`);
          }
        }
      }
    }
  }
});

test('every server schema rejects personal data, unknown keys, and identifiers in category values', () => {
  const privateValues = [
    'person@example.com',
    'ABCDEF123456',
    '198.51.100.24',
    'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  ];
  for (const [name, definition] of Object.entries(eventRegistry)) {
    if (definition.source !== 'server') continue;
    const serverName = name as ServerEventName;
    const valid: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(definition.properties)) {
      valid[key] = property.kind === 'boolean' ? false : property.allowed[0];
    }
    assert.equal(validServerProperties(serverName, valid), true, name);
    assert.equal(
      validServerProperties(serverName, {
        ...valid,
        subscriber_id: privateValues[3],
      }),
      false,
      name,
    );
    for (const [key, property] of Object.entries(definition.properties)) {
      if (property.kind !== 'category') continue;
      for (const privateValue of privateValues) {
        assert.equal(
          validServerProperties(serverName, { ...valid, [key]: privateValue }),
          false,
          `${name}.${key}`,
        );
      }
    }
  }
});

test('the E10-01 emitter payload keys match page_view and never include URL secrets', async () => {
  const source = await readFile(
    new URL('../public/page-view.js', import.meta.url),
    'utf8',
  );
  const requests: string[] = [];
  runInNewContext(source, {
    location: {
      pathname: '/privacy',
      search: '?ref=private-ref&token=private-token',
      hash: '#private-fragment',
      hostname: 'valstara.com',
    },
    document: {
      currentScript: { dataset: { websiteId: 'public-website-id' } },
      referrer: 'https://partner.example/path?email=private@example.com',
      title: 'Privacy',
      documentElement: { lang: 'en' },
    },
    URL,
    fetch(_url: string, options: RequestInit) {
      requests.push(String(options.body));
      return Promise.resolve({ ok: true });
    },
  });
  assert.equal(requests.length, 1);
  const posted = JSON.parse(requests[0]) as {
    payload: Record<string, string>;
  };
  assert.deepEqual(
    Object.keys(posted.payload).sort(),
    Object.keys(eventRegistry.page_view.properties).sort(),
  );
  assert.equal(posted.payload.url, '/privacy');
  assert.equal(posted.payload.referrer, 'https://partner.example');
  assert.doesNotMatch(JSON.stringify(posted), /private|@example\.com/iu);
});

test('unregistered and client-sourced events throw in development and drop in production', async () => {
  const requests: unknown[] = [];
  const send = (async (...args: unknown[]) => {
    requests.push(args);
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const development = createAnalyticsService({
    environment: 'development',
    send,
  });
  const production = createAnalyticsService({
    environment: 'production',
    send,
  });
  const unknownTrack = development.track as (
    name: string,
    props: unknown,
  ) => Promise<void>;
  assert.throws(() => unknownTrack('unknown', submitted), TypeError);
  assert.throws(() => unknownTrack('page_view', {}), TypeError);
  assert.throws(
    () => unknownTrack('signup_submitted', { ...submitted, email: 'a@b.com' }),
    TypeError,
  );
  const productionTrack = production.track as (
    name: string,
    props: unknown,
  ) => Promise<void>;
  await Promise.all([
    productionTrack('unknown', submitted),
    productionTrack('page_view', {}),
    productionTrack('signup_submitted', { ...submitted, email: 'a@b.com' }),
  ]);
  await Promise.resolve();
  assert.equal(requests.length, 0);
});

test('track settles before collector I/O and makes one attempt even when the collector fails', async () => {
  let attempts = 0;
  let rejectRequest: ((reason: Error) => void) | undefined;
  const send = ((_url: string, options: RequestInit) => {
    attempts += 1;
    const posted = JSON.parse(String(options.body)) as {
      payload: { name: string; data: Record<string, unknown> };
    };
    assert.equal(posted.payload.name, 'signup_submitted');
    assert.deepEqual(posted.payload.data, submitted);
    return new Promise<Response>((_resolve, reject) => {
      rejectRequest = reject;
    });
  }) as typeof fetch;
  const analytics = createAnalyticsService({ environment: 'production', send });
  await analytics.track('signup_submitted', submitted);
  assert.equal(attempts, 1);
  assert.ok(rejectRequest !== undefined);
  rejectRequest(new Error('collector down'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(attempts, 1);

  const syncFailure = createAnalyticsService({
    environment: 'production',
    send: (() => {
      throw new Error('collector down synchronously');
    }) as typeof fetch,
  });
  await assert.doesNotReject(syncFailure.track('signup_submitted', submitted));
});

test('UTM capture happens on the server with the referral envelope', () => {
  const capture = createReferralCaptureService(
    'analytics-capture-test-secret',
    {
      clock: () => new Date('2026-10-06T00:00:00.000Z'),
    },
  );
  const landing = capture.capture(
    new URL(
      'https://valstara.com/?ref=ABCDEF123456&utm_source=mail&utm_campaign=launch',
    ),
  );
  assert.deepEqual(capture.verifyRef(capture.signRef(landing)), {
    ref: 'ABCDEF123456',
    utm: { source: 'mail', campaign: 'launch' },
  });
  assert.deepEqual(
    capture.verifyRef(
      capture.signRef(capture.capture(new URL('https://valstara.com/'))),
    ),
    { ref: null, utm: null },
  );
});
