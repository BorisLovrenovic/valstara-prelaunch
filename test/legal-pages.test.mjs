import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(join(root, path), 'utf8');

const subscriberPolicyCategory = {
  id: 'Waitlist status',
  email: 'Email address',
  email_normalised: 'Email address',
  email_domain: 'Email address',
  status: 'Waitlist status',
  category_preference: 'Optional category preference',
  source: 'Acquisition source',
  utm: 'Acquisition source',
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

test('the modelled subscriber fields reconcile to policy rows with purpose, basis and retention', async () => {
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
  for (const [field, category] of Object.entries(subscriberPolicyCategory)) {
    const row = policyRows.find(([data]) => data.startsWith(category));
    assert.ok(row, `${field} has no policy category`);
    assert.equal(row.length, 4, `${field} must have four policy columns`);
    for (const [index, label] of [
      [1, 'purpose'],
      [2, 'basis'],
      [3, 'retention'],
    ]) {
      assert.ok(row[index], `${field} has no ${label}`);
    }
  }

  for (const [modelField, category] of [
    ['verification_token', 'Verification and status link records'],
    ['survey_response', 'Optional category preference'],
    ['referral_edge', 'Referral code'],
    ['giveaway_entry', 'Giveaway entries'],
    ['giveaway_award', "A provisional winner's country of residence"],
    ['fraud_flag', 'Fraud review decisions'],
    ['email_send', 'Email delivery events'],
  ]) {
    assert.ok(
      model.includes(`## \`${modelField}\``),
      `${modelField} missing from model`,
    );
    assert.ok(
      policyRows.some(([data]) => data.startsWith(category)),
      `${modelField} missing from policy`,
    );
  }
});

test('the privacy notice publishes exactly the storage allowlist entry', async () => {
  const policy = await read('src/content/privacy.md');
  const allowlist = JSON.parse(await read('scripts/ci/privacy-allowlist.json'));
  const section = policy.split('## Cookie and storage inventory\n', 2)[1];
  assert.ok(section, 'inventory heading is missing');
  const entries = tableRows(section).slice(1);
  assert.equal(entries.length, 1, 'the inventory must have one entry');
  assert.deepEqual(
    Object.keys(allowlist).filter((key) =>
      /storage|themePreference/iu.test(key),
    ),
    ['themePreference'],
  );
  assert.equal(entries[0][0], `\`${allowlist.themePreference.storageKey}\``);
  assert.match(entries[0][1], /local storage/iu);
  assert.ok(entries[0][2]);
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
  { timeout: 120_000 },
  async () => {
    const result = spawnSync('npm', ['run', 'build'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 110_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    for (const slug of ['terms', 'privacy']) {
      const content = await read(`src/content/${slug}.md`);
      const html = await read(`dist/client/${slug}/index.html`);
      assert.match(content, new RegExp(`^portTarget: /${slug}$`, 'mu'));
      assert.match(content, /\*\*Draft notice\.\*\*/u);
      assert.match(html, /Draft notice\./u);
      assert.match(html, /<h1[^>]*>/u);
      assert.doesNotMatch(html, /<script\b|\.js(?:["?]|$)/iu);
      assert.doesNotMatch(content, /representative/iu);
    }
    const signupRoute = await read('src/pages/api/signup.ts');
    assert.match(signupRoute, /createSignupRoute/u);
    assert.doesNotMatch(signupRoute, /representative|article.?27/iu);
    assert.doesNotMatch(await read('src/content/legit.md'), /representative/iu);
  },
);
