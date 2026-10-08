import { appendFile, readFile } from 'node:fs/promises';

const originalFetch = globalThis.fetch;
async function mode(name) {
  return (await readFile(`/run/chaos/${name}-mode`, 'utf8')).trim();
}

globalThis.fetch = async (input, init) => {
  const url = input instanceof globalThis.Request ? input.url : String(input);
  if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
    const token = new globalThis.URLSearchParams(init?.body).get('response');
    if (token === 'invalid-token')
      return globalThis.Response.json({
        success: false,
        'error-codes': ['invalid-input-response'],
      });
    if (token === 'replayed-token')
      return globalThis.Response.json({
        success: false,
        'error-codes': ['timeout-or-duplicate'],
      });
    const current = await mode('turnstile');
    if (current === 'secret')
      return globalThis.Response.json({
        success: false,
        'error-codes': ['invalid-input-secret'],
      });
    if (current === 'delayed')
      await new Promise((resolve) => globalThis.setTimeout(resolve, 1_000));
    return globalThis.Response.json({ success: true });
  }
  if (url === 'https://api.resend.com/emails') {
    return (await mode('resend')) === 'revoked'
      ? new globalThis.Response(null, { status: 401 })
      : globalThis.Response.json({ id: 'local-chaos-sink-message' });
  }
  if (url === 'http://alerts.local.test/alerts') {
    await appendFile('/run/chaos/alerts.jsonl', `${String(init?.body)}\n`);
    return new globalThis.Response(null, { status: 204 });
  }
  return originalFetch(input, init);
};
