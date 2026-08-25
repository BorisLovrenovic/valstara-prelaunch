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

function normalisePoolAcquisitionError(error: unknown): Error {
  const normalisedError = normaliseDatabaseError(error);

  if (
    normalisedError instanceof Error &&
    /timeout exceeded when trying to connect/i.test(normalisedError.message)
  ) {
    return new DatabaseUnavailableError(error);
  }

  return normalisedError;
}

function toPgValues(
  values: readonly unknown[] | undefined,
): never[] | undefined {
  return values ? ([...values] as never[]) : undefined;
}

function sqlTokens(text: string): readonly string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < text.length) {
    const character = text[index];

    if (character === undefined) {
      break;
    }

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    if (text.startsWith('--', index)) {
      const lineEnd = text.indexOf('\n', index + 2);
      index = lineEnd === -1 ? text.length : lineEnd + 1;
      continue;
    }

    if (text.startsWith('/*', index)) {
      let depth = 1;
      index += 2;

      while (index < text.length && depth > 0) {
        if (text.startsWith('/*', index)) {
          depth += 1;
          index += 2;
        } else if (text.startsWith('*/', index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }

    if (character === "'" || character === '"') {
      const quote = character;
      index += 1;

      while (index < text.length) {
        if (text[index] === quote) {
          index += 1;
          if (text[index] !== quote) {
            break;
          }
        }
        index += 1;
      }
      continue;
    }

    if (character === '$') {
      const tag = text
        .slice(index)
        .match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag !== undefined) {
        const closingIndex = text.indexOf(tag, index + tag.length);
        index = closingIndex === -1 ? text.length : closingIndex + tag.length;
        continue;
      }
    }

    if (/[A-Za-z_]/.test(character)) {
      const keyword = text.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*/)?.[0];
      if (keyword !== undefined) {
        tokens.push(keyword.toUpperCase());
        index += keyword.length;
        continue;
      }
    }

    if (character === ';') {
      tokens.push(character);
    }
    index += 1;
  }

  return tokens;
}

function assertCommand(statement: SqlStatement): void {
  const tokens = sqlTokens(statement.text);
  const statementKeywords = new Set([
    'EXPLAIN',
    'FETCH',
    'SELECT',
    'SHOW',
    'TABLE',
    'VALUES',
    'WITH',
  ]);
  let startsStatement = true;

  for (const token of tokens) {
    if (token === ';') {
      startsStatement = true;
      continue;
    }

    if (
      token === 'RETURNING' ||
      (startsStatement && statementKeywords.has(token))
    ) {
      throw new TypeError(
        'Result-set queries must use readOne() or list() with an explicit limit.',
      );
    }

    startsStatement = false;
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
      throw normalisePoolAcquisitionError(error);
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
