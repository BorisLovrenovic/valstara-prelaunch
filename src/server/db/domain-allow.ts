import type { DatabaseConnection } from './pool.ts';

export interface DomainAllowRepository {
  contains(domain: string): Promise<boolean>;
  insert(domain: string, actor: string): Promise<number>;
}

export function createDomainAllowRepository(
  database: DatabaseConnection,
): DomainAllowRepository {
  return {
    async contains(domain) {
      const row = await database.readOne<{ readonly allowed: boolean }>({
        text: 'SELECT true AS allowed FROM domain_allow WHERE domain = $1',
        values: [domain],
      });
      return row !== null;
    },
    async insert(domain, actor) {
      return database.execute({
        text: `
          INSERT INTO domain_allow (domain, allowed_by)
          VALUES ($1, $2)
          ON CONFLICT (domain) DO NOTHING
        `,
        values: [domain, actor],
      });
    },
  };
}
