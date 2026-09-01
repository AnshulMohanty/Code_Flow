/**
 * The injected SQL seam (V3-P2).
 *
 * This package must not depend on `pg`. The same reasoning as V3-P0's `BudgetRedisLike`: a
 * library that imports a database driver forces every consumer to install one, drags a native
 * dependency into the pruned `node:20-slim` image, and makes the hermetic suite's job harder
 * for nothing. `SqlClientLike` is structurally satisfied by `pg.Pool` and `pg.Client` as they
 * already are — production passes a real pool, the tests pass a recording fake.
 *
 * Placeholders are `$1`-style (Postgres), because the only real backend behind this today is
 * Postgres and pretending otherwise would mean writing SQL that works nowhere.
 */
export interface SqlQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
}

export interface SqlClientLike {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<SqlQueryResult<Row>>;
}
