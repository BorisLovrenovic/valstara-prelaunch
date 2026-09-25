import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  giveawayRulesSchema,
  renderRulesArticle,
  validateRulesCatalog,
  validateRulesRevision,
  type GiveawayRulesData,
} from '../src/server/giveaway/rules.ts';

const rulesVersion = 'VAL-GW-LAUNCH-20260925-r1';
const source = readFileSync(
  new URL(
    '../src/content/giveaway-rules/VAL-GW-LAUNCH-20260925-r1.md',
    import.meta.url,
  ),
  'utf8',
);
const body = source.slice(source.indexOf('\n---\n') + '\n---\n'.length);
const approvedSource = readFileSync(
  new URL('../docs/prerequisites/p4-rules-page-draft.md', import.meta.url),
  'utf8',
);
const baseData = {
  rulesVersion,
  publishedOn: '2026-09-25',
  revision: 1,
  portTarget: '/giveaway/rules',
  title: 'Valstara Launch Giveaway — Official Rules',
  description: 'Official rules for the Valstara launch giveaway.',
  versionLabel: 'Rules version:',
  earlierVersionsNote:
    'Earlier versions stay available at their own permanent addresses.',
  prizeCount: 5,
  prizeApproxRetailValueEur: 300,
  conservativeUsdPerEur: 2,
  bundleContents: 'to be announced',
} as const;

function fixture(
  overrides: {
    data?: Partial<GiveawayRulesData>;
    body?: string;
    renderedHtml?: string;
    mismatchedHash?: boolean;
  } = {},
) {
  const data = { ...baseData, ...overrides.data };
  const renderedHtml = overrides.renderedHtml ?? '<h2>Rendered rules</h2>';
  const sha256 = createHash('sha256')
    .update(renderRulesArticle(data, renderedHtml), 'utf8')
    .digest('hex');
  return {
    filePath: `src/content/giveaway-rules/${rulesVersion}.md`,
    data: {
      ...data,
      sha256: overrides.mismatchedHash ? '0'.repeat(64) : sha256,
    },
    body: overrides.body ?? body,
    renderedHtml,
  };
}

test('the approved rules have every required section and statement', () => {
  const revision = validateRulesRevision(fixture());
  assert.equal(revision.rulesVersion, rulesVersion);
  assert.equal(revision.publishedOn, '2026-09-25');
  assert.equal(
    body.trim(),
    approvedSource
      .slice(approvedSource.indexOf('## 1. Who runs this giveaway'))
      .trim(),
  );
  assert.match(body, /country of residence/iu);
  assert.match(body, /don't need your postal address/iu);
  assert.match(
    body,
    /a person reviews every case before anyone is disqualified/iu,
  );
});

test('a missing or empty required section fails validation', () => {
  const missing = body.replace(/^## 10\. Taxes\n[\s\S]*?(?=^## 11\.)/mu, '');
  assert.throws(
    () => validateRulesRevision(fixture({ body: missing })),
    /required sections|section 10/u,
  );
  const empty = body.replace(
    /^## 10\. Taxes\n[\s\S]*?(?=^## 11\.)/mu,
    '## 10. Taxes\n\n',
  );
  assert.throws(
    () => validateRulesRevision(fixture({ body: empty })),
    /section 10 has no content/u,
  );
});

test('placeholders are rejected while the approved unannounced contents are allowed', () => {
  assert.doesNotThrow(() => validateRulesRevision(fixture()));
  assert.throws(
    () =>
      validateRulesRevision(fixture({ body: `${body}\nTODO: add product` })),
    /placeholder/u,
  );
  assert.throws(
    () =>
      validateRulesRevision(
        fixture({ body: `${body}\n[set by E7-02 at publication]` }),
      ),
    /placeholder/u,
  );
  assert.match(source, /^bundleContents: 'to be announced'$/mu);
  assert.doesNotMatch(source, /\bdummy product\b|^\s*-\s*placeholder/imu);
  const prizeSection = body.split('## 5. Prizes')[1].split('## 6.')[0];
  assert.doesNotMatch(prizeSection, /^\s*[-*] /mu);
});

test('the prize cap and conservative pool cap are enforced from structured values', () => {
  assert.throws(
    () =>
      validateRulesRevision(
        fixture({ data: { prizeApproxRetailValueEur: 450 } }),
      ),
    /exceeds €449/u,
  );
  assert.throws(
    () =>
      validateRulesRevision(fixture({ data: { conservativeUsdPerEur: 10 } })),
    /below US\$5,000/u,
  );
  assert.throws(
    () => validateRulesRevision(fixture({ data: { prizeCount: 6 } })),
    /prize text/u,
  );
});

test('required legal statements cannot be silently removed', () => {
  const withoutFreeEntry = body.replace(
    'No purchase or payment is necessary to enter or to win.',
    'Entry requires payment.',
  );
  assert.throws(
    () => validateRulesRevision(fixture({ body: withoutFreeEntry })),
    /missing a required statement/u,
  );
  const withPostalCollection = body.replace(
    "we don't need your postal address",
    'we need your postal address',
  );
  assert.throws(
    () => validateRulesRevision(fixture({ body: withPostalCollection })),
    /missing a required statement/u,
  );
});

test('a published revision cannot change rendered content under its recorded hash', () => {
  const published = fixture();
  assert.throws(
    () =>
      validateRulesRevision({
        ...published,
        renderedHtml: '<h2>Edited published rules</h2>',
      }),
    /SHA-256 mismatch/u,
  );
  assert.throws(
    () => validateRulesRevision(fixture({ mismatchedHash: true })),
    /SHA-256 mismatch/u,
  );
  assert.throws(
    () =>
      validateRulesRevision({
        ...fixture(),
        filePath: 'src/content/giveaway-rules/overwritten.md',
      }),
    /filename/u,
  );
});

test('catalogue selects the latest appended revision and preserves old versions', () => {
  const first = validateRulesRevision(fixture());
  assert.equal(
    validateRulesCatalog([first]).current.rulesVersion,
    rulesVersion,
  );
  const nextVersion = 'VAL-GW-LAUNCH-20260925-r2';
  const nextInput = fixture({
    data: { rulesVersion: nextVersion, revision: 2 },
  });
  const second = validateRulesRevision({
    ...nextInput,
    filePath: `src/content/giveaway-rules/${nextVersion}.md`,
  });
  const catalogue = validateRulesCatalog([second, first]);
  assert.equal(catalogue.current.rulesVersion, nextVersion);
  assert.equal(catalogue.byVersion.get(rulesVersion), first);
  assert.throws(() => validateRulesCatalog([]), /At least one/u);
  assert.throws(() => validateRulesCatalog([first, first]), /unique/u);
  assert.throws(
    () =>
      validateRulesCatalog([
        first,
        { ...first, rulesVersion: 'VAL-GW-LAUNCH-20260925-r9' },
      ]),
    /publication date and revision must be unique/u,
  );
});

test('frontmatter schema requires the permanent target, version and hash', () => {
  assert.equal(
    giveawayRulesSchema.safeParse({ ...baseData, sha256: '0'.repeat(64) })
      .success,
    true,
  );
  assert.equal(giveawayRulesSchema.safeParse(baseData).success, false);
  assert.equal(
    giveawayRulesSchema.safeParse({
      ...baseData,
      portTarget: '/giveaway/other',
      sha256: '0'.repeat(64),
    }).success,
    false,
  );
});
