import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

import { createBrevoProvider } from '../src/server/email/providers/brevo.ts';
import { createFlagService } from '../src/server/flags/service.ts';
import { createPartnerBrevoSync } from '../src/server/partner/brevo-sync.ts';
import type { Alert } from '../src/server/verification-rate/p1-webhook.ts';

import {
  createPartnerFixture,
  insertPartner,
  insertReferral,
  partnerErasure,
  type PartnerFixture,
} from './helpers/partner-review-fixture.ts';

const clock = () => new Date('2026-11-22T12:00:00.000Z');
const listId = 27;
const attributeDefinitions = [
  ['PARTNER_ID', 'text'],
  ['FULL_NAME', 'text'],
  ['STATUS', 'text'],
  ['PARTNER_TYPE', 'text'],
  ['CODE', 'text'],
  ['CONTRACT_SIGNED_AT', 'text'],
  ['CONTRACT_VERSION', 'text'],
  ['CONFIRMED_REFERRALS', 'float'],
  ['PENDING_REFERRALS', 'float'],
  ['MARKETING_CONSENT', 'boolean'],
].map(([name, type]) => ({ name, type, category: 'normal' }));

interface Contact {
  readonly ext_id: string;
  readonly email: string;
  readonly listIds: readonly number[];
  readonly updateEnabled: boolean;
  readonly attributes: Record<string, unknown>;
}

function harness(fixture: PartnerFixture) {
  const contacts = new Map<string, Contact>();
  const upserts: string[] = [];
  const removals: string[] = [];
  const deletes: string[] = [];
  const alerts: Alert[] = [];
  const hooks: {
    beforeUpsert: (id: string) => Promise<void>;
    upsertStatus: number;
    missingAttribute: boolean;
  } = {
    beforeUpsert: async () => {},
    upsertStatus: 204,
    missingAttribute: false,
  };
  const provider = createBrevoProvider(
    'test-key',
    'mail.valstara.com',
    listId,
    {
      async fetch(input, init) {
        const url = new URL(String(input));
        assert.equal(url.origin, 'https://api.brevo.com');
        if (url.pathname === '/v3/contacts/attributes') {
          assert.equal(init?.method, 'GET');
          return Response.json({
            attributes: hooks.missingAttribute
              ? attributeDefinitions.slice(1)
              : attributeDefinitions,
          });
        }
        if (url.pathname === '/v3/contacts') {
          assert.equal(init?.method, 'POST');
          const contact = JSON.parse(String(init?.body)) as Contact;
          upserts.push(contact.ext_id);
          await hooks.beforeUpsert(contact.ext_id);
          contacts.set(contact.ext_id, contact);
          return new Response(null, { status: hooks.upsertStatus });
        }
        const id = decodeURIComponent(
          url.pathname.replace('/v3/contacts/', ''),
        );
        assert.equal(url.searchParams.get('identifierType'), 'ext_id');
        if (init?.method === 'PUT') {
          assert.deepEqual(JSON.parse(String(init.body)), {
            unlinkListIds: [listId],
          });
          removals.push(id);
        } else {
          assert.equal(init?.method, 'DELETE');
          deletes.push(id);
        }
        return new Response(null, { status: contacts.delete(id) ? 204 : 404 });
      },
    },
  );
  const flags = createFlagService(fixture.app);
  const transport = {
    send: async (alert: Alert) => {
      alerts.push(alert);
    },
  };
  const newJob = () =>
    createPartnerBrevoSync(
      fixture.app,
      flags,
      { listId, provider },
      transport,
      clock,
    );
  return {
    contacts,
    upserts,
    removals,
    deletes,
    alerts,
    hooks,
    newJob,
    missingTarget: () =>
      createPartnerBrevoSync(fixture.app, flags, null, transport, clock),
    enable: () => flags.set('partners.brevo_sync', true, 'admin.operator'),
    erasure: partnerErasure(fixture, (email) => provider.deleteContact(email)),
  };
}

async function suppress(fixture: PartnerFixture, email: string) {
  await fixture.owner.execute({
    text: `INSERT INTO suppression (email_normalised, reason, source) VALUES ($1, 'manual', 'test')`,
    values: [email],
  });
}

