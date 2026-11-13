import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test, { before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { landingCopy } from '../src/copy/landing.ts';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
import { giveawayCard, renderLanding } from './helpers/landing-render.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const currentVersion = 'VAL-GW-LAUNCH-20261009-r1';
const rulesDirectory = join(root, 'src/content/giveaway-rules');

before(async () => {
  await ensureAppBuild();
});

async function filesUnder(directory, extensions) {
  return (await readdir(join(root, directory), { recursive: true }))
    .filter((name) => extensions.some((extension) => name.endsWith(extension)))
    .map((name) => join(directory, name));
}

async function customerSources() {
  const paths = [
    ...(await filesUnder('src/copy', ['.ts'])),
    ...(await filesUnder('src/content', ['.md'])),
    'src/server/email/transactional-templates.ts',
    'src/server/email/weekly-template.ts',
    'src/server/email/template-layout.ts',
  ];
  return Promise.all(
    paths.map(async (path) => ({
      path,
      source: await readFile(join(root, path), 'utf8'),
    })),
  );
}

test('full-site customer copy, including email templates, has no forbidden or placeholder prose', async () => {
  const policy = JSON.parse(
    await readFile(join(root, 'scripts/forbidden-copy.json'), 'utf8'),
  );
  const sources = await customerSources();
  for (const { path, source } of sources) {
    for (const { term } of policy.entries)
      assert.ok(
        !source.toLowerCase().includes(term),
        `${path}: forbidden ${term}`,
      );
    assert.doesNotMatch(
      source,
      /\b(?:TODO|TBD|lorem ipsum|dummy product|insert (?:text|copy)|replace this text)\b/iu,
      path,
    );
  }
  const gate = spawnSync(process.execPath, ['scripts/ci/security-gates.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(gate.status, 0, `${gate.stdout}\n${gate.stderr}`);
});

test('the founder-approved revision changes only the representative sentence and metadata', async () => {
  const earlier = await readFile(
    join(rulesDirectory, 'VAL-GW-LAUNCH-20261001-r1.md'),
    'utf8',
  );
  const current = await readFile(
    join(rulesDirectory, `${currentVersion}.md`),
    'utf8',
  );
  const representativeSentence =
    'Our EU and UK data-protection representatives are listed in our [Privacy Notice](/privacy). They are not the organisers of this giveaway.\n\n';
  assert.equal(earlier.split(representativeSentence).length, 2);
  assert.doesNotMatch(current, /data-protection representatives/iu);
  const expected = earlier
    .replace(representativeSentence, '')
    .replace('VAL-GW-LAUNCH-20261001-r1', currentVersion)
    .replace("publishedOn: '2026-10-01'", "publishedOn: '2026-10-09'")
    .replace(
      /sha256: '[a-f0-9]{64}'/u,
      "sha256: 'd35678f459daa99560613337a923b7f2cb5f0347fceae3d77a1ad67bc8b908e4'",
    );
  assert.equal(current, expected);
});

test('current giveaway claims match the approved rules and prize limits', async () => {
  const rules = await readFile(
    join(rulesDirectory, `${currentVersion}.md`),
    'utf8',
  );
  const signup = await readFile(join(root, 'src/copy/signup.ts'), 'utf8');
  const award = await readFile(
    join(root, 'src/copy/giveaway-award.ts'),
    'utf8',
  );
  const adr = await readFile(
    join(root, 'docs/architecture/adr/026-global-giveaway-hong-kong-law.md'),
    'utf8',
  );
  assert.match(
    rules,
    /No purchase or payment is necessary to enter or to win/u,
  );
  assert.match(signup, /No purchase necessary/u);
  assert.match(rules, /18 or older/u);
  assert.match(signup, /aged 18 and over/u);
  assert.match(award, /18 or older/u);
  assert.match(rules, /No person can win more than one prize/u);
  assert.match(rules, /Every eligible entry counts equally/u);
  assert.match(
    rules,
    /number of eligible entries you hold divided by the total number of eligible entries/u,
  );
  const count = Number(/^prizeCount: (\d+)$/mu.exec(rules)?.[1]);
  const value = Number(/^prizeApproxRetailValueEur: (\d+)$/mu.exec(rules)?.[1]);
  const rate = Number(/^conservativeUsdPerEur: (\d+)$/mu.exec(rules)?.[1]);
  assert.equal(count, 5);
  assert.equal(value, 300);
  assert.ok(value <= 449 && count * value * rate < 5000);
  assert.match(rules, /5 prizes/u);
  assert.match(rules, /€300/u);
  assert.match(rules, /€1,500/u);
  const landingPrize = landingCopy.rewards.prize({
    prizeCount: count,
    prizeApproxRetailValueEur: value,
  });
  assert.ok(landingPrize.includes(`${count} prizes`));
  assert.ok(landingPrize.includes(`€${value}`));
  const rendered = await renderLanding({
    flags: [{ key: 'giveaway.open', enabled: true }],
  });
  const card = giveawayCard(rendered.body);
  assert.ok(
    card.includes(landingPrize),
    'rendered giveaway card matches current rules figures',
  );
  // The figures readers see are drawn apart from that sentence.
  const drawnLine =
    /<p\b[^>]*class="landing-prize__line"[^>]*>([\s\S]*?)<\/p>/u.exec(
      card,
    )?.[1];
  assert.ok(drawnLine, 'rendered giveaway card draws the prize line');
  assert.deepEqual(
    [
      ...drawnLine.matchAll(
        /<span\b[^>]*class="landing-figure\b[^"]*"[^>]*>([^<]*)<\/span>/gu,
      ),
    ].map(([, text]) => text.trim()),
    [String(count), `€${value.toLocaleString('en-US')}`],
    'drawn prize figures match current rules figures',
  );
  assert.equal(
    drawnLine
      .replace(/<[^>]+>/gu, '')
      .replace(/\s+/gu, ' ')
      .trim(),
    landingPrize,
    'drawn prize line states the same claim',
  );
  assert.ok(card.includes(landingCopy.rewards.freeEntry));
  assert.ok(card.includes(landingCopy.rewards.age));
  assert.equal(landingCopy.rewards.freeEntry, 'No purchase necessary');
  assert.equal(landingCopy.rewards.age, '18 and over');
  assert.match(adr, /€449 or less/u);
  assert.match(adr, /below US\$5,000/u);
});

test('guarantee and sourcing claims match the founder-approved source', async () => {
  const source = await readFile(
    join(root, 'docs/prerequisites/p3b-trust-pages-copy.md'),
    'utf8',
  );
  for (const name of ['legit', 'guarantee', 'about']) {
    const content = await readFile(
      join(root, `src/content/${name}.md`),
      'utf8',
    );
    const original = source.split(`## /${name}\n`)[1]?.split('\n---\n')[0];
    assert.ok(original, `missing approved /${name} source`);
    const approvedCopy = original
      .split('### Page copy\n')[1]
      ?.split('### Source notes')[0]
      ?.split('*Widget-on variant')[0]
      ?.replace('*Pre-launch paragraph, removed at the storefront port:* ', '')
      ?.trim();
    assert.ok(approvedCopy, `missing approved /${name} page copy`);
    const body = content.split('\n---\n')[1]?.trim();
    const normalizeTables = (value) =>
      value
        .replace(/^\|.*\|$/gmu, (row) =>
          row
            .split('|')
            .slice(1, -1)
            .map((cell) => (/^-+$/u.test(cell.trim()) ? '---' : cell.trim()))
            .join('|'),
        )
        .trim();
    assert.equal(normalizeTables(body), normalizeTables(approvedCopy));
  }
});

test('landing data claim names email processors without promising exclusive processing', async () => {
  const landing = await readFile(join(root, 'src/copy/landing.ts'), 'utf8');
  assert.match(
    landing,
    /Our email providers process it to deliver those messages/u,
  );
  assert.doesNotMatch(landing, /and nowhere else/u);
});

// E11.5-12: the claims audit re-run on the redesigned surfaces.

// The P8 record's provider tables: display name, logo file, brand colour,
// under the category heading whose v2 token they sit beneath.
async function p8Providers() {
  const record = await readFile(
    join(root, 'docs/prerequisites/p8-provider-list.md'),
    'utf8',
  );
  const providers = [];
  let category;
  for (const line of record.split('\n')) {
    const heading = /^### .+ — `([a-z_]+)`$/u.exec(line);
    if (heading) {
      category = heading[1];
      continue;
    }
    const row = /^\| ([^|]+?) \| `([^`]+)` \| `(#[0-9a-f]{6})` \|/u.exec(line);
    if (row && category)
      providers.push({
        name: row[1],
        category,
        logo: `/images/providers/${row[2]}`,
        brandColor: row[3],
      });
  }
  return { record, providers };
}

function showcaseDrift(p8, showcase) {
  const key = ({ name, category, logo, brandColor }) =>
    JSON.stringify({ name, category, logo, brandColor });
  const recorded = new Set(p8.map(key));
  const built = new Set(showcase.map(key));
  return {
    unconfirmed: showcase.filter((entry) => !recorded.has(key(entry))),
    missing: p8.filter((entry) => !built.has(key(entry))),
  };
}

test('E11.5-12: every showcase entry matches its P8 confirmation, and the landing page shows exactly those providers', async () => {
  const { record, providers: p8 } = await p8Providers();
  const showcase = JSON.parse(
    await readFile(join(root, 'src/content/provider-showcase.json'), 'utf8'),
  );
  assert.equal(p8.length, 34, 'the P8 record lists 34 providers');
  assert.match(
    record,
    /Every provider below is confirmed for the launch catalogue by \*\*Boris Lovrenovic, 2026-10-25\*\*/u,
  );
  assert.deepEqual(showcaseDrift(p8, showcase), {
    unconfirmed: [],
    missing: [],
  });
  assert.deepEqual(
    showcase.map(({ name }) => name),
    p8.map(({ name }) => name),
    'the showcase keeps the P8 order',
  );
  for (const entry of showcase) {
    assert.deepEqual(
      entry.confirmation,
      { name: 'Boris Lovrenovic', date: '2026-10-25' },
      `${entry.name}: catalogue confirmation`,
    );
    assert.deepEqual(
      entry.source,
      { kind: 'founder-supplied', date: '2026-10-25' },
      `${entry.name}: logo source`,
    );
  }
  // Planted drift in either direction is reported, so the comparison above
  // cannot pass over an unconfirmed or a dropped provider.
  assert.deepEqual(
    showcaseDrift(p8, [
      ...showcase.slice(1),
      { ...showcase[0], name: 'Unconfirmed Provider' },
    ]).unconfirmed.map(({ name }) => name),
    ['Unconfirmed Provider'],
  );
  assert.deepEqual(
    showcaseDrift(p8, showcase.slice(1)).missing.map(({ name }) => name),
    [showcase[0].name],
  );

  const { body } = await renderLanding();
  const catalogue = [...body.matchAll(/data-provider-banner="([^"]+)"/gu)].map(
    ([, name]) => name.replaceAll('&amp;', '&'),
  );
  assert.deepEqual(
    catalogue,
    p8.map(({ name }) => name),
    'the catalogue shows every confirmed provider, once, and no other',
  );
  const logos = new Set(
    [...body.matchAll(/\/images\/providers\/[a-z0-9-]+\.(?:svg|webp)/gu)].map(
      ([path]) => path,
    ),
  );
  const confirmedLogos = new Set(p8.map(({ logo }) => logo));
  assert.deepEqual(
    [...logos].filter((logo) => !confirmedLogos.has(logo)),
    [],
    'every rendered logo is a confirmed P8 file',
  );
  for (const attribute of ['data-hero-banner', 'data-final-banner']) {
    const names = [
      ...body.matchAll(new RegExp(`${attribute}="([^"]+)"`, 'gu')),
    ];
    assert.ok(names.length > 0, `${attribute} banners render`);
    for (const [, name] of names)
      assert.ok(
        p8.some((provider) => provider.name === name.replaceAll('&amp;', '&')),
        `${attribute} ${name} is a confirmed provider`,
      );
  }
});

