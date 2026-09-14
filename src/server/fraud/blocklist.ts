import disposableDomainDataset from './disposable-email-domains.json' with { type: 'json' };

function loadBlocklist(): ReadonlySet<string> {
  const domains: readonly string[] = disposableDomainDataset;

  if (
    domains.length === 0 ||
    domains.some(
      (domain) => domain !== domain.trim() || domain !== domain.toLowerCase(),
    )
  ) {
    throw new Error('Disposable-domain dataset is empty or not normalised.');
  }

  return new Set(domains);
}

// Loaded once when the server module graph boots. No rendered page or request
// downloads configuration from a third party.
const disposableDomains = loadBlocklist();

export function isBlocklistedDomain(domain: string): boolean {
  const labels = domain.split('.');
  for (let index = 0; index < labels.length - 1; index += 1) {
    if (disposableDomains.has(labels.slice(index).join('.'))) {
      return true;
    }
  }
  return false;
}

export const disposableDomainCount = disposableDomains.size;
