import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";

const config = loadConfig();
const pool = createPool(String(config.DATABASE_URL));
const here = path.dirname(fileURLToPath(import.meta.url));
const sql = await fs.readFile(path.join(here, "migrations", "001_initial.sql"), "utf8");
await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
await pool.query(sql);
await pool.end();
console.log("Billing database migration complete");
