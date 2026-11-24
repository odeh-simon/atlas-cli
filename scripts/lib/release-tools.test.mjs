import { describe, expect, it, vi } from "vitest";
import { resolvePnpm, tarFlagsForVersion } from "./release-tools.mjs";

describe("tarFlagsForVersion", () => {
  it.each([
    ["GNU tar", "tar (GNU tar) 1.35\nCopyright (C) 2023 Free Software Foundation, Inc.", ["--force-local"]],
    ["macOS bsdtar", "bsdtar 3.5.3 - libarchive 3.7.4 zlib/1.2.12 liblzma/5.4.3 bz2lib/1.0.8", []],
    ["Windows bsdtar", "bsdtar 3.7.2 - libarchive 3.7.2 zlib/1.2.5.f-ipp", []],
    ["BusyBox tar", "tar (busybox) 1.36.1", []],
    ["empty output", "", []]
  ])("selects flags for %s", (_name, output, expected) => {
    expect(tarFlagsForVersion(output)).toEqual(expected);
  });
});

describe("resolvePnpm", () => {
  const base = { execPath: "/node", platform: "darwin" };

  it.each([
    ["darwin", "/cache/corepack/v1/pnpm/9.15.0/bin/pnpm.cjs"],
    ["linux", "/usr/lib/node_modules/pnpm/bin/pnpm.mjs"],
    ["win32", "C:\\Program Files\\pnpm\\bin\\pnpm.cjs"]
  ])("runs the launching pnpm script with Node on %s", (platform, npmExecPath) => {
    const canRun = vi.fn();
    expect(resolvePnpm({ ...base, platform, env: { npm_execpath: npmExecPath }, canRun })).toEqual({
      command: "/node",
      args: [npmExecPath]
    });
    expect(canRun).not.toHaveBeenCalled();
  });

  it.each([
    ["darwin", "/opt/pnpm/pnpm"],
    ["win32", "C:\\pnpm\\pnpm.exe"]
  ])("runs a standalone pnpm executable directly on %s", (platform, npmExecPath) => {
    expect(resolvePnpm({ ...base, platform, env: { npm_execpath: npmExecPath }, canRun: () => false })).toEqual({
      command: npmExecPath,
      args: []
    });
  });

  it.each([
    ["is unset", {}],
    ["is empty", { npm_execpath: "" }],
    ["points to npm", { npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js" }],
    ["only has pnpm in a parent folder", { npm_execpath: "/opt/pnpm/lib/npm-cli.js" }]
  ])("falls back to corepack when npm_execpath %s", (_name, env) => {
    const canRun = vi.fn(() => true);
    expect(resolvePnpm({ ...base, env, canRun })).toEqual({ command: "corepack", args: ["pnpm"] });
    expect(canRun).toHaveBeenCalledWith("corepack", ["pnpm", "--version"]);
  });

  it("falls back to pnpm on PATH when corepack is unavailable", () => {
    expect(resolvePnpm({ ...base, env: {}, canRun: () => false })).toEqual({ command: "pnpm", args: [] });
  });

  it("uses .cmd launchers on Windows", () => {
    const options = { ...base, platform: "win32", env: {} };
    expect(resolvePnpm({ ...options, canRun: () => true })).toEqual({ command: "corepack.cmd", args: ["pnpm"] });
    expect(resolvePnpm({ ...options, canRun: () => false })).toEqual({ command: "pnpm.cmd", args: [] });
  });
});
