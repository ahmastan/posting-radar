import pg from "pg";
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 12, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
export type Db = Pick<pg.PoolClient, "query">;
export async function transaction<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { db.release(); }
}
