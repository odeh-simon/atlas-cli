import type initSqlJs from "sql.js";

export type SqlDatabase = initSqlJs.Database;
type SqlValue = initSqlJs.SqlValue;

export function queryAll(db: SqlDatabase, sql: string, params: readonly SqlValue[] = []): Record<string, SqlValue>[] {
  const statement = db.prepare(sql);
  const rows: Record<string, SqlValue>[] = [];

  try {
    statement.bind([...params]);
    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
  } finally {
    statement.free();
  }

  return rows;
}

export function queryOne(
  db: SqlDatabase,
  sql: string,
  params: readonly SqlValue[] = []
): Record<string, SqlValue> | undefined {
  return queryAll(db, sql, params)[0];
}

export function requiredString(row: Record<string, SqlValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new TypeError(`Expected ${key} to be a string`);
  }

  return value;
}

export function optionalString(row: Record<string, SqlValue>, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new TypeError(`Expected ${key} to be a string when present`);
  }

  return value;
}

export function requiredNumber(row: Record<string, SqlValue>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new TypeError(`Expected ${key} to be a number`);
  }

  return value;
}
