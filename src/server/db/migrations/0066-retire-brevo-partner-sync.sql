-- D-056 defers the dedicated partner list sync. Keep the contract-version
-- constraint from 0065 and leave the append-only audit history intact.
DROP TABLE brevo_partner_sync_result;
DROP TABLE brevo_partner_sync;

DELETE FROM campaign_flag WHERE key = 'partners.brevo_sync';
