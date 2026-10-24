import { dsrCopy } from '../../copy/dsr.ts';
import { renderEmailDocument } from '../email/template-layout.ts';
import type { TemplateRenderer } from '../email/service.ts';
export function dsrRenderers(
  baseUrl: string,
  sendingDomain: string,
): ReadonlyMap<string, TemplateRenderer> {
  return new Map(
    (['export', 'delete'] as const).map((operation) => [
      `dsr_${operation}`,
      {
        kind: 'transactional' as const,
        async render(input: Parameters<TemplateRenderer['render']>[0]) {
          if (typeof input.payload.token_id !== 'string')
            throw new Error('dsr_token_missing');
          const url = new URL('/dsr', baseUrl);
          url.searchParams.set('operation', operation);
          url.searchParams.set('t', await input.token(input.payload.token_id));
          return renderEmailDocument({
            from: `hello@${sendingDomain}`,
            to: input.email,
            unsubscribePageUrl: input.unsubscribePageUrl,
            document: {
              subject: dsrCopy[operation].subject,
              preheader: dsrCopy[operation].preheader,
              paragraphs: [dsrCopy.emailBody],
              links: [
                { label: dsrCopy[operation].button, url: url.toString() },
              ],
            },
          });
        },
      },
    ]),
  );
}
