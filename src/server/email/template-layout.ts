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
  readonly paragraphs: readonly string[];
  readonly facts?: readonly string[];
  readonly links: readonly EmailLink[];
}

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

function tokenCss(): string {
  const source = readFileSync(
    resolve(process.cwd(), 'src/styles/tokens.css'),
    'utf8',
  );
  const root = /:root\s*\{[\s\S]*?^\}/mu.exec(source)?.[0];
  if (root === undefined) throw new Error('email_design_tokens_missing');
  return root;
}

let cachedTokenCss: string | null = null;

function emailTokenCss(): string {
  cachedTokenCss ??= tokenCss();
  return cachedTokenCss;
}

/** HTML and plain text come from one content structure, so neither loses a link. */
export function renderEmailDocument(input: {
  readonly from: string;
  readonly to: string;
  readonly document: EmailDocument;
  readonly unsubscribePageUrl: string;
}): Message {
  const { document, unsubscribePageUrl } = input;
  const links = [
    ...document.links,
    { label: emailCopy.unsubscribe, url: unsubscribePageUrl },
  ];
  const lines = [
    ...document.paragraphs,
    ...(document.facts ?? []),
    ...links.map(({ label, url }) => `${label}: ${url}`),
  ];
  const paragraphsHtml = document.paragraphs
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join('');
  const factsHtml =
    document.facts === undefined || document.facts.length === 0
      ? ''
      : `<ul>${document.facts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join('')}</ul>`;
  const linksHtml = links
    .map(
      ({ label, url }) =>
        `<p><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></p>`,
    )
    .join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${emailTokenCss()} body{background:var(--paper);color:var(--ink);font-family:var(--font-sans)} a{color:var(--coral)}</style></head><body><main>${paragraphsHtml}${factsHtml}${linksHtml}</main></body></html>`;
  return {
    from: input.from,
    to: input.to,
    subject: document.subject,
    text: lines.join('\n\n'),
    html,
  };
}
