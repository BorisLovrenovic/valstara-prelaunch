import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { startAppServer } from './helpers/listen-port.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(join(root, path), 'utf8');
const adminDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

const subscriberPolicyCategory = {
  id: 'Waitlist status',
  email: 'Email address',
  email_normalised: 'Email address',
  email_domain: 'Email address',
  status: 'Waitlist status',
  category_preference: 'Optional category preference',
  source: 'Acquisition source',
  utm: 'Acquisition source',
  signup_had_ref: 'Acquisition source',
  referral_code: 'Referral code',
  referred_by_id: 'Referral code',
  referral_tier: 'Referral code',
  confirmed_referrals: 'Referral code',
  access_window: 'Waitlist status',
  subslush_customer: 'Waitlist status',
  giveaway_rules_version: 'Giveaway entries',
  marketing_consent_at: 'Optional marketing choice',
  marketing_consent_version: 'Optional marketing choice',
  marketing_consent_source: 'Optional marketing choice',
  marketing_opt_in_pending: 'Optional marketing choice',
  marketing_opt_in_pending_version: 'Optional marketing choice',
  signup_ip_prefix_hash: 'Truncated, hashed IP prefix',
  verified_at: 'Waitlist status',
  unsubscribed_at: 'Waitlist status',
  expired_at: 'Waitlist status',
  disqualified_at: 'Fraud review decisions',
  disqualification_previous_status: 'Fraud review decisions',
  disqualified_by_flag_id: 'Fraud review decisions',
  created_at: 'Waitlist status',
  updated_at: 'Waitlist status',
};

// Every column in these subject-linked tables has an explicit policy row.
// Comparing against the migrated schema makes a new collected field fail until
// its purpose, basis and retention have been reviewed.
const relatedPolicyFields = {
  verification_token: {
    'Verification and status link records': [
      'id',
      'subscriber_id',
      'token_hash',
      'purpose',
      'expires_at',
      'consumed_at',
      'created_at',
    ],
  },
  referral_edge: {
    'Referral code': [
      'id',
      'referrer_id',
      'referred_id',
      'state',
      'reward_state',
      'rejected_reason',
      'state_before_rejection',
      'confirmed_at',
      'created_at',
    ],
  },
  milestone_award: {
    'Referral code': [
      'id',
      'subscriber_id',
      'tier',
      'reward_kind',
      'state',
      'awarded_at',
    ],
  },
  survey_response: {
    'Optional category preference': [
      'id',
      'subscriber_id',
      'answers',
      'version',
      'created_at',
      'first_answered_at',
    ],
  },
  giveaway_entry: {
    'Giveaway entries': [
      'id',
      'subscriber_id',
      'method',
      'entries',
      'rules_version',
      'rules_sha256',
      'source_edge_id',
      'voided_at',
      'voided_by_disqualification_flag_id',
      'created_at',
    ],
  },
  giveaway_award: {
    "A provisional winner's country of residence": [
      'id',
      'draw_id',
      'prize_slot',
      'entry_snapshot_hash',
      'selection_position',
      'entry_id',
      'subscriber_id',
      'state',
      'notified_at',
      'response_deadline_at',
      'country_of_residence',
      'age_confirmed',
      'sanctions_passed',
      'skill_passed',
      'substitution_state',
      'substitution_offered_at',
      'substitution_deadline_at',
      'substitution_offer',
      'substitution',
      'publicity_permission',
      'delivered_at',
      'created_at',
      'updated_at',
    ],
  },
  giveaway_award_candidate: {
    "A provisional winner's country of residence": [
      'draw_id',
      'selection_position',
      'award_id',
      'subscriber_id',
      'outcome',
      'reason',
      'checked_at',
    ],
  },
  fraud_flag: {
    'Fraud review decisions': [
      'id',
      'subscriber_id',
      'kind',
      'detail',
      'state',
      'reviewed_by',
      'reviewed_at',
      'created_at',
    ],
  },
  email_send: {
    'Email delivery events': [
      'id',
      'subscriber_id',
      'template',
      'provider',
      'business_key',
      'payload',
      'unsubscribe_token_id',
      'unsubscribe_token_purpose',
      'provider_message_id',
      'state',
      'attempts',
      'next_attempt_at',
      'expires_at',
      'last_error',
      'created_at',
      'updated_at',
      'accepted_at',
      'gap_alerted_at',
    ],
  },
  suppression: {
    'Email delivery events': [
      'email_normalised',
      'reason',
      'source',
      'created_at',
    ],
  },
  dsr_erasure: {
    'Data-subject requests': [
      'subscriber_id',
      'requested_at',
      'attempts',
      'next_attempt_at',
      'escalated_at',
      'deadline_alerted_at',
      'completed_at',
    ],
  },
  erasure_ledger: {
    'Data-subject requests': ['subscriber_id', 'erased_at'],
  },
  giveaway_draw_void: {
    'Giveaway entries': [
      'draw_id',
      'subscriber_id',
      'reason',
      'voided_at',
      'actor',
    ],
  },
  brevo_contact_sync: {
    'Optional marketing choice': [
      'email_normalised',
      'email',
      'listed',
      'synced_at',
    ],
  },
};

