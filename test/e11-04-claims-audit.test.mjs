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
