import assert from 'node:assert/strict';
import test from 'node:test';

import { marketingOptInCopy } from '../src/copy/marketing.ts';
import { memberStatusCopy } from '../src/copy/member-status.ts';
import { createMarketingRoute } from '../src/pages/api/me/marketing.ts';
import type { DatabasePool } from '../src/server/db/pool.ts';
import type { FlagService } from '../src/server/flags/types.ts';
import { createMarketingService } from '../src/server/subscriber/marketing.ts';

import {
  ageFixture,
  insertMember,
  insertToken,
  laterTime,
  type AgeFixture,
} from './helpers/waitlist-age-fixture.ts';

// E11.8-06 (D-082 Q1): while waitlist.age_13 is on, a new marketing grant
// from /me needs the 16+ affirmation, in the form and on the server, and
// records the 16+ wording version. After rollback, a member admitted under
// the 13+ policy cannot turn it on, and can always turn it off.

function route(f: AgeFixture, flags: FlagService) {
  const marketing = createMarketingService(f.app, {
    flags,
    clock: () => laterTime,
  });
  return {
    marketing,
    async send(
      fields: Record<string, string>,
      address = '203.0.113.50',
    ): Promise<{ status: number; body: unknown }> {
      const response = await createMarketingRoute({
        verifyTurnstile: async () => 'verified',
        change: (input) => marketing.change(input),
        ipPrefixPepper: 'pepper',
      })({
        clientAddress: address,
        request: new Request('https://valstara.test/api/me/marketing', {
          method: 'POST',
          body: new URLSearchParams({ turnstile_token: 'ok', ...fields }),
        }),
      } as never);
      return { status: response.status, body: await response.json() };
    },
  };
}

async function consent(owner: DatabasePool, id: string) {
  return owner.readOne<{
    marketing_consent_version: string | null;
    marketing_consent_source: string | null;
  }>({
    text: `SELECT marketing_consent_version, marketing_consent_source
           FROM subscriber WHERE id = $1`,
    values: [id],
  });
}

async function grants(owner: DatabasePool, id: string) {
  return owner.list<{ action: string; detail: unknown }>(
    {
      text: `SELECT action, detail FROM audit_log
             WHERE subject_id = $1 AND action LIKE 'consent.marketing_%'
             ORDER BY at`,
      values: [id],
    },
    10,
  );
}

const saved = {
  status: 200,
  body: { status: 'accepted', message: memberStatusCopy.marketing.saved },
};

test('with the flag on, a grant without the 16+ affirmation is refused, and one with it records the 16+ version', async () => {
  const f = await ageFixture('e11-8-06-marketing-on');
  try {
    const flags = f.flags();
    await flags.set('waitlist.age_13', true, 'e11-8-06-test');
    const { marketing, send } = route(f, flags);
    for (const admission of ['18_plus', '13_plus'] as const) {
      const member = await insertMember(f.owner, { admission });
      const token = await insertToken(f.owner, member, 'status');
      assert.equal(
        await marketing.grantRequirement(member),
        'sixteen_affirmation',
      );
      assert.deepEqual(await send({ t: token, marketing: 'on' }), {
        status: 400,
        body: {
          error: {
            code: 'invalid_input',
            message: memberStatusCopy.marketing.sixteen.required,
          },
        },
      });
      assert.deepEqual(await grants(f.owner, member), []);
      assert.deepEqual(
        await send({
          t: token,
          marketing: 'on',
          marketing_age_affirmed: 'nope',
        }),
        {
          status: 400,
          body: {
            error: {
              code: 'invalid_input',
              message: memberStatusCopy.marketing.invalidInput,
            },
          },
        },
      );
      assert.deepEqual(
        await send({
          t: token,
          marketing: 'on',
          marketing_age_affirmed: 'yes',
        }),
        saved,
      );
      assert.deepEqual(await consent(f.owner, member), {
        marketing_consent_version: 'v2',
        marketing_consent_source: 'member_status',
      });
      assert.deepEqual(await grants(f.owner, member), [
        {
          action: 'consent.marketing_granted',
          detail: { source: 'member_status', version: 'v2' },
        },
      ]);
      // Turning it off never asks for the affirmation.
      assert.deepEqual(await send({ t: token, marketing: 'off' }), saved);
      assert.equal(
        (await consent(f.owner, member))?.marketing_consent_version,
        null,
      );
    }
  } finally {
    await f.dispose();
  }
});

test('after rollback, a member admitted at 13 cannot turn marketing on, can turn it off, and an 18+ member grants as before', async () => {
  const f = await ageFixture('e11-8-06-marketing-rollback');
  try {
    const flags = f.flags();
    const { marketing, send } = route(f, flags);
    const admitted13 = await insertMember(f.owner, { admission: '13_plus' });
    const token13 = await insertToken(f.owner, admitted13, 'status');
    const consented13 = await insertMember(f.owner, { admission: '13_plus' });
    const tokenConsented = await insertToken(f.owner, consented13, 'status');
    await f.owner.execute({
      text: `UPDATE subscriber SET marketing_consent_at = $2,
               marketing_consent_version = 'v2',
               marketing_consent_source = 'member_status'
             WHERE id = $1`,
      values: [consented13, laterTime],
    });
    const adult = await insertMember(f.owner, { admission: '18_plus' });
    const tokenAdult = await insertToken(f.owner, adult, 'status');

    assert.equal(await flags.isEnabled('waitlist.age_13'), false);
    assert.equal(await marketing.grantRequirement(admitted13), 'paused');
    assert.equal(await marketing.grantRequirement(adult), 'none');
    const paused = {
      status: 503,
      body: {
        error: {
          code: 'unavailable',
          message: memberStatusCopy.marketing.grantPaused,
        },
      },
    };
    // The direct grant request is refused on the server, affirmed or not.
    assert.deepEqual(await send({ t: token13, marketing: 'on' }), paused);
    assert.deepEqual(
      await send(
        { t: token13, marketing: 'on', marketing_age_affirmed: 'yes' },
        '203.0.113.51',
      ),
      paused,
    );
    assert.deepEqual(await grants(f.owner, admitted13), []);
    assert.equal(
      (await consent(f.owner, admitted13))?.marketing_consent_version,
      null,
    );
    // Withdrawal stays available.
    assert.deepEqual(
      await send({ t: tokenConsented, marketing: 'off' }, '203.0.113.52'),
      saved,
    );
    assert.equal(
      (await consent(f.owner, consented13))?.marketing_consent_version,
      null,
    );
    assert.deepEqual(
      (await grants(f.owner, consented13)).map((row) => row.action),
      ['consent.marketing_withdrawn'],
    );
    // An 18+ member grants the 18+ wording, unchanged.
    assert.deepEqual(
      await send({ t: tokenAdult, marketing: 'on' }, '203.0.113.53'),
      saved,
    );
    assert.deepEqual(await consent(f.owner, adult), {
      marketing_consent_version: marketingOptInCopy.version,
      marketing_consent_source: 'member_status',
    });
  } finally {
    await f.dispose();
  }
});
