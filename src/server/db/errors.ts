export class DatabaseUnavailableError extends Error {
  public constructor(cause: unknown) {
    super('The database is unavailable.', { cause });
    this.name = 'DatabaseUnavailableError';
  }
}

export class MigrationChecksumMismatchError extends Error {
  public constructor(filename: string) {
    super(`Applied migration checksum does not match: ${filename}`);
    this.name = 'MigrationChecksumMismatchError';
  }
}
