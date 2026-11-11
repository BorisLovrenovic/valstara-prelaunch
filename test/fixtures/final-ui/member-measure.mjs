// E11.5-11r: one measurer for /me and /leaderboard, run on the canvas's
// markup by measure-member-geometry.mjs and on the built pages by
// test/member-leaderboard-final-design-rendered.test.mjs, each with its own
// selectors, so the two are compared box by box. It runs in the page
// (page.evaluate), so it is self-contained.
//
// Boxes are [x, y, width, height] in CSS px. The grid (the dashboard, the
// task column or the leaderboard grid) is relative to <main>; each card is
// relative to the grid; each element inside a card is relative to its card.
// An element that is not drawn, or is clipped to nothing for assistive
// technology only, is null.

export const canvasSelectors = {
  main: 'main',
  footer: '.footer-slot footer',
  grid: '.vgrid, .task',
  // /me: the dashboard's cards in order (status, referral, rewards,
  // preferences, data), then "Leave the waitlist".
  cards: '.vgrid > .card',
  head: '.me-head',
  facts: '.facts',
  fact: '.fact',
  badge: '.badge-wave',
  cardHead: '.card-head',
  cardTitle: '.card-title',
  linkbox: '.linkbox',
  copy: '.ref-row .btn',
  share: '.share-phone .btn',
  well: '.progress-well',
  meterValue: '.meter__value',
  track: '.meter__track',
  rewardRows: '.reward-rows > li',
  rewardBadges: '.badge-state',
  rewardSettled: '.badge-state--settled',
  rewardsEmpty: '.well:not(.progress-well)',
  prefBlocks: '.pref-block',
  switch: '.switch',
  switchWord: '.switch-state',
  prefNotice: '.pref-block .notice',
  summary: '.disclosure summary',
  legends: '.survey legend',
  chips: '.chip-option',
  segmented: '.segmented',
  segments: '.segment',
  surveyActions: '.survey__actions .btn',
  dataLinks: '.data-links a',
  leave: '.leave',
  leaveButton: '.leave .btn',
  task: '.task-card',
  taskTile: '.task-card__head .tile',
  taskHeading: '.task-card__head h1',
  taskLine: '.task-card__line',
  taskNotice: '.task-card__notice',
  taskButton: '.task-card__actions .btn',
  // /leaderboard.
  intro: '.page-intro',
  board: '.board',
  boardHead: '.board__head',
  rows: '.board__list > li',
  rank: '.board__rank',
  handle: '.board__handle',
  count: '.board__count',
  skeleton: '.board__list > li.is-skel',
  meta: '.board__meta',
  boardState: '.board__state',
  aside: '.lb-side',
  panels: '.lb-side > .card',
  panelButton: '.lb-cta .btn',
};

export const buildSelectors = {
  main: 'main',
  footer: 'body > footer',
  grid: '.member-grid, .member-task, .leaderboard-grid',
  cards: '.member-grid > .card',
  head: '.member-head',
  facts: '.member-facts',
  fact: '.member-fact',
  badge: '.member-wave',
  cardHead: '.member-card-head',
  cardTitle: '.member-card-title',
  linkbox: '.member-linkbox',
  copy: '.member-copy',
  share: '.member-native-share',
  well: '.member-meter',
  meterValue: '.member-meter__value',
  track: '.member-meter__track',
  rewardRows: '.member-reward',
  rewardBadges: '.member-reward__state',
  rewardSettled: '.member-reward__state--settled',
  rewardsEmpty: '.member-rewards-empty',
  prefBlocks: '.member-pref',
  switch: '.member-switch__track',
  switchWord: '[data-marketing-state]',
  prefNotice: '[data-marketing-result][data-result]',
  summary: '.member-survey summary',
  legends: '.member-survey legend',
  chips: '.member-chip',
  segmented: '.member-segments',
  segments: '.member-segment',
  surveyActions: '.member-survey__actions .button',
  dataLinks: '.member-data-links a',
  leave: '.member-leave',
  leaveButton: '.member-leave .button',
  task: '.member-task__card',
  taskTile: '.member-task__head .member-tile',
  taskHeading: '.member-task__head h1',
  taskLine: '.member-task__line',
  taskNotice: '.member-task__notice',
  taskButton: '.member-task__actions .button',
  intro: '.leaderboard-intro',
  board: '.leaderboard-board',
  boardHead: '.leaderboard-board-head',
  rows: '.leaderboard-entry',
  rank: '.leaderboard-rank',
  handle: '.leaderboard-handle',
  count: '.leaderboard-count',
  skeleton: '.leaderboard-skeleton > li',
  meta: '.leaderboard-meta, .leaderboard-loading',
  boardState: '.leaderboard-state',
  aside: '.leaderboard-aside',
  panels: '.leaderboard-aside > .card',
  panelButton: '[data-leaderboard-cta] .button',
};

