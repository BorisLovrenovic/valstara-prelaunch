import programmeDocument from '../../content/partner-programme.json' with { type: 'json' };

export interface PartnerProgrammeSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
}

export interface PartnerProgrammeContent {
  readonly title: string;
  readonly description: string;
  readonly heading: string;
  readonly sections: readonly PartnerProgrammeSection[];
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`The partner programme content needs ${label}.`);
  }
  return value;
}

/** Validates `src/content/partner-programme.json`, the `/partners` page's prose. */
export function parsePartnerProgrammeContent(
  value: unknown,
): PartnerProgrammeContent {
  const document = (value ?? {}) as Record<string, unknown>;
  const sections = document.sections;
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error('The partner programme content needs sections.');
  }
  return Object.freeze({
    title: nonEmpty(document.title, 'a title'),
    description: nonEmpty(document.description, 'a description'),
    heading: nonEmpty(document.heading, 'a heading'),
    sections: Object.freeze(
      sections.map((section: unknown) => {
        const entry = (section ?? {}) as Record<string, unknown>;
        const paragraphs = entry.paragraphs;
        if (!Array.isArray(paragraphs) || paragraphs.length === 0) {
          throw new Error('Each partner programme section needs paragraphs.');
        }
        return Object.freeze({
          heading: nonEmpty(entry.heading, 'a section heading'),
          paragraphs: Object.freeze(
            paragraphs.map((paragraph) => nonEmpty(paragraph, 'a paragraph')),
          ),
        });
      }),
    ),
  });
}

export const partnerProgrammeContent =
  parsePartnerProgrammeContent(programmeDocument);
