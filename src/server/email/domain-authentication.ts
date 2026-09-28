import { resolveCname, resolveTxt } from 'node:dns/promises';

import type { ResendDomainAuthenticationConfiguration } from '../config.ts';
import type { AlertTransport } from '../verification-rate/p1-webhook.ts';

export type DomainAuthReason =
  | 'ok'
  | 'send_cname_missing'
  | 'send_cname_mismatch'
  | 'rsend_cname_missing'
  | 'rsend_cname_mismatch'
  | 'spf_txt_missing_or_invalid'
  | 'dkim_missing'
  | 'dkim_mismatch'
  | 'dmarc_missing'
  | 'dmarc_invalid';

export interface AuthenticationRecordHealth {
  readonly passed: boolean;
  readonly reason: DomainAuthReason;
}

export interface DmarcAuthenticationRecordHealth extends AuthenticationRecordHealth {
  readonly policy: 'none' | 'quarantine' | 'reject' | null;
}

export interface SendingDomainAuthenticationHealth {
  readonly domain: string;
  readonly spf: AuthenticationRecordHealth;
  readonly dkim: AuthenticationRecordHealth;
  readonly dmarc: DmarcAuthenticationRecordHealth;
  readonly checkedAt: Date;
}

export interface DomainAuthenticationDependencies {
  readonly clock: () => Date;
  readonly configuration: ResendDomainAuthenticationConfiguration & {
    readonly sendingDomain: string;
  };
  readonly resolveTxt?: typeof resolveTxt;
  readonly resolveCname?: typeof resolveCname;
}

function normalizedTarget(value: string): string {
  return value.toLowerCase().replace(/\.$/u, '');
}

function cnameHealth(
  records: readonly string[] | null,
  expected: string,
  missing: DomainAuthReason,
  mismatch: DomainAuthReason,
): AuthenticationRecordHealth {
  if (records === null || records.length === 0) {
    return { passed: false, reason: missing };
  }
  return records.length === 1 &&
    normalizedTarget(records[0] ?? '') === normalizedTarget(expected)
    ? { passed: true, reason: 'ok' }
    : { passed: false, reason: mismatch };
}

export async function domainAuthenticationHealth(
  dependencies: DomainAuthenticationDependencies,
): Promise<readonly SendingDomainAuthenticationHealth[]> {
  const lookupTxt = dependencies.resolveTxt ?? resolveTxt;
  const lookupCname = dependencies.resolveCname ?? resolveCname;
  const { configuration } = dependencies;
  const domain = configuration.sendingDomain;
  const readTxt = async (name: string): Promise<string[] | null> => {
    try {
      return (await lookupTxt(name)).map((parts) => parts.join(''));
    } catch {
      return null;
    }
  };
  const readCname = async (name: string): Promise<string[] | null> => {
    try {
      return await lookupCname(name);
    } catch {
      return null;
    }
  };

  const [sendCname, rsendCname, spfRecords, dkimRecords, dmarcRecords] =
    await Promise.all([
      readCname(`send.${domain}`),
      readCname(`rsend.${domain}`),
      readTxt(`send.${domain}`),
      readTxt(`resend._domainkey.${domain}`),
      readTxt(`_dmarc.${domain}`),
    ]);

  const sendHealth = cnameHealth(
    sendCname,
    configuration.sendCnameExpectedTarget,
    'send_cname_missing',
    'send_cname_mismatch',
  );
  const rsendHealth = cnameHealth(
    rsendCname,
    configuration.rsendCnameExpectedTarget,
    'rsend_cname_missing',
    'rsend_cname_mismatch',
  );
  const hasSpf =
    spfRecords !== null &&
    spfRecords.filter((record) => /^v=spf1(?:\s|$)/u.test(record)).length === 1;
  const spf = !sendHealth.passed
    ? sendHealth
    : !rsendHealth.passed
      ? rsendHealth
      : hasSpf
        ? { passed: true, reason: 'ok' as const }
        : { passed: false, reason: 'spf_txt_missing_or_invalid' as const };

  const dkim =
    dkimRecords === null || dkimRecords.length === 0
      ? { passed: false, reason: 'dkim_missing' as const }
      : dkimRecords.length === 1 &&
          dkimRecords[0] === configuration.dkimExpectedValue
        ? { passed: true, reason: 'ok' as const }
        : { passed: false, reason: 'dkim_mismatch' as const };

  const dmarcRecordsWithVersion =
    dmarcRecords?.filter((record) => /^v=DMARC1(?:\s*;|$)/iu.test(record)) ??
    [];
  const policyMatch =
    dmarcRecordsWithVersion.length === 1
      ? /(?:^|;)\s*p=(none|quarantine|reject)(?:;|$)/iu.exec(
          dmarcRecordsWithVersion[0] ?? '',
        )
      : null;
  const policy = (policyMatch?.[1]?.toLowerCase() ?? null) as
    'none' | 'quarantine' | 'reject' | null;
  const dmarc: DmarcAuthenticationRecordHealth =
    dmarcRecords === null || dmarcRecords.length === 0
      ? { passed: false, reason: 'dmarc_missing', policy: null }
      : dmarcRecordsWithVersion.length === 1 && policy !== null
        ? { passed: true, reason: 'ok', policy }
        : { passed: false, reason: 'dmarc_invalid', policy: null };

  return [
    {
      domain,
      spf,
      dkim,
      dmarc,
      checkedAt: dependencies.clock(),
    },
  ];
}

export async function checkDomainAuthenticationAtStartup(
  dependencies: DomainAuthenticationDependencies & {
    readonly alerts: AlertTransport;
    readonly writeLog: (line: string) => void;
  },
): Promise<readonly SendingDomainAuthenticationHealth[]> {
  const result = await domainAuthenticationHealth(dependencies);
  for (const domain of result) {
    const failures = (
      [
        ['spf', domain.spf],
        ['dkim', domain.dkim],
        ['dmarc', domain.dmarc],
      ] as const
    ).filter(([, status]) => !status.passed);
    if (failures.length === 0) continue;
    for (const [record, status] of failures) {
      dependencies.writeLog(
        `${JSON.stringify({ event: 'domain_authentication_failed', domain: domain.domain, record, code: status.reason })}\n`,
      );
    }
    try {
      await dependencies.alerts.send({
        event: 'domain_authentication_failed',
        detail: {
          domain: domain.domain,
          failed_records: failures.map(([record]) => record).join(','),
          codes: failures.map(([, status]) => status.reason).join(','),
        },
        occurredAt: domain.checkedAt,
        severity: 'P1',
      });
    } catch {
      dependencies.writeLog(
        `${JSON.stringify({ event: 'domain_authentication_alert_failed', code: 'alert_unavailable' })}\n`,
      );
    }
  }
  return result;
}
