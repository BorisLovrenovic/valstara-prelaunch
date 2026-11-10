// E11.5-11q: one measurer for /verify, run on the canvas's markup by
// measure-verify-geometry.mjs and on the built page by
// test/verify-final-design-rendered.test.mjs, each with its own selectors, so
// the two are compared box by box. It runs in the page (page.evaluate), so it
// is self-contained.
//
// Boxes are [x, y, width, height] in CSS px. The grid (the success grid or
// the task column) is relative to <main>; each card is relative to the grid;
// each element inside a card is relative to its card. An element that is not
// drawn, or is clipped to nothing for assistive technology only, is null.

export const canvasSelectors = {
  main: 'main',
  footer: '.footer-slot footer',
  grid: '.vgrid, .task',
  hero: '.v-hero',
  heroTile: '.success-head .tile',
  heroHeading: '.v-hero h1',
  heroLine: '.success-head p',
  heroMeta: '.v-hero__meta',
  badge: '.badge-wave',
  badgeBars: '.badge-wave__bars i',
  referral: '.card:has(.ref-row)',
  cardTile: '.card-head .tile',
  cardTitle: '.card-title',
  linkbox: '.linkbox',
  copy: '.ref-row .btn',
  copyStatus: '.ref-status',
  share: '.share-phone .btn',
  well: '.progress-well',
  meterValue: '.meter__value',
  track: '.meter__track',
  segments: '.meter__seg',
  unlocksLabel: '.unlocks .label-sm',
  pills: '.unlocks__list .pill',
  held: '.held-line',
  survey: '.card.survey',
  legends: 'legend',
  chips: '.chip-option',
  segmented: '.segmented',
  segmentOptions: '.segment',
  surveyResult: '.survey__notice',
  fieldError: '.field__error',
  actions: '.survey__actions .btn',
  status: '.status-card',
  statusLink: '.status-card .btn',
  task: '.task-card',
  taskLead: '.task-card > .notice',
  taskTile: '.task-card__head .tile',
  taskHeading: '.task-card__head h1',
  taskLine: '.task-card__line',
  taskNotice: '.task-card__notice',
  label: '.field__label',
  input: '.input',
  button: '.task-card__actions .btn',
};

export const buildSelectors = {
  main: 'main',
  footer: 'body > footer',
  grid: '.verification-success, .verification-task',
  hero: '.verification-hero',
  heroTile: '.verification-hero__head .verification-tile',
  heroHeading: '.verification-hero h1',
  heroLine: '.verification-hero__head p',
  heroMeta: '.verification-hero__meta',
  badge: '.verification-wave',
  badgeBars: '.verification-wave__bars i',
  referral: '[data-referral-card]',
  cardTile: '.verification-card-head .verification-tile',
  cardTitle: '.verification-card-title',
  linkbox: '.verification-linkbox',
  copy: '.verification-copy',
  copyStatus: '.verification-copy-result',
  share: '.verification-native-share',
  well: '.verification-well',
  meterValue: '.verification-meter__value',
  track: '.verification-meter__track',
  segments: '.verification-meter__segment',
  unlocksLabel: '.verification-unlocks .verification-label',
  pills: '.verification-unlocks__list .pill',
  held: '.verification-held',
  survey: '.verification-survey-card',
  legends: 'legend',
  chips: '.verification-chip',
  segmented: '.verification-segments',
  segmentOptions: '.verification-segment',
  surveyResult: '.verification-survey-result',
  fieldError: '[data-survey-state="invalid"] .verification-survey-result',
  actions: '.verification-survey-actions .button',
  status: '.verification-status',
  statusLink: '.verification-status__link',
  task: '.verification-task__card',
  taskLead: '.verification-invalid__notice',
  taskTile: '.verification-task__head .verification-tile',
  taskHeading: '.verification-task__head h1',
  taskLine: '.verification-task__line',
  taskNotice:
    '.verification-resend-result[data-resend-result="success"], .verification-resend-result[data-resend-result="error"], noscript .verification-notice',
  label: '.field__label',
  input: '.input',
  button: '.verification-task__actions .button',
};

