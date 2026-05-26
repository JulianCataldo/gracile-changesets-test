#!/usr/bin/env tsx

/*------------------------------------------------------------------------------

Changesets release orchestrator — runs in CI on pushes to `main` / `next`.

Flow:
1. Detect current branch; exit early if it is not a release branch.
2. Exit early when no pending changeset files exist (unless --phase=publish).
3. prepare phase
    a. Configure git user from GITHUB_ACTOR.
    b. Enter / exit Changesets pre-mode depending on the branch.
    c. Run `changeset version` to bump versions and consume changeset files.
    d. Validate: stable branch must have no prerelease versions;
      next branch must have only `-<preTag>.N` versions on changed packages.
    e. Commit the version bumps.
4. publish phase
    a. Run `changeset publish` (with `--tag <preTag>` on the next branch).
    b. Retry once on failure to recover partially published packages.
    c. Push the commit and tags to origin.
    d. On stable branch, merge main back into next (--no-ff).

CLI flags (all optional):
  --dry-run            Print mutating commands without executing them.
  --phase              all (default) | prepare | publish
  --pre-tag            Dist-tag for prerelease publishes (default: "next").
  --stable-branch      Default: "main".
  --next-branch        Default: "next".
  --skip-merge-back    Skip the main→next merge after a stable release.

------------------------------------------------------------------------------*/

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    "dry-run": { type: "boolean" },
    phase: { type: "string" },
    "pre-tag": { type: "string" },
    "skip-merge-back": { type: "boolean" },
    "stable-branch": { type: "string" },
    "next-branch": { type: "string" },
  },
});

const cwd = process.cwd();
const dryRun = args["dry-run"] ?? false;
const phase = args.phase ?? "all";
const stableBranch = args["stable-branch"] ?? "main";
const nextBranch = args["next-branch"] ?? "next";
const preTag = args["pre-tag"] ?? "next";
const skipMergeBack = args["skip-merge-back"] ?? false;

const supportedPhases = new Set(["all", "prepare", "publish"]);
if (!supportedPhases.has(phase)) {
  fail(`Unsupported --phase=${phase}. Expected all, prepare, or publish.`);
}

const branch = getBranch();
const isStable = branch === stableBranch;
const isNext = branch === nextBranch;

if (!isStable && !isNext) {
  log(
    `Branch ${branch} is not ${stableBranch} or ${nextBranch}; skipping release.`,
  );
  process.exit(0);
}

const pendingChangesets = hasPendingChangesets();
if (!pendingChangesets && phase !== "publish") {
  log("No pending changesets; skipping release.");
  process.exit(0);
}

if (phase === "all" || phase === "prepare") {
  prepareRelease();
}

if (phase === "all" || phase === "publish") {
  publishRelease();
}

// ---------------------------------------------------------------------------

function prepareRelease(): void {
  configureGitUser();

  if (isNext) {
    enterPreModeIfNeeded();
  }

  if (isStable) {
    exitPreModeIfNeeded();
  }

  run("pnpm", ["changeset", "version"], { env: githubEnv() });

  if (isStable) {
    validateStableRelease();
  }

  if (isNext) {
    validateNextRelease();
  }

  commitVersionBumps();
}

function publishRelease(): void {
  const publishArgs = ["changeset", "publish"];
  if (isNext) {
    publishArgs.push("--tag", preTag);
  }

  try {
    run("pnpm", publishArgs, { env: publishEnv() });
  } catch {
    warn(
      "Publish failed; retrying once to recover partially published packages.",
    );
    run("pnpm", publishArgs, { env: publishEnv() });
  }

  run("git", ["push", "origin", `HEAD:${branch}`]);
  run("git", ["push", "--tags"]);

  if (isStable && !skipMergeBack) {
    mergeBackMainIntoNext();
  }
}

function configureGitUser(): void {
  const actor =
    process.env.GITHUB_ACTOR || process.env.USER || "github-actions";
  run("git", ["config", "--global", "user.name", actor]);
  run("git", [
    "config",
    "--global",
    "user.email",
    `${actor}@users.noreply.github.com`,
  ]);
}

function enterPreModeIfNeeded(): void {
  const preJson = path.join(cwd, ".changeset", "pre.json");
  if (existsSync(preJson)) {
    log(`Already in Changesets pre mode for ${preTag}.`);
    return;
  }

  run("pnpm", ["changeset", "pre", "enter", preTag]);
}

function exitPreModeIfNeeded(): void {
  const preJson = path.join(cwd, ".changeset", "pre.json");
  if (!existsSync(preJson)) {
    log("Not in Changesets pre mode.");
    return;
  }

  run("pnpm", ["changeset", "pre", "exit"]);
}

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
}

interface PackageEntry {
  file: string;
  packageJson: PackageJson;
}

function validateStableRelease(): void {
  const preJson = path.join(cwd, ".changeset", "pre.json");
  if (existsSync(preJson)) {
    fail(
      ".changeset/pre.json is still present on the stable branch after versioning.",
    );
  }

  const badPackages = readPackageJsonFiles()
    .filter(({ packageJson }) => typeof packageJson.version === "string")
    .filter(({ packageJson }) => packageJson.version!.includes("-"));

  if (badPackages.length > 0) {
    for (const { file, packageJson } of badPackages) {
      error(
        `${packageJson.name} has prerelease version ${packageJson.version} in ${file}.`,
      );
    }
    fail("Stable release validation failed.");
  }
}

