import { getCollection } from 'astro:content';
import { validateRulesCatalog, validateRulesRevision } from './rules.ts';

const entries = await getCollection('giveawayRules');
const catalog = validateRulesCatalog(
  entries.map((entry) => {
    if (!entry.body || !entry.rendered?.html) {
      throw new Error(`Giveaway rules ${entry.id} have no rendered content.`);
    }
    return validateRulesRevision({
      filePath: entry.filePath ?? '',
      data: entry.data,
      body: entry.body,
      renderedHtml: entry.rendered.html,
    });
  }),
);

export function currentRules() {
  return catalog.current;
}

export function allRulesRevisions() {
  return [...catalog.byVersion.values()];
}
