import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  emailPreviewRenderers,
  renderEmailPreviews,
} from '../scripts/design/email-previews.ts';
import { dsrCopy } from '../src/copy/dsr.ts';
import { emailCopy } from '../src/copy/email.ts';
import {
  emailThemeFromCss,
  renderEmailDocument,
  type EmailDocument,
} from '../src/server/email/template-layout.ts';

const baseUrl = 'https://valstara.test';
const tokensCss = readFileSync('src/styles/tokens.css', 'utf8');
const previews = await renderEmailPreviews(baseUrl);

const preheaders: Readonly<Record<string, string>> = {
  verification_test: emailCopy.verify.preheader,
  verification_reminder: emailCopy.reminder.preheader,
  welcome: emailCopy.welcome.preheader,
  milestone_reached: emailCopy.milestone.preheader,
  status_link: emailCopy.statusLink.preheader,
  giveaway_entry_receipt: emailCopy.receipt.preheader,
  giveaway_winner: emailCopy.winner.preheader,
  dsr_export: dsrCopy.export.preheader,
  dsr_delete: dsrCopy.delete.preheader,
  weekly_campaign_update: emailCopy.weekly.preheader,
};

// The main action each message exists for, by first-party path.
const mainActions: Readonly<Record<string, RegExp>> = {
  verification_test: /^\/verify$/u,
  verification_reminder: /^\/verify$/u,
  welcome: /^\/me$/u,
  milestone_reached: /^\/me$/u,
  status_link: /^\/me$/u,
  giveaway_entry_receipt: /^\/giveaway\/rules\/VAL-GW-/u,
  giveaway_winner: /^\/giveaway\/award$/u,
  dsr_export: /^\/dsr$/u,
  dsr_delete: /^\/dsr$/u,
  weekly_campaign_update: /^\/me$/u,
};

const firstPartyPaths =
  /^\/(?:|verify|me|legit|unsubscribe|dsr|giveaway\/award|giveaway\/rules\/VAL-GW-[A-Z0-9]+-\d{8}-r\d+)$/u;

function html(message: { readonly html?: string }): string {
  assert.ok(message.html, 'every template has an HTML part');
  return message.html;
}

function decode(value: string): string {
  return value.replaceAll('&amp;', '&');
}

function hrefs(markup: string): string[] {
  return [...markup.matchAll(/<a\b[^>]*\bhref="([^"]*)"/gu)].map((match) =>
    decode(match[1]),
  );
}

