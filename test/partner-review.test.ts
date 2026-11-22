// E11.7-06: founder review, contract tracking and lifecycle commands, against
// a real database. The Tests line: the full transition matrix · the audit
// records · the code re-check · contract fields · the stale filter. The
// export's columns, paging and audit are in test/partner-export.test.ts, and
// authentication refusal in test/partner-review-cli.test.ts.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { exportSubject } from '../src/server/dsr/export.ts';
import { createErasureService } from '../src/server/dsr/service.ts';
import { withTransaction } from '../src/server/db/transaction.ts';
import { partnerListPageLimit } from '../src/server/db/partner-review.ts';
import { partnerStaleAfterMs } from '../src/server/partner/config.ts';
import { createPartnerApplicationPurgeJob } from '../src/server/partner/retention.ts';
import {
  createPartnerReviewService,
  partnerApprovedBusinessKey,
  partnerRejectedBusinessKey,
  PartnerReviewInputError,
  PartnerReviewRefusedError,
  partnerStatuses,
  partnerTransitions,
  textDigest,
} from '../src/server/partner/review.ts';
import { createPartnerCodeRules } from '../src/server/referral/partner-code.ts';

import {
  createPartnerFixture,
  insertMember,
  insertPartner,
  insertReferral,
  type PartnerFixture,
} from './helpers/partner-review-fixture.ts';

const DAY_MS = 24 * 60 * 60 * 1_000;
const now = new Date('2026-11-22T12:00:00.000Z');
const actor = 'admin.operator';
const clock = () => now;

async function withFixture(
  run: (fixture: PartnerFixture) => Promise<void>,
): Promise<void> {
  const fixture = await createPartnerFixture('e11-7-06-review-test');
  try {
    await run(fixture);
  } finally {
    await fixture.dispose();
  }
}

async function partnerRow(fixture: PartnerFixture, id: string) {
  const row = await fixture.owner.readOne<Record<string, unknown>>({
    text: `SELECT status, status_changed_at, partner_type, university, notes,
        contract_sent_at, to_char(contract_signed_at, 'YYYY-MM-DD') AS contract_signed_at,
        contract_version, contract_reference
      FROM partner WHERE id = $1`,
    values: [id],
  });
  assert.ok(row);
  return row;
}

async function audits(fixture: PartnerFixture, subjectId: string | null) {
  return fixture.owner.list<{
    action: string;
    actor: string;
    subject_type: string;
    subject_id: string | null;
    detail: Record<string, unknown>;
  }>(
    {
      text: `SELECT action, actor, subject_type, subject_id, detail FROM audit_log
        WHERE action LIKE 'partner.%'
          AND ($1::text IS NULL OR subject_id = $1)
        ORDER BY at, id`,
      values: [subjectId],
    },
    100,
  );
}

async function emails(fixture: PartnerFixture, subscriberId: string) {
  return fixture.owner.list<{ template: string; business_key: string }>(
    {
      text: `SELECT template, business_key FROM email_send
        WHERE subscriber_id = $1 ORDER BY created_at, business_key`,
      values: [subscriberId],
    },
    20,
  );
}

async function refusal(
  promise: Promise<unknown>,
): Promise<PartnerReviewRefusedError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PartnerReviewRefusedError, String(error));
    return error;
  }
  assert.fail('The command was not refused.');
}

const allowed = new Set(
  partnerTransitions.map(([from, to]) => `${from}>${to}`),
);

