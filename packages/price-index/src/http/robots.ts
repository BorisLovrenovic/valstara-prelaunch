// robots.txt (RFC 9309), read for the `*` group only (E11.6-04 founder
// decision 2: the fetcher presents as an ordinary browser, whose user agent
// no named group lists). Allow and Disallow rules use the longest match, an
// Allow winning a tie; `*` matches any run of characters and a trailing `$`
// anchors the end. `Crawl-delay` is read from the same group.

interface Rule {
  allow: boolean;
  pattern: string;
  matcher: RegExp;
}

export interface RobotsRules {
  /** The `*` group's rules, in file order. Empty when the group is absent. */
  readonly rules: readonly { allow: boolean; pattern: string }[];
  /** The `*` group's `Crawl-delay` in milliseconds, or null without one. */
  readonly crawlDelayMilliseconds: number | null;
  isAllowed(pathAndQuery: string): boolean;
}

function compile(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`, 'u');
}

/** Seconds as written in `Crawl-delay` (`10`, `2.5`), in whole milliseconds. */
function crawlDelayMilliseconds(value: string): number | null {
  const match = /^(\d{1,6})(?:\.(\d{1,3})\d*)?$/u.exec(value);
  if (!match) {
    return null;
  }
  const whole = Number.parseInt(match[1] ?? '0', 10);
  const fraction = Number.parseInt((match[2] ?? '').padEnd(3, '0'), 10);
  return whole * 1000 + fraction;
}

/** Normalises percent-encoding so `%7e` and `%7E` compare equal. */
function normalisePath(value: string): string {
  return value.replace(/%[0-9a-f]{2}/giu, (escape) => escape.toUpperCase());
}

export function parseRobots(text: string): RobotsRules {
  const rules: Rule[] = [];
  let crawlDelay: number | null = null;
  // Whether the current group names `*`, and whether its user-agent lines
  // have ended (a rule after them belongs to the group).
  let inStar = false;
  let collectingAgents = false;

  for (const rawLine of text.split(/\r\n|\r|\n/u)) {
    const line = rawLine.replace(/#.*$/u, '').trim();
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === 'user-agent') {
      if (!collectingAgents) {
        inStar = false;
        collectingAgents = true;
      }
      if (value === '*') {
        inStar = true;
      }
      continue;
    }
    collectingAgents = false;
    if (!inStar) {
      continue;
    }
    if (key === 'allow' || key === 'disallow') {
      // An empty Disallow allows everything, which is the default anyway.
      if (value === '') {
        continue;
      }
      const pattern = normalisePath(value);
      rules.push({
        allow: key === 'allow',
        pattern,
        matcher: compile(pattern),
      });
    } else if (key === 'crawl-delay') {
      const delay = crawlDelayMilliseconds(value);
      if (delay !== null) {
        crawlDelay = Math.max(crawlDelay ?? 0, delay);
      }
    }
  }

  return {
    rules: rules.map(({ allow, pattern }) => ({ allow, pattern })),
    crawlDelayMilliseconds: crawlDelay,
    isAllowed(pathAndQuery) {
      const target = normalisePath(pathAndQuery);
      let best: Rule | null = null;
      for (const rule of rules) {
        if (!rule.matcher.test(target)) {
          continue;
        }
        const length = rule.pattern.length;
        if (
          best === null ||
          length > best.pattern.length ||
          (length === best.pattern.length && rule.allow && !best.allow)
        ) {
          best = rule;
        }
      }
      return best === null || best.allow;
    },
  };
}

/** No rules: what a missing robots.txt (404 or 410) means. */
export const noRobotsRules: RobotsRules = parseRobots('');
