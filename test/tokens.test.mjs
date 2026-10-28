import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const tokenPath = new URL('../src/styles/tokens.css', import.meta.url);
const brandGuidelinesPath = new URL(
  '../docs/brand/identity-guidelines.md',
  import.meta.url,
);
const tokenContractPath = new URL('../docs/brand/tokens.md', import.meta.url);

const expectedRootTokens = {
  '--paper': '#FAFAFA',
  '--surface': '#FFFFFF',
  '--ink': '#101014',
  '--ink-600': '#55555E',
  '--ink-300': '#A0A0A8',
  '--line': '#E5E5E5',
  '--coral': '#E8654A',
  '--coral-lift': '#FF8A66',
  '--coral-tint': '#FDEEE9',
  '--midnight': '#171733',
  '--midnight-deep': '#0D0D1F',
  '--error': '#C0392B',
  '--warning': '#B7791F',
  '--success': '#2E7D57',
  '--font-sans':
    "'Instrument Sans', 'Instrument Sans Fallback', system-ui, sans-serif",
  '--font-mono':
    "'JetBrains Mono', 'JetBrains Mono Fallback', ui-monospace, monospace",
  '--step-5': '2rem',
  '--leading-5': '2.5rem',
  '--step-4': '1.5rem',
  '--leading-4': '2rem',
  '--step-3': '1.25rem',
  '--leading-3': '1.75rem',
  '--step-2': '1rem',
  '--leading-2': '1.5rem',
  '--step-1': '0.875rem',
  '--leading-1': '1.25rem',
  '--step-0': '0.8125rem',
  '--leading-0': '1.125rem',
  '--radius-card': '12px',
  '--radius-control': '8px',
  '--radius-pill': '999px',
  '--duration-fast': '150ms',
  '--duration-base': '200ms',
  '--ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
};

// Values in both dark blocks. E11.5-11a replaces the E11.5-01 dark
// --shadow-1 and --shadow-2 with the wireframe values and adds the dark line,
// coral-tint, error text and edges; --shadow-3 keeps its E11.5-01 value,
// because the wireframes give no dark overlay shadow.
const expectedDarkTokens = {
  '--paper': '#0F0F1A',
  '--surface': '#171733',
  '--ink': '#F0F0EE',
  '--ink-600': '#A0A0A8',
  '--coral': '#FF8A66',
  '--on-midnight': '#F0F0EE',
  '--line': 'rgba(240,240,238,.14)',
  '--coral-tint': 'rgba(255,138,102,.16)',
  '--error-text': 'var(--ink)',
  '--shadow-1': '0 1px 2px rgba(0,0,0,.4), 0 8px 20px rgba(0,0,0,.35)',
  '--shadow-2': '0 2px 6px rgba(0,0,0,.45), 0 20px 48px rgba(0,0,0,.55)',
  '--shadow-3': '0 4px 8px rgb(0 0 0 / 0.40), 0 16px 40px rgb(0 0 0 / 0.50)',
  '--edge': '0 0 0 1px rgba(240,240,238,.1)',
  '--banner-edge': 'inset 0 0 0 1px rgba(240,240,238,.1)',
  '--banner-edge-hero': 'inset 0 0 0 1px rgba(240,240,238,.12)',
  '--banner-edge-hover': 'inset 0 0 0 1px rgba(240,240,238,.14)',
  '--shadow-chip-dark':
    '0 0 0 1px rgba(240,240,238,.18), 0 6px 14px rgba(0,0,0,.3)',
  '--shadow-band': '0 0 0 1px rgba(240,240,238,.1), 0 24px 64px rgba(0,0,0,.6)',
};

