// E11.6-11: a strict check of FAQPage JSON-LD against schema.org's FAQPage
// and the properties search engines require of it: an `@context` of
// schema.org, `@type` FAQPage, and a non-empty `mainEntity` of Questions,
// each with a non-empty `name` and one `acceptedAnswer` Answer with a
// non-empty `text`. Nothing else is allowed, and no question repeats.
// Exports only: node --test runs every file under test/, helpers included.

const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';

function onlyKeys(value, keys, where, issues) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) issues.push(`${where} has an unexpected ${key}`);
  }
}

/** Every way `data` fails to be valid FAQPage JSON-LD; empty when valid. */
export function faqPageIssues(data) {
  const issues = [];
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return ['the data is not an object'];
  }
  onlyKeys(data, ['@context', '@type', 'mainEntity'], 'the page', issues);
  if (data['@context'] !== 'https://schema.org') {
    issues.push('@context is not https://schema.org');
  }
  if (data['@type'] !== 'FAQPage') issues.push('@type is not FAQPage');
  if (!Array.isArray(data.mainEntity) || data.mainEntity.length === 0) {
    issues.push('mainEntity is not a non-empty list');
    return issues;
  }
  const names = new Set();
  data.mainEntity.forEach((question, index) => {
    const where = `mainEntity[${index}]`;
    if (question === null || typeof question !== 'object') {
      issues.push(`${where} is not an object`);
      return;
    }
    onlyKeys(question, ['@type', 'name', 'acceptedAnswer'], where, issues);
    if (question['@type'] !== 'Question') {
      issues.push(`${where} is not a Question`);
    }
    if (!nonEmpty(question.name)) issues.push(`${where} has no name`);
    else if (names.has(question.name)) issues.push(`${where} repeats`);
    names.add(question.name);
    const answer = question.acceptedAnswer;
    if (answer === null || typeof answer !== 'object') {
      issues.push(`${where} has no acceptedAnswer`);
      return;
    }
    onlyKeys(answer, ['@type', 'text'], `${where}.acceptedAnswer`, issues);
    if (answer['@type'] !== 'Answer') {
      issues.push(`${where}.acceptedAnswer is not an Answer`);
    }
    if (!nonEmpty(answer.text)) issues.push(`${where} has an empty answer`);
  });
  return issues;
}