test('the partner sync uses the dedicated list and only the approved contact fields', async (t) => {
  const fixture = await createPartnerFixture('partner-sync-fields');
  t.after(() => fixture.dispose());
  const h = harness(fixture);
  const active = await insertPartner(fixture, {
    status: 'active',
    email: 'Maya.Partner@Example.test',
    fullName: 'Maya Partner',
    partnerType: 'student_ambassador',
    code: 'MAYA',
    marketing: true,
  });
  const paused = await insertPartner(fixture, { status: 'paused' });
  const terminated = await insertPartner(fixture, { status: 'terminated' });
  await insertPartner(fixture, { status: 'contract_sent' });
  const suppressed = await insertPartner(fixture, { status: 'active' });
  await suppress(fixture, suppressed.email);
  await insertReferral(fixture, active.subscriberId);
  await insertReferral(fixture, active.subscriberId, { state: 'attributed' });
  await insertReferral(fixture, active.subscriberId, { voided: true });
  await insertReferral(fixture, active.subscriberId, {
    state: 'attributed',
    voided: true,
  });

  const job = h.newJob();
  assert.deepEqual(await job.run(), {
    state: 'disabled',
    selected: 0,
    upserted: 0,
    removed: 0,
    failed: 0,
  });
  assert.deepEqual(h.upserts, []);
  await h.enable();
  assert.deepEqual(await job.run(), {
    state: 'completed',
    selected: 3,
    upserted: 3,
    removed: 0,
    failed: 0,
  });
  assert.deepEqual(
    [...h.contacts.keys()].sort(),
    [active.email.toLowerCase(), paused.email, terminated.email].sort(),
  );
  assert.deepEqual(h.contacts.get(active.email.toLowerCase()), {
    ext_id: active.email.toLowerCase(),
    email: active.email,
    listIds: [listId],
    updateEnabled: true,
    attributes: {
      PARTNER_ID: active.id,
      FULL_NAME: 'Maya Partner',
      STATUS: 'active',
      PARTNER_TYPE: 'student_ambassador',
      CODE: 'MAYA',
      CONTRACT_SIGNED_AT: '2026-11-02',
      CONTRACT_VERSION: 'v1',
      CONFIRMED_REFERRALS: 1,
      PENDING_REFERRALS: 1,
      MARKETING_CONSENT: true,
    },
  });
  assert.equal(
    h.contacts.get(paused.email)?.attributes.MARKETING_CONSENT,
    false,
  );
  assert.equal(
    (await job.run()).selected,
    0,
    'successful payloads are applied only once',
  );

  await insertReferral(fixture, active.subscriberId);
  await suppress(fixture, paused.email);
  assert.deepEqual(await h.newJob().run(), {
    state: 'completed',
    selected: 2,
    upserted: 1,
    removed: 1,
    failed: 0,
  });
  assert.equal(
    h.contacts.get(active.email.toLowerCase())?.attributes.CONFIRMED_REFERRALS,
    2,
  );
  assert.deepEqual(h.removals, [paused.email]);
  assert.deepEqual(h.deletes, [], 'losing eligibility unlinks only this list');
  assert.equal((await job.run()).selected, 0);
});

test('partner sync bounds each pass, refuses missing configuration, and retries unapplied changes', async (t) => {
  const fixture = await createPartnerFixture('partner-sync-retry');
  t.after(() => fixture.dispose());
  const h = harness(fixture);
  const partners = await Promise.all([
    insertPartner(fixture, { status: 'active' }),
    insertPartner(fixture, { status: 'paused' }),
    insertPartner(fixture, { status: 'terminated' }),
  ]);
  await h.enable();
  assert.equal(
    (await h.missingTarget().runOnDemand('admin.operator')).state,
    'unavailable',
  );
  assert.deepEqual(h.alerts, [
    {
      event: 'brevo_contact_sync_failed',
      severity: 'P2',
      occurredAt: clock(),
      detail: { code: 'partner_sync_unavailable' },
    },
  ]);

  const job = h.newJob();
  await assert.rejects(job.run(501), RangeError);
  h.hooks.missingAttribute = true;
  assert.equal((await job.run(2)).failed, 2);
  assert.deepEqual(h.upserts, []);
  h.hooks.missingAttribute = false;
  h.hooks.upsertStatus = 503;
  assert.deepEqual(await job.run(2), {
    state: 'unavailable',
    selected: 2,
    upserted: 0,
    removed: 0,
    failed: 2,
  });
  assert.equal(
    await fixture.owner.readOne({
      text: 'SELECT 1 FROM brevo_partner_sync WHERE fingerprint IS NOT NULL',
    }),
    null,
  );
  const [uncertain] = h.upserts;
  assert.ok(uncertain);
  await suppress(fixture, uncertain);

  h.hooks.upsertStatus = 204;
  assert.deepEqual(await h.newJob().run(2), {
    state: 'completed',
    selected: 2,
    upserted: 1,
    removed: 1,
    failed: 0,
  });
  assert.deepEqual(h.removals, [uncertain]);
  assert.deepEqual(await job.run(2), {
    state: 'completed',
    selected: 1,
    upserted: 1,
    removed: 0,
    failed: 0,
  });
  assert.equal((await job.run(2)).selected, 0);
  assert.deepEqual(
    [...h.contacts.keys()].sort(),
    partners
      .map((p) => p.email)
      .filter((email) => email !== uncertain)
      .sort(),
  );
});

