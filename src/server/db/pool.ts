import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { DatabaseUnavailableError } from './errors';

const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const MAX_POOL_SIZE = 10;

export interface SqlStatement {
  readonly text: string;
  readonly values?: readonly unknown[];
}

export interface DatabaseConnection {
  execute(statement: SqlStatement): Promise<number>;
  readOne<Row extends QueryResultRow>(
    statement: SqlStatement,
  ): Promise<Row | null>;
  list<Row extends QueryResultRow>(
    statement: SqlStatement,
    limit: number,
  ): Promise<readonly Row[]>;
}

export interface DatabaseClient extends DatabaseConnection {
  release(): void;
}

export interface DatabasePool extends DatabaseConnection {
  connect(): Promise<DatabaseClient>;
  close(): Promise<void>;
}

function withLimit(statement: SqlStatement, limit: number): SqlStatement {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('A query list limit must be a positive integer.');
  }

  const values = statement.values ? [...statement.values] : [];
  const text = statement.text.trim().replace(/;$/, '');

  return {
    text: `${text} LIMIT $${values.length + 1}`,
    values: [...values, limit],
  };
}

const unavailableErrorCodes = new Set([
  '08000',
  '08001',
  '08003',
  '08006',
  '53300',
  '57P01',
  '57P02',
  '57P03',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

function normaliseDatabaseError(error: unknown): Error {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    unavailableErrorCodes.has(error.code)
  ) {
    return new DatabaseUnavailableError(error);
  }

  return error instanceof Error
    ? error
    : new Error('The database returned an unknown error.', { cause: error });
}

function toPgValues(
  values: readonly unknown[] | undefined,
): never[] | undefined {
  return values ? ([...values] as never[]) : undefined;
}

function assertCommand(statement: SqlStatement): void {
  const firstKeyword = statement.text
    .trimStart()
    .match(/^[a-z]+/i)?.[0]
    ?.toUpperCase();

  if (
    firstKeyword === 'EXPLAIN' ||
    firstKeyword === 'SELECT' ||
    firstKeyword === 'SHOW' ||
    firstKeyword === 'VALUES' ||
    firstKeyword === 'WITH' ||
    /\bRETURNING\b/i.test(statement.text)
  ) {
    throw new TypeError(
      'Result-set queries must use readOne() or list() with an explicit limit.',
    );
  }
}

class PostgresConnection implements DatabaseClient {
  private readonly client: PoolClient;

  public constructor(client: PoolClient) {
    this.client = client;
  }

  public async execute(statement: SqlStatement): Promise<number> {
    assertCommand(statement);

    try {
      const result = await this.client.query(
        statement.text,
        toPgValues(statement.values),
      );
      return result.rowCount ?? 0;
    } catch (error) {
      throw normaliseDatabaseError(error);
    }
  }

  public async readOne<Row extends QueryResultRow>(
    statement: SqlStatement,
  ): Promise<Row | null> {
    const rows = await this.list<Row>(statement, 1);
    return rows[0] ?? null;
  }

  public async list<Row extends QueryResultRow>(
    statement: SqlStatement,
    limit: number,
  ): Promise<readonly Row[]> {
    const limitedStatement = withLimit(statement, limit);

    try {
      const result = await this.client.query<Row>(
        limitedStatement.text,
        toPgValues(limitedStatement.values),
      );
      return result.rows;
    } catch (error) {
      throw normaliseDatabaseError(error);
    }
  }

  public release(): void {
    this.client.release();
  }
}

class PostgresPool implements DatabasePool {
  private readonly pool: Pool;

  public constructor(pool: Pool) {
    this.pool = pool;
  }

  public async execute(statement: SqlStatement): Promise<number> {
    assertCommand(statement);

    try {
      const result = await this.pool.query(
        statement.text,
        toPgValues(statement.values),
      );
      return result.rowCount ?? 0;
    } catch (error) {
      throw normaliseDatabaseError(error);
    }
  }

  public async readOne<Row extends QueryResultRow>(
    statement: SqlStatement,
  ): Promise<Row | null> {
    const rows = await this.list<Row>(statement, 1);
    return rows[0] ?? null;
  }

  public async list<Row extends QueryResultRow>(
    statement: SqlStatement,
    limit: number,
  ): Promise<readonly Row[]> {
    const limitedStatement = withLimit(statement, limit);

    try {
      const result = await this.pool.query<Row>(
        limitedStatement.text,
        toPgValues(limitedStatement.values),
      );
      return result.rows;
    } catch (error) {
      throw normaliseDatabaseError(error);
    }
  }

  public async connect(): Promise<DatabaseClient> {
    try {
      return new PostgresConnection(await this.pool.connect());
    } catch (error) {
      throw normaliseDatabaseError(error);
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createPool(databaseUrl: string): DatabasePool {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: DEFAULT_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: DEFAULT_IDLE_TIMEOUT_MS,
    max: MAX_POOL_SIZE,
  });

  pool.on('error', () => undefined);

  return new PostgresPool(pool);
}
