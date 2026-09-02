import pg from "pg";

const { Pool } = pg;

export function createPool(connectionString: string) {
  return new Pool({ connectionString, max: 12, idleTimeoutMillis: 30_000 });
}

export type Database = ReturnType<typeof createPool>;
