// E11.7-06: the template and business keys of the review emails, kept free
// of imports so the email dispatch (`templates.ts`, loaded by the
// maintenance worker) never pulls in the review service's module graph.

export const partnerApprovedTemplate = 'partner_approved';
export const partnerRejectedTemplate = 'partner_rejected';

export function partnerApprovedBusinessKey(partnerId: string): string {
  return `partner-approved:${partnerId}`;
}

export function partnerRejectedBusinessKey(partnerId: string): string {
  return `partner-rejected:${partnerId}`;
}
