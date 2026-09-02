import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createApp } from "./app.js";

const config = loadConfig();
const db = createPool(String(config.DATABASE_URL));
await db.query("SELECT 1");
const app = createApp(config, db);
const server = app.listen(Number(config.PORT), "127.0.0.1", () => {
  console.log(`EquiProfile Billing listening on ${config.PORT}`);
});

async function shutdown() {
  server.close(async () => { await db.end(); process.exit(0); });
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
