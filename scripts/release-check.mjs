import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPnpm } from "./lib/release-tools.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const script of ["check", "test", "release:bundle", "release:smoke"]) {
  runPnpm(["run", script], workspaceRoot);
}
