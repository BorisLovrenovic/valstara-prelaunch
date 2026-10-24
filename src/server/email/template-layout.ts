import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { emailCopy } from '../../copy/email.ts';

import type { Message } from './service.ts';

export interface EmailLink {
  readonly label: string;
  readonly url: string;
}

export interface EmailDocument {
  readonly subject: string;
  /** Inbox preview text; hidden in the body and absent from the plain text. */
  readonly preheader: string;
  readonly paragraphs: readonly string[];
  readonly facts?: readonly string[];
  /** The first link is the message's main action and renders as its button. */
  readonly links: readonly [EmailLink, ...EmailLink[]];
}

interface EmailPalette {
  readonly paper: string;
  readonly surface: string;
  readonly ink: string;
  readonly muted: string;
  readonly line: string;
  readonly coral: string;
  readonly midnight: string;
}

/**
 * Every colour, font and size the layout inlines, resolved from tokens.css.
 * Gmail and Outlook ignore custom properties, so the tokens are read here and
 * written into the markup as literal values.
 */
export interface EmailTheme {
  readonly light: EmailPalette;
  readonly dark: EmailPalette;
  readonly fontSans: string;
  readonly fontMono: string;
  /** Outlook on Windows cannot load web fonts and falls back to a serif. */
  readonly msoFontSans: string;
  readonly msoFontMono: string;
  readonly weightSemibold: string;
  readonly trackingNormal: string;
  readonly px: {
    readonly wordmark: number;
    readonly wordmarkLeading: number;
    readonly body: number;
    readonly bodyLeading: number;
    readonly small: number;
    readonly smallLeading: number;
    readonly label: number;
    readonly labelLeading: number;
    readonly space1: number;
    readonly space2: number;
    readonly space3: number;
    readonly space4: number;
    readonly radiusCard: number;
    readonly radiusControl: number;
    readonly tapMin: number;
  };
}

// The email-safe content width (E11.5-11). Not a site token: the site's
// container is fluid, a mail client's reading pane is not.
const EMAIL_WIDTH_PX = 600;
// rem tokens convert against the CSS initial root font size.
const ROOT_FONT_SIZE_PX = 16;
const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'system-ui',
  'ui-monospace',
  'ui-sans-serif',
]);

function escapeHtml(value: string): string {
  return value.replaceAll(/[&<>"']/gu, (character) => {
    const escaped: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return escaped[character];
  });
}

function declarations(body: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const declaration of body.split(';')) {
    const match = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/u.exec(declaration);
    if (match) result.set(match[1], match[2].replaceAll(/\s+/gu, ' '));
  }
  return result;
}

function ruleBody(css: string, selector: string): string {
  const pattern = new RegExp(
    `^${selector.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*\\{([\\s\\S]*?)^\\}`,
    'mu',
  );
  const body = pattern.exec(css)?.[1];
  if (body === undefined) throw new Error('email_design_tokens_missing');
  return body;
}

function fontFaces(
  css: string,
): Map<string, { readonly local: readonly string[]; readonly web: boolean }> {
  const faces = new Map<
    string,
    { readonly local: readonly string[]; readonly web: boolean }
  >();
  for (const [, body] of css.matchAll(/@font-face\s*\{([\s\S]*?)\}/gu)) {
    const family = /font-family:\s*'([^']+)'/u.exec(body)?.[1];
    if (family === undefined) continue;
    faces.set(family, {
      local: [...body.matchAll(/local\('([^']+)'\)/gu)].map(
        (match) => match[1],
      ),
      web: /url\(/u.test(body),
    });
  }
  return faces;
}

function familyName(family: string): string {
  return family.replaceAll(/^'|'$/gu, '');
}

function quoteFamily(name: string): string {
  return GENERIC_FAMILIES.has(name) || !/\s/u.test(name) ? name : `'${name}'`;
}