// E11.5-01 values, with the light elevations replaced by the E11.5-11a
// wireframe values (founder-authorised 2026-10-26), written as the ticket
// states them.
const foundationTokens = {
  '--on-midnight': '#fafafa',
  '--shadow-1': '0 1px 2px rgba(16,16,20,.05), 0 6px 16px rgba(16,16,20,.06)',
  '--shadow-2': '0 2px 6px rgba(16,16,20,.07), 0 18px 44px rgba(16,16,20,.14)',
  '--shadow-3':
    '0 10px 28px rgba(16,16,20,.16), 0 36px 80px rgba(16,16,20,.22)',
  '--container-max': '75rem',
  '--gutter': 'var(--space-2)',
  '--gutter-wide': 'var(--space-4)',
  '--section-gap': 'var(--space-8)',
  '--section-gap-wide': 'var(--space-10)',
  '--measure': '68ch',
  '--weight-regular': '400',
  '--weight-medium': '500',
  '--weight-semibold': '600',
  '--weight-bold': '700',
  '--tracking-tight': '-0.01em',
  '--tracking-normal': '0',
  '--tap-min': '2.75rem',
  '--icon-sm': '1rem',
  '--icon-md': '1.5rem',
  '--icon-lg': '2.5rem',
  '--layer-dock': '20',
  '--layer-skip': '30',
};

// E11.5-11a: the wireframe roles, component values, layout and sizes, light
// values on bare :root. Roles and component values are as the ticket states
// them; sizes are the sheet's pixel values in rem (16px root).
const wireframeTokens = {
  '--edge': '0 0 0 0 transparent',
  '--field': 'var(--ink-600)',
  '--on-coral': '#101014',
  '--error-text': 'var(--error)',
  '--radius-check': '4px',
  '--shadow-button': '0 1px 2px rgba(16,16,20,.14)',
  '--overlay-hover': 'inset 0 0 0 100px rgba(16,16,20,.08)',
  '--overlay-active': 'inset 0 0 0 100px rgba(16,16,20,.16)',
  '--on-midnight-border': 'rgba(250,250,250,.45)',
  '--on-midnight-hover': 'rgba(250,250,250,.08)',
  '--on-midnight-active': 'rgba(250,250,250,.14)',
  '--on-midnight-disabled': 'rgba(250,250,250,.45)',
  '--on-midnight-disabled-border': 'rgba(250,250,250,.2)',
  '--inset-on-midnight': 'inset 0 0 0 1px var(--on-midnight-border)',
  '--inset-on-midnight-disabled':
    'inset 0 0 0 1px var(--on-midnight-disabled-border)',
  '--shadow-chip': '0 1px 2px rgba(0,0,0,.2), 0 6px 14px rgba(0,0,0,.16)',
  // E11.5-11c (founder-authorised 2026-10-27): the banner chip and white
  // banner text stay #FFFFFF, and the chip name #101014, in both themes.
  '--banner-white': '#ffffff',
  '--banner-ink': '#101014',
  '--banner-tone-dark': 'rgba(255,255,255,.13)',
  '--banner-tone-light': 'rgba(255,255,255,.16)',
  '--banner-tone-ink': 'rgba(16,16,20,.10)',
  // E11.5-11c (founder-authorised 2026-10-27): the wireframe's .t1 to .t3
  // tonal-shape offsets, one token per side each shape sets.
  '--banner-shape-t1-top': '-80%',
  '--banner-shape-t1-right': '-12%',
  '--banner-shape-t2-right': '-20%',
  '--banner-shape-t2-bottom': '-75%',
  '--banner-shape-t3-top': '-140%',
  '--banner-shape-t3-left': '-34%',
  // E11.5-11d (founder-authorised 2026-10-28): the .t4 to .t6 offsets, and
  // the dark chip's shadow, which the dark frames draw with a light ring.
  '--banner-shape-t4-top': '-90%',
  '--banner-shape-t4-right': '16%',
  '--banner-shape-t5-top': '-64%',
  '--banner-shape-t5-right': '6%',
  '--banner-shape-t6-top': '38%',
  '--banner-shape-t6-left': '52%',
  '--shadow-chip-dark': '0 1px 2px rgba(0,0,0,.2), 0 6px 14px rgba(0,0,0,.16)',
  '--banner-edge': '0 0 0 0 transparent',
  '--banner-edge-hero': '0 0 0 0 transparent',
  '--banner-edge-hover': '0 0 0 0 transparent',
  '--shadow-sticky':
    '0 -2px 6px rgba(16,16,20,.06), 0 -16px 40px rgba(16,16,20,.14)',
  '--shadow-band': '0 0 0 0 transparent',
  '--grid-columns': '4',
  '--grid-columns-wide': '12',
  '--grid-gap': 'var(--space-2)',
  '--grid-gap-wide': 'var(--space-3)',
  '--header-height': 'var(--space-9)',
  '--header-height-wide': 'var(--space-10)',
  '--space-0-5': '0.25rem',
  '--space-0-75': '0.375rem',
  '--space-1-5': '0.75rem',
  // E11.5-11c (founder-authorised 2026-10-27): the medium hero chip's 14px.
  '--space-1-75': '0.875rem',
  '--space-2-5': '1.25rem',
  '--border-thin': '1px',
  '--border-check': '1.5px',
  '--border-strong': '2px',
  '--focus-width': '2px',
  '--focus-offset': '2px',
  '--underline-thickness': '2px',
  '--underline-offset': '3px',
  '--ring-focus': '0 0 0 2px var(--surface), 0 0 0 4px var(--coral)',
  '--inset-line': 'inset 0 0 0 1px var(--line)',
  '--inset-strong': 'inset 0 0 0 1px var(--ink-300)',
  '--icon-base': '1.25rem',
  '--star-sm': '0.75rem',
  '--star-md': '1rem',
  '--control-height': '3rem',
  '--control-inset-strong': 'calc(var(--space-2) - var(--border-thin))',
  '--check-size': '1.25rem',
  '--check-target-offset': 'calc((var(--check-size) - var(--tap-min)) / 2)',
  '--badge-size': '1.5rem',
  '--tile-size': '2.5rem',
};

