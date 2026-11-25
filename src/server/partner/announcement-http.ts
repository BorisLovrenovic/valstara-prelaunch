import { adminCopy } from '../../copy/admin.ts';
import { DatabaseUnavailableError } from '../db/errors.ts';

import {
  PartnerAnnouncementRefusedError,
  type PartnerAnnouncementRunResult,
  type PartnerAnnouncementService,
} from './announcement.ts';

// E11.7-16: the request and response of POST /api/admin/partners/announce
// (docs/api/README.md#admin-routes). Body `{ "id": "<announcement id>",
// "dry_run"?: true }`, no other key. A refusal is `400 invalid_input` with a
// message from the copy layer; nothing from the database reaches a response.

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function errorResponse(
  code: 'internal' | 'invalid_input' | 'unavailable',
  message: string,
): Response {
  const status =
    code === 'invalid_input' ? 400 : code === 'unavailable' ? 503 : 500;
  return jsonResponse(status, { error: { code, message } });
}

function refusalMessage(error: PartnerAnnouncementRefusedError): string {
  const copy = adminCopy.partnerAnnouncement;
  switch (error.refusal) {
    case 'not_found':
      return copy.notFound;
    case 'invalid':
      return copy.invalid(error.details);
    case 'flags_off':
      return copy.flagsOff(error.details);
  }
}

function present(
  result: PartnerAnnouncementRunResult,
): Record<string, unknown> {
  return result.dryRun
    ? {
        announcement: { id: result.announcementId, dry_run: true },
        partners_due: result.due,
      }
    : {
        announcement: { id: result.announcementId, dry_run: false },
        queued: result.queued,
        already_queued: result.alreadyQueued,
        remaining: result.remaining,
      };
}

function readBody(body: unknown): { id: string; dryRun: boolean } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return null;
  const record = body as Record<string, unknown>;
  if (!Object.keys(record).every((key) => key === 'id' || key === 'dry_run'))
    return null;
  if (typeof record.id !== 'string' || record.id === '') return null;
  if (record.dry_run !== undefined && typeof record.dry_run !== 'boolean')
    return null;
  return { id: record.id, dryRun: record.dry_run === true };
}

export function createPartnerAnnouncementHandler(
  service: PartnerAnnouncementService,
): (input: { actor: string; request: Request }) => Promise<Response> {
  return async ({ actor, request }) => {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return errorResponse(
        'invalid_input',
        adminCopy.partnerAnnouncement.bodyInvalid,
      );
    }
    const body = readBody(parsed);
    if (body === null)
      return errorResponse(
        'invalid_input',
        adminCopy.partnerAnnouncement.bodyInvalid,
      );
    try {
      return jsonResponse(
        200,
        present(await service.run({ id: body.id, dryRun: body.dryRun, actor })),
      );
    } catch (error) {
      if (error instanceof PartnerAnnouncementRefusedError)
        return errorResponse('invalid_input', refusalMessage(error));
      return error instanceof DatabaseUnavailableError
        ? errorResponse(
            'unavailable',
            adminCopy.partnerAnnouncement.unavailable,
          )
        : errorResponse('internal', adminCopy.partnerAnnouncement.unavailable);
    }
  };
}