/** Reads the light `:root` block, the dark block and the fallback faces. */
export function emailThemeFromCss(source: string): EmailTheme {
  const css = source.replaceAll(/\/\*[\s\S]*?\*\//gu, '');
  const light = declarations(ruleBody(css, ':root'));
  const dark = declarations(ruleBody(css, ":root[data-theme='dark']"));
  const faces = fontFaces(css);

  function value(name: string, scheme: ReadonlyMap<string, string>): string {
    let resolved = scheme.get(name) ?? light.get(name);
    for (let depth = 0; resolved?.includes('var(') === true; depth += 1) {
      if (depth > 8) throw new Error('email_design_token_cycle');
      resolved = resolved.replaceAll(
        /var\((--[\w-]+)\)/gu,
        (_, reference: string) => {
          const next = scheme.get(reference) ?? light.get(reference);
          if (next === undefined) throw new Error('email_design_token_missing');
          return next;
        },
      );
    }
    if (resolved === undefined) throw new Error('email_design_token_missing');
    // Values are written into style attributes and a style element unescaped.
    if (!/^[\w\s#.,'%()-]+$/u.test(resolved))
      throw new Error('email_design_token_invalid');
    return resolved;
  }

  function px(name: string): number {
    const match = /^(\d*\.?\d+)(rem|px)$/u.exec(value(name, light));
    if (match === null) throw new Error('email_design_token_invalid');
    const amount = Number(match[1]);
    return match[2] === 'rem' ? amount * ROOT_FONT_SIZE_PX : amount;
  }

  // A metric-matched fallback face is a site-only alias for local fonts, so a
  // mail client gets the local fonts themselves.
  function fontStacks(name: string): readonly [string, string] {
    const families = value(name, light)
      .split(',')
      .map((family) => familyName(family.trim()));
    const expanded = families.flatMap((family) => {
      const face = faces.get(family);
      return face !== undefined && !face.web && face.local.length > 0
        ? face.local
        : [family];
    });
    const local = expanded.filter((family) => faces.get(family)?.web !== true);
    return [
      expanded.map(quoteFamily).join(', '),
      local.map(quoteFamily).join(', '),
    ];
  }

  function palette(scheme: ReadonlyMap<string, string>): EmailPalette {
    return {
      paper: value('--paper', scheme),
      surface: value('--surface', scheme),
      ink: value('--ink', scheme),
      muted: value('--ink-600', scheme),
      line: value('--line', scheme),
      coral: value('--coral', scheme),
      midnight: value('--midnight', scheme),
    };
  }

  const [fontSans, msoFontSans] = fontStacks('--font-sans');
  const [fontMono, msoFontMono] = fontStacks('--font-mono');
  return {
    light: palette(light),
    dark: palette(dark),
    fontSans,
    fontMono,
    msoFontSans,
    msoFontMono,
    weightSemibold: value('--weight-semibold', light),
    trackingNormal: value('--tracking-normal', light),
    px: {
      wordmark: px('--step-3'),
      wordmarkLeading: px('--leading-3'),
      body: px('--step-2'),
      bodyLeading: px('--leading-2'),
      small: px('--step-1'),
      smallLeading: px('--leading-1'),
      label: px('--step-0'),
      labelLeading: px('--leading-0'),
      space1: px('--space-1'),
      space2: px('--space-2'),
      space3: px('--space-3'),
      space4: px('--space-4'),
      radiusCard: px('--radius-card'),
      radiusControl: px('--radius-control'),
      tapMin: px('--tap-min'),
    },
  };
}

let cachedTheme: EmailTheme | null = null;

function emailTheme(): EmailTheme {
  cachedTheme ??= emailThemeFromCss(
    readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8'),
  );
  return cachedTheme;
}

function style(rules: Readonly<Record<string, string | number>>): string {
  return Object.entries(rules)
    .map(
      ([property, value]) =>
        `${property}:${typeof value === 'number' ? `${value}px` : value}`,
    )
    .join(';');
}

function head(subject: string, theme: EmailTheme): string {
  const { light, dark, px } = theme;
  const darkRules = [
    `.v-page{background-color:${dark.paper} !important}`,
    `.v-card{background-color:${dark.surface} !important;border-color:${dark.surface} !important}`,
    `.v-text,.v-text a{color:${dark.ink} !important}`,
    `.v-muted,.v-muted a{color:${dark.muted} !important}`,
    `.v-button{background-color:${dark.coral} !important}`,
    `.v-button a{color:${dark.midnight} !important}`,
  ].join('');
  return [
    '<head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="supported-color-schemes" content="light dark">',
    `<title>${escapeHtml(subject)}</title>`,
    `<style>body{margin:0;padding:0}p{margin:0 0 ${px.space2}px}a{color:${light.ink};text-decoration:underline}.v-muted a{color:${light.muted}}@media (prefers-color-scheme: dark){${darkRules}}</style>`,
    `<!--[if mso]><style>body,table,td,div,p,a,li{font-family:${theme.msoFontSans} !important}.v-facts,.v-facts li{font-family:${theme.msoFontMono} !important}</style><![endif]-->`,
    '</head>',
  ].join('');
}

function button(link: EmailLink, theme: EmailTheme): string {
  const { light, px } = theme;
  const cell = style({
    height: px.tapMin,
    'background-color': light.coral,
    'border-radius': px.radiusControl,
  });
  // Padding makes up the tap target around one line of body text; Outlook
  // ignores anchor padding, so the cell's height holds the target there.
  const anchor = style({
    display: 'block',
    padding: `${(px.tapMin - px.bodyLeading) / 2}px ${px.space3}px`,
    'font-family': theme.fontSans,
    'font-size': px.body,
    'line-height': px.bodyLeading,
    'font-weight': theme.weightSemibold,
    color: light.midnight,
    'text-decoration': 'none',
  });
  return `<tr><td style="${style({ padding: `${px.space1}px 0 ${px.space3}px` })}"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="v-button" align="center" valign="middle" height="${px.tapMin}" bgcolor="${light.coral}" style="${cell}"><a href="${escapeHtml(link.url)}" style="${anchor}">${escapeHtml(link.label)}</a></td></tr></table></td></tr>`;
}

function body(
  document: EmailDocument,
  unsubscribePageUrl: string,
  theme: EmailTheme,
): string {
  const { light, px } = theme;
  const [action, ...secondary] = document.links;
  const prose = style({
    'font-family': theme.fontSans,
    'font-size': px.body,
    'line-height': px.bodyLeading,
    color: light.ink,
  });
  const paragraphs = `<tr><td class="v-text" style="${prose}">${document.paragraphs
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join('')}</td></tr>`;
  const facts =
    document.facts === undefined || document.facts.length === 0
      ? ''
      : `<tr><td class="v-text" style="${style({
          padding: `0 0 ${px.space3}px`,
          'font-family': theme.fontMono,
          'font-size': px.small,
          'line-height': px.smallLeading,
          'font-variant-numeric': 'tabular-nums',
          color: light.ink,
        })}"><ul class="v-facts" style="${style({
          margin: 0,
          padding: `0 0 0 ${px.space3}px`,
        })}">${document.facts
          .map((fact) => `<li>${escapeHtml(fact)}</li>`)
          .join('')}</ul></td></tr>`;
  const links = secondary
    .map(
      ({ label, url }) =>
        `<tr><td class="v-text" style="${style({ padding: `0 0 ${px.space1}px` })};${prose}"><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></td></tr>`,
    )
    .join('');
  const footerLine = style({ padding: `0 0 ${px.space1}px` });
  const footer = `<tr><td class="v-muted" style="${style({
    padding: `${px.space3}px ${px.space3}px 0`,
    'font-family': theme.fontSans,
    'font-size': px.label,
    'line-height': px.labelLeading,
    color: light.muted,
  })}"><div style="${footerLine}">${escapeHtml(emailCopy.footer.legalLine)}</div><div style="${footerLine}">${escapeHtml(emailCopy.footer.supportEmail)}</div><div><a href="${escapeHtml(unsubscribePageUrl)}">${escapeHtml(emailCopy.unsubscribe)}</a></div></td></tr>`;
  const preheader = `<div style="${style({
    display: 'none',
    'max-height': 0,
    overflow: 'hidden',
    'mso-hide': 'all',
    'font-size': 1,
    'line-height': 1,
    opacity: '0',
  })}">${escapeHtml(document.preheader)}${'&zwnj;&nbsp;'.repeat(40)}</div>`;
  return [
    `<body class="v-page" style="${style({ margin: 0, padding: 0, 'background-color': light.paper })}">`,
    preheader,
    `<table role="presentation" class="v-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${light.paper}" style="${style({ width: '100%', 'background-color': light.paper })}">`,
    `<tr><td align="center" style="${style({ padding: `${px.space4}px ${px.space2}px` })}">`,
    `<table role="presentation" width="${EMAIL_WIDTH_PX}" cellpadding="0" cellspacing="0" border="0" style="${style({ width: '100%', 'max-width': EMAIL_WIDTH_PX })}">`,
    `<tr><td class="v-text" style="${style({
      padding: `0 0 ${px.space3}px`,
      'font-family': theme.fontSans,
      'font-size': px.wordmark,
      'line-height': px.wordmarkLeading,
      'font-weight': theme.weightSemibold,
      'letter-spacing': theme.trackingNormal,
      color: light.ink,
    })}">${escapeHtml(emailCopy.wordmark)}</td></tr>`,
    `<tr><td class="v-card" bgcolor="${light.surface}" style="${style({
      padding: `${px.space4}px ${px.space3}px`,
      'background-color': light.surface,
      border: `thin solid ${light.line}`,
      'border-radius': px.radiusCard,
    })}">`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">',
    paragraphs,
    facts,
    button(action, theme),
    links,
    '</table></td></tr>',
    footer,
    '</table></td></tr></table></body>',
  ].join('');
}

/** HTML and plain text come from one content structure, so neither loses a link. */
export function renderEmailDocument(input: {
  readonly from: string;
  readonly to: string;
  readonly document: EmailDocument;
  readonly unsubscribePageUrl: string;
  readonly theme?: EmailTheme;
}): Message {
  const { document, unsubscribePageUrl } = input;
  const theme = input.theme ?? emailTheme();
  const lines = [
    ...document.paragraphs,
    ...(document.facts ?? []),
    ...document.links.map(({ label, url }) => `${label}: ${url}`),
    emailCopy.footer.legalLine,
    emailCopy.footer.supportEmail,
    `${emailCopy.unsubscribe}: ${unsubscribePageUrl}`,
  ];
  const html = `<!doctype html><html lang="en">${head(document.subject, theme)}${body(document, unsubscribePageUrl, theme)}</html>`;
  return {
    from: input.from,
    to: input.to,
    subject: document.subject,
    text: lines.join('\n\n'),
    html,
  };
}
