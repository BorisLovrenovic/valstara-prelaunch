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
