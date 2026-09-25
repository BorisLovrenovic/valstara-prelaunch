import { createHash } from 'node:crypto';
import { z } from 'astro/zod';

export const giveawayRulesSchema = z.object({
  rulesVersion: z.string().regex(/^VAL-GW-[A-Z0-9]+-\d{8}-r[1-9]\d*$/u),
  publishedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  revision: z.number().int().positive(),
  portTarget: z.literal('/giveaway/rules'),
  title: z.string().min(1),
  description: z.string().min(1),
  versionLabel: z.string().min(1),
  earlierVersionsNote: z.string().min(1),
  prizeCount: z.number().int().positive(),
  prizeApproxRetailValueEur: z.number().positive(),
  conservativeUsdPerEur: z.number().positive(),
  bundleContents: z.union([
    z.literal('to be announced'),
    z.array(z.string().min(1)).min(1),
  ]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export type GiveawayRulesData = z.infer<typeof giveawayRulesSchema>;

export interface RulesRevision {
  rulesVersion: string;
  sha256: string;
  html: string;
  title: string;
  description: string;
  publishedOn: string;
  revision: number;
}

const requiredHeadings = [
  'Who runs this giveaway',
  'Who can enter',
  'How to enter — no purchase necessary',
  'Entry period',
  'Prizes',
  "If a product isn't available",
  'Your chances of winning',
  'How winners are chosen',
  'Winner checks',
  'Taxes',
  'Disqualification',
  'Winner publicity',
  'Your data',
  'Changes to these rules',
  'Governing law',
] as const;

const requiredStatements = [
  /no purchase or payment is necessary/iu,
  /18 or older/iu,
  /one registration per person/iu,
  /no person can win more than one prize/iu,
  /number of eligible entries you hold divided by the total number of eligible entries/iu,
  /winners are responsible for any taxes/iu,
  /country of residence/iu,
  /don.t need your postal address/iu,
  /sanctions laws/iu,
  /if you live in Canada, correctly answer a short mathematical skill-testing question/iu,
  /within 14 days/iu,
  /laws of Hong Kong/iu,
  /3NITY DIGITAL LIMITED/iu,
  /79886556/u,
  /a person reviews every case before anyone is disqualified/iu,
  /compliance@subslush\.com within 14 days/iu,
  /separate permission/iu,
] as const;

function escapeHtml(value: string): string {
  return value.replaceAll(/[&<>"']/gu, (character) => {
    const escaped: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return escaped[character];
  });
}

export function renderRulesArticle(
  data: Pick<
    GiveawayRulesData,
    'title' | 'versionLabel' | 'rulesVersion' | 'earlierVersionsNote'
  >,
  renderedHtml: string,
): string {
  return (
    `<h1>${escapeHtml(data.title)}</h1>` +
    `<p><strong>${escapeHtml(data.versionLabel)}</strong> ${escapeHtml(data.rulesVersion)} · ${escapeHtml(data.earlierVersionsNote)}</p>` +
    renderedHtml
  );
}

function validateSections(body: string): void {
  const headings = [...body.matchAll(/^## (\d+)\. ([^\n]+)$/gmu)];
  if (headings.length !== requiredHeadings.length) {
    throw new Error('Giveaway rules must contain all 15 required sections.');
  }
  for (const [index, heading] of headings.entries()) {
    const expected = `${index + 1}. ${requiredHeadings[index]}`;
    if (`${heading[1]}. ${heading[2]}` !== expected) {
      throw new Error(
        `Giveaway rules section ${index + 1} is missing or changed.`,
      );
    }
    const sectionEnd = headings[index + 1]?.index ?? body.length;
    if (
      !body.slice((heading.index ?? 0) + heading[0].length, sectionEnd).trim()
    ) {
      throw new Error(`Giveaway rules section ${index + 1} has no content.`);
    }
  }
}

export function validateRulesRevision(input: {
  filePath: string;
  data: unknown;
  body: string;
  renderedHtml: string;
}): RulesRevision {
  const data = giveawayRulesSchema.parse(input.data);
  if (input.filePath.split('/').at(-1) !== `${data.rulesVersion}.md`) {
    throw new Error('Giveaway rules filename must equal rulesVersion.');
  }
  const versionSuffix = `${data.publishedOn.replaceAll('-', '')}-r${data.revision}`;
  if (!data.rulesVersion.endsWith(versionSuffix)) {
    throw new Error(
      'Giveaway rules version must match publication date and revision.',
    );
  }
  if (
    /\[(?:todo|tbd|placeholder|set by)[^\]]*\]|\b(?:todo|tbd|placeholder|lorem ipsum|dummy product)\b/iu.test(
      input.body,
    )
  ) {
    throw new Error('Giveaway rules contain a placeholder marker.');
  }
  validateSections(input.body);
  for (const statement of requiredStatements) {
    if (!statement.test(input.body)) {
      throw new Error(
        `Giveaway rules are missing a required statement: ${statement.source}`,
      );
    }
  }
  if (data.prizeApproxRetailValueEur > 449) {
    throw new Error('A giveaway prize exceeds €449.');
  }
  const poolUsd =
    data.prizeCount *
    data.prizeApproxRetailValueEur *
    data.conservativeUsdPerEur;
  if (poolUsd >= 5000) {
    throw new Error('The giveaway prize pool must stay below US$5,000.');
  }
  const totalEur = data.prizeCount * data.prizeApproxRetailValueEur;
  if (
    !input.body.includes(`${data.prizeCount} prizes`) ||
    !input.body.includes(`€${data.prizeApproxRetailValueEur}`) ||
    !input.body.includes(`€${totalEur.toLocaleString('en-US')}`)
  ) {
    throw new Error(
      'Giveaway prize text does not match its structured values.',
    );
  }
  if (data.bundleContents === 'to be announced') {
    if (
      !/goods in the bundle will be listed on this page before the draw/iu.test(
        input.body,
      )
    ) {
      throw new Error(
        'Unannounced bundle contents need a pre-draw listing promise.',
      );
    }
  } else if (data.bundleContents.some((item) => !input.body.includes(item))) {
    throw new Error('Every listed bundle item must appear in the prize text.');
  }

  const html = renderRulesArticle(data, input.renderedHtml);
  const actualHash = createHash('sha256').update(html, 'utf8').digest('hex');
  if (actualHash !== data.sha256) {
    throw new Error(
      `Giveaway rules ${data.rulesVersion} SHA-256 mismatch: recorded ${data.sha256}, rendered ${actualHash}.`,
    );
  }
  return {
    rulesVersion: data.rulesVersion,
    sha256: actualHash,
    html,
    title: data.title,
    description: data.description,
    publishedOn: data.publishedOn,
    revision: data.revision,
  };
}

export function validateRulesCatalog(revisions: RulesRevision[]): {
  current: RulesRevision;
  byVersion: ReadonlyMap<string, RulesRevision>;
} {
  const byVersion = new Map<string, RulesRevision>();
  for (const revision of revisions) {
    if (byVersion.has(revision.rulesVersion)) {
      throw new Error('Giveaway rules versions must be unique.');
    }
    byVersion.set(revision.rulesVersion, revision);
  }
  if (revisions.length === 0) {
    throw new Error('At least one giveaway rules revision is required.');
  }
  const ordered = [...revisions].sort((left, right) =>
    left.publishedOn === right.publishedOn
      ? left.revision - right.revision
      : left.publishedOn.localeCompare(right.publishedOn),
  );
  for (let index = 1; index < ordered.length; index += 1) {
    if (
      ordered[index].publishedOn === ordered[index - 1].publishedOn &&
      ordered[index].revision === ordered[index - 1].revision
    ) {
      throw new Error(
        'Giveaway rules publication date and revision must be unique.',
      );
    }
  }
  return { current: ordered[ordered.length - 1], byVersion };
}