test('the full transition matrix: the database allows exactly the eleven documented transitions of the 64 pairs', async () => {
  assert.equal(partnerStatuses.length, 8);
  assert.equal(allowed.size, 11);
  await withFixture(async (fixture) => {
    const outcomes: string[] = [];
    for (const from of partnerStatuses) {
      for (const to of partnerStatuses) {
        const partner = await insertPartner(fixture, {
          status: from,
          // Every row holds a registered code, so moving to approved is
          // refused only by the transition rule, never for a missing code.
          code: `M${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`,
        });
        // The write a command would make for the target status, as the
        // application role: the contract record the target carries, and a
        // new status time only for a real move.
        const write = fixture.app.execute({
          text: `UPDATE partner SET
              status = $2,
              status_changed_at = CASE WHEN status = $2 THEN status_changed_at ELSE $3 END,
              applied_at = CASE WHEN $2 = 'unconfirmed' THEN applied_at ELSE COALESCE(applied_at, $3) END,
              contract_sent_at = CASE WHEN $2 IN ('contract_sent', 'active', 'paused', 'terminated')
                THEN COALESCE(contract_sent_at, $3) ELSE contract_sent_at END,
              contract_signed_at = CASE WHEN $2 IN ('active', 'paused', 'terminated')
                THEN COALESCE(contract_signed_at, ($3 AT TIME ZONE 'UTC')::date) ELSE contract_signed_at END,
              contract_version = CASE WHEN $2 IN ('active', 'paused', 'terminated')
                THEN COALESCE(contract_version, 'v1') ELSE contract_version END
            WHERE id = $1`,
          values: [partner.id, to, now],
        });
        const key = `${from}>${to}`;
        if (allowed.has(key)) {
          assert.equal(await write, 1, key);
          assert.equal((await partnerRow(fixture, partner.id)).status, to, key);
          outcomes.push(key);
        } else {
          await assert.rejects(
            write,
            (error: Error) =>
              error.message ===
              `partner status cannot move from ${from} to ${to}`,
            key,
          );
          assert.equal(
            (await partnerRow(fixture, partner.id)).status,
            from,
            key,
          );
        }
      }
    }
    assert.deepEqual(outcomes.sort(), [...allowed].sort());
    assert.equal(outcomes.length + (64 - 11), 64);
  });
});

test('the guard keeps the status time and the contract record honest', async () => {
  await withFixture(async (fixture) => {
    const active = await insertPartner(fixture, { status: 'active' });
    // The status time moves only with the status.
    await assert.rejects(
      fixture.app.execute({
        text: 'UPDATE partner SET status_changed_at = $2 WHERE id = $1',
        values: [active.id, now],
      }),
      /changes only with the status/u,
    );
    // The contract record is written once, by its own transition.
    await assert.rejects(
      fixture.app.execute({
        text: `UPDATE partner SET contract_version = 'v2' WHERE id = $1`,
        values: [active.id],
      }),
      /recorded only by contract-signed/u,
    );
    // Approval needs a registered code.
    const applied = await insertPartner(fixture, { status: 'applied' });
    await assert.rejects(
      fixture.app.execute({
        text: `UPDATE partner SET status = 'approved', status_changed_at = $2 WHERE id = $1`,
        values: [applied.id, now],
      }),
      /registered partner code/u,
    );
    // The application role can no longer write a status outside the guard,
    // and the notes check holds.
    await assert.rejects(
      fixture.app.execute({
        text: `UPDATE partner SET notes = '   ' WHERE id = $1`,
        values: [active.id],
      }),
      /partner_notes/u,
    );
  });
});

test('approve re-runs the code rules: a code taken, blocked or malformed since submission changes nothing', async () => {
  await withFixture(async (fixture) => {
    const service = createPartnerReviewService(fixture.app, clock);
    const partner = await insertPartner(fixture, {
      status: 'applied',
      requestedCode: 'MAYA',
    });
    // Another partner registered MAYA after this application was submitted.
    const other = await insertPartner(fixture, {
      status: 'approved',
      code: 'MAYA',
    });
    assert.notEqual(other.id, partner.id);

    const taken = await refusal(service.approve(partner.id, null, actor));
    assert.equal(taken.refusal, 'code_refused');
    assert.equal(taken.codeReason, 'taken');
    assert.ok(taken.alternatives.length > 0);
    for (const alternative of taken.alternatives) {
      const check = await createPartnerCodeRules(fixture.app).check(
        alternative,
      );
      assert.equal(check.outcome, 'available', alternative);
    }

    const blocked = await refusal(
      service.approve(partner.id, 'netflixdeals', actor),
    );
    assert.equal(blocked.codeReason, 'blocked');
    const malformed = await refusal(service.approve(partner.id, 'ab!', actor));
    assert.equal(malformed.codeReason, 'format');

    // Nothing changed: still applied, no code, no audit, no email.
    assert.equal((await partnerRow(fixture, partner.id)).status, 'applied');
    assert.equal(
      (
        await fixture.owner.readOne<{ n: number }>({
          text: `SELECT count(*)::int AS n FROM referral_code
            WHERE owner_kind = 'partner' AND owner_id = $1`,
          values: [partner.id],
        })
      )?.n,
      0,
    );
    assert.deepEqual(await audits(fixture, partner.id), []);
    assert.deepEqual(await emails(fixture, partner.subscriberId), []);

    // --code chooses an available code: it is registered inactive.
    const approved = await service.approve(partner.id, 'maya2026', actor);
    assert.equal(approved.before.status, 'applied');
    assert.equal(approved.after.status, 'approved');
    assert.equal(approved.after.code, 'MAYA2026');
    assert.equal(approved.after.code_active, false);
    assert.equal(approved.mailQueued, true);
    assert.deepEqual(await emails(fixture, partner.subscriberId), [
      {
        template: 'partner_approved',
        business_key: partnerApprovedBusinessKey(partner.id),
      },
    ]);
    // A second approval is refused by the status, and sends nothing more.
    const again = await refusal(service.approve(partner.id, null, actor));
    assert.equal(again.refusal, 'wrong_status');
    assert.equal((await emails(fixture, partner.subscriberId)).length, 1);
  });
});