export function measureVerify(selectors) {
  const { document, getComputedStyle } = globalThis;
  const shown = (element) =>
    element !== null &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).clipPath === 'none' &&
    getComputedStyle(element).visibility !== 'hidden';
  const round = (value) => Math.round(value * 100) / 100;
  const box = (element, from) => {
    if (!shown(element) || from === null) return null;
    const rect = element.getBoundingClientRect();
    return [
      rect.left - from.left,
      rect.top - from.top,
      rect.width,
      rect.height,
    ].map(round);
  };
  const one = (selector, scope = document) => scope.querySelector(selector);
  const all = (selector, scope, from) =>
    [...scope.querySelectorAll(selector)]
      .filter(shown)
      .map((element) => box(element, from));
  const rectOf = (element) =>
    shown(element) ? element.getBoundingClientRect() : null;

  const main = one(selectors.main);
  const grid = one(selectors.grid);
  const mainRect = main.getBoundingClientRect();
  const gridRect = grid.getBoundingClientRect();
  const footer = one(selectors.footer);
  const result = {
    grid: box(grid, mainRect),
    footerGap: round(footer.getBoundingClientRect().top - gridRect.bottom),
  };

  const task = one(selectors.task);
  if (shown(task)) {
    const from = rectOf(task);
    result.task = {
      card: box(task, gridRect),
      lead: box(one(selectors.taskLead, task), from),
      tile: box(one(selectors.taskTile, task), from),
      heading: box(one(selectors.taskHeading, task), from),
      line: box(one(selectors.taskLine, task), from),
      notice: all(selectors.taskNotice, task, from)[0] ?? null,
      label: box(one(selectors.label, task), from),
      input: box(one(selectors.input, task), from),
      button: box(one(selectors.button, task), from),
    };
    return result;
  }

  const hero = one(selectors.hero);
  const heroRect = rectOf(hero);
  result.hero = {
    card: box(hero, gridRect),
    tile: box(one(selectors.heroTile, hero), heroRect),
    heading: box(one(selectors.heroHeading, hero), heroRect),
    line: box(one(selectors.heroLine, hero), heroRect),
    meta: box(one(selectors.heroMeta, hero), heroRect),
    badge: box(one(selectors.badge, hero), heroRect),
    bars: all(selectors.badgeBars, hero, heroRect),
  };

  const referral = one(selectors.referral);
  if (shown(referral)) {
    const from = rectOf(referral);
    result.referral = {
      card: box(referral, gridRect),
      tile: box(one(selectors.cardTile, referral), from),
      title: box(one(selectors.cardTitle, referral), from),
      linkbox: box(one(selectors.linkbox, referral), from),
      copy: box(one(selectors.copy, referral), from),
      copyStatus: box(one(selectors.copyStatus, referral), from),
      share: box(one(selectors.share, referral), from),
      well: box(one(selectors.well, referral), from),
      meterValue: box(one(selectors.meterValue, referral), from),
      track: box(one(selectors.track, referral), from),
      segments: all(selectors.segments, referral, from),
      unlocksLabel: box(one(selectors.unlocksLabel, referral), from),
      pills: all(selectors.pills, referral, from),
      held: box(one(selectors.held, referral), from),
    };
  } else result.referral = null;

  const survey = one(selectors.survey);
  if (shown(survey)) {
    const from = rectOf(survey);
    result.survey = {
      card: box(survey, gridRect),
      title: box(one(selectors.cardTitle, survey), from),
      legends: all(selectors.legends, survey, from),
      chips: all(selectors.chips, survey, from),
      segmented: box(one(selectors.segmented, survey), from),
      segments: all(selectors.segmentOptions, survey, from),
      result: box(one(selectors.surveyResult, survey), from),
      fieldError: box(one(selectors.fieldError, survey), from),
      actions: all(selectors.actions, survey, from),
    };
  } else result.survey = null;

  const status = one(selectors.status);
  const statusRect = rectOf(status);
  result.status = {
    card: box(status, gridRect),
    tile: box(one(selectors.cardTile, status), statusRect),
    title: box(one(selectors.cardTitle, status), statusRect),
    link: box(one(selectors.statusLink, status), statusRect),
  };
  return result;
}
