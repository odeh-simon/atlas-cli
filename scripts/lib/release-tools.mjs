import { spawnSync } from "node:child_process";
import { posix, win32 } from "node:path";

/** GNU tar treats `C:\...` as a remote host unless --force-local is set; bsdtar rejects the flag. */
export function tarFlagsForVersion(versionOutput) {
  return versionOutput.includes("GNU tar") ? ["--force-local"] : [];
}

let cachedTarFlags;

/** Flags for the tar on PATH, detected once per process. */
export function tarFlags() {
  if (cachedTarFlags === undefined) {
    const result = spawnSync("tar", ["--version"], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`tar --version failed (${result.status}): ${result.stderr}`);
    cachedTarFlags = tarFlagsForVersion(result.stdout);
  }
  return cachedTarFlags;
}

/**
 * Resolve how to run pnpm: the pnpm that launched this script, then corepack, then pnpm on PATH.
 * Returns a command and the arguments to put before pnpm's own.
 */
export function resolvePnpm({
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
  canRun = commandRuns
} = {}) {
  const npmExecPath = env.npm_execpath;
  if (npmExecPath) {
    const name = (platform === "win32" ? win32 : posix).basename(npmExecPath);
    if (/^pnpm\.[cm]?js$/i.test(name)) return { command: execPath, args: [npmExecPath] };
    // Standalone pnpm is a native executable, so Node cannot load it as a script.
    if (/^pnpm(\.exe)?$/i.test(name)) return { command: npmExecPath, args: [] };
  }
  const suffix = platform === "win32" ? ".cmd" : "";
  const corepack = { command: `corepack${suffix}`, args: ["pnpm"] };
  if (canRun(corepack.command, [...corepack.args, "--version"])) return corepack;
  return { command: `pnpm${suffix}`, args: [] };
}

let cachedPnpm;

/** Run pnpm with inherited output and throw if it fails. */
export function runPnpm(args, cwd) {
  cachedPnpm ??= resolvePnpm();
  const fullArgs = [...cachedPnpm.args, ...args];
  const result = spawn(cachedPnpm.command, fullArgs, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed with exit code ${result.status}`);
}

function commandRuns(command, args) {
  const result = spawn(command, args, { stdio: "ignore" });
  return result.error === undefined && result.status === 0;
}

// Node cannot spawn .cmd files directly on Windows, so run them through cmd.exe.
function spawn(command, args, options) {
  return process.platform === "win32" && command.endsWith(".cmd")
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], options)
    : spawnSync(command, args, options);
}