test('approve without --code registers the requested code when it still passes', async () => {
  await withFixture(async (fixture) => {
    const service = createPartnerReviewService(fixture.app, clock);
    const partner = await insertPartner(fixture, {
      status: 'applied',
      requestedCode: 'LENA',
    });
    const result = await service.approve(partner.id, null, actor);
    assert.equal(result.after.code, 'LENA');
    const [audit] = await audits(fixture, partner.id);
    assert.equal(audit?.detail.code_changed_at_approval, false);
    assert.equal(audit?.detail.approval_mail_queued, true);
  });
});

test('contract fields: contract-sent records the time, and contract-signed records the date, version and reference and sets active', async () => {
  await withFixture(async (fixture) => {
    const service = createPartnerReviewService(fixture.app, clock);
    const partner = await insertPartner(fixture, { status: 'approved' });

    // Signing before the contract was sent is a wrong status.
    const early = await refusal(
      service.contractSigned(
        partner.id,
        { date: '2026-11-22', version: 'v1' },
        actor,
      ),
    );
    assert.equal(early.refusal, 'wrong_status');
    assert.equal(early.status, 'approved');

    const sent = await service.contractSent(partner.id, actor);
    assert.equal(sent.after.status, 'contract_sent');
    assert.equal(sent.after.contract_sent_at, now.toISOString());

    for (const [input, problem] of [
      [{ date: '2026-02-30', version: 'v1' }, 'date'],
      [{ date: '22/11/2026', version: 'v1' }, 'date'],
      [{ date: '2026-11-23', version: 'v1' }, 'signedInFuture'],
      [{ date: '2026-11-21', version: 'v1' }, 'signedBeforeSent'],
      [{ date: '2026-11-22', version: 'version one' }, 'contractVersion'],
      [{ date: '2026-11-22', version: '' }, 'contractVersion'],
      [
        {
          date: '2026-11-22',
          version: 'v1',
          reference: 'mail maya@example.test',
        },
        'contractReference',
      ],
      [
        { date: '2026-11-22', version: 'v1', reference: 'x'.repeat(201) },
        'contractReference',
      ],
    ] as const) {
      await assert.rejects(
        service.contractSigned(partner.id, input, actor),
        (error: unknown) =>
          error instanceof PartnerReviewInputError && error.problem === problem,
        JSON.stringify(input),
      );
    }
    assert.equal(
      (await partnerRow(fixture, partner.id)).status,
      'contract_sent',
    );

    const signed = await service.contractSigned(
      partner.id,
      {
        date: '2026-11-22',
        version: 'partner-v1.2',
        reference: 'signfree-ABC123',
      },
      actor,
    );
    assert.equal(signed.after.status, 'active');
    const row = await partnerRow(fixture, partner.id);
    assert.equal(row.contract_signed_at, '2026-11-22');
    assert.equal(row.contract_version, 'partner-v1.2');
    assert.equal(row.contract_reference, 'signfree-ABC123');
    assert.equal(
      (row.contract_sent_at as Date).toISOString(),
      now.toISOString(),
    );
    // The code stays inactive: E11.7-07 owns activation.
    assert.equal(signed.after.code_active, false);

    // A reference is optional.
    const second = await insertPartner(fixture, { status: 'contract_sent' });
    await service.contractSigned(
      second.id,
      { date: '2026-11-22', version: 'v1' },
      actor,
    );
    assert.equal(
      (await partnerRow(fixture, second.id)).contract_reference,
      null,
    );
  });
});