export function measureMember(selectors) {
  const { document, getComputedStyle } = globalThis;
  const shown = (element) => {
    if (element === null || element.getClientRects().length === 0) return false;
    for (let node = element; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.clipPath !== 'none' || style.visibility === 'hidden')
        return false;
    }
    return true;
  };
  const round = (value) => Math.round(value * 100) / 100;
  const box = (element, from) => {
    if (element === null || !shown(element) || from === null) return null;
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
    element !== null && shown(element) ? element.getBoundingClientRect() : null;

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
      tile: box(one(selectors.taskTile, task), from),
      heading: box(one(selectors.taskHeading, task), from),
      line: box(one(selectors.taskLine, task), from),
      notice: all(selectors.taskNotice, task, from)[0] ?? null,
      button: box(one(selectors.taskButton, task), from),
    };
    return result;
  }

  const board = one(selectors.board);
  if (board !== null) {
    const intro = one(selectors.intro);
    result.intro = box(intro, mainRect);
    const from = rectOf(board);
    result.board = {
      card: box(board, gridRect),
      head: box(one(selectors.boardHead, board), from),
      rows: all(selectors.rows, board, from),
      ranks: all(selectors.rank, board, from),
      skeleton: all(selectors.skeleton, board, from),
      meta: box(
        [...board.querySelectorAll(selectors.meta)].find(shown) ?? null,
        from,
      ),
      state: box(one(selectors.boardState, board), from),
    };
    const aside = one(selectors.aside);
    if (shown(aside)) {
      result.aside = {
        box: box(aside, gridRect),
        panels: all(selectors.panels, aside, rectOf(aside)),
        button: box(one(selectors.panelButton, aside), rectOf(aside)),
      };
    } else result.aside = null;
    return result;
  }

  const cards = [...document.querySelectorAll(selectors.cards)];
  const [status, referral, rewards, preferences, data] = cards;
  const statusRect = rectOf(status);
  result.status = {
    card: box(status, gridRect),
    head: box(one(selectors.head, status), statusRect),
    facts: box(one(selectors.facts, status), statusRect),
    fact: all(selectors.fact, status, statusRect),
    badge: box(one(selectors.badge, status), statusRect),
  };
  const referralRect = rectOf(referral);
  result.referral = {
    card: box(referral, gridRect),
    head: box(one(selectors.cardHead, referral), referralRect),
    linkbox: box(one(selectors.linkbox, referral), referralRect),
    copy: box(one(selectors.copy, referral), referralRect),
    share: box(one(selectors.share, referral), referralRect),
    well: box(one(selectors.well, referral), referralRect),
    meterValue: box(one(selectors.meterValue, referral), referralRect),
    track: box(one(selectors.track, referral), referralRect),
  };
  const rewardsRect = rectOf(rewards);
  result.rewards = {
    card: box(rewards, gridRect),
    head: box(one(selectors.cardHead, rewards), rewardsRect),
    rows: all(selectors.rewardRows, rewards, rewardsRect),
    badges: all(selectors.rewardBadges, rewards, rewardsRect),
    // Each row's state, so rows can be compared state for state.
    states: [...rewards.querySelectorAll(selectors.rewardRows)].map((row) =>
      row.querySelector(selectors.rewardSettled) === null ? 'held' : 'settled',
    ),
    empty: box(one(selectors.rewardsEmpty, rewards), rewardsRect),
  };
  const preferencesRect = rectOf(preferences);
  result.preferences = {
    card: box(preferences, gridRect),
    title: box(one(selectors.cardTitle, preferences), preferencesRect),
    blocks: all(selectors.prefBlocks, preferences, preferencesRect),
    switch: box(one(selectors.switch, preferences), preferencesRect),
    word: box(one(selectors.switchWord, preferences), preferencesRect),
    notice: box(one(selectors.prefNotice, preferences), preferencesRect),
    summary: box(one(selectors.summary, preferences), preferencesRect),
    legends: all(selectors.legends, preferences, preferencesRect),
    chips: all(selectors.chips, preferences, preferencesRect),
    segmented: box(one(selectors.segmented, preferences), preferencesRect),
    segments: all(selectors.segments, preferences, preferencesRect),
    actions: all(selectors.surveyActions, preferences, preferencesRect),
  };
  const dataRect = rectOf(data);
  result.data = {
    card: box(data, gridRect),
    title: box(one(selectors.cardTitle, data), dataRect),
    links: all(selectors.dataLinks, data, dataRect),
  };
  const leave = one(selectors.leave);
  result.leave = {
    box: box(leave, gridRect),
    button: box(one(selectors.leaveButton, leave), rectOf(leave)),
  };
  return result;
}
