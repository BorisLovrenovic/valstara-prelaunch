import type { DatabaseConnection, DatabasePool } from './pool.ts';

export async function withTransaction<Result>(
  database: DatabasePool,
  operation: (connection: DatabaseConnection) => Promise<Result>,
): Promise<Result> {
  const connection = await database.connect();

  try {
    await connection.execute({ text: 'BEGIN' });
    const result = await operation(connection);
    await connection.execute({ text: 'COMMIT' });
    return result;
  } catch (error) {
    await connection.execute({ text: 'ROLLBACK' });
    throw error;
  } finally {
    connection.release();
  }
}

/** Isolate an optional write while retaining the caller's transaction. */
export async function tryInSavepoint(
  connection: DatabaseConnection,
  operation: () => Promise<boolean>,
): Promise<boolean> {
  await connection.execute({ text: 'SAVEPOINT optional_email_queue' });
  try {
    const result = await operation();
    await connection.execute({
      text: 'RELEASE SAVEPOINT optional_email_queue',
    });
    return result;
  } catch {
    await connection.execute({
      text: 'ROLLBACK TO SAVEPOINT optional_email_queue',
    });
    await connection.execute({
      text: 'RELEASE SAVEPOINT optional_email_queue',
    });
    return false;
  }
}