function validateNextRelease(): void {
  const badPackages = changedPackageJsonFiles()
    .filter(({ packageJson }) => packageJson.private !== true)
    .filter(({ packageJson }) => typeof packageJson.version === "string")
    .filter(({ packageJson }) => !packageJson.version!.includes(`-${preTag}.`));

  if (badPackages.length > 0) {
    for (const { file, packageJson } of badPackages) {
      error(
        `${packageJson.name} has non-${preTag} version ${packageJson.version} in ${file}.`,
      );
    }
    fail(`Prerelease validation failed for ${nextBranch}.`);
  }
}

function commitVersionBumps(): void {
  run("git", ["add", "-A"]);

  const diff = run("git", ["diff", "--cached", "--quiet"], {
    check: false,
    stdio: "pipe",
  });

  if (diff.status === 0) {
    log("No version changes to commit.");
    return;
  }

  const message = isNext
    ? `Version packages [${preTag}] [skip ci]`
    : "Version packages [skip ci]";

  run("git", ["commit", "-m", message]);
}

function mergeBackMainIntoNext(): void {
  try {
    run("git", ["fetch", "origin", nextBranch]);
    run("git", ["checkout", "-B", nextBranch, `origin/${nextBranch}`]);
    run("git", [
      "merge",
      stableBranch,
      "--no-ff",
      "-m",
      `Auto-merge ${stableBranch} into ${nextBranch} [skip ci]`,
    ]);
    run("git", ["push", "origin", nextBranch]);
  } catch {
    warn(
      `Could not merge ${stableBranch} back into ${nextBranch}. Resolve manually if needed.`,
    );
  }
}

function hasPendingChangesets(): boolean {
  const changesetDir = path.join(cwd, ".changeset");
  if (!existsSync(changesetDir)) {
    return false;
  }

  return readdirSync(changesetDir).some(
    (file) => file.endsWith(".md") && file !== "README.md",
  );
}

function changedPackageJsonFiles(): PackageEntry[] {
  const packageJsonFiles = collectPackageJsonFiles(path.join(cwd, "packages"));
  if (packageJsonFiles.length === 0) {
    return [];
  }

  const output = run(
    "git",
    ["diff", "--name-only", "--", ...packageJsonFiles],
    { stdio: "pipe" },
  ).stdout;

  return (output ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(readPackageJsonFile);
}

function readPackageJsonFiles(): PackageEntry[] {
  return collectPackageJsonFiles(path.join(cwd, "packages")).map(
    readPackageJsonFile,
  );
}

function collectPackageJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectPackageJsonFiles(fullPath));
    } else if (entry.name === "package.json") {
      files.push(path.relative(cwd, fullPath));
    }
  }

  return files;
}

function readPackageJsonFile(file: string): PackageEntry {
  return {
    file,
    packageJson: JSON.parse(
      readFileSync(path.join(cwd, file), "utf8"),
    ) as PackageJson,
  };
}

function getBranch(): string {
  if (process.env.GITHUB_REF_NAME) {
    return process.env.GITHUB_REF_NAME;
  }

  const output =
    run("git", ["branch", "--show-current"], {
      stdio: "pipe",
    }).stdout?.trim() ?? "";

  if (!output) {
    fail("Could not determine current branch.");
  }

  return output;
}

function githubEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  };
}

function publishEnv(): NodeJS.ProcessEnv {
  return {
    ...githubEnv(),
    GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "",
    NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN || "",
    NPM_CONFIG_PROVENANCE: process.env.NPM_CONFIG_PROVENANCE || "true",
  };
}

interface RunOptions {
  env?: NodeJS.ProcessEnv;
  check?: boolean;
  stdio?: "inherit" | "pipe";
}

function run(
  command: string,
  commandArgs: string[],
  options: RunOptions = {},
): SpawnSyncReturns<string> {
  const printable = [command, ...commandArgs].join(" ");
  if (dryRun && isMutatingCommand(command, commandArgs)) {
    log(`[dry-run] ${printable}`);
    return {
      status: 0,
      stdout: "",
      stderr: "",
      pid: 0,
      signal: null,
      output: [],
    };
  }

  log(`$ ${printable}`);
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: false,
    stdio: options.stdio ?? "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (options.check === false) {
    return result;
  }

  if (result.status !== 0) {
    throw new Error(`${printable} exited with status ${result.status}`);
  }

  return result;
}

function isMutatingCommand(command: string, commandArgs: string[]): boolean {
  const commandText = [command, ...commandArgs].join(" ");
  return /(^| )(add|commit|push|checkout|merge|fetch|changeset pre|changeset version|changeset publish)( |$)/.test(
    commandText,
  );
}

function log(message: string): void {
  console.log(`[release] ${message}`);
}

function warn(message: string): void {
  console.warn(`::warning::${message}`);
}

function error(message: string): void {
  console.error(`::error::${message}`);
}

function fail(message: string): never {
  error(message);
  process.exit(1);
}