test('the audit records: every command writes the actor and the before and after values, and never the free text', async () => {
  await withFixture(async (fixture) => {
    const service = createPartnerReviewService(fixture.app, clock);
    const partner = await insertPartner(fixture, {
      status: 'applied',
      requestedCode: 'AUDITME',
    });
    await service.approve(partner.id, null, actor);
    await service.contractSent(partner.id, actor);
    await service.contractSigned(
      partner.id,
      { date: '2026-11-22', version: 'v1', reference: 'signfree-REF9' },
      actor,
    );
    await service.pause(partner.id, actor);
    await service.reactivate(partner.id, actor);
    await service.setType(
      partner.id,
      'student_ambassador',
      'Lund University',
      actor,
    );
    await service.note(
      partner.id,
      'Strong TikTok reach.\nCall in January.',
      actor,
    );
    await service.pause(partner.id, actor);
    await service.terminate(partner.id, actor);
    await service.show(partner.id, actor);

    const rows = await audits(fixture, partner.id);
    assert.deepEqual(
      rows.map((row) => row.action),
      [
        'partner.approved',
        'partner.contract_sent',
        'partner.contract_signed',
        'partner.paused',
        'partner.reactivated',
        'partner.type_changed',
        'partner.note_replaced',
        'partner.paused',
        'partner.terminated',
        'partner.viewed',
      ],
    );
    const transitions: [string, string][] = [
      ['applied', 'approved'],
      ['approved', 'contract_sent'],
      ['contract_sent', 'active'],
      ['active', 'paused'],
      ['paused', 'active'],
      ['active', 'active'],
      ['active', 'active'],
      ['active', 'paused'],
      ['paused', 'terminated'],
    ];
    rows.slice(0, 9).forEach((row, index) => {
      assert.equal(row.actor, actor);
      assert.equal(row.subject_type, 'partner');
      assert.equal(row.subject_id, partner.id);
      const before = row.detail.before as Record<string, unknown>;
      const after = row.detail.after as Record<string, unknown>;
      assert.ok(before && after, row.action);
      if (row.action !== 'partner.note_replaced') {
        assert.deepEqual(
          [before.status, after.status],
          transitions[index],
          row.action,
        );
      }
    });
    const byAction = (action: string) =>
      rows.find((row) => row.action === action)!.detail;
    // Approval: the code before and after.
    const approval = byAction('partner.approved');
    assert.equal((approval.before as Record<string, unknown>).code, null);
    assert.equal((approval.after as Record<string, unknown>).code, 'AUDITME');
    // Signing: the date and version, and only a digest of the reference.
    const signing = byAction('partner.contract_signed');
    const signedAfter = signing.after as Record<string, unknown>;
    assert.equal(signedAfter.contract_signed_at, '2026-11-22');
    assert.equal(signedAfter.contract_version, 'v1');
    assert.deepEqual(
      signedAfter.contract_reference,
      textDigest('signfree-REF9'),
    );
    // The type change: the types, and only a digest of the university.
    const typed = byAction('partner.type_changed');
    assert.equal(
      (typed.before as Record<string, unknown>).partner_type,
      'creator',
    );
    assert.equal(
      (typed.after as Record<string, unknown>).partner_type,
      'student_ambassador',
    );
    assert.deepEqual(
      (typed.after as Record<string, unknown>).university,
      textDigest('Lund University'),
    );
    // The note: length and SHA-256 of the before and after, never the text.
    const note = byAction('partner.note_replaced');
    assert.deepEqual(note, {
      before: { notes: null },
      after: {
        notes: {
          length: 'Strong TikTok reach.\nCall in January.'.length,
          sha256: createHash('sha256')
            .update('Strong TikTok reach.\nCall in January.', 'utf8')
            .digest('hex'),
        },
      },
    });
    const serialised = JSON.stringify(rows);
    for (const text of [
      'Strong TikTok',
      'Lund University',
      'signfree-REF9',
      partner.email,
    ]) {
      assert.equal(serialised.includes(text), false, text);
    }
    // The read audit carries the partner's id and nothing else.
    assert.deepEqual(rows.at(-1)?.detail, {});
  });
});

