// E11.7-06: `partners export`, the founder review CSV,
// against a real database. The Tests line: the export's columns, paging and
// audit. The CSV is read back through the real admin route.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { APIContext } from 'astro';

import { createPartnerExportRoute } from '../src/pages/api/admin/partners/export.csv.ts';
import { createAuditService } from '../src/server/audit/service.ts';
import {
  openPartnerExportSnapshot,
  partnerExportBatchSize,
  type PartnerExportSnapshot,
} from '../src/server/db/partner-review.ts';
import {
  createPartnerExportService,
  createPartnerExportServiceWithSnapshot,
  partnerExportColumns,
} from '../src/server/partner/export.ts';

import {
  createPartnerFixture,
  insertPartner,
  insertReferral,
  partnerErasure,
  type PartnerFixture,
} from './helpers/partner-review-fixture.ts';

const actor = 'admin.operator';

async function withFixture(
  run: (fixture: PartnerFixture) => Promise<void>,
): Promise<void> {
  const fixture = await createPartnerFixture('e11-7-06-export-test');
  try {
    await run(fixture);
  } finally {
    await fixture.dispose();
  }
}

/** Minimal CSV parsing for the fields this export writes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\r' && text[index + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
    } else field += character;
  }
  assert.equal(field, '');
  assert.equal(row.length, 0, 'every row ends with CRLF');
  return rows;
}

async function exportThroughRoute(fixture: PartnerFixture): Promise<Response> {
  const route = createPartnerExportRoute(
    createPartnerExportService(fixture.app, createAuditService(fixture.app)),
  );
  return route({
    locals: { adminActor: actor },
  } as unknown as APIContext) as Promise<Response>;
}

test("the export's columns: one row per contracted partner, in the founder's order, with no referred person's data", async () => {
  await withFixture(async (fixture) => {
    const active = await insertPartner(fixture, {
      status: 'active',
      fullName: 'Maya "MJ" Example, Jr',
      email: 'Maya.Partner@Example.test',
      marketing: true,
      partnerType: 'student_ambassador',
      code: 'MAYAJ',
    });
    const paused = await insertPartner(fixture, { status: 'paused' });
    const terminated = await insertPartner(fixture, { status: 'terminated' });
    // Not contracted, purged or suppressed: never exported.
    for (const status of [
      'applied',
      'approved',
      'contract_sent',
      'rejected',
      'unconfirmed',
    ] as const)
      await insertPartner(fixture, { status });
    const purged = await insertPartner(fixture, { status: 'terminated' });
    await fixture.owner.execute({
      text: `UPDATE partner SET subscriber_id = NULL, confirmation_token_id = NULL,
          full_name = NULL, country_of_residence = NULL, channels = NULL,
          handles = NULL, audience_size = NULL, promotion_plan = NULL,
          requested_code = NULL, university = NULL, student_email = NULL,
          company_name = NULL, age_confirmed = NULL,
          programme_terms_agreed = NULL, personal_data_purged_at = now()
        WHERE id = $1`,
      values: [purged.id],
    });
    const suppressed = await insertPartner(fixture, { status: 'active' });
    await fixture.owner.execute({
      text: `INSERT INTO suppression (email_normalised, reason, source)
        SELECT email_normalised, 'unsubscribe', 'test' FROM subscriber WHERE id = $1`,
      values: [suppressed.subscriberId],
    });

    // Referrals: two confirmed, one pending, one voided confirmed. Only the
    // counts are exported.
    const friends = [
      await insertReferral(fixture, active.subscriberId, {
        email: 'friend-a@example.test',
      }),
      await insertReferral(fixture, active.subscriberId, {
        email: 'friend-b@example.test',
      }),
      await insertReferral(fixture, active.subscriberId, {
        state: 'attributed',
        email: 'friend-c@example.test',
      }),
      await insertReferral(fixture, active.subscriberId, {
        voided: true,
        email: 'friend-d@example.test',
      }),
    ];
    await fixture.owner.execute({
      text: `UPDATE partner SET notes = 'Private founder note', country_of_residence = 'FI'
        WHERE id = $1`,
      values: [active.id],
    });

    const response = await exportThroughRoute(fixture);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get('Content-Type'),
      'text/csv; charset=utf-8',
    );
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.match(
      response.headers.get('Content-Disposition') ?? '',
      /^attachment; filename="valstara-partners\.csv"$/u,
    );
    const text = await response.text();
    const [header, ...rows] = parseCsv(text);
    assert.deepEqual(header, [
      'EMAIL',
      'EXT_ID',
      'PARTNER_ID',
      'FULL_NAME',
      'STATUS',
      'PARTNER_TYPE',
      'CODE',
      'CONTRACT_SIGNED_AT',
      'CONTRACT_VERSION',
      'CONFIRMED_REFERRALS',
      'PENDING_REFERRALS',
      'MARKETING_CONSENT',
    ]);
    assert.deepEqual(header, [...partnerExportColumns]);
    assert.deepEqual(
      rows.map((row) => row[2]).sort(),
      [active.id, paused.id, terminated.id].sort(),
    );
    const maya = rows.find((row) => row[2] === active.id);
    assert.deepEqual(maya, [
      'Maya.Partner@Example.test',
      // EXT_ID is the linked member's normalised email, as the Brevo sync uses.
      'maya.partner@example.test',
      active.id,
      'Maya "MJ" Example, Jr',
      'active',
      'student_ambassador',
      'MAYAJ',
      '2026-11-02',
      'v1',
      '2',
      '1',
      'true',
    ]);
    assert.equal(rows.find((row) => row[2] === paused.id)?.[11], 'false');
    // No country, application answers, notes or referred person's data.
    assert.equal(
      rows.some((row) => row.includes('FI')),
      false,
      'country',
    );
    for (const absent of [
      'Private founder note',
      'Short videos.',
      '@handle',
      ...friends.map((friend) => friend.email),
      ...friends.map((friend) => friend.referredId),
    ]) {
      assert.equal(text.includes(absent), false, absent);
    }
  });
});

test('a fresh review export excludes pending and completed erasures', async () => {
  await withFixture(async (fixture) => {
    const erased = await insertPartner(fixture, { status: 'active' });
    const pending = await insertPartner(fixture, { status: 'paused' });
    const eligible = await insertPartner(fixture, { status: 'terminated' });
    const erasure = partnerErasure(fixture, async () => {});
    const confirmErased = await erasure.signedConfirmation(erased.subscriberId);
    const confirmPending = await erasure.signedConfirmation(
      pending.subscriberId,
    );
    assert.deepEqual(await confirmErased(), { kind: 'pending' });
    assert.equal(await erasure.fulfil(), 1);
    assert.deepEqual(await confirmPending(), { kind: 'pending' });
    const response = await exportThroughRoute(fixture);
    assert.equal(response.status, 200);
    const [header, ...rows] = parseCsv(await response.text());
    assert.deepEqual(header, [...partnerExportColumns]);
    assert.deepEqual(
      rows.map((row) => row[2]),
      [eligible.id],
    );
  });
});

test("the export's paging: it streams pages of at most 500 rows from one snapshot", async () => {
  await withFixture(async (fixture) => {
    const total = 2 * partnerExportBatchSize + 7;
    const at = new Date('2026-11-01T09:00:00.000Z');
    await fixture.owner.execute({
      text: `INSERT INTO subscriber (id, email, email_normalised, email_domain,
          status, created_at, verified_at, referral_code)
        SELECT gen_random_uuid(), 'page' || n || '@example.test',
          'page' || n || '@example.test', 'example.test', 'verified',
          $1, $1, 'G' || lpad(n::text, 11, '0')
        FROM generate_series(1, $2::int) AS n`,
      values: [at, total],
    });
    await fixture.owner.execute({
      text: `INSERT INTO partner (id, subscriber_id, status, status_changed_at,
          submitted_at, applied_at, full_name, country_of_residence,
          partner_type, channels, handles, audience_size, promotion_plan,
          requested_code, age_confirmed, programme_terms_agreed,
          contract_sent_at, contract_signed_at, contract_version)
        SELECT gen_random_uuid(), id, 'active', $1, $1, $1, 'Paged partner',
          'SE', 'standard', ARRAY['other'], ARRAY['@x'], 'under_1k', 'Plan',
          'PAGE', true, true, $1, '2026-11-01', 'v1'
        FROM subscriber WHERE email LIKE 'page%@example.test'`,
      values: [at],
    });

    const pages: { limit: number; rows: number }[] = [];
    let closed = 0;
    const service = createPartnerExportServiceWithSnapshot(async () => {
      const snapshot = await openPartnerExportSnapshot(fixture.app);
      const recorded: PartnerExportSnapshot = {
        rowCount: snapshot.rowCount,
        async page(afterId, limit) {
          const rows = await snapshot.page(afterId, limit);
          pages.push({ limit, rows: rows.length });
          return rows;
        },
        async close() {
          closed += 1;
          await snapshot.close();
        },
      };
      return recorded;
    }, createAuditService(fixture.app));

    // Rows written after the snapshot opened are not in this export.
    const stream = await service.open(actor);
    await insertPartner(fixture, { status: 'active' });
    const text = await new Response(stream).text();
    const rows = parseCsv(text).slice(1);
    assert.equal(rows.length, total);
    assert.equal(new Set(rows.map((row) => row[2])).size, total);
    assert.deepEqual(pages, [
      { limit: partnerExportBatchSize, rows: partnerExportBatchSize },
      { limit: partnerExportBatchSize, rows: partnerExportBatchSize },
      { limit: partnerExportBatchSize, rows: 7 },
    ]);
    assert.ok(closed >= 1);

    // The snapshot refuses a page larger than the batch cap.
    const snapshot = await openPartnerExportSnapshot(fixture.app);
    try {
      await assert.rejects(
        snapshot.page(null, partnerExportBatchSize + 1),
        RangeError,
      );
    } finally {
      await snapshot.close();
    }
  });
});

test("the export's audit: the row count is recorded before the first byte, and a failed audit fails closed", async () => {
  await withFixture(async (fixture) => {
    await insertPartner(fixture, { status: 'active' });
    await insertPartner(fixture, { status: 'paused' });
    await insertPartner(fixture, { status: 'applied' });

    const service = createPartnerExportService(
      fixture.app,
      createAuditService(fixture.app),
    );
    const stream = await service.open(actor);
    // Audited already, before any byte is read.
    const audit = await fixture.owner.list<{
      action: string;
      actor: string;
      subject_type: string;
      detail: Record<string, unknown>;
    }>(
      {
        text: `SELECT action, actor, subject_type, detail FROM audit_log
          WHERE action = 'partner.exported'`,
      },
      10,
    );
    assert.deepEqual(audit, [
      {
        action: 'partner.exported',
        actor,
        subject_type: 'export',
        detail: { row_count: 2, page_size: partnerExportBatchSize },
      },
    ]);
    assert.equal(parseCsv(await new Response(stream).text()).length, 3);

    // The audit write fails: no stream, and the snapshot is released.
    let closed = false;
    const failing = createPartnerExportServiceWithSnapshot(
      async () => {
        const snapshot = await openPartnerExportSnapshot(fixture.app);
        return {
          rowCount: snapshot.rowCount,
          page: (afterId, limit) => snapshot.page(afterId, limit),
          async close() {
            closed = true;
            await snapshot.close();
          },
        };
      },
      {
        async record() {
          throw new Error('audit unavailable');
        },
      },
    );
    await assert.rejects(failing.open(actor), /audit unavailable/u);
    assert.equal(closed, true);
    // A system actor never exports.
    await assert.rejects(service.open('system:cron'), /human export actor/u);

    // Through the route, a failure is the closed envelope with no detail.
    const route = createPartnerExportRoute(failing);
    const response = (await route({
      locals: { adminActor: actor },
    } as unknown as APIContext)) as Response;
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: {
        code: 'internal',
        message: 'The partners export is temporarily unavailable.',
      },
    });
  });
});
