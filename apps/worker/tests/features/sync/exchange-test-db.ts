import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
function expandNumberedParams(sql: string, values: unknown[]) {
  const expanded: unknown[] = [];
  const rewritten = sql.replace(/\?(\d+)/g, (_, index) => {
    expanded.push(values[Number(index) - 1]);
    return "?";
  });
  return expanded.length > 0
    ? { sql: rewritten, values: expanded }
    : { sql, values };
}

class SqliteStatement {
  private values: unknown[] = [];

  constructor(
    private readonly owner: SqliteD1,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async run() {
    return this.execute();
  }

  async all<T>() {
    return this.execute() as unknown as { results: T[] };
  }

  async raw() {
    this.owner.executedSql.push(this.sql);
    const query = expandNumberedParams(this.sql, this.values);
    return (
      this.owner.database
        .prepare(query.sql)
        .all(...(query.values as never[])) as Record<string, unknown>[]
    ).map((row) => Object.values(row));
  }

  async first<T>() {
    this.owner.executedSql.push(this.sql);
    const query = expandNumberedParams(this.sql, this.values);
    return (
      (this.owner.database
        .prepare(query.sql)
        .get(...(query.values as never[])) as T) ?? null
    );
  }

  execute() {
    this.owner.executedSql.push(this.sql);
    const query = expandNumberedParams(this.sql, this.values);
    if (/^\s*(SELECT|WITH)\b/i.test(query.sql)) {
      return {
        success: true,
        meta: { changes: 0 },
        results: this.owner.database
          .prepare(query.sql)
          .all(...(query.values as never[])),
      };
    }
    const result = this.owner.database
      .prepare(query.sql)
      .run(...(query.values as never[]));
    return {
      success: true,
      meta: { changes: Number(result.changes) },
      results: [],
    };
  }
}

export class SqliteD1 {
  readonly database = new DatabaseSync(":memory:");
  readonly executedSql: string[] = [];

  constructor() {
    this.database.exec("PRAGMA foreign_keys = ON");
    const migrationsDirectory = fileURLToPath(
      new URL("../../../../../packages/db/migrations/", import.meta.url),
    );
    for (const file of readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      this.database.exec(
        readFileSync(`${migrationsDirectory}/${file}`, "utf8"),
      );
    }
  }

  prepare(sql: string) {
    return new SqliteStatement(this, sql);
  }

  async batch(statements: D1PreparedStatement[]) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) =>
        (statement as unknown as SqliteStatement).execute(),
      );
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}