test('reject sends the "rejected" email only with --template, and the audit says which', async () => {
  await withFixture(async (fixture) => {
    const service = createPartnerReviewService(fixture.app, clock);
    const quiet = await insertPartner(fixture, { status: 'applied' });
    const result = await service.reject(quiet.id, false, actor);
    assert.equal(result.after.status, 'rejected');
    assert.equal(result.mailQueued, false);
    assert.deepEqual(await emails(fixture, quiet.subscriberId), []);
    const [quietAudit] = await audits(fixture, quiet.id);
    assert.equal(quietAudit?.detail.template_requested, false);
    assert.equal(quietAudit?.detail.rejection_mail_queued, false);

    // An approved partner whose contract never went ahead is closed with
    // reject. Its code stays registered, inactive and never reissued.
    const approved = await insertPartner(fixture, {
      status: 'approved',
      code: 'KEEPCODE',
    });
    const told = await service.reject(approved.id, true, actor);
    assert.equal(told.mailQueued, true);
    assert.deepEqual(await emails(fixture, approved.subscriberId), [
      {
        template: 'partner_rejected',
        business_key: partnerRejectedBusinessKey(approved.id),
      },
    ]);
    const [toldAudit] = await audits(fixture, approved.id);
    assert.equal(toldAudit?.detail.template_requested, true);
    assert.equal(toldAudit?.detail.rejection_mail_queued, true);
    const code = await fixture.owner.readOne<{
      owner_id: string;
      active: boolean;
    }>({
      text: `SELECT owner_id, active FROM referral_code WHERE code = 'KEEPCODE'`,
    });
    assert.deepEqual(code, { owner_id: approved.id, active: false });
    assert.equal(
      (await createPartnerCodeRules(fixture.app).check('KEEPCODE')).outcome,
      'refused',
    );

    // contract_sent can be rejected too; nothing leaves rejected.
    const sent = await insertPartner(fixture, { status: 'contract_sent' });
    await service.reject(sent.id, false, actor);
    for (const command of [
      () => service.reject(sent.id, true, actor),
      () => service.approve(sent.id, null, actor),
      () => service.reactivate(sent.id, actor),
    ]) {
      const refused = await refusal(command());
      assert.equal(refused.refusal, 'wrong_status');
      assert.equal(refused.status, 'rejected');
    }
    assert.deepEqual(await emails(fixture, sent.subscriberId), []);
  });
});

test('each command applies only from its documented source statuses', async () => {
  await withFixture(async (fixture) => {
    const service = createPartnerReviewService(fixture.app, clock);
    const commands = {
      approve: {
        from: ['applied'],
        run: (id: string) => service.approve(id, null, actor),
      },
      reject: {
        from: ['applied', 'approved', 'contract_sent'],
        run: (id: string) => service.reject(id, false, actor),
      },
      contractSent: {
        from: ['approved'],
        run: (id: string) => service.contractSent(id, actor),
      },
      contractSigned: {
        from: ['contract_sent'],
        run: (id: string) =>
          service.contractSigned(
            id,
            { date: '2026-11-22', version: 'v1' },
            actor,
          ),
      },
      pause: {
        from: ['active'],
        run: (id: string) => service.pause(id, actor),
      },
      terminate: {
        from: ['active', 'paused'],
        run: (id: string) => service.terminate(id, actor),
      },
      reactivate: {
        from: ['paused'],
        run: (id: string) => service.reactivate(id, actor),
      },
    } as const;
    for (const [name, command] of Object.entries(commands)) {
      for (const status of partnerStatuses) {
        const partner = await insertPartner(fixture, { status });
        const attempt = command.run(partner.id);
        if (status === 'unconfirmed') {
          // An unconfirmed application is never found for review.
          assert.equal((await refusal(attempt)).refusal, 'not_found', name);
        } else if ((command.from as readonly string[]).includes(status)) {
          await attempt;
        } else {
          const refused = await refusal(attempt);
          assert.equal(refused.refusal, 'wrong_status', `${name} ${status}`);
        }
      }
    }
  });
});

test('set-type: a student ambassador needs a university; other types take none and keep the stored fields', async () => {
  await withFixture(async (fixture) => {
    const service = createPartnerReviewService(fixture.app, clock);
    const partner = await insertPartner(fixture, { status: 'active' });
    for (const [type, university, problem] of [
      ['student_ambassador', undefined, 'university'],
      ['student_ambassador', '   ', 'university'],
      ['student_ambassador', 'x'.repeat(201), 'university'],
      ['standard', 'Lund University', 'universityNotAllowed'],
      ['ambassador', undefined, 'type'],
    ] as const) {
      await assert.rejects(
        service.setType(partner.id, type, university, actor),
        (error: unknown) =>
          error instanceof PartnerReviewInputError && error.problem === problem,
        `${type} ${String(university)}`,
      );
    }
    await service.setType(
      partner.id,
      'student_ambassador',
      ' Lund University ',
      actor,
    );
    assert.deepEqual(
      [
        (await partnerRow(fixture, partner.id)).partner_type,
        (await partnerRow(fixture, partner.id)).university,
      ],
      ['student_ambassador', 'Lund University'],
    );
    await service.setType(partner.id, 'standard', undefined, actor);
    const row = await partnerRow(fixture, partner.id);
    assert.equal(row.partner_type, 'standard');
    assert.equal(row.university, 'Lund University');
  });
});

