import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/**
 * Load .env regardless of which directory the process was started from.
 *
 * `dotenv/config` resolves .env against process.cwd(). npm workspace scripts run
 * with cwd set to the workspace directory, so `npm run eval` from the repo root
 * looks for server/.env — while .env.example, and the README instruction to copy
 * it, both live at the repo root. The file is right there and dotenv never sees it.
 *
 * The failure is quiet and misleading: the SDK reports "could not resolve
 * authentication method", which reads like a missing key rather than a path bug.
 *
 * Resolving from this module's own location instead of cwd makes it work from
 * either directory. Root wins if both exist — with an array, the first file to
 * define a key owns it.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const workspaceRoot = path.resolve(here, "..");

dotenv.config({
  path: [path.join(repoRoot, ".env"), path.join(workspaceRoot, ".env")],
  quiet: true,
});
