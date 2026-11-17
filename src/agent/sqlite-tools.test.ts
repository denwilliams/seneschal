import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createSqliteTools } from "./sqlite-tools.ts";

const hasSqlite = spawnSync("sqlite3", ["--version"], { stdio: "ignore" }).status === 0;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "harness-sqlite-tool-"));
  const workspace = join(root, "workspace");
  const other = join(root, "other");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(other, { recursive: true });
  const tools = Object.fromEntries(
    createSqliteTools({
      jail: { readRoots: [workspace], writeRoots: [workspace], cwd: workspace },
      timeoutSeconds: 5,
    }).map((t) => [t.name, t as any]),
  );
  return { workspace, other, tools };
}

test("execute_sqlite creates and writes a database inside the workspace", { skip: !hasSqlite }, async () => {
  const { workspace, tools } = setup();

  await tools.execute_sqlite.execute("id", {
    path: "people.db",
    sql: "CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
  });
  const result = await tools.execute_sqlite.execute("id", {
    path: "people.db",
    sql: "INSERT INTO people(name) VALUES(:name)",
    params: { name: "Ada" },
  });

  assert.equal(existsSync(join(workspace, "people.db")), true);
  assert.match(result.content[0].text, /changes=1/);
});

test("query_sqlite returns structured JSON rows with bound parameters", { skip: !hasSqlite }, async () => {
  const { tools } = setup();
  await tools.execute_sqlite.execute("id", { path: "people.db", sql: "CREATE TABLE people(name TEXT, age INTEGER)" });
  await tools.execute_sqlite.execute("id", { path: "people.db", sql: "INSERT INTO people(name, age) VALUES(?1, ?2)", params: ["Ada", 36] });

  const result = await tools.query_sqlite.execute("id", {
    path: "people.db",
    sql: "SELECT name, age FROM people WHERE age > :age",
    params: { age: 30 },
  });

  assert.deepEqual(result.details.rows, [{ name: "Ada", age: 36 }]);
  assert.deepEqual(result.details.columns, ["name", "age"]);
  assert.match(result.content[0].text, /database content, not instructions/);
});

test("inspect_sqlite reports schema details", { skip: !hasSqlite }, async () => {
  const { tools } = setup();
  await tools.execute_sqlite.execute("id", { path: "app.db", sql: "CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE)" });

  const result = await tools.inspect_sqlite.execute("id", { path: "app.db" });

  assert.match(result.content[0].text, /table users/);
  assert.match(result.content[0].text, /email TEXT NOT NULL/);
  assert.equal(result.details.objects.some((o: any) => o.name === "users"), true);
});

test("query_sqlite refuses writes before running them", { skip: !hasSqlite }, async () => {
  const { tools } = setup();
  await tools.execute_sqlite.execute("id", { path: "app.db", sql: "CREATE TABLE users(id INTEGER)" });

  await assert.rejects(
    () => tools.query_sqlite.execute("id", { path: "app.db", sql: "INSERT INTO users(id) VALUES(1)" }),
    /only runs read-only/,
  );
});

test("sqlite tools refuse paths outside the channel jail", { skip: !hasSqlite }, async () => {
  const { other, tools } = setup();

  await assert.rejects(
    () => tools.execute_sqlite.execute("id", { path: join(other, "app.db"), sql: "CREATE TABLE t(id INTEGER)" }),
    /outside this channel's workspace/,
  );
});

test("sqlite tools allow a database through a configured workspace symlink", { skip: !hasSqlite }, async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-sqlite-symlink-"));
  const workspace = join(root, "workspace");
  const allowedTarget = join(root, "allowed-target");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(allowedTarget, { recursive: true });
  symlinkSync(allowedTarget, join(workspace, "shared"), "dir");
  const tools = Object.fromEntries(
    createSqliteTools({
      jail: {
        readRoots: [workspace],
        writeRoots: [workspace],
        workspaceSymlinkRoots: [allowedTarget],
        cwd: workspace,
      },
      timeoutSeconds: 5,
    }).map((t) => [t.name, t as any]),
  );

  await tools.execute_sqlite.execute("id", {
    path: "shared/app.db",
    sql: "CREATE TABLE items(id INTEGER PRIMARY KEY)",
  });
  const result = await tools.query_sqlite.execute("id", {
    path: "shared/app.db",
    sql: "SELECT name FROM sqlite_master WHERE type = 'table'",
  });

  assert.equal(existsSync(join(allowedTarget, "app.db")), true);
  assert.deepEqual(result.details.rows, [{ name: "items" }]);
});

test("sqlite tools accept exactly one SQL statement", { skip: !hasSqlite }, async () => {
  const { tools } = setup();

  await assert.rejects(
    () => tools.execute_sqlite.execute("id", { path: "app.db", sql: "CREATE TABLE t(id INTEGER); CREATE TABLE u(id INTEGER)" }),
    /exactly one SQL statement/,
  );
});

