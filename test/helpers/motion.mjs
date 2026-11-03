import assert from 'node:assert/strict';

// E11.5-11i (founder decisions 2026-10-31): anchors and focus scroll
// smoothly under `prefers-reduced-motion: no-preference`, so a test that
// reads a position after Tab or an anchor jump waits for the scroll to end.
// The end is read from outside the page, so it also works with JavaScript
// disabled, where the page cannot hear scrollend: the position unchanged over
// three samples, within a bounded wait.
export async function scrollSettled(page, { samples = 3, interval = 50 } = {}) {
  const position = () =>
    page.evaluate(() => [globalThis.scrollX, globalThis.scrollY].join(','));
  let last = await position();
  for (let steady = 0, attempt = 0; steady < samples; attempt += 1) {
    assert.ok(attempt < 200, 'the scroll ends within 10 seconds');
    await new Promise((resolve) => globalThis.setTimeout(resolve, interval));
    const current = await position();
    steady = current === last ? steady + 1 : 0;
    last = current;
  }
}

// E11.5-11i: focus is never mid-motion (founder decisions 2026-10-31). For
// the focused element and every ancestor:
// - no entrance (`data-enter`), scroll reveal (`data-reveal`) or any other
//   animation is in effect;
// - a transition is allowed only as the focus's own state change, and only
//   if it ends within --duration-base; it is let finish, bounded by that
//   duration;
// - then each is at full opacity with no displacing transform (an identity
//   matrix, such as the skip link's resting translateY(0), is at rest).
// One exemption: a native checkbox or radio is a transparent 44px target over
// the box it draws (E11.5-11a), so its own opacity is not checked. Its drawn
// box, the next sibling, must be at full opacity with a visible focus ring.
// Returns the problems found, empty when focus is at rest.
export function focusMotionIssues(page) {
  return page.evaluate(async () => {
    const { document, getComputedStyle } = globalThis;
    const frame = () =>
      new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
    // A scroll-driven animation's timeline resolves after layout and takes
    // effect a frame later. Read before that and a reveal looks at rest.
    await frame();
    await frame();
    const active = document.activeElement;
    if (active === null || active === document.body) return [];
    const issues = [];
    const describe = (node) =>
      `${node.tagName.toLowerCase()}.${node.className || '(no class)'}`;
    // The built stylesheet may minify 200ms to .2s.
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue('--duration-base')
      .trim();
    const limit =
      Number.parseFloat(token) * (/(?<!m)s$/u.test(token) ? 1000 : 1);
    if (!Number.isFinite(limit) || limit <= 0)
      return ['--duration-base is not a duration'];

    const chain = [];
    for (
      let node = active;
      node !== null && node !== document.documentElement;
      node = node.parentElement
    )
      chain.push(node);

    const transitions = [];
    for (const node of chain) {
      for (const animation of node.getAnimations()) {
        const timing = animation.effect?.getComputedTiming();
        if (animation instanceof globalThis.CSSTransition) {
          if (timing.endTime > limit)
            issues.push(
              `${describe(node)} transition on ${animation.transitionProperty} lasts ${timing.endTime}ms, longer than --duration-base`,
            );
          else transitions.push(animation);
        } else if (timing?.progress !== null) {
          const kind = node.hasAttribute('data-reveal')
            ? 'reveal'
            : node.hasAttribute('data-enter')
              ? 'entrance'
              : 'animation';
          issues.push(
            `${describe(node)} ${kind} ${animation.animationName ?? ''} in effect`.trim(),
          );
        }
      }
    }
    // Each ends within --duration-base of starting (checked above); the wait
    // is bounded by that duration plus the two frames that deliver the end.
    let settled = false;
    Promise.allSettled(
      transitions.map((transition) => transition.finished),
    ).then(() => {
      settled = true;
    });
    await Promise.race([
      Promise.allSettled(transitions.map((transition) => transition.finished)),
      new Promise((resolve) => globalThis.setTimeout(resolve, limit)),
    ]);
    if (!settled) {
      await frame();
      await frame();
    }
    const timedOut = !settled;
    if (timedOut) issues.push('a focus transition is still running');

    const atRest = (node, { checkOpacity = true } = {}) => {
      const style = getComputedStyle(node);
      const matrix =
        style.transform === 'none'
          ? null
          : new globalThis.DOMMatrixReadOnly(style.transform);
      if (
        (checkOpacity && style.opacity !== '1') ||
        (matrix !== null && !matrix.isIdentity) ||
        !['none', '0px', '0px 0px'].includes(style.translate) ||
        !['none', '1'].includes(style.scale) ||
        !['none', '0deg'].includes(style.rotate)
      )
        issues.push(
          `${describe(node)} opacity ${style.opacity} transform ${style.transform} translate ${style.translate}`,
        );
    };
    for (const node of chain) {
      const transparentTarget =
        node === active &&
        node.matches('input[type="checkbox"], input[type="radio"]');
      atRest(node, { checkOpacity: !transparentTarget });
      if (transparentTarget) {
        const box = node.nextElementSibling;
        if (box === null) {
          issues.push(`${describe(node)} has no drawn box`);
          continue;
        }
        atRest(box);
        const style = getComputedStyle(box);
        if (
          style.outlineStyle === 'none' ||
          !(Number.parseFloat(style.outlineWidth) > 0)
        )
          issues.push(`${describe(node)} shows no focus ring on its box`);
      }
    }
    return issues;
  });
}
