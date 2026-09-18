import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "..", "..", "migrations");

async function ensureMigrationsTable() {
  await pool.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

async function run() {
  await ensureMigrationsTable();
  const applied = new Set(
    (await pool.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name)
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip (already applied): ${file}`);
      continue;
    }
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    console.log(`applying: ${file}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
      await client.query("COMMIT");
      console.log(`applied: ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`failed: ${file}`, err);
      process.exitCode = 1;
      break;
    } finally {
      client.release();
    }
  }

  await pool.end();
}

run();