// Compares CSS values as written: whitespace, a leading zero and trailing
// zeros on a number are formatting, not value.
function cssValue(value) {
  return value
    .replaceAll(/\s+/gu, ' ')
    .replaceAll(/\s*([(),/])\s*/gu, '$1')
    .replaceAll(/-?\d*\.?\d+/gu, (number) => String(Number(number)))
    .trim()
    .toLowerCase();
}

function declarations(block) {
  return new Map(
    [...block.matchAll(/(?<name>--[\w-]+):\s*(?<value>[^;]+);/g)].map(
      ({ groups }) => [groups.name, groups.value.trim().replace(/\s+/gu, ' ')],
    ),
  );
}

function colourLuminance(hex) {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const [lighter, darker] = [
    colourLuminance(foreground),
    colourLuminance(background),
  ].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

function lockedColour(brandGuidelines, name) {
  const markdownCode = String.fromCharCode(96);
  const tokenTable = brandGuidelines.slice(
    brandGuidelines.indexOf('## 5. Colour — LOCKED'),
    brandGuidelines.indexOf('### 5.1 The coral rule'),
  );
  const match = tokenTable.match(
    new RegExp(
      `\\| ${markdownCode}${name}${markdownCode} \\| ${markdownCode}(?<value>#[0-9A-F]{6})${markdownCode}`,
      'u',
    ),
  );
  assert.ok(match, `locked colour source is missing ${name}`);
  return match.groups.value;
}

test('tokens exactly transcribe the locked colour and typography sources', async () => {
  const [source, brandGuidelines] = await Promise.all([
    readFile(tokenPath, 'utf8'),
    readFile(brandGuidelinesPath, 'utf8'),
  ]);
  const root = declarations(
    source.match(/:root\s*\{(?<block>[\s\S]*?)\}/u).groups.block,
  );

  for (const [name, value] of Object.entries(expectedRootTokens)) {
    assert.equal(root.get(name)?.toUpperCase(), value.toUpperCase(), name);
  }
  for (const [name, value] of Object.entries({
    ...foundationTokens,
    ...wireframeTokens,
  })) {
    assert.ok(root.has(name), `${name} is declared on bare :root`);
    assert.equal(cssValue(root.get(name)), cssValue(value), name);
  }

  for (const name of [
    'paper',
    'surface',
    'ink',
    'ink-600',
    'ink-300',
    'line',
    'coral',
    'coral-lift',
    'coral-tint',
    'midnight',
    'midnight-deep',
  ]) {
    assert.equal(
      root.get(`--${name}`)?.toUpperCase(),
      lockedColour(brandGuidelines, name),
      name,
    );
  }

  for (const [name, value] of [
    ['error', '#C0392B'],
    ['warning', '#B7791F'],
    ['success', '#2E7D57'],
  ]) {
    const markdownCode = String.fromCharCode(96);
    assert.match(
      brandGuidelines,
      new RegExp(
        `${markdownCode}${name}${markdownCode} ${markdownCode}${value}${markdownCode}`,
        'u',
      ),
    );
    assert.equal(root.get(`--${name}`)?.toUpperCase(), value, name);
  }
  assert.match(brandGuidelines, /Instrument Sans/u);
  assert.match(brandGuidelines, /JetBrains Mono/u);

  for (const [name, value] of Object.entries({
    '--space-0': '0',
    '--space-1': '0.5rem',
    '--space-2': '1rem',
    '--space-3': '1.5rem',
    '--space-4': '2rem',
    '--space-5': '2.5rem',
    '--space-6': '3rem',
    '--space-7': '3.5rem',
    '--space-8': '4rem',
    '--space-9': '4.5rem',
    '--space-10': '5rem',
  })) {
    assert.equal(root.get(name), value, name);
  }
});

test('every colour value reuses the locked §5 palette and the type scale has no new size', async () => {
  const [source, guidelines] = await Promise.all([
    readFile(tokenPath, 'utf8'),
    readFile(brandGuidelinesPath, 'utf8'),
  ]);
  const lockedNames = [
    'paper',
    'surface',
    'ink',
    'ink-600',
    'ink-300',
    'line',
    'coral',
    'coral-lift',
    'coral-tint',
    'midnight',
    'midnight-deep',
  ];
  const palette = new Set(
    lockedNames.map((name) => lockedColour(guidelines, name).toLowerCase()),
  );
  for (const value of ['#0F0F1A', '#F0F0EE', '#C0392B', '#B7791F', '#2E7D57']) {
    assert.match(guidelines, new RegExp(value, 'iu'));
    palette.add(value.toLowerCase());
  }
  const root = declarations(
    source.match(/:root\s*\{(?<block>[\s\S]*?)\}/u).groups.block,
  );
  const dark = declarations(
    source.match(/:root\[data-theme=['"]dark['"]\]\s*\{(?<block>[\s\S]*?)\}/u)
      .groups.block,
  );
  assert.deepEqual(
    [...root.keys()].sort(),
    [
      ...Object.keys(expectedRootTokens),
      ...Object.keys(foundationTokens),
      ...Object.keys(wireframeTokens),
      '--space-0',
      ...Array.from({ length: 10 }, (_, index) => `--space-${index + 1}`),
    ].sort(),
    'bare :root declares exactly the authorised tokens, regardless of colour syntax or size name',
  );
  assert.deepEqual(
    [...dark.keys()].sort(),
    Object.keys(expectedDarkTokens).sort(),
    'dark mode introduces no colour or type-size token',
  );
  assert.deepEqual(
    new Set(
      [...source.matchAll(/(?<name>--[\w-]+)\s*:/gu)].map(
        (match) => match.groups.name,
      ),
    ),
    new Set(root.keys()),
    'no selector introduces an undeclared colour or type-size token',
  );
  assert.equal(
    [...source.matchAll(/--[\w-]+\s*:/gu)].length,
    root.size + dark.size * 2,
    'tokens are declared only in the base and paired dark blocks',
  );
  const expectedColourNames = new Set([
    ...Object.entries(expectedRootTokens)
      .filter(([, value]) => value.startsWith('#'))
      .map(([name]) => name),
    '--on-midnight',
    '--on-coral',
    '--banner-white',
    '--banner-ink',
  ]);
  assert.deepEqual(
    new Set(
      [...root]
        .filter(([, value]) => /^#[0-9a-f]{6}$/iu.test(value))
        .map(([name]) => name),
    ),
    expectedColourNames,
  );
  for (const [name, value] of [...root, ...dark]) {
    if (/^#[0-9a-f]{6}$/iu.test(value)) {
      assert.ok(
        palette.has(value.toLowerCase()),
        `${name} must reuse §5 palette`,
      );
    }
  }
  assert.equal(root.get('--on-midnight'), root.get('--paper'));
  assert.equal(dark.get('--on-midnight'), dark.get('--ink'));
  assert.deepEqual(
    [...root.keys()]
      .filter((name) => /^--(?:step|leading)-/u.test(name))
      .sort(),
    Object.keys(expectedRootTokens)
      .filter((name) => /^--(?:step|leading)-/u.test(name))
      .sort(),
  );
});

test('the port checklist names the storefront target for the verbatim token file', async () => {
  const contract = await readFile(tokenContractPath, 'utf8');
  assert.match(
    contract,
    /\| `src\/styles\/tokens\.css` \| Storefront global stylesheet, \*\*verbatim\*\*/u,
  );
});

test('tokens are a framework-free, light-first portable CSS file', async () => {
  const source = await readFile(tokenPath, 'utf8');
  const rootMatch = source.match(/:root\s*\{(?<block>[\s\S]*?)\}/u);
  const systemDarkMatch = source.match(
    /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme\]\)\s*\{(?<block>[\s\S]*?)\}\s*\}/u,
  );
  const explicitDarkMatch = source.match(
    /:root\[data-theme=['"]dark['"]\]\s*\{(?<block>[\s\S]*?)\}/u,
  );

  assert.ok(rootMatch);
  assert.ok(systemDarkMatch);
  assert.ok(explicitDarkMatch);
  assert.doesNotMatch(source, /@(?:import|use|tailwind|layer)\b/u);
  assert.doesNotMatch(source, /(?:theme\(|var\(--tw-|styled\.)/u);

  const root = declarations(rootMatch.groups.block);
  const systemDark = declarations(systemDarkMatch.groups.block);
  const explicitDark = declarations(explicitDarkMatch.groups.block);
  assert.deepEqual(systemDark, explicitDark);

  for (const [name, value] of Object.entries(expectedDarkTokens)) {
    assert.ok(explicitDark.has(name), `${name} is in the dark blocks`);
    assert.equal(cssValue(explicitDark.get(name)), cssValue(value), name);
  }
  assert.deepEqual(
    [...explicitDark.keys()].sort(),
    Object.keys(expectedDarkTokens).sort(),
  );

  for (const name of explicitDark.keys()) {
    assert.ok(root.has(name), `${name} must have a light base definition`);
  }
});

test('declared body-text pairings meet WCAG AA in both themes', async () => {
  const source = await readFile(tokenPath, 'utf8');
  const root = Object.fromEntries(
    [
      ...declarations(
        source.match(/:root\s*\{(?<block>[\s\S]*?)\}/u).groups.block,
      ),
    ].filter(([, value]) => value.startsWith('#')),
  );
  const explicitDarkMatch = source.match(
    /:root\[data-theme=['"]dark['"]\]\s*\{(?<block>[\s\S]*?)\}/u,
  );
  assert.ok(explicitDarkMatch);
  const dark = Object.fromEntries(
    [...declarations(explicitDarkMatch.groups.block)].filter(([, value]) =>
      value.startsWith('#'),
    ),
  );
  const themes = [
    {
      name: 'light',
      tokens: root,
      pairings: [
        ['--ink', '--paper'],
        ['--ink', '--surface'],
        ['--ink-600', '--paper'],
        ['--paper', '--midnight'],
        ['--paper', '--midnight-deep'],
        ['--error', '--paper'],
      ],
    },
    {
      name: 'dark',
      tokens: { ...root, ...dark },
      pairings: [
        ['--ink', '--paper'],
        ['--ink', '--surface'],
        // Muted text must clear AA in dark too. --ink-600 gains a dark override
        // (#A0A0A8, the light --ink-300 value — founder-authorised 2026-09-05)
        // because at its light value it fails on the dark grounds. --ink-300 is
        // tertiary/placeholder text and is checked for parity.
        ['--ink-600', '--paper'],
        ['--ink-600', '--surface'],
        ['--ink-300', '--paper'],
        ['--ink-300', '--surface'],
      ],
    },
  ];

  for (const theme of themes) {
    for (const [foreground, background] of theme.pairings) {
      assert.ok(
        contrastRatio(theme.tokens[foreground], theme.tokens[background]) >=
          4.5,
        `${theme.name} ${foreground} on ${background} must meet WCAG AA`,
      );
    }
  }

  for (const theme of themes) {
    const foreground =
      theme.name === 'light' ? root['--on-midnight'] : dark['--on-midnight'];
    assert.ok(contrastRatio(foreground, root['--midnight']) >= 4.5);
    assert.ok(
      contrastRatio(theme.tokens['--coral'], root['--midnight']) >= 3,
      `${theme.name} coral on midnight must meet large-text and accent contrast`,
    );
  }

  assert.notEqual(root['--error'], root['--coral']);
  assert.ok(
    contrastRatio(root['--error'], root['--coral']) >= 1.2,
    '--error must be visibly distinct from --coral',
  );
});

test('self-hosted Latin variable fonts have metric fallbacks and tabular-figure contract', async () => {
  const source = await readFile(tokenPath, 'utf8');
  for (const filename of [
    'instrument-sans-latin-wght-normal.woff2',
    'instrument-sans-latin-wght-normal.woff',
    'jetbrains-mono-latin-wght-normal.woff2',
    'jetbrains-mono-latin-wght-normal.woff',
    'OFL-Instrument-Sans.txt',
    'OFL-JetBrains-Mono.txt',
  ]) {
    assert.ok(
      (await readFile(new URL(`../public/fonts/${filename}`, import.meta.url)))
        .byteLength > 0,
      `${filename} must ship`,
    );
  }
  assert.match(
    source,
    /font-family: 'Instrument Sans Fallback'[\s\S]*size-adjust:[\s\S]*ascent-override:[\s\S]*descent-override:[\s\S]*line-gap-override:/u,
  );
  assert.match(
    source,
    /font-family: 'JetBrains Mono Fallback'[\s\S]*size-adjust:[\s\S]*ascent-override:[\s\S]*descent-override:[\s\S]*line-gap-override:/u,
  );
  assert.match(
    source,
    /\.tabular-figure\s*\{[\s\S]*font-family: var\(--font-mono\);[\s\S]*font-variant-numeric: tabular-nums;/u,
  );
});

// E11.5-11a: read the colour forms used by tokens.css and fail closed on
// other colour syntax, so a new spelling cannot evade the palette check.
function colourLiterals(value) {
  const colours = [];
  let remainder = value.replaceAll(/#[0-9a-f]+/giu, (literal) => {
    const digits = literal.slice(1);
    assert.match(digits, /^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu);
    const expanded =
      digits.length <= 4
        ? [...digits].map((digit) => digit.repeat(2))
        : digits.match(/.{2}/gu);
    const [red, green, blue, alpha = 255] = expanded.map((channel) =>
      Number.parseInt(channel, 16),
    );
    colours.push([red, green, blue, alpha / 255]);
    return '';
  });
  assert.doesNotMatch(remainder, /#/u, `unsupported colour in ${value}`);
  remainder = remainder.replaceAll(/\brgba?\(([^()]*)\)/giu, (_, body) => {
    const parts = body.split(/[\s,/]+/u).filter(Boolean);
    assert.ok(
      (parts.length === 3 || parts.length === 4) &&
        parts.every((part) => /^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(part)),
      `unsupported colour in ${value}`,
    );
    const [red, green, blue, alpha = 1] = parts.map(Number);
    assert.ok(
      [red, green, blue].every((channel) => channel <= 255) && alpha <= 1,
      `unsupported colour in ${value}`,
    );
    colours.push([red, green, blue, alpha]);
    return '';
  });
  const allowedWords = new Set([
    'bottom',
    'calc',
    'color-mix',
    'cubic-bezier',
    'currentcolor',
    'in',
    'inset',
    'linear-gradient',
    'monospace',
    'right',
    'sans-serif',
    'srgb',
    'system-ui',
    'to',
    'transparent',
    'ui-monospace',
  ]);
  remainder = remainder
    .replaceAll(/var\(--[\w-]+\)/gu, '')
    .replaceAll(/'[^']*'|"[^"]*"/gu, '');
  for (const [word] of remainder.matchAll(/\b[a-z][a-z-]*\b/giu)) {
    assert.ok(
      allowedWords.has(word.toLowerCase()),
      `unsupported colour in ${value}`,
    );
  }
  return colours;
}

function blockOf(source, pattern) {
  return declarations(source.match(pattern).groups.block);
}

test('no new hue: every colour token is a locked palette value, an alpha variant of one, or a black-based shadow', async () => {
  assert.deepEqual(colourLiterals('#f00'), [[255, 0, 0, 1]]);
  assert.deepEqual(colourLiterals('#f008'), [[255, 0, 0, 136 / 255]]);
  assert.deepEqual(colourLiterals('#ff000088'), [[255, 0, 0, 136 / 255]]);
  assert.throws(() => colourLiterals('hsl(0 100% 50%)'), /unsupported colour/u);
  assert.throws(() => colourLiterals('red'), /unsupported colour/u);
  const [source, guidelines] = await Promise.all([
    readFile(tokenPath, 'utf8'),
    readFile(brandGuidelinesPath, 'utf8'),
  ]);
  const palette = new Set(
    [
      'paper',
      'surface',
      'ink',
      'ink-600',
      'ink-300',
      'line',
      'coral',
      'coral-lift',
      'coral-tint',
      'midnight',
      'midnight-deep',
    ].map((name) => lockedColour(guidelines, name).toLowerCase()),
  );
  // The dark palette and the functional colours, each quoted in §5.
  for (const value of ['#0F0F1A', '#F0F0EE', '#C0392B', '#B7791F', '#2E7D57']) {
    assert.match(guidelines, new RegExp(value, 'iu'));
    palette.add(value.toLowerCase());
  }
  const hex = ([red, green, blue]) =>
    `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  const blocks = [
    blockOf(source, /:root\s*\{(?<block>[\s\S]*?)\}/u),
    blockOf(
      source,
      /:root\[data-theme=['"]dark['"]\]\s*\{(?<block>[\s\S]*?)\}/u,
    ),
  ];
  const assertNoNewHue = (checkedBlocks) => {
    let checked = 0;
    for (const block of checkedBlocks) {
      for (const [name, value] of block) {
        for (const colour of colourLiterals(value)) {
          checked += 1;
          const shade = hex(colour);
          if (palette.has(shade)) continue;
          // Black appears only inside a shadow or edge value, never as a fill.
          assert.equal(shade, '#000000', `${name} adds the hue ${shade}`);
          assert.match(
            name,
            /^--(?:shadow|edge)/u,
            `${name} uses black outside a shadow`,
          );
          assert.match(value, /\d+px/u, `${name} is a shadow value`);
        }
      }
    }
    return checked;
  };
  const checked = assertNoNewHue(blocks);
  assert.throws(
    () => assertNoNewHue([new Map([['--on-coral', '#f00']])]),
    /--on-coral adds the hue #ff0000/u,
  );
  // The alpha variants named by the ticket are among the colours checked.
  assert.ok(checked >= 40, `${checked} colour literals checked`);
  const root = blocks[0];
  assert.deepEqual(colourLiterals(root.get('--banner-tone-dark')), [
    [255, 255, 255, 0.13],
  ]);
  assert.deepEqual(colourLiterals(blocks[1].get('--line')), [
    [240, 240, 238, 0.14],
  ]);
  assert.deepEqual(colourLiterals(blocks[1].get('--coral-tint')), [
    [255, 138, 102, 0.16],
  ]);
});

test('every text pairing on the component sheet clears its WCAG threshold in both themes', async () => {
  const source = await readFile(tokenPath, 'utf8');
  const root = blockOf(source, /:root\s*\{(?<block>[\s\S]*?)\}/u);
  const dark = blockOf(
    source,
    /:root\[data-theme=['"]dark['"]\]\s*\{(?<block>[\s\S]*?)\}/u,
  );
  const toHex = ([red, green, blue]) =>
    `#${[red, green, blue].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;

  for (const [themeName, scheme] of [
    ['light', root],
    ['dark', new Map([...root, ...dark])],
  ]) {
    // A token's opaque colour, following var() references, with a
    // translucent colour composited over the ground it sits on.
    const resolve = (name) => {
      let value = scheme.get(name);
      assert.ok(value, `${themeName} ${name}`);
      for (let depth = 0; value.startsWith('var('); depth += 1) {
        assert.ok(depth < 4);
        value = scheme.get(value.slice(4, -1));
      }
      return value;
    };
    const opaque = (name, ground) => {
      const [colour] = colourLiterals(resolve(name));
      if (colour[3] === 1) return toHex(colour);
      const [base] = colourLiterals(opaque(ground));
      return toHex(
        colour
          .slice(0, 3)
          .map(
            (channel, index) =>
              channel * colour[3] + base[index] * (1 - colour[3]),
          ),
      );
    };
    const pairs = [
      // [foreground, background, ground for a translucent background, min]
      // Primary label on coral; the sheet's 5.8:1.
      ['--on-coral', '--coral', null, 4.5],
      // Labels, field text and secondary button text.
      ['--ink', '--surface', null, 4.5],
      ['--ink', '--paper', null, 4.5],
      // Hint, placeholder (ink-600), checkbox label, Optional pill, FAQ answer.
      ['--ink-600', '--surface', null, 4.5],
      ['--ink-600', '--paper', null, 4.5],
      // Field error message.
      ['--error-text', '--surface', null, 4.5],
      ['--error-text', '--paper', null, 4.5],
      // Reward pill text on coral-tint, over a card and over the page.
      ['--ink', '--coral-tint', '--surface', 4.5],
      ['--ink', '--coral-tint', '--paper', 4.5],
      // Step badge and the ticked checkbox's check.
      ['--paper', '--ink', null, 4.5],
      // On-midnight label at rest and over its hover and active fills.
      ['--on-midnight', '--midnight', null, 4.5],
      ['--on-midnight', '--on-midnight-hover', '--midnight', 4.5],
      ['--on-midnight', '--on-midnight-active', '--midnight', 4.5],
      // Non-text: field and checkbox boundary, error icon and border, the
      // focus outline and the link underline (3:1, WCAG 1.4.11).
      ['--field', '--surface', null, 3],
      ['--error', '--surface', null, 3],
      ['--coral', '--paper', null, 3],
      ['--coral', '--surface', null, 3],
      ['--coral-lift', '--midnight', null, 3],
    ];
    for (const [foreground, background, ground, minimum] of pairs) {
      const ratio = contrastRatio(
        opaque(foreground),
        opaque(background, ground),
      );
      assert.ok(
        ratio >= minimum,
        `${themeName} ${foreground} on ${background}: ${ratio.toFixed(2)}`,
      );
    }
    // The primary label is #101014 on coral in both themes.
    assert.equal(resolve('--on-coral').toLowerCase(), '#101014');
  }
  // Disabled states (primary ink-600 on coral-tint, secondary ink-300, the
  // on-midnight .45 label) are inactive controls, exempt from 1.4.3.
  // Light --ink-300 is never a placeholder or text colour on the sheet:
  assert.ok(
    contrastRatio(root.get('--ink-300'), root.get('--surface')) < 4.5,
    'ink-300 would fail as placeholder text, hence ink-600',
  );
});