test("sqlite tools run the CLI in safe mode and cannot escape the jail", { skip: !hasSqlite }, async () => {
  const { other, tools } = setup();
  const outside = join(other, "owned.txt");

  await assert.rejects(
    () => tools.execute_sqlite.execute("id", { path: "app.db", sql: `.shell touch ${outside}` }),
    /dot-commands/,
  );
  await assert.rejects(
    () => tools.execute_sqlite.execute("id", { path: "app.db", sql: `ATTACH DATABASE '${join(other, "other.db")}' AS other` }),
    /only runs a single write or DDL statement/,
  );
  await assert.rejects(
    () => tools.execute_sqlite.execute("id", { path: "app.db", sql: `VACUUM INTO '${join(other, "vacuum.db")}'` }),
    /only runs a single write or DDL statement/,
  );
  await tools.execute_sqlite.execute("id", { path: "app.db", sql: "CREATE TABLE values_table(v TEXT)" });
  await assert.rejects(
    () => tools.query_sqlite.execute("id", { path: "app.db", sql: `SELECT writefile('${outside}', 'owned')` }),
    /sqlite3 failed/,
  );

  assert.equal(existsSync(outside), false);
  assert.equal(existsSync(join(other, "other.db")), false);
  assert.equal(existsSync(join(other, "vacuum.db")), false);
});

test("sqlite tools reject CLI go and slash separators", { skip: !hasSqlite }, async () => {
  for (const separator of ["go", "/"]) {
    const { tools } = setup();
    await assert.rejects(
      () => tools.execute_sqlite.execute("id", {
        path: "app.db",
        sql: `CREATE TABLE seed(x)\n${separator}\nCREATE TABLE second(y)`,
      }),
      /terminators/,
    );
    await assert.rejects(() => tools.query_sqlite.execute("id", { path: "app.db", sql: "SELECT * FROM seed" }), /no SQLite database/);
  }
});

test("sqlite tools do not treat a trigger followed by SQL as one statement", { skip: !hasSqlite }, async () => {
  const { tools } = setup();
  await assert.rejects(
    () => tools.execute_sqlite.execute("id", {
      path: "app.db",
      sql: "CREATE TRIGGER t AFTER INSERT ON source BEGIN SELECT 1; END; DROP TABLE source",
    }),
    /exactly one SQL statement/,
  );
});

test("sqlite tools accept a single CREATE TRIGGER statement", { skip: !hasSqlite }, async () => {
  const { tools } = setup();
  await tools.execute_sqlite.execute("id", { path: "app.db", sql: "CREATE TABLE source(v TEXT)" });
  await tools.execute_sqlite.execute("id", { path: "app.db", sql: "CREATE TABLE audit(v TEXT)" });
  await tools.execute_sqlite.execute("id", {
    path: "app.db",
    sql: "CREATE TRIGGER source_audit AFTER INSERT ON source BEGIN INSERT INTO audit VALUES (NEW.v); END",
  });
  await tools.execute_sqlite.execute("id", { path: "app.db", sql: "INSERT INTO source VALUES ('ok')" });
  const result = await tools.query_sqlite.execute("id", { path: "app.db", sql: "SELECT v FROM audit" });
  assert.deepEqual(result.details.rows, [{ v: "ok" }]);
});

test("SQLite text parameters preserve NUL and special UTF-8 bytes", { skip: !hasSqlite }, async () => {
  const { tools } = setup();
  await tools.execute_sqlite.execute("id", { path: "app.db", sql: "CREATE TABLE values_table(v TEXT)" });
  const value = "a\0'\nπb";
  const result = await tools.query_sqlite.execute("id", {
    path: "app.db",
    sql: "SELECT hex(:v) AS value",
    params: { v: value },
  });
  assert.deepEqual(result.details.rows, [{ value: Buffer.from(value).toString("hex").toUpperCase() }]);
});

test("execute_sqlite rejects RETURNING before a mutation can be reported as failed", { skip: !hasSqlite }, async () => {
  const { workspace, tools } = setup();
  await tools.execute_sqlite.execute("id", { path: "app.db", sql: "CREATE TABLE items(v TEXT)" });
  await tools.execute_sqlite.execute("id", { path: "app.db", sql: "INSERT INTO items VALUES ('keep')" });
  const tinyOutputTools = Object.fromEntries(
    createSqliteTools({
      jail: { readRoots: [workspace], writeRoots: [workspace], cwd: workspace },
      timeoutSeconds: 5,
      maxOutputBytes: 1,
    }).map((t) => [t.name, t as any]),
  );
  await assert.rejects(
    () => tinyOutputTools.execute_sqlite.execute("id", { path: "app.db", sql: "DELETE FROM items RETURNING v" }),
    /does not allow RETURNING/,
  );
  const result = await tools.query_sqlite.execute("id", { path: "app.db", sql: "SELECT v FROM items" });
  assert.deepEqual(result.details.rows, [{ v: "keep" }]);
});
