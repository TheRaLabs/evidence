import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Runtime markdown pages are generated under this URL prefix by default.
// Example output path:
//   /runtime-generated/<dashboard-id>-<content-hash>
// This keeps runtime-generated pages isolated from static pages in the project.
const DEFAULT_PREFIX = '/runtime-generated';

/**
 * Normalize the runtime route prefix used for generated markdown routes.
 *
 * Why normalization is needed:
 * - callers may pass empty strings, missing slashes, or trailing slashes
 * - downstream path joins expect a stable, slash-prefixed format
 *
 * Output guarantees:
 * - never empty
 * - always starts with '/'
 * - never ends with '/'
 */
export function normalizeCompiledPrefix(rawPrefix) {
  const trimmed = (rawPrefix || DEFAULT_PREFIX).trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_PREFIX;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * Convert any dashboard id into a filesystem/URL-safe identifier.
 *
 * Allowed characters:
 * - letters
 * - numbers
 * - underscore
 * - hyphen
 *
 * Any unsupported character is replaced with '_', so we can safely use the
 * id in:
 * - markdown file names
 * - route segment names
 * - cleanup prefix matching
 */
export function safeDashboardId(input) {
  return String(input || 'dashboard').replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Build a deterministic slug for a dashboard markdown snapshot.
 *
 * Slug format:
 *   <safe-dashboard-id>-<sha256(markdown).slice(0, 12)>
 *
 * The hash ties slug identity to markdown content, which gives us:
 * - stable slugs for identical content
 * - natural cache busting when content changes
 * - low collision risk while keeping route length short
 */
export function computeSlug(dashboardId, markdown) {
  const safeId = safeDashboardId(dashboardId);
  const hash = crypto
    .createHash('sha256')
    .update(markdown, 'utf8')
    .digest('hex')
    .slice(0, 12);
  return `${safeId}-${hash}`;
}

/**
 * Atomically write file contents to avoid partially written files.
 *
 * Strategy:
 * 1) write to a temporary sibling file
 * 2) rename temp file to final target path
 *
 * `rename` on the same filesystem is atomic on modern OSes, so readers either
 * see the old complete file or the new complete file, never a half-written file.
 */
async function writeFileAtomic(filePath, content) {
  const tmpPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmpPath, content, 'utf8');
  await fs.rename(tmpPath, filePath);
}

/**
 * Persist a runtime markdown snapshot and return route metadata.
 *
 * High-level flow:
 * 1) normalize prefix and compute stable slug
 * 2) ensure runtime directory exists
 * 3) atomically write `<slug>.md`
 * 4) clean up older snapshots for the same dashboard
 *
 * Retention behavior:
 * - keeps up to `retainPerDashboard` newest files per dashboard
 * - always keeps the file for `currentSlug` as an extra safety guard
 */
export async function writeRuntimeMarkdown({
  dashboardId,
  markdown,
  markdownPagesRoot,
  compiledPrefix,
  retainPerDashboard = 1,
}) {
  const normalizedPrefix = normalizeCompiledPrefix(compiledPrefix);
  const safeId = safeDashboardId(dashboardId);
  const slug = computeSlug(dashboardId, markdown);
  const runtimeDir = path.join(
    markdownPagesRoot,
    normalizedPrefix.replace(/^\/+/, ''),
  );
  const filePath = path.join(runtimeDir, `${slug}.md`);

  await fs.mkdir(runtimeDir, { recursive: true });
  await writeFileAtomic(filePath, markdown);
  await cleanupOlderDashboardMarkdownFiles({
    runtimeDir,
    safeDashboardId: safeId,
    currentSlug: slug,
    retainCount: retainPerDashboard,
  });

  return {
    slug,
    compiledPath: `${normalizedPrefix}/${slug}`,
    runtimeDir,
    filePath,
  };
}

/**
 * Remove stale markdown snapshot files for one dashboard.
 *
 * Only files matching `<safeDashboardId>-*.md` are considered.
 * Files are sorted by `mtime` descending (newest first), then old files beyond
 * the retain threshold are removed.
 *
 * Notes:
 * - cleanup is best-effort and uses `force: true` to avoid hard failures when
 *   files are already gone
 * - retainCount < 1 means "skip cleanup" to avoid accidental full deletion
 */
async function cleanupOlderDashboardMarkdownFiles({
  runtimeDir,
  safeDashboardId,
  currentSlug,
  retainCount,
}) {
  if (retainCount < 1) return;
  const prefix = `${safeDashboardId}-`;
  const entries = await fs.readdir(runtimeDir, { withFileTypes: true });
  const matched = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(prefix) || !entry.name.endsWith('.md')) continue;
    const fullPath = path.join(runtimeDir, entry.name);
    const stats = await fs.stat(fullPath);
    matched.push({
      name: entry.name,
      fullPath,
      mtimeMs: stats.mtimeMs,
    });
  }

  matched.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const keepNames = new Set(
    matched.slice(0, retainCount).map((entry) => entry.name),
  );
  keepNames.add(`${currentSlug}.md`);

  await Promise.all(
    matched
      .filter((entry) => !keepNames.has(entry.name))
      .map((entry) => fs.rm(entry.fullPath, { force: true })),
  );
}

/**
 * Materialize Svelte route directories from runtime markdown files.
 *
 * Input:
 * - markdown files under `<markdownPagesRoot>/<normalizedPrefix>/*.md`
 *
 * Output:
 * - route directories under `<projectRoot>/src/pages/<normalizedPrefix>/<slug>/+page.md`
 *
 * Synchronization behavior:
 * - for each runtime markdown file, create/update corresponding route page
 * - remove route directories that no longer have a source markdown file
 *
 * This function is intended to be rerun repeatedly so the generated route tree
 * stays aligned with current runtime markdown artifacts.
 */
export async function materializeRuntimeRoutes({
  projectRoot,
  markdownPagesRoot,
  compiledPrefix,
}) {
  const normalizedPrefix = normalizeCompiledPrefix(compiledPrefix);
  const runtimeDir = path.join(
    markdownPagesRoot,
    normalizedPrefix.replace(/^\/+/, ''),
  );
  const targetBaseDir = path.join(
    projectRoot,
    'src/pages',
    normalizedPrefix.replace(/^\/+/, ''),
  );

  await fs.mkdir(targetBaseDir, { recursive: true });
  if (!existsSync(runtimeDir)) {
    return { slugs: [] };
  }

  const entries = await fs.readdir(runtimeDir, { withFileTypes: true });
  const slugs = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const slug = entry.name.slice(0, -3);
    const markdownPath = path.join(runtimeDir, entry.name);
    const markdown = await fs.readFile(markdownPath, 'utf8');
    const routeDir = path.join(targetBaseDir, slug);
    const routeMarkdown = path.join(routeDir, '+page.md');
    await fs.mkdir(routeDir, { recursive: true });
    await writeFileAtomic(routeMarkdown, markdown);
    slugs.push(slug);
  }

  const routeEntries = await fs.readdir(targetBaseDir, { withFileTypes: true });
  await Promise.all(
    routeEntries
      .filter((entry) => entry.isDirectory() && !slugs.includes(entry.name))
      .map((entry) =>
        fs.rm(path.join(targetBaseDir, entry.name), {
          recursive: true,
          force: true,
        }),
      ),
  );

  return { slugs };
}
