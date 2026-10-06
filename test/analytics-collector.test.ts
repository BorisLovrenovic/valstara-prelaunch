import assert from 'node:assert/strict';
import test from 'node:test';

import { Pool } from 'pg';

import { createAnalyticsService } from '../src/server/analytics/service.ts';

const websiteId = 'a4041033-3269-4a73-8772-c16f9bdf1a33';

test('server event reaches the pinned local Umami collector with category data', async () => {
  const database = new Pool({
    connectionString:
      'postgresql://umami:umami-local-only@127.0.0.1:5434/umami',
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
  });
  try {
    await database.query(
      `INSERT INTO website (website_id, name, domain)
       VALUES ($1, 'Valstara', 'valstara.com')
       ON CONFLICT (website_id) DO NOTHING`,
      [websiteId],
    );
    const before = await database.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count FROM website_event
       WHERE website_id = $1 AND event_name = 'signup_submitted'`,
      [websiteId],
    );
    let delivery: Promise<Response> | undefined;
    const analytics = createAnalyticsService({
      environment: 'production',
      send: ((url: string, options: RequestInit) => {
        assert.equal(url, 'http://umami:3000/api/send');
        delivery = fetch('http://127.0.0.1:3000/api/send', options);
        return delivery;
      }) as typeof fetch,
    });
    await analytics.track('signup_submitted', {
      source_bucket: 'direct',
      had_ref: false,
      marketing_opt_in: false,
    });
    assert.ok(delivery !== undefined);
    const response = await delivery;
    assert.equal(response.status, 200);
    const receipt = (await response.json()) as Record<string, unknown>;
    assert.equal(typeof receipt.sessionId, 'string');

    let recorded:
      | {
          count: number;
          event_id: string;
          url_path: string;
          url_query: string | null;
        }
      | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const rows = await database.query<{
        count: number;
        event_id: string;
        url_path: string;
        url_query: string | null;
      }>(
        `SELECT (SELECT COUNT(*)::integer FROM website_event
                 WHERE website_id = $1 AND event_name = 'signup_submitted') AS count,
                event_id, url_path, url_query
         FROM website_event
         WHERE website_id = $1 AND event_name = 'signup_submitted'
         ORDER BY created_at DESC LIMIT 1`,
        [websiteId],
      );
      recorded = rows.rows[0];
      if (recorded !== undefined && recorded.count > before.rows[0].count)
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(recorded?.count, before.rows[0].count + 1);
    assert.equal(recorded.url_path, '/');
    assert.equal(recorded.url_query, '');
    const data = await database.query<{
      data_key: string;
      string_value: string | null;
    }>(
      `SELECT data_key, string_value FROM event_data
       WHERE website_event_id = $1 ORDER BY data_key`,
      [recorded.event_id],
    );
    assert.deepEqual(data.rows, [
      { data_key: 'had_ref', string_value: 'false' },
      { data_key: 'marketing_opt_in', string_value: 'false' },
      { data_key: 'source_bucket', string_value: 'direct' },
    ]);
  } finally {
    await database.end();
  }
});
