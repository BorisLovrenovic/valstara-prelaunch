import { createAuditService } from '../audit/service.ts';
import type { DatabasePool } from '../db/pool.ts';
import { createFlagService } from '../flags/service.ts';

export async function recordHandoffFreeze(
  database: DatabasePool,
  actor: string,
  mode: 'operational' | 'local_rehearsal',
): Promise<void> {
  if (!actor.trim()) throw new Error('A named freeze operator is required.');
  if (await createFlagService(database).isEnabled('signup.enabled'))
    throw new Error('Close signups before recording the full freeze.');
  await createAuditService(database).record({
    action: 'handoff.frozen',
    actor,
    subjectType: 'handoff',
    subjectId: null,
    detail: { mode },
  });
}
