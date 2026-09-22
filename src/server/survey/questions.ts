export const surveyQuestionSets = Object.freeze({
  '2026-09-08': Object.freeze({
    categoryPreference: Object.freeze([
      'apparel',
      'footwear',
      'accessories',
      'home',
      'beauty',
    ]),
    shoppingFrequency: Object.freeze([
      'weekly',
      'monthly',
      'a few times a year',
      'rarely',
    ]),
  }),
} as const);

export type SurveyVersion = keyof typeof surveyQuestionSets;

export const currentSurveyVersion: SurveyVersion = '2026-09-08';

export interface SurveyAnswers {
  readonly category_preference: readonly string[] | null;
  readonly shopping_frequency: string | null;
}

export interface SurveySubmission {
  readonly answers: SurveyAnswers;
  readonly version: string;
}

export interface SurveyQuestionSet {
  readonly categoryPreference: readonly string[];
  readonly shoppingFrequency: readonly string[];
}

export type SurveyQuestionSets = Readonly<Record<string, SurveyQuestionSet>>;

export function validateSurveySubmission(
  submission: SurveySubmission,
  questionSets: SurveyQuestionSets = surveyQuestionSets,
): SurveySubmission | null {
  const questionSet = questionSets[submission.version];
  if (questionSet === undefined) return null;

  const categories = submission.answers.category_preference;
  if (
    categories !== null &&
    (categories.length === 0 ||
      new Set(categories).size !== categories.length ||
      categories.some(
        (category) => !questionSet.categoryPreference.includes(category),
      ))
  ) {
    return null;
  }

  const frequency = submission.answers.shopping_frequency;
  if (
    frequency !== null &&
    !questionSet.shoppingFrequency.includes(frequency)
  ) {
    return null;
  }

  return {
    answers: {
      category_preference: categories === null ? null : [...categories],
      shopping_frequency: frequency,
    },
    version: submission.version,
  };
}
