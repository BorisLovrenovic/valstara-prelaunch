import { partnerDashboardCopy } from '../../copy/partner-dashboard.ts';
import type { PartnerDashboardRow } from '../db/partner-dashboard.ts';
import { waveOneEarlyAccessMonth } from '../referral/config.ts';
import { earlyAccessMonthLabel } from '../referral/ladder-presentation.ts';
import { partnerWelcomeDiscount } from '../referral/partner-perks.ts';
import { siteOrigin } from '../seo.ts';

import { flyerPath } from './config.ts';
import {
  fillPartnerMessage,
  hasKitDownloads,
  partnerKit,
  partnerMessageTemplates,
  type PartnerKit,
} from './kit.ts';
import { qrDownloads, qrSvg } from './qr.ts';

export interface PartnerKitDownloads {
  readonly files: readonly {
    readonly href: string;
    readonly title: string;
    readonly kind: string;
  }[];
  readonly videos: readonly { readonly href: string; readonly title: string }[];
}

/** The files and video links, or null when the kit lists none. */
export function presentKitDownloads(
  kit: PartnerKit = partnerKit,
): PartnerKitDownloads | null {
  if (!hasKitDownloads(kit)) return null;
  const copy = partnerDashboardCopy.kit;
  return {
    files: kit.files.map((file) => ({
      href: `/${file.path}`,
      title: file.title,
      kind: copy.fileKind[file.kind],
    })),
    videos: kit.videos.map((video) => ({
      href: video.url,
      title: video.title,
    })),
  };
}

/**
 * The asset kit for an authenticated dashboard or flyer. Only a partner whose
 * link credits signups gets one: a paused partner's link redirects without
 * attributing, so a QR code, flyer or message for it would mislead.
 */
export function presentPartnerKit(
  row: Pick<
    PartnerDashboardRow,
    'status' | 'active_code' | 'code' | 'confirmed' | 'partner_type'
  >,
  bearer: string,
  referralEnabled: boolean,
  kit: PartnerKit = partnerKit,
) {
  if (row.status !== 'active' || !row.active_code) return null;
  const copy = partnerDashboardCopy;
  const link = new URL(`/r/${row.code}`, siteOrigin).href;
  const flyer = new URL(flyerPath, siteOrigin);
  flyer.searchParams.set('t', bearer);
  const downloads = qrDownloads(link);
  return {
    link,
    code: row.code,
    qr: qrSvg(link, copy.kit.qrLabel(link)),
    qrPng: downloads.png,
    qrSvg: downloads.svg,
    qrFileName: `valstara-${row.code.toLowerCase()}-qr`,
    flyerHref: `${flyer.pathname}${flyer.search}`,
    messages: partnerMessageTemplates.map((template) => ({
      id: template.id,
      title: template.title,
      body: fillPartnerMessage(template, { code: row.code, link }),
    })),
    perk: referralEnabled
      ? copy.flyer.perk(
          earlyAccessMonthLabel(waveOneEarlyAccessMonth),
          partnerWelcomeDiscount(row.confirmed, row.partner_type),
        )
      : null,
    downloads: presentKitDownloads(kit),
  };
}

export type PartnerKitView = NonNullable<ReturnType<typeof presentPartnerKit>>;
