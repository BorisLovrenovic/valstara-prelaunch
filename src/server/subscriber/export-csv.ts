import type { AdminExportRow } from '../db/admin-export.ts';

export const adminExportColumns = [
  'email',
  'email_normalised',
  'referral_tier',
  'referral_code',
  'confirmed_referrals',
  'category_preference',
  'source',
  'marketing_consent_at',
  'marketing_consent_version',
  'marketing_consent_source',
  'access_window',
  'subslush_customer',
] as const;

function field(value: string | number | boolean | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvHeader(): string {
  return `${adminExportColumns.join(',')}\r\n`;
}

export function csvRow(row: AdminExportRow): string {
  return `${[
    row.email,
    row.email_normalised,
    row.referral_tier,
    row.referral_code,
    row.confirmed_referrals,
    row.category_preference === null
      ? null
      : JSON.stringify(row.category_preference),
    row.source,
    row.marketing_consent_at?.toISOString() ?? null,
    row.marketing_consent_version,
    row.marketing_consent_source,
    row.access_window,
    row.subslush_customer,
  ]
    .map(field)
    .join(',')}\r\n`;
}
