#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Parse CLI args in `--key value` / `--flag` form.
 * Values are kept as strings for predictable downstream handling.
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    args[key] = value;
  }
  return args;
}

/**
 * Recursively collect all file paths under a directory.
 *
 * Used by post-build rewriting logic to locate every generated HTML file.
 */
async function walkFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath)));
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

/**
 * Best-effort short git SHA for traceability in artifact metadata.
 * Falls back to `nogit` when git metadata is unavailable.
 */
function getGitSha(cwd) {
  try {
    return execSync('git rev-parse --short HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'nogit';
  }
}

/**
 * Rewrite adapter-static asset references so versioned artifacts are immutable.
 *
 * Rewrites common `_app` path patterns to:
 *   /assets/<versionHash>/...
 * This decouples HTML routing from hashed static assets and allows long cache.
 */
async function rewriteHtmlAssetPaths(versionDir, versionHash) {
  const files = await walkFiles(versionDir);
  const htmlFiles = files.filter((file) => file.endsWith('.html'));

  for (const htmlFile of htmlFiles) {
    const original = await fs.readFile(htmlFile, 'utf8');
    let rewritten = original;

    // Common static output path patterns from adapter-static.
    rewritten = rewritten.replaceAll('/_app/', `/assets/${versionHash}/`);
    rewritten = rewritten.replaceAll('./_app/', `/assets/${versionHash}/`);
    rewritten = rewritten.replace(/(?:\.\.\/)+_app\//g, `/assets/${versionHash}/`);

    if (rewritten !== original) {
      await fs.writeFile(htmlFile, rewritten, 'utf8');
    }
  }
}

/**
 * Atomically write JSON payloads by temp-file + rename.
 *
 * Prevents partially written `current.json` pointers during process interruption.
 */
async function writeJsonAtomic(filePath, payload) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  await fs.rename(tmpPath, filePath);
}

/**
 * Publish a built dashboard into versioned artifact storage.
 *
 * High-level flow:
 * 1) validate build directory and artifact root
 * 2) create a unique version hash
 * 3) copy build output to temp dir
 * 4) rewrite HTML asset paths to versioned `/assets/<hash>/...`
 * 5) atomically promote temp dir and update `current.json`
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dashboard = args.dashboard ?? 'example';

  const cwd = process.cwd();
  const buildDir = path.join(cwd, 'build');
  if (!existsSync(buildDir)) {
    throw new Error(`build directory not found at ${buildDir}. Run build first.`);
  }

  const artifactBaseRoot = process.env.EVIDENCE_ARTIFACTS_ROOT?.trim();
  if (!artifactBaseRoot) {
    throw new Error('EVIDENCE_ARTIFACTS_ROOT is required');
  }
  const artifactsRoot = path.join(artifactBaseRoot, dashboard);
  await fs.mkdir(artifactsRoot, { recursive: true });

  const gitSha = getGitSha(cwd);
  const seed = `${gitSha}:${Date.now()}:${Math.random()}`;
  const versionHash = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12);

  const tempVersionDir = path.join(artifactsRoot, `.tmp-${versionHash}`);
  const finalVersionDir = path.join(artifactsRoot, versionHash);

  if (existsSync(tempVersionDir)) {
    await fs.rm(tempVersionDir, { recursive: true, force: true });
  }

  if (existsSync(finalVersionDir)) {
    throw new Error(`version already exists: ${finalVersionDir}`);
  }

  await fs.cp(buildDir, tempVersionDir, { recursive: true });
  await rewriteHtmlAssetPaths(tempVersionDir, versionHash);
  await fs.rename(tempVersionDir, finalVersionDir);

  const currentPath = path.join(artifactsRoot, 'current.json');
  await writeJsonAtomic(currentPath, {
    dashboard,
    versionHash,
    updatedAt: new Date().toISOString(),
    gitSha,
  });

  console.log(`Published dashboard=${dashboard} version=${versionHash}`);
  console.log(`Artifacts root: ${artifactsRoot}`);
  console.log(`Version dir: ${finalVersionDir}`);
  console.log(`Current file: ${currentPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
