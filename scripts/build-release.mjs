import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPnpm, tarFlags } from "./lib/release-tools.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, "..");
const cliPackagePath = join(workspaceRoot, "packages", "cli", "package.json");
const cliPackage = JSON.parse(readFileSync(cliPackagePath, "utf8"));
const version = process.env.SIGIL_RELEASE_VERSION ?? cliPackage.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Sigil release version is invalid: ${String(version)}`);
}
const outputDirectory = resolve(readOption("--output") ?? join(workspaceRoot, "release"));
const temporaryRoot = mkdtempSync(join(tmpdir(), "sigil-release-"));
const stageDirectory = join(temporaryRoot, `sigil-cli-${version}`);
const archivePath = join(outputDirectory, `sigil-cli-${version}.tgz`);
const checksumPath = `${archivePath}.sha256`;

assertSupportedRuntime();

try {
  if (!process.argv.includes("--skip-build")) runPnpm(["build"], workspaceRoot);
  runPnpm(
    ["--config.node-linker=hoisted", "--filter", "@sigil/cli", "deploy", stageDirectory, "--prod"],
    workspaceRoot
  );

  const deployedPackagePath = join(stageDirectory, "package.json");
  const deployedPackage = JSON.parse(readFileSync(deployedPackagePath, "utf8"));
  writeFileSync(
    deployedPackagePath,
    `${JSON.stringify(
      {
        ...deployedPackage,
        version,
        private: true,
        sigilDistribution: "portable",
        scripts: undefined,
        devDependencies: undefined
      },
      null,
      2
    )}\n`
  );
  writeFileSync(join(stageDirectory, "sigil.cmd"), '@echo off\r\nnode "%~dp0dist\\index.js" %*\r\n');
  const unixLauncher = join(stageDirectory, "sigil");
  writeFileSync(unixLauncher, '#!/usr/bin/env sh\nexec node "$(dirname "$0")/dist/index.js" "$@"\n');
  chmodSync(unixLauncher, 0o755);
  copyFileSync(
    join(workspaceRoot, "DOCs", "Sigil_CLI_Install_and_Release.md"),
    join(stageDirectory, "INSTALL.md")
  );

  mkdirSync(outputDirectory, { recursive: true });
  rmSync(archivePath, { force: true });
  rmSync(checksumPath, { force: true });
  const tarArgs = [...tarFlags(), "-czf", archivePath.replace(/\\/g, "/"), "-C", stageDirectory.replace(/\\/g, "/"), "."];
  run("tar", tarArgs, workspaceRoot);
  const checksum = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  writeFileSync(checksumPath, `${checksum}  ${basename(archivePath)}\n`);

  console.log(`Release archive: ${archivePath}`);
  console.log(`SHA-256: ${checksum}`);
  console.log(`Checksum file: ${checksumPath}`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
}

function assertSupportedRuntime() {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`Sigil release builds require Node.js 22 or newer; current runtime is ${process.versions.node}`);
  }
}