test('a fresh partner sync excludes pending and completed signed erasures', async (t) => {
  const fixture = await createPartnerFixture('partner-sync-erasure-fresh');
  t.after(() => fixture.dispose());
  const h = harness(fixture);
  const erased = await insertPartner(fixture, { status: 'paused' });
  const pending = await insertPartner(fixture, { status: 'active' });
  const eligible = await insertPartner(fixture, { status: 'terminated' });
  const confirmErased = await h.erasure.signedConfirmation(erased.subscriberId);
  const confirmPending = await h.erasure.signedConfirmation(
    pending.subscriberId,
  );
  assert.deepEqual(await confirmErased(), { kind: 'pending' });
  assert.equal(await h.erasure.fulfil(), 1);
  assert.deepEqual(await confirmPending(), { kind: 'pending' });
  await h.enable();
  assert.deepEqual(await h.newJob().run(), {
    state: 'completed',
    selected: 1,
    upserted: 1,
    removed: 0,
    failed: 0,
  });
  assert.deepEqual(h.upserts, [eligible.email]);
});

test('the automatic pass finishes an in-flight contact before shutting down', async (t) => {
  const fixture = await createPartnerFixture('partner-sync-automatic');
  t.after(() => fixture.dispose());
  const h = harness(fixture);
  const partner = await insertPartner(fixture, { status: 'active' });
  const shutdown = new AbortController();
  h.hooks.beforeUpsert = async () => {
    shutdown.abort();
  };
  await h.enable();
  await h.newJob().runContinuously(shutdown.signal);
  assert.deepEqual(h.upserts, [partner.email]);
  assert.equal((await h.newJob().run()).selected, 0);
  assert.deepEqual(h.alerts, []);
});

test(
  'signed confirmation cuts off a selected contact and waits for an in-flight upsert',
  { timeout: 25_000 },
  async (t) => {
    const fixture = await createPartnerFixture('partner-sync-erasure-race');
    t.after(() => fixture.dispose());
    const h = harness(fixture);
    const first = await insertPartner(fixture, { status: 'active' });
    const second = await insertPartner(fixture, { status: 'active' });
    const [inFlight, later] =
      first.subscriberId < second.subscriberId
        ? [first, second]
        : [second, first];
    const confirmFirst = await h.erasure.signedConfirmation(
      inFlight.subscriberId,
    );
    const confirmLater = await h.erasure.signedConfirmation(later.subscriberId);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    h.hooks.beforeUpsert = async (id) => {
      if (id !== inFlight.email) return;
      started.resolve();
      await release.promise;
    };
    await h.enable();
    const running = h.newJob().run();
    let confirmation: ReturnType<typeof confirmFirst> | undefined;
    try {
      await Promise.race([
        started.promise,
        running.then(() => {
          throw new Error('Sync did not begin the expected upsert.');
        }),
      ]);
      assert.deepEqual(await confirmLater(), { kind: 'pending' });
      confirmation = confirmFirst();
      let blocked = false;
      for (let attempt = 0; attempt < 150; attempt += 1) {
        if (
          await fixture.owner.readOne({
            text: `SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND query LIKE 'SELECT id, email_normalised, status%'`,
          })
        ) {
          blocked = true;
          break;
        }
        await sleep(10);
      }
      assert.ok(
        blocked,
        'the signed confirmation waits on the provider-held subscriber lock',
      );
    } finally {
      release.resolve();
      await Promise.all([running, confirmation]);
    }

    assert.deepEqual(await confirmation, { kind: 'pending' });
    assert.deepEqual(await running, {
      state: 'completed',
      selected: 2,
      upserted: 1,
      removed: 0,
      failed: 0,
    });
    assert.deepEqual(h.upserts, [inFlight.email]);
    assert.ok(
      h.contacts.has(inFlight.email),
      'the upsert reached Brevo before confirmation',
    );
    assert.equal(
      (await h.newJob().run()).selected,
      0,
      'pending subjects cannot retry',
    );
    assert.equal(await h.erasure.fulfil(), 2);
    assert.deepEqual(h.deletes.sort(), [inFlight.email, later.email].sort());
    assert.equal(h.contacts.size, 0);
    assert.equal(
      await fixture.owner.readOne({ text: 'SELECT 1 FROM brevo_partner_sync' }),
      null,
    );
    assert.equal(
      (await h.newJob().run()).selected,
      0,
      'erased subjects cannot reappear',
    );
  },
);