test('note replaces one notes field and refuses an email or IP address', async () => {
  await withFixture(async (fixture) => {
    const service = createPartnerReviewService(fixture.app, clock);
    const partner = await insertPartner(fixture, { status: 'applied' });
    for (const text of [
      '',
      '   ',
      'x'.repeat(2_001),
      'Reach her at maya@example.test',
      'Signed up from 203.0.113.7',
      'Bell \u0007 character',
    ]) {
      await assert.rejects(
        service.note(partner.id, text, actor),
        (error: unknown) =>
          error instanceof PartnerReviewInputError && error.problem === 'notes',
        text.slice(0, 20),
      );
    }
    await service.note(partner.id, 'First note.', actor);
    await service.note(partner.id, `  ${'y'.repeat(2_000)}  `, actor);
    assert.equal(
      (await partnerRow(fixture, partner.id)).notes,
      'y'.repeat(2_000),
    );
    const rows = await audits(fixture, partner.id);
    assert.deepEqual(rows.at(-1)?.detail, {
      before: { notes: textDigest('First note.') },
      after: { notes: textDigest('y'.repeat(2_000)) },
    });
  });
});

test('the stale filter shows only partners waiting more than 14 days in applied, approved or contract_sent', async () => {
  await withFixture(async (fixture) => {
    const service = createPartnerReviewService(fixture.app, clock);
    const old = new Date(now.getTime() - partnerStaleAfterMs - 60_000);
    const fresh = new Date(now.getTime() - partnerStaleAfterMs + 60_000);
    const staleApplied = await insertPartner(fixture, {
      status: 'applied',
      at: old,
    });
    const staleApproved = await insertPartner(fixture, {
      status: 'approved',
      at: old,
    });
    const staleSent = await insertPartner(fixture, {
      status: 'contract_sent',
      at: old,
    });
    await insertPartner(fixture, { status: 'applied', at: fresh });
    await insertPartner(fixture, { status: 'active', at: old });
    await insertPartner(fixture, { status: 'paused', at: old });
    await insertPartner(fixture, { status: 'rejected', at: old });
    await insertPartner(fixture, { status: 'unconfirmed', at: old });

    const stale = await service.list({ stale: true }, actor);
    assert.deepEqual(
      stale.partners.map((row) => row.id).sort(),
      [staleApplied.id, staleApproved.id, staleSent.id].sort(),
    );
    assert.ok(stale.partners.every((row) => row.stale));

    // Without the filter every confirmed application is listed, and
    // unconfirmed ones never are.
    const all = await service.list({}, actor);
    assert.equal(all.partners.length, 7);
    assert.equal(all.partners.filter((row) => row.stale).length, 3);
    await assert.rejects(
      service.list({ status: 'unconfirmed' }, actor),
      (error: unknown) =>
        error instanceof PartnerReviewInputError && error.problem === 'status',
    );

    // Each read is audited with the filters and the row count only.
    const reads = (await audits(fixture, null)).filter(
      (row) => row.action === 'partner.listed',
    );
    assert.deepEqual(
      reads.map((row) => row.detail),
      [
        {
          filters: {
            status: null,
            type: null,
            since: null,
            stale: true,
            after: null,
          },
          row_count: 3,
        },
        {
          filters: {
            status: null,
            type: null,
            since: null,
            stale: false,
            after: null,
          },
          row_count: 7,
        },
      ],
    );
    assert.ok(
      reads.every((row) => row.subject_id === null && row.actor === actor),
    );
  });
});