test('E11.5-12: every rendered reward figure matches the referral configuration and its documented source', async () => {
  const { milestoneTiers } = await import('../src/server/referral/config.ts');
  const referral = await readFile(
    join(root, 'docs/modules/referral.md'),
    'utf8',
  );
  // ADR-025's confirmed values, as the referral module records them.
  assert.match(referral, /\*\*Tier 1 — 3 confirmed referrals:\*\*/u);
  assert.match(referral, /= 15% launch discount/u);
  assert.match(
    referral,
    /\(15% \/ 25%\) are \*\*confirmed production values\*\*/u,
  );
  assert.match(referral, /qualification deadline 90 days after store launch/u);
  assert.deepEqual(
    milestoneTiers.map(({ number, threshold, discountPercent, enabled }) => ({
      number,
      threshold,
      discountPercent,
      enabled,
    })),
    [
      { number: 1, threshold: 3, discountPercent: 15, enabled: true },
      { number: 2, threshold: 5, discountPercent: 25, enabled: false },
    ],
  );

  const { body } = await renderLanding();
  // What a reader sees: the page's text, without its styles and scripts,
  // whose percentages are geometry rather than claims.
  const visible = body
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ');
  const enabled = milestoneTiers.filter((tier) => tier.enabled);
  assert.deepEqual(
    [...body.matchAll(/class="landing-tier" data-tier="(\d+)"/gu)].map(
      ([, number]) => Number(number),
    ),
    enabled.map(({ number }) => number),
    'only enabled tiers are promised',
  );
  for (const tier of enabled) {
    const sentence = landingCopy.rewards.tier(tier);
    assert.ok(visible.includes(sentence), `tier ${tier.number} sentence`);
    assert.ok(
      sentence.includes(`${tier.threshold} confirmed referrals`) &&
        sentence.includes(`${tier.discountPercent}% off`),
    );
    const drawn = new RegExp(
      `data-tier="${tier.number}"[\\s\\S]*?<span class="landing-figure tabular-figure"[^>]*>\\s*${tier.threshold}\\s*</span>[\\s\\S]*?<span class="tabular-figure"[^>]*>\\s*${tier.discountPercent}%\\s*</span>`,
      'u',
    );
    assert.match(body, drawn, `tier ${tier.number} drawn figures`);
  }
  for (const tier of milestoneTiers.filter((candidate) => !candidate.enabled))
    assert.ok(
      !visible.includes(landingCopy.rewards.tier(tier)) &&
        !visible.includes(`${tier.discountPercent}%`) &&
        !new RegExp(`\\b${tier.threshold} confirmed referrals`, 'u').test(
          visible,
        ),
      `disabled tier ${tier.number} is not promised`,
    );
  // The held-discount window, wherever a surface states it.
  const window = /within (\d+) days after (?:store )?launch/u;
  for (const path of [
    'src/copy/landing.ts',
    'src/copy/verification.ts',
    'src/copy/member-status.ts',
    'src/copy/email.ts',
  ]) {
    const source = await readFile(join(root, path), 'utf8');
    const stated = [...source.matchAll(new RegExp(window, 'gu'))];
    assert.ok(stated.length > 0, `${path} states the held window`);
    for (const [, days] of stated) assert.equal(days, '90', path);
  }
  assert.ok(body.includes(landingCopy.rewards.held));
});
