#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const cwd = process.cwd();
const dryRun = Boolean(args["dry-run"]);
const phase = String(args.phase ?? "all");
const stableBranch = String(args["stable-branch"] ?? "main");
const nextBranch = String(args["next-branch"] ?? "next");
const preTag = String(args["pre-tag"] ?? "next");
const skipMergeBack = Boolean(args["skip-merge-back"]);

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

function prepareRelease() {
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

function publishRelease() {
  const publishArgs = ["changeset", "publish"];
  if (isNext) {
    publishArgs.push("--tag", preTag);
  }

  try {
    run("pnpm", publishArgs, { env: publishEnv() });
  } catch (error) {
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

function configureGitUser() {
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

function enterPreModeIfNeeded() {
  const preJson = path.join(cwd, ".changeset", "pre.json");
  if (existsSync(preJson)) {
    log(`Already in Changesets pre mode for ${preTag}.`);
    return;
  }

  run("pnpm", ["changeset", "pre", "enter", preTag]);
}

function exitPreModeIfNeeded() {
  const preJson = path.join(cwd, ".changeset", "pre.json");
  if (!existsSync(preJson)) {
    log("Not in Changesets pre mode.");
    return;
  }

  run("pnpm", ["changeset", "pre", "exit"]);
}

function validateStableRelease() {
  const preJson = path.join(cwd, ".changeset", "pre.json");
  if (existsSync(preJson)) {
    fail(
      ".changeset/pre.json is still present on the stable branch after versioning.",
    );
  }

  const badPackages = readPackageJsonFiles()
    .filter(({ packageJson }) => typeof packageJson.version === "string")
    .filter(({ packageJson }) => packageJson.version.includes("-"));

  if (badPackages.length > 0) {
    for (const { file, packageJson } of badPackages) {
      error(
        `${packageJson.name} has prerelease version ${packageJson.version} in ${file}.`,
      );
    }
    fail("Stable release validation failed.");
  }
}

function validateNextRelease() {
  const badPackages = changedPackageJsonFiles()
    .filter(({ packageJson }) => packageJson.private !== true)
    .filter(({ packageJson }) => typeof packageJson.version === "string")
    .filter(({ packageJson }) => !packageJson.version.includes(`-${preTag}.`));

  if (badPackages.length > 0) {
    for (const { file, packageJson } of badPackages) {
      error(
        `${packageJson.name} has non-${preTag} version ${packageJson.version} in ${file}.`,
      );
    }
    fail(`Prerelease validation failed for ${nextBranch}.`);
  }
}

function commitVersionBumps() {
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

function mergeBackMainIntoNext() {
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
  } catch (error) {
    warn(
      `Could not merge ${stableBranch} back into ${nextBranch}. Resolve manually if needed.`,
    );
  }
}

function hasPendingChangesets() {
  const changesetDir = path.join(cwd, ".changeset");
  if (!existsSync(changesetDir)) {
    return false;
  }

  return readdirSync(changesetDir).some(
    (file) => file.endsWith(".md") && file !== "README.md",
  );
}

function changedPackageJsonFiles() {
  const packageJsonFiles = collectPackageJsonFiles(path.join(cwd, "packages"));
  if (packageJsonFiles.length === 0) {
    return [];
  }

  const output = run(
    "git",
    ["diff", "--name-only", "--", ...packageJsonFiles],
    {
      stdio: "pipe",
    },
  ).stdout;

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(readPackageJsonFile);
}

function readPackageJsonFiles() {
  return collectPackageJsonFiles(path.join(cwd, "packages")).map(
    readPackageJsonFile,
  );
}

function collectPackageJsonFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }

  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

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

function readPackageJsonFile(file) {
  return {
    file,
    packageJson: JSON.parse(readFileSync(path.join(cwd, file), "utf8")),
  };
}

function getBranch() {
  if (process.env.GITHUB_REF_NAME) {
    return process.env.GITHUB_REF_NAME;
  }

  const output = run("git", ["branch", "--show-current"], {
    stdio: "pipe",
  }).stdout.trim();
  if (!output) {
    fail("Could not determine current branch.");
  }

  return output;
}

function githubEnv() {
  return {
    ...process.env,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  };
}

function publishEnv() {
  return {
    ...githubEnv(),
    GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "",
    NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN || "",
    NPM_CONFIG_PROVENANCE: process.env.NPM_CONFIG_PROVENANCE || "true",
  };
}

function run(command, commandArgs, options = {}) {
  const printable = [command, ...commandArgs].join(" ");
  if (dryRun && isMutatingCommand(command, commandArgs)) {
    log(`[dry-run] ${printable}`);
    return { status: 0, stdout: "", stderr: "" };
  }

  log(`$ ${printable}`);
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: options.env || process.env,
    encoding: "utf8",
    shell: false,
    stdio: options.stdio || "inherit",
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

function isMutatingCommand(command, commandArgs) {
  const commandText = [command, ...commandArgs].join(" ");
  return /(^| )(add|commit|push|checkout|merge|fetch|changeset pre|changeset version|changeset publish)( |$)/.test(
    commandText,
  );
}

function parseArgs(argv) {
  const parsed = {};

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      fail(`Unexpected argument ${arg}. Use --key=value or --flag.`);
    }

    const [rawKey, ...rawValue] = arg.slice(2).split("=");
    parsed[rawKey] = rawValue.length > 0 ? rawValue.join("=") : true;
  }

  return parsed;
}

function log(message) {
  console.log(`[release] ${message}`);
}

function warn(message) {
  console.warn(`::warning::${message}`);
}

function error(message) {
  console.error(`::error::${message}`);
}

function fail(message) {
  error(message);
  process.exit(1);
}
