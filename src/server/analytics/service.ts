import {
  eventRegistry,
  isEventName,
  validServerProperties,
  type EventProps,
  type ServerEventName,
} from './registry.ts';

const website = 'a4041033-3269-4a73-8772-c16f9bdf1a33';
const collectorUrl = 'http://umami:3000/api/send';
// Umami's collector discards bot-classified User-Agents with a 200 response.
// This fixed, non-personal value is required for server events to be recorded.
const collectorUserAgent =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface AnalyticsService {
  track<Name extends ServerEventName>(
    event: Name,
    props: EventProps<Name>,
  ): Promise<void>;
}

export interface AnalyticsDependencies {
  readonly environment?: 'development' | 'production' | 'test';
  readonly send?: typeof fetch;
}

/**
 * Validate synchronously, then schedule a single best-effort collector call.
 * The returned promise settles before collector I/O and can safely be awaited
 * by a route or transition without changing its response deadline.
 */
export function createAnalyticsService(
  dependencies: AnalyticsDependencies = {},
): AnalyticsService {
  const environment =
    dependencies.environment ?? process.env.NODE_ENV ?? 'development';
  const send = dependencies.send ?? fetch;
  return {
    track(event, props) {
      const name: string = event;
      let valid: boolean;
      try {
        valid =
          isEventName(name) &&
          eventRegistry[name].source === 'server' &&
          validServerProperties(name as ServerEventName, props);
      } catch {
        valid = false;
      }
      if (!valid) {
        if (environment === 'development') {
          throw new TypeError('Analytics event is unregistered or invalid.');
        }
        return Promise.resolve();
      }

      // Neither a rejected request nor a synchronous test/provider failure can
      // escape this microtask. There is deliberately no retry or queue.
      queueMicrotask(() => {
        try {
          void send(collectorUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': collectorUserAgent,
            },
            body: JSON.stringify({
              type: 'event',
              payload: {
                website,
                hostname: 'valstara.com',
                url: '/',
                name,
                data: props,
              },
            }),
            signal: AbortSignal.timeout(1_500),
          }).catch(() => {});
        } catch {
          // Analytics loss does not change a campaign state transition.
        }
      });
      return Promise.resolve();
    },
  };
}
