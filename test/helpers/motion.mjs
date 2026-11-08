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

// E11.5-11l (founder-authorised 2026-11-07): the hero's first-paint entrance
// runs once per page load and ends within 580ms. A test that reads geometry
// with motion allowed waits for it, bounded at 2 seconds, so it measures the
// page at rest. A finished entrance leaves document.getAnimations(), because
// its fill is backwards only. It works with JavaScript disabled, because the
// check runs from outside the page.
export async function entranceEnded(page) {
  const entering = () =>
    page.evaluate(
      () =>
        globalThis.document
          .getAnimations()
          .filter((animation) =>
            animation.effect?.target?.matches?.('[data-enter]'),
          ).length,
    );
  for (let attempt = 0; (await entering()) > 0; attempt += 1) {
    assert.ok(attempt < 40, 'the entrance ends within 2 seconds');
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
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

// E11.5-11m: the signup island's state motion. `recordStateMotion` installs
// a recorder in the page that notes, as each state change happens, every CSS
// transition then running and where focus is. A change is an element shown
// or hidden, a `data-leaving` or `data-returning` mark, or a button's label
// replaced. `readStateMotion` returns the notes. With `pauseOn` set to an
// event name, the first such change also pauses every running transition,
// so a test can read the page mid-transition; `resumeStateMotion` plays
// them on. Each transition is noted with its target (with its pseudo-element),
// property, duration, delay and its first and last values.
export function recordStateMotion(page, { pauseOn = null } = {}) {
  return page.evaluate((pause) => {
    const { document, performance } = globalThis;
    const marks = [
      'data-success',
      'data-form-error',
      'data-resend-status',
      'data-resend',
      'data-dock-error',
      'data-dock-confirmation',
      'data-dock-submit',
      'data-dock-close',
      'data-different-address',
      'data-submit',
      'data-dock',
    ];
    const describe = (element) => {
      if (!(element instanceof globalThis.Element)) return null;
      if (element.id) return `#${element.id}`;
      const mark = marks.find((name) => element.hasAttribute(name));
      if (mark !== undefined) return `[${mark}]`;
      if (element.hasAttribute('data-label-entering')) return 'label';
      const first = String(element.getAttribute('class') ?? '').split(' ')[0];
      return `${element.tagName.toLowerCase()}${first ? `.${first}` : ''}`;
    };
    const camel = (property) =>
      property.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    const transitions = () =>
      document
        .getAnimations()
        .filter((animation) => animation instanceof globalThis.CSSTransition)
        .map((animation) => {
          const timing = animation.effect.getComputedTiming();
          const frames = animation.effect.getKeyframes();
          const key = camel(animation.transitionProperty);
          return {
            target: `${describe(animation.effect.target)}${animation.effect.pseudoElement ?? ''}`,
            property: animation.transitionProperty,
            duration: timing.duration,
            delay: timing.delay,
            from: frames[0]?.[key],
            to: frames.at(-1)?.[key],
          };
        });
    globalThis.stateMotion = [];
    let paused = false;
    // Changes made in one task arrive in one batch, so the batch's time is
    // each change's time, and whether a mark was added is read from its old
    // value: with reduced motion a mark can be added and removed in one task.
    const observer = new globalThis.MutationObserver((records) => {
      const running = transitions();
      const t = performance.now();
      for (const record of records) {
        let event;
        if (record.type === 'childList') {
          if (!record.target.matches('button')) continue;
          event = 'label';
        } else if (record.attributeName === 'hidden') {
          if (record.oldValue === null) event = 'hidden';
          else if (!record.target.hidden) event = 'shown';
          else continue;
        } else {
          if (record.oldValue !== null) continue;
          event = record.attributeName.replace('data-', '');
        }
        globalThis.stateMotion.push({
          event,
          target: describe(record.target),
          t,
          focus: describe(document.activeElement),
          transitions: running,
        });
        if (!paused && pause === event) {
          paused = true;
          for (const animation of document.getAnimations())
            if (animation instanceof globalThis.CSSTransition)
              animation.pause();
        }
      }
    });
    observer.observe(document.querySelector('valstara-signup-form'), {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['hidden', 'data-leaving', 'data-returning'],
    });
  }, pauseOn);
}

export function readStateMotion(page) {
  return page.evaluate(() => globalThis.stateMotion);
}

export function resumeStateMotion(page) {
  return page.evaluate(() => {
    for (const animation of globalThis.document.getAnimations())
      if (animation instanceof globalThis.CSSTransition) animation.play();
  });
}

// Waits, bounded at 2 seconds, until no CSS transition runs in the page.
export async function transitionsEnded(page) {
  await page.waitForFunction(
    () =>
      globalThis.document
        .getAnimations()
        .every((animation) => !(animation instanceof globalThis.CSSTransition)),
    undefined,
    { timeout: 2_000 },
  );
}
