(() => {
  const path = globalThis.location.pathname;
  if (
    /^\/(?:me|verify|unsubscribe)(?:\/|$)/u.test(path) ||
    /^\/(?:api\/)?admin(?:\/|$)/u.test(path)
  ) {
    return;
  }

  const website = globalThis.document.currentScript?.dataset.websiteId;
  if (!website) return;

  let referrer = '';
  try {
    if (globalThis.document.referrer) {
      referrer = new globalThis.URL(globalThis.document.referrer).origin;
    }
  } catch {
    // A malformed referrer contributes no analytics property.
  }

  const payload = {
    website,
    hostname: globalThis.location.hostname,
    url: path,
    referrer,
    title: globalThis.document.title,
    language: globalThis.document.documentElement.lang,
  };

  try {
    void globalThis
      .fetch('/analytics/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'event', payload }),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        keepalive: true,
      })
      .catch(() => {});
  } catch {
    // Analytics never holds up a page.
  }
})();