test('list filters by status, type and --since on applied_at, and pages at most 100 rows', async () => {
  await withFixture(async (fixture) => {
    const service = createPartnerReviewService(fixture.app, clock);
    const early = await insertPartner(fixture, {
      status: 'applied',
      at: new Date('2026-11-01T09:00:00.000Z'),
      appliedAt: new Date('2026-11-03T09:00:00.000Z'),
    });
    const late = await insertPartner(fixture, {
      status: 'approved',
      partnerType: 'student_ambassador',
      at: new Date('2026-11-01T09:00:00.000Z'),
      appliedAt: new Date('2026-11-10T00:00:00.000Z'),
    });
    // --since is on applied_at, not on submission or status times.
    const since = await service.list({ since: '2026-11-10' }, actor);
    assert.deepEqual(
      since.partners.map((row) => row.id),
      [late.id],
    );
    const byStatus = await service.list({ status: 'applied' }, actor);
    assert.deepEqual(
      byStatus.partners.map((row) => row.id),
      [early.id],
    );
    const byType = await service.list({ type: 'student_ambassador' }, actor);
    assert.deepEqual(
      byType.partners.map((row) => row.id),
      [late.id],
    );
    await assert.rejects(
      service.list({ since: '2026-13-01' }, actor),
      PartnerReviewInputError,
    );

    // 101 more applications: the first page is capped and continues.
    const bulkAt = new Date('2026-11-01T09:00:00.000Z');
    await fixture.owner.execute({
      text: `INSERT INTO subscriber (id, email, email_normalised, email_domain,
          status, created_at, verified_at, referral_code)
        SELECT gen_random_uuid(), 'bulk' || n || '@example.test',
          'bulk' || n || '@example.test', 'example.test', 'verified',
          $1, $1, 'B' || lpad(n::text, 11, '0')
        FROM generate_series(1, 101) AS n`,
      values: [bulkAt],
    });
    await fixture.owner.execute({
      text: `INSERT INTO partner (id, subscriber_id, status, status_changed_at,
          submitted_at, applied_at, full_name, country_of_residence,
          partner_type, channels, handles, audience_size, promotion_plan,
          requested_code, age_confirmed, programme_terms_agreed)
        SELECT gen_random_uuid(), id, 'applied', $1, $1, $2, 'Bulk', 'SE',
          'standard', ARRAY['other'], ARRAY['@x'], 'under_1k', 'Plan',
          'BULK', true, true
        FROM subscriber WHERE email LIKE 'bulk%@example.test'`,
      values: [bulkAt, new Date('2026-11-15T00:00:00.000Z')],
    });
    const first = await service.list({}, actor);
    assert.equal(first.partners.length, partnerListPageLimit);
    assert.ok(first.nextAfter !== null);
    const second = await service.list({ after: first.nextAfter }, actor);
    assert.equal(second.partners.length, 103 - partnerListPageLimit);
    assert.equal(second.nextAfter, null);
    const ids = new Set(
      [...first.partners, ...second.partners].map((row) => row.id),
    );
    assert.equal(ids.size, 103);
  });
});

test('show includes the referral counts, the flagged referrals and the last activity', async () => {
  await withFixture(async (fixture) => {
    const service = createPartnerReviewService(fixture.app, clock);
    const partner = await insertPartner(fixture, { status: 'active' });
    const confirmed = await insertReferral(fixture, partner.subscriberId, {
      createdAt: new Date('2026-11-05T10:00:00.000Z'),
      confirmedAt: new Date('2026-11-18T08:00:00.000Z'),
      email: 'friend-one@example.test',
    });
    await insertReferral(fixture, partner.subscriberId, {
      state: 'attributed',
      createdAt: new Date('2026-11-12T10:00:00.000Z'),
    });
    await insertReferral(fixture, partner.subscriberId, {
      voided: true,
      createdAt: new Date('2026-11-06T10:00:00.000Z'),
    });
    await fixture.owner.execute({
      text: `INSERT INTO fraud_flag (id, subscriber_id, kind, detail, state)
        VALUES ($1, $2, 'ip_velocity', '{}', 'open'),
               ($3, $2, 'manual', '{}', 'open')`,
      values: [randomUUID(), confirmed.referredId, randomUUID()],
    });
    // A referral of some other member never counts here.
    const stranger = await insertMember(fixture);
    await insertReferral(fixture, stranger.id, {
      createdAt: new Date('2026-11-20T10:00:00.000Z'),
    });

    const shown = await service.show(partner.id, actor);
    assert.deepEqual(
      {
        confirmed: shown.referrals.confirmed,
        pending: shown.referrals.pending,
        voided: shown.referrals.voided,
        flagged: shown.referrals.flagged,
      },
      { confirmed: 1, pending: 1, voided: 1, flagged: 1 },
    );
    // The latest signup or confirmation among the partner's referrals.
    assert.equal(
      shown.referrals.last_activity_at?.toISOString(),
      '2026-11-18T08:00:00.000Z',
    );
    assert.deepEqual(shown.flaggedReferrals, [
      {
        referred_id: confirmed.referredId,
        state: 'confirmed',
        voided: false,
        flag_kinds: ['ip_velocity', 'manual'],
      },
    ]);
    // Referred people are named by id only, never by email.
    assert.equal(
      JSON.stringify(shown).includes('friend-one@example.test'),
      false,
    );
    assert.equal(shown.partner.email, partner.email);
    await assert.rejects(
      service.show(randomUUID(), actor),
      (error: unknown) =>
        error instanceof PartnerReviewRefusedError &&
        error.refusal === 'not_found',
    );
  });
});

