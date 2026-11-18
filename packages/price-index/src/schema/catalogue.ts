import { z } from 'zod';

import {
  aliasSchema,
  displayNameSchema,
  duplicates,
  normaliseAlias,
  slugSchema,
} from './common.ts';

// config/catalogue.json (docs/features/price-index.md#catalogue-configcataloguejson).

export const serviceCategories = [
  'ai',
  'streaming',
  'music',
  'productivity',
  'learning',
  'fitness',
] as const;

export const serviceStatuses = ['selling_now', 'launch', 'planned'] as const;

export const billingPeriods = ['month', 'year'] as const;

/**
 * `/prices/countries/{country}` is the market hub (E11.6-12), so a service
 * with this id would collide with it at `/prices/{service}`.
 */
export const reservedServiceIds: ReadonlySet<string> = new Set(['countries']);

export const planSchema = z.strictObject({
  plan_id: slugSchema,
  name: displayNameSchema,
  billing_period: z.enum(billingPeriods),
  is_student: z.boolean(),
  is_family: z.boolean(),
});

/**
 * The names the source uses, for matching only: `service` for the service
 * itself, and `plans[plan_id]` for each plan. A plan with no entry has no
 * alias, so no source row can match it and it stays `missing`.
 */
export const sourceAliasesSchema = z.strictObject({
  service: z.array(aliasSchema),
  plans: z.record(slugSchema, z.array(aliasSchema)),
});

/**
 * A bare lower-case hostname: dot-separated labels of letters, digits and
 * inner hyphens, at least two labels, with no scheme, path, port or
 * trailing dot (D-031 Q1).
 */
export const hostnamePattern =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const hostnameSchema = z.string().regex(hostnamePattern, {
  error: 'must be a bare lower-case hostname, with no scheme, path or port',
});

export const serviceSchema = z
  .strictObject({
    service_id: slugSchema.refine((value) => !reservedServiceIds.has(value), {
      error: 'is reserved by a price route',
    }),
    name: displayNameSchema,
    category: z.enum(serviceCategories),
    website_url: z.url({
      protocol: /^https$/,
      error: 'must be an https URL',
    }),
    /**
     * Further hosts an override's `source_url` may be on, beside the
     * `website_url` host (D-031 Q1). Compared exactly; never a pattern.
     */
    official_hosts: z.array(hostnameSchema).optional(),
    status: z.enum(serviceStatuses),
    plans: z.array(planSchema).min(1),
    source_aliases: sourceAliasesSchema,
  })
  .superRefine((service, context) => {
    if (service.official_hosts !== undefined) {
      for (const host of duplicates(service.official_hosts)) {
        context.addIssue({
          code: 'custom',
          message: `duplicate official host ${host} in service ${service.service_id}`,
          path: ['official_hosts'],
        });
      }
      const websiteHost = new URL(service.website_url).hostname;
      if (service.official_hosts.includes(websiteHost)) {
        context.addIssue({
          code: 'custom',
          message: `official host ${websiteHost} is already the website_url host of ${service.service_id}`,
          path: ['official_hosts'],
        });
      }
    }

    const planIds = service.plans.map((plan) => plan.plan_id);
    for (const planId of duplicates(planIds)) {
      context.addIssue({
        code: 'custom',
        message: `duplicate plan_id ${planId} in service ${service.service_id}`,
        path: ['plans'],
      });
    }

    const knownPlans = new Set(planIds);
    const planByAlias = new Map<string, string>();
    for (const [planId, aliases] of Object.entries(
      service.source_aliases.plans,
    )) {
      if (!knownPlans.has(planId)) {
        context.addIssue({
          code: 'custom',
          message: `alias entry for unknown plan ${planId} in service ${service.service_id}`,
          path: ['source_aliases', 'plans', planId],
        });
      }
      for (const alias of aliases) {
        const key = normaliseAlias(alias);
        const owner = planByAlias.get(key);
        if (owner !== undefined && owner !== planId) {
          context.addIssue({
            code: 'custom',
            message: `alias "${alias}" maps to two plans, ${owner} and ${planId}, in service ${service.service_id}`,
            path: ['source_aliases', 'plans', planId],
          });
        }
        planByAlias.set(key, owner ?? planId);
      }
    }
  });

export const catalogueFileSchema = z
  .strictObject({ services: z.array(serviceSchema) })
  .superRefine((file, context) => {
    for (const serviceId of duplicates(
      file.services.map((service) => service.service_id),
    )) {
      context.addIssue({
        code: 'custom',
        message: `duplicate service_id ${serviceId}`,
        path: ['services'],
      });
    }

    const serviceByAlias = new Map<string, string>();
    for (const service of file.services) {
      for (const alias of service.source_aliases.service) {
        const key = normaliseAlias(alias);
        const owner = serviceByAlias.get(key);
        if (owner !== undefined && owner !== service.service_id) {
          context.addIssue({
            code: 'custom',
            message: `alias "${alias}" maps to two services, ${owner} and ${service.service_id}`,
            path: ['services'],
          });
        }
        serviceByAlias.set(key, owner ?? service.service_id);
      }
    }
  });

export type Plan = z.infer<typeof planSchema>;
export type Service = z.infer<typeof serviceSchema>;
export type CatalogueFile = z.infer<typeof catalogueFileSchema>;