function tableRows(section) {
  return section
    .split('\n')
    .filter((line) => line.startsWith('| '))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter((cells) => !cells[0]?.startsWith('---'));
}

async function withMigratedSchema(run) {
  const databaseName = `valstara_e903policy_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(adminDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = new Pool({ connectionString: adminUrl.toString() });
  let database;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const migrated = spawnSync(
      'npx',
      ['tsx', 'src/server/db/run-migrations.ts', 'e9-03-policy-test'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: databaseUrl.toString(),
          VALSTARA_APP_DB_PASSWORD: appPassword,
        },
      },
    );
    assert.equal(migrated.status, 0, `${migrated.stdout}\n${migrated.stderr}`);
    database = new Pool({ connectionString: databaseUrl.toString() });
    await run(database);
  } finally {
    await database?.end();
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  }
}

test('the modelled personal-data fields reconcile to policy rows with purpose, basis and retention', async () => {
  const model = await read('docs/data/model.md');
  const policy = await read('src/content/privacy.md');
  const modelSection = model
    .split('## `subscriber`\n', 2)[1]
    ?.split('\n---', 1)[0];
  assert.ok(modelSection, 'subscriber section must exist in the data model');
  const modelFields = tableRows(modelSection)
    .slice(1)
    .flatMap(([column]) =>
      [...column.matchAll(/`([^`]+)`/gu)].map((match) => match[1]),
    );
  assert.deepEqual(
    [...modelFields].sort(),
    Object.keys(subscriberPolicyCategory).sort(),
    'a model field was added or removed without reconciling the privacy policy',
  );

  const processingSection = policy
    .split('## What we use and why\n', 2)[1]
    ?.split('\n## ', 1)[0];
  assert.ok(processingSection);
  const policyRows = tableRows(processingSection).slice(1);
  const inventory = {
    subscriber: Object.entries(subscriberPolicyCategory).reduce(
      (groups, [field, category]) => {
        (groups[category] ??= []).push(field);
        return groups;
      },
      {},
    ),
    ...relatedPolicyFields,
  };
  await withMigratedSchema(async (database) => {
    for (const [table, categories] of Object.entries(inventory)) {
      assert.ok(
        table === 'giveaway_award_candidate'
          ? model.includes('A separate `giveaway_award_candidate`')
          : model.includes(`## \`${table}\``),
        `${table} missing from model`,
      );
      const result = await database.query(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name',
        ['public', table],
      );
      const schemaFields = result.rows.map((row) => row.column_name);
      const mappedFields = Object.values(categories).flat();
      assert.deepEqual(
        mappedFields.sort(),
        schemaFields,
        `${table} has a collected field without a policy mapping`,
      );
      for (const [category, fields] of Object.entries(categories)) {
        const row = policyRows.find(([data]) => data.startsWith(category));
        assert.ok(row, `${table}.${fields.join(', ')} has no policy row`);
        assert.equal(
          row.length,
          4,
          `${category} must have four policy columns`,
        );
        for (const [index, label] of [
          [1, 'purpose'],
          [2, 'basis'],
          [3, 'retention'],
        ]) {
          assert.ok(
            row[index],
            `${table}.${fields.join(', ')} has no ${label}`,
          );
        }
      }
    }
  });
});

test('the privacy notice publishes the theme and Turnstile storage entries', async () => {
  const policy = await read('src/content/privacy.md');
  const allowlist = JSON.parse(await read('scripts/ci/privacy-allowlist.json'));
  const section = policy.split('## Cookie and storage inventory\n', 2)[1];
  assert.ok(section, 'inventory heading is missing');
  const entries = tableRows(section).slice(1);
  assert.equal(entries.length, 2, 'the inventory must have two entries');
  assert.deepEqual(
    Object.keys(allowlist).filter((key) =>
      /storage|themePreference/iu.test(key),
    ),
    ['themePreference'],
  );
  assert.equal(entries[0][0], `\`${allowlist.themePreference.storageKey}\``);
  assert.match(entries[0][1], /local storage/iu);
  assert.ok(entries[0][2]);
  const processorStorage = allowlist.thirdPartyRequests.find(
    (entry) => entry.host === 'challenges.cloudflare.com',
  )?.disclosureContract.processorStorage;
  assert.equal(entries[1][0], `\`${processorStorage?.key}\``);
  assert.equal(processorStorage?.origin, 'https://challenges.cloudflare.com');
  assert.equal(processorStorage?.scope, 'active-protected-form');
  assert.match(entries[1][1], /Cloudflare local storage/iu);
  assert.match(entries[1][2], /secure a form/iu);
});

