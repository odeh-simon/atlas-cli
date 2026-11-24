import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tarFlags } from "./lib/release-tools.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = resolve(readOption("--release-dir") ?? join(workspaceRoot, "release"));
const archivePath = resolve(readOption("--archive") ?? latestArchive(releaseDirectory));
const checksumPath = `${archivePath}.sha256`;
const temporaryRoot = mkdtempSync(join(tmpdir(), "sigil-release-smoke-"));
const repositoryRoot = join(temporaryRoot, "repo");
const sigilHome = join(temporaryRoot, "home");

assertSupportedRuntime();
verifyChecksum(archivePath, checksumPath);

try {
  const extractArgs = [...tarFlags(), "-xzf", archivePath.replace(/\\/g, "/"), "-C", temporaryRoot.replace(/\\/g, "/")];
  run("tar", extractArgs, workspaceRoot);
  const cliPath = join(temporaryRoot, "dist", "index.js");
  if (!existsSync(cliPath)) throw new Error("Release archive does not contain dist/index.js");
  mkdirSync(repositoryRoot, { recursive: true });

  const version = run(process.execPath, [cliPath, "--version"], temporaryRoot);
  const help = run(process.execPath, [cliPath, "--help"], temporaryRoot);
  const doctor = run(process.execPath, [cliPath, "doctor"], repositoryRoot, { SIGIL_HOME: sigilHome });
  const status = run(process.execPath, [cliPath, "status"], repositoryRoot, { SIGIL_HOME: sigilHome });

  if (!/^\d+\.\d+\.\d+/.test(version.trim())) throw new Error(`Unexpected Sigil version output: ${version.trim()}`);
  if (!help.includes("Usage:")) throw new Error("Sigil help output is incomplete");
  if (!doctor.includes("Doctor: passed")) throw new Error("Sigil doctor did not pass from the extracted release");
  if (!status.includes("No Sigil session found")) throw new Error("Sigil status smoke output is incomplete");

  console.log(`Release smoke passed: ${basename(archivePath)}`);
  console.log(`Sigil version: ${version.trim()}`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function latestArchive(directory) {
  const archive = readdirSync(directory)
    .filter((name) => /^sigil-cli-.+\.tgz$/.test(name))
    .sort()
    .at(-1);
  if (archive === undefined) throw new Error(`No Sigil release archive found under ${directory}`);
  return join(directory, archive);
}

function verifyChecksum(archive, checksumFile) {
  if (!existsSync(checksumFile)) throw new Error(`Checksum file is missing: ${checksumFile}`);
  const expected = readFileSync(checksumFile, "utf8").trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (expected !== actual) throw new Error(`Release checksum mismatch for ${archive}`);
}

function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function assertSupportedRuntime() {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`Sigil release smoke tests require Node.js 22 or newer; current runtime is ${process.versions.node}`);
  }
}
