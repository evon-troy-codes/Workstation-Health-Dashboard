// sql.js — one small interface over SQLite, so the store is written once for
// both ways the server runs:
//
//   run(sql, params)   → nothing          (INSERT, UPDATE, DELETE, CREATE)
//   first(sql, params) → one row or null
//   all(sql, params)   → an array of rows
//
// Every method is async; parameters are positional (?).

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
  };
}

// node:sqlite's DatabaseSync (the Docker server, and the tests).
function nodeSql(db) {
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
  };
}

export { d1Sql, nodeSql };