function hexColours(source: string): string[] {
  return [...source.matchAll(/#[0-9a-f]{3,8}\b/giu)].map((match) =>
    match[0].toLowerCase(),
  );
}

function px(value: string): number {
  const match = /^(\d+)px$/u.exec(value.trim());
  assert.ok(match, `${value} is a px length`);
  return Number(match[1]);
}

function declaration(styleText: string, property: string): string {
  const match = new RegExp(`(?:^|;)${property}:([^;]+)`, 'u').exec(styleText);
  assert.ok(match, `${property} in ${styleText}`);
  return match[1];
}

// Independent of the layout's parser: the colour values and font family
// names that appear anywhere in tokens.css.
function tokenColours(css: string): Set<string> {
  return new Set(hexColours(css));
}

function tokenFamilies(css: string): Set<string> {
  const families = new Set<string>();
  for (const [, stack] of css.matchAll(/--font-(?:sans|mono):([^;]+);/gu))
    for (const family of stack.split(','))
      families.add(family.trim().replaceAll(/^'|'$/gu, ''));
  for (const [, name] of css.matchAll(/local\('([^']+)'\)/gu))
    families.add(name);
  return families;
}

function inlinedFamilies(markup: string): string[] {
  return [...markup.matchAll(/font-family:([^;"}]+)/gu)].flatMap(([, stack]) =>
    stack
      .replace(/\s*!important\s*$/u, '')
      .split(',')
      .map((family) => family.trim().replaceAll(/^'|'$/gu, '')),
  );
}

const document: EmailDocument = {
  subject: 'Fixture subject',
  preheader: 'Fixture preheader.',
  paragraphs: ['Fixture first line.', 'A <b>marked</b> & "quoted" line.'],
  facts: ['Confirmed referrals: 3'],
  links: [
    { label: 'Main action', url: `${baseUrl}/me?t=a&b=c` },
    { label: 'Secondary', url: `${baseUrl}/legit` },
  ],
};

function renderFixture(css: string) {
  return renderEmailDocument({
    from: 'Valstara <hello@send.valstara.com>',
    to: 'reader@example.test',
    document,
    unsubscribePageUrl: `${baseUrl}/unsubscribe?t=unsubscribe-signature`,
    theme: emailThemeFromCss(css),
  });
}

test('E11.5-11 previews cover every template the dispatcher registers', () => {
  const dispatch = readFileSync('src/server/email/resend-dispatch.ts', 'utf8');
  assert.match(dispatch, /\.\.\.dsrRenderers\(/u);
  assert.match(dispatch, /\.\.\.createTransactionalRenderers\(/u);
  assert.match(dispatch, /'weekly_campaign_update',\s*createWeeklyTemplate\(/u);
  assert.deepEqual(
    [...emailPreviewRenderers(baseUrl).keys()].sort(),
    Object.keys(preheaders).sort(),
  );
  assert.equal(previews.length, Object.keys(preheaders).length);
});

test('E11.5-11 every template has no var(, no image and no remote URL beyond its first-party links', () => {
  for (const { template, message } of previews) {
    const markup = html(message);
    assert.ok(!markup.includes('var('), `${template}: var(`);
    assert.doesNotMatch(
      markup,
      /<(?:img|picture|svg|link|script|iframe|object|embed|video|audio|form|base)\b/iu,
      `${template}: embedded or remote element`,
    );
    assert.doesNotMatch(
      markup,
      /\b(?:src|srcset|background|poster|action|data)\s*=|url\(|@import/iu,
      `${template}: resource reference`,
    );
    for (const [url] of markup.matchAll(/[a-z][\w+.-]*:\/\/[^\s"'<>)]+/giu)) {
      assert.equal(new URL(decode(url)).origin, baseUrl, `${template}: ${url}`);
    }
    assert.doesNotMatch(markup, /=\s*"\/\//u, `${template}: protocol-relative`);
    const links = hrefs(markup);
    assert.ok(links.length >= 2, template);
    for (const link of links) {
      const url = new URL(link);
      assert.equal(url.origin, baseUrl, `${template}: ${link}`);
      // A wrapped or rewritten link would leave this closed set of routes.
      assert.match(url.pathname, firstPartyPaths, `${template}: ${link}`);
    }
  }
});

test('E11.5-11 every inlined colour and font in every template traces to tokens.css', () => {
  const colours = tokenColours(tokensCss);
  const families = tokenFamilies(tokensCss);
  for (const { template, message } of previews) {
    const markup = html(message);
    assert.doesNotMatch(markup, /\b(?:rgba?|hsla?)\(/u, template);
    const used = hexColours(markup);
    assert.ok(used.length > 0, template);
    for (const colour of used)
      assert.ok(colours.has(colour), `${template}: ${colour}`);
    // No named colour slips past the hex trace.
    for (const [, property, value] of markup.matchAll(
      /(?:^|[;{"])\s*(color|background-color|border-color|border)\s*:\s*([^;"}]+)/gu,
    ))
      assert.match(value, /#[0-9a-f]{3,8}\b/iu, `${template}: ${property}`);
    for (const [, value] of markup.matchAll(/bgcolor="([^"]+)"/gu))
      assert.ok(colours.has(value.toLowerCase()), `${template}: ${value}`);
    const fonts = inlinedFamilies(markup);
    assert.ok(fonts.length > 0, template);
    for (const family of fonts)
      assert.ok(families.has(family), `${template}: font ${family}`);
  }
});

test('E11.5-11 changing a token fixture changes the inlined colours, fonts and sizes', () => {
  const real = tokenColours(tokensCss);
  let next = 0x100000;
  const replacements = new Map<string, string>();
  const fixtureCss = tokensCss
    .replaceAll(/#[0-9a-f]{3,8}\b/giu, (colour) => {
      const key = colour.toLowerCase();
      let replacement = replacements.get(key);
      if (replacement === undefined) {
        do {
          replacement = `#${(next += 0x010101).toString(16).padStart(6, '0')}`;
        } while (real.has(replacement));
        replacements.set(key, replacement);
      }
      return replacement;
    })
    .replaceAll('Instrument Sans', 'Fixture Sans')
    .replaceAll('JetBrains Mono', 'Fixture Mono')
    .replaceAll("local('Arial')", "local('Fixture Local Sans')")
    .replaceAll("local('Courier New')", "local('Fixture Local Mono')")
    .replace('--step-2: 1rem;', '--step-2: 1.125rem;')
    .replace('--tap-min: 2.75rem;', '--tap-min: 3rem;');
  assert.notEqual(fixtureCss, tokensCss);
  const fixtureColours = new Set(replacements.values());

  const baseline = html(renderFixture(tokensCss));
  const changed = html(renderFixture(fixtureCss));
  assert.notEqual(changed, baseline);

  const used = hexColours(changed);
  assert.ok(used.length > 0);
  for (const colour of used) {
    assert.ok(fixtureColours.has(colour), `fixture colour ${colour}`);
    assert.ok(!real.has(colour), `real colour ${colour} survived`);
  }
  // Light and dark coral both follow their tokens.
  assert.ok(changed.includes(`bgcolor="${replacements.get('#e8654a')}"`));
  assert.ok(
    changed.includes(
      `.v-button{background-color:${replacements.get('#ff8a66')} !important}`,
    ),
  );

  const fonts = new Set(inlinedFamilies(changed));
  for (const family of [
    'Fixture Sans',
    'Fixture Mono',
    'Fixture Local Sans',
    'Fixture Local Mono',
  ])
    assert.ok(fonts.has(family), family);
  for (const family of [
    'Instrument Sans',
    'JetBrains Mono',
    'Arial',
    'Courier New',
  ])
    assert.ok(!fonts.has(family), `real font ${family} survived`);

  assert.match(baseline, /font-size:16px;line-height:24px/u);
  assert.match(changed, /font-size:18px;line-height:24px/u);
  assert.match(changed, /height="48"/u);
});

test('E11.5-11 the layout resolves var() references and rejects missing or unsafe tokens', () => {
  const aliased = html(
    renderFixture(
      tokensCss.replace('--space-3: 1.5rem;', '--space-3: var(--space-4);'),
    ),
  );
  assert.match(aliased, /display:block;padding:10px 32px/u);
  assert.throws(
    () => emailThemeFromCss(tokensCss.replace(/--coral: #e8654a;/u, '')),
    /email_design_token_missing/u,
  );
  assert.throws(
    () =>
      emailThemeFromCss(
        tokensCss.replace('--ink: #101014;', '--ink: #101014" onload="x;'),
      ),
    /email_design_token_invalid/u,
  );
  assert.throws(
    () =>
      emailThemeFromCss(tokensCss.replace(":root[data-theme='dark']", '.x')),
    /email_design_tokens_missing/u,
  );
});

test('E11.5-11 every template carries its hidden preheader from the copy layer', () => {
  for (const { template, message } of previews) {
    const markup = html(message);
    const preheader = preheaders[template];
    assert.ok(preheader, template);
    const hidden = /<body\b[^>]*><div style="([^"]+)">([^<]*)<\/div>/u.exec(
      markup,
    );
    assert.ok(hidden, `${template}: preheader is the body's first element`);
    assert.ok(hidden[2].startsWith(preheader), template);
    assert.match(hidden[1], /(?:^|;)display:none(?:;|$)/u, template);
    assert.match(hidden[1], /(?:^|;)mso-hide:all(?:;|$)/u, template);
    assert.match(hidden[1], /(?:^|;)max-height:0px(?:;|$)/u, template);
    assert.equal(markup.split(preheader).length, 2, `${template}: once`);
    // The plain text still opens with the message's own first line.
    assert.ok(!message.text.includes(preheader), template);
  }
  assert.equal(
    previews
      .find(({ template }) => template === 'verification_test')
      ?.message.text.split('\n')[0],
    emailCopy.verify.firstLine,
  );
  assert.equal(new Set(Object.values(preheaders)).size, 10);
});

test('E11.5-11 the layout is at most 600px wide and its one button is at least 44px tall', () => {
  const theme = emailThemeFromCss(tokensCss);
  for (const { template, message } of previews) {
    const markup = html(message);
    assert.match(
      markup,
      /<table role="presentation" width="600"[^>]*style="width:100%;max-width:600px"/u,
      template,
    );
    for (const [, width] of markup.matchAll(/\bwidth="(\d+)"/gu))
      assert.ok(Number(width) <= 600, `${template}: width ${width}`);
    for (const [, width] of markup.matchAll(
      /(?:^|[;{"])\s*(?:min-|max-)?width:\s*(\d+)px/gu,
    ))
      assert.ok(Number(width) <= 600, `${template}: width ${width}px`);

    const buttons = [
      ...markup.matchAll(
        /<td class="v-button"[^>]*height="(\d+)"[^>]*bgcolor="([^"]+)"[^>]*style="([^"]+)"><a href="([^"]+)" style="([^"]+)">([^<]+)<\/a><\/td>/gu,
      ),
    ];
    assert.equal(buttons.length, 1, `${template}: one primary button`);
    const [, height, background, cellStyle, href, anchorStyle] = buttons[0];
    assert.ok(Number(height) >= 44, `${template}: cell height ${height}`);
    assert.ok(px(declaration(cellStyle, 'height')) >= 44, template);
    assert.equal(background, theme.light.coral, template);
    const [paddingBlock] = declaration(anchorStyle, 'padding').split(' ');
    const anchorHeight =
      2 * px(paddingBlock) + px(declaration(anchorStyle, 'line-height'));
    assert.ok(anchorHeight >= 44, `${template}: anchor height ${anchorHeight}`);
    assert.equal(declaration(anchorStyle, 'display'), 'block', template);
    const main = mainActions[template];
    assert.ok(main, template);
    assert.match(new URL(decode(href)).pathname, main, template);
    assert.equal(markup.split('class="v-button"').length, 2, template);
  }
});

test('E11.5-11 the footer carries the legal line, the support address and the unsubscribe link, and plain text keeps every link', () => {
  for (const { template, message } of previews) {
    const markup = html(message);
    const footer = /<td class="v-muted"[^>]*>([\s\S]*?)<\/td>/u.exec(markup);
    assert.ok(footer, template);
    assert.ok(footer[1].includes(emailCopy.footer.legalLine), template);
    assert.ok(footer[1].includes('support@valstara.com'), template);
    assert.match(
      footer[1],
      new RegExp(
        `<a href="${baseUrl}/unsubscribe\\?t=unsubscribe-signature">${emailCopy.unsubscribe}</a>`,
        'u',
      ),
      template,
    );
    assert.equal(
      emailCopy.footer.legalLine,
      'Valstara is a trading brand of 3NITY Digital Limited, registered in Hong Kong.',
    );
    assert.ok(message.text.includes(emailCopy.footer.legalLine), template);
    assert.ok(message.text.includes('support@valstara.com'), template);
    assert.ok(markup.includes(`>${emailCopy.wordmark}</td>`), template);
    // Every link in the HTML, the button included, is in the plain text.
    for (const link of hrefs(markup))
      assert.ok(message.text.includes(link), `${template}: ${link}`);
  }
});

test('E11.5-11 the layout is light by default with a dark block from the dark tokens', () => {
  const theme = emailThemeFromCss(tokensCss);
  assert.equal(theme.light.paper, '#fafafa');
  assert.equal(theme.dark.paper, '#0f0f1a');
  for (const { template, message } of previews) {
    const markup = html(message);
    assert.match(markup, /<meta name="color-scheme" content="light dark">/u);
    assert.ok(
      markup.includes(
        `<body class="v-page" style="margin:0px;padding:0px;background-color:${theme.light.paper}">`,
      ),
      template,
    );
    const dark = /@media \(prefers-color-scheme: dark\)\{(.*?\})\}/u.exec(
      markup,
    );
    assert.ok(dark, `${template}: dark block`);
    for (const value of [
      theme.dark.paper,
      theme.dark.surface,
      theme.dark.ink,
      theme.dark.muted,
      theme.dark.coral,
    ])
      assert.ok(dark[1].includes(value), `${template}: dark ${value}`);
    for (const value of [theme.light.paper, theme.light.ink])
      assert.ok(
        !dark[1].includes(value),
        `${template}: light ${value} in dark`,
      );
  }
});

test('E11.5-11 the layout escapes copy and keeps paragraphs, facts and links in reading order', () => {
  const message = renderFixture(tokensCss);
  const markup = html(message);
  assert.ok(
    markup.includes(
      '<p>A &lt;b&gt;marked&lt;/b&gt; &amp; &quot;quoted&quot; line.</p>',
    ),
  );
  assert.ok(markup.includes(`href="${baseUrl}/me?t=a&amp;b=c"`));
  const order = [
    '<p>Fixture first line.</p>',
    '<li>Confirmed referrals: 3</li>',
    '>Main action</a>',
    '>Secondary</a>',
    emailCopy.footer.legalLine,
    `>${emailCopy.unsubscribe}</a>`,
  ].map((marker) => markup.indexOf(marker));
  assert.ok(order.every((index) => index > 0));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
  assert.equal(message.text.split('\n\n')[0], 'Fixture first line.');
  assert.ok(
    message.text.endsWith(
      `${emailCopy.unsubscribe}: ${baseUrl}/unsubscribe?t=unsubscribe-signature`,
    ),
  );
});
