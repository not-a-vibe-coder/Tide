/**
 * npm run doctor [suiAddress] — checks every outside connection with your real keys.
 * The same check runs in Telegram with the admin-only /doctor command.
 */
import { runChecks } from "./checks.js";
import { loadConfig } from "./config.js";

const results = await runChecks(loadConfig(), { sui: process.argv[2], solana: process.argv[3] });
for (const r of results) console.log(`${r.ok ? "✔" : "✘"} ${r.name}: ${r.detail}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