test('the draft policy states the separate marketing choice and winner-only location collection', async () => {
  const policy = await read('src/content/privacy.md');
  assert.match(
    policy,
    /Joining the waitlist and entering the giveaway use the contract basis/u,
  );
  assert.match(policy, /Marketing uses a separate, optional, unticked choice/u);
  assert.match(
    policy,
    /Withdrawing marketing consent never removes your waitlist place or giveaway entries/u,
  );
  assert.match(
    policy,
    /provisional winner's country of residence at award time/u,
  );
  assert.match(policy, /do not collect a postal address/u);
});

test(
  'legal pages use founder-authorised draft content at permanent static URLs',
  { timeout: 150_000 },
  async () => {
    await ensureAppBuild();

    for (const slug of ['terms', 'privacy']) {
      const content = await read(`src/content/${slug}.md`);
      const html = await read(`dist/client/${slug}/index.html`);
      assert.match(content, new RegExp(`^portTarget: /${slug}$`, 'mu'));
      assert.match(content, /\*\*Draft notice\.\*\*/u);
      assert.match(html, /Draft notice\./u);
      assert.match(html, /<h1[^>]*>/u);
      const dataBlocks = [
        ...html.matchAll(
          /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gu,
        ),
      ];
      assert.equal(dataBlocks.length, 1);
      assert.equal(JSON.parse(dataBlocks[0][1])['@type'], 'Organization');
      const emitter = html.match(
        /<script defer src="\/page-view\.js" data-website-id="[a-f0-9-]{36}"><\/script>/u,
      );
      assert.ok(emitter, 'the legal page needs the approved page-view emitter');
      assert.doesNotMatch(
        html.replace(dataBlocks[0][0], '').replace(emitter[0], ''),
        /<script\b|\.js(?:["?]|$)/iu,
      );
      assert.doesNotMatch(content, /representative/iu);
    }
    const signupRoute = await read('src/pages/api/signup.ts');
    assert.match(signupRoute, /createSignupRoute/u);
    assert.doesNotMatch(signupRoute, /representative|article.?27/iu);
    assert.doesNotMatch(await read('src/content/legit.md'), /representative/iu);

    // A real HTTP request enters Astro middleware before reaching the signup
    // route. Missing Turnstile is rejected by the route's challenge boundary;
    // a representative-dependent middleware gate would reject it earlier.
    // A reserved port below the kernel's ephemeral range (see
    // test/helpers/listen-port.mjs).
    const app = await startAppServer({
      label: 'Legal-page',
      readyPath: '/privacy',
      cwd: root,
      entry: join(root, 'dist/server/entry.mjs'),
      env: (port) => ({
        ADMIN_CREDENTIAL: 'legal-page-admin-credential-32-chars',
        ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
        DATABASE_URL: adminDatabaseUrl,
        EMAIL_BASE_URL: `http://127.0.0.1:${port}`,
        EMAIL_TOKEN_SECRET: 'legal-page-email-token-secret-32-chars',
        RESEND_WEBHOOK_SECRET: 'whsec_bG9jYWwtb25seS1yZXNlbmQtd2ViaG9vay1rZXk=',
        BREVO_WEBHOOK_TOKEN: 'legal-page-brevo-webhook-token-32-chars',
        IP_PREFIX_PEPPER: 'legal-page-prefix-pepper',
        REFERRAL_SIGNING_SECRET: 'legal-page-referral-secret',
        RESEND_API_KEY: 'legal-page-resend-key',
        RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
        RESEND_KEY_MODE: 'test',
        RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
        RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
        RESEND_SENDING_DOMAIN: 'send.valstara.com',
        TURNSTILE_SECRET_KEY: 'legal-page-turnstile-secret',
        HOST: '127.0.0.1',
      }),
    });
    const origin = `http://127.0.0.1:${app.port}`;
    try {
      const response = await globalThis.fetch(`${origin}/api/signup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: origin,
        },
        body: new globalThis.URLSearchParams({
          email: 'no-representative@example.test',
        }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'challenge_failed');
    } finally {
      await app.stop();
    }
  },
);