test('notes and the contract reference are personal data: exported to the subject, cleared by erasure and the purge, and the code is retired, never reissued', async () => {
  await withFixture(async (fixture) => {
    const service = createPartnerReviewService(fixture.app, clock);
    const partner = await insertPartner(fixture, {
      status: 'contract_sent',
      code: 'ERASEME',
    });
    await service.contractSigned(
      partner.id,
      { date: '2026-11-22', version: 'v1', reference: 'signfree-ERASE' },
      actor,
    );
    await service.note(partner.id, 'Founder note to erase.', actor);

    const exported: { table: string; data: Record<string, unknown> }[] = [];
    for await (const line of exportSubject(fixture.app, partner.subscriberId))
      exported.push(JSON.parse(line));
    const partnerRows = exported.filter((row) => row.table === 'partner');
    assert.equal(partnerRows[0]?.data.notes, 'Founder note to erase.');
    assert.equal(partnerRows[0]?.data.contract_reference, 'signfree-ERASE');
    assert.deepEqual(
      exported
        .filter((row) => row.table === 'referral_code')
        .map((row) => row.data.code)
        .sort(),
      ['ERASEME', memberCode(exported)].sort(),
    );

    const erasure = createErasureService(fixture.app, {
      clock,
      alerts: { send: async () => undefined },
      deleteContact: async () => undefined,
    });
    await withTransaction(fixture.app, (connection) =>
      erasure.request(connection, partner.subscriberId),
    );
    assert.equal(await erasure.run(), 1);
    const erased = await partnerRow(fixture, partner.id);
    assert.equal(erased.notes, null);
    assert.equal(erased.contract_reference, null);
    assert.equal(erased.status, 'active');
    const retired = await fixture.owner.readOne<{
      owner_id: string | null;
      active: boolean;
    }>({
      text: `SELECT owner_id, active FROM referral_code WHERE code = 'ERASEME'`,
    });
    assert.deepEqual(retired, { owner_id: null, active: false });
    // Never reissued: the code stays taken.
    const check = await createPartnerCodeRules(fixture.app).check('eraseme');
    assert.equal(check.outcome, 'refused');
    const after: string[] = [];
    for await (const line of exportSubject(fixture.app, partner.subscriberId))
      after.push(line);
    assert.equal(
      after.some((line) => line.includes('ERASEME')),
      false,
    );
    // A purged partner changes no more.
    assert.equal(
      (await refusal(service.note(partner.id, 'Again.', actor))).refusal,
      'purged',
    );

    // The retention purge of a rejected partner retires its code the same way.
    const rejected = await insertPartner(fixture, {
      status: 'rejected',
      code: 'PURGEME',
      at: new Date(now.getTime() - 91 * DAY_MS),
    });
    await fixture.owner.execute({
      text: `UPDATE partner SET notes = 'Rejected note.' WHERE id = $1`,
      values: [rejected.id],
    });
    const job = createPartnerApplicationPurgeJob(fixture.app, { clock });
    assert.equal(await job.run(500), 1);
    assert.equal((await partnerRow(fixture, rejected.id)).notes, null);
    assert.deepEqual(
      await fixture.owner.readOne({
        text: `SELECT owner_id, active FROM referral_code WHERE code = 'PURGEME'`,
      }),
      { owner_id: null, active: false },
    );
  });
});

/** The member code row the subject export also holds, beside the partner code. */
function memberCode(
  rows: readonly { table: string; data: Record<string, unknown> }[],
): string {
  const member = rows.find(
    (row) => row.table === 'referral_code' && row.data.owner_kind === 'member',
  );
  assert.ok(member);
  return String(member.data.code);
}
