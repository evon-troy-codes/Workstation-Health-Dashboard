// sql.js — one small interface over SQLite, so the store is written once for
// both ways the server runs:
//
//   run(sql, params)   → nothing          (INSERT, UPDATE, DELETE, CREATE)
//   first(sql, params) → one row or null
//   all(sql, params)   → an array of rows
//   batch([[sql, params], …]) → nothing, all or none (one transaction)
//
// Every method is async; parameters are positional (?). Foreign keys are
// enforced on both: D1 always enforces them, so node:sqlite is told to.

// Cloudflare D1 (env.DB in the Worker).
function d1Sql(db) {
  return {
    async run(sql, params = []) {
      await db.prepare(sql).bind(...params).run();
    },
    async first(sql, params = []) {
      return (await db.prepare(sql).bind(...params).first()) ?? null;
    },
    async all(sql, params = []) {
      return (await db.prepare(sql).bind(...params).all()).results ?? [];
    },
    async batch(statements) {
      await db.batch(statements.map(([sql, params = []]) => db.prepare(sql).bind(...params)));
    },
  };
}

// node:sqlite's DatabaseSync (the Docker server, and the tests).
function nodeSql(db) {
  db.exec("PRAGMA foreign_keys = ON");
  return {
    async run(sql, params = []) {
      db.prepare(sql).run(...params);
    },
    async first(sql, params = []) {
      return db.prepare(sql).get(...params) ?? null;
    },
    async all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    // Synchronous inside, so no other request's queries run in between.
    async batch(statements) {
      db.exec("BEGIN");
      try {
        for (const [sql, params = []] of statements) db.prepare(sql).run(...params);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

export { d1Sql, nodeSql };
