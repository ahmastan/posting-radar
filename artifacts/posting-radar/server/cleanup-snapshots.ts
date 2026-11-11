import { pool } from "./db.js";
import { cleanupDuplicateSnapshots } from "./snapshot-cleanup.js";

try {
  const args = process.argv.slice(2);
  const dryRun = args.length === 0 || (args.length === 1 && args[0] === "--dry-run");
  const apply = args.length === 4 && args[0] === "--approve" && args[2] === "--approved-by";
  if (!dryRun && !apply) throw new Error("Usage: snapshots:cleanup [--dry-run | --approve <reviewed-plan-hash> --approved-by <name>]");
  const result = await cleanupDuplicateSnapshots(apply ? { planHash: args[1], approvedBy: args[3] } : undefined);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Cleanup failed.");
  process.exitCode = 1;
} finally { await pool.end(); }
