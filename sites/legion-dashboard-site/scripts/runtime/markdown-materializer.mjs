import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_PREFIX = '/runtime-generated';

export function normalizeCompiledPrefix(rawPrefix) {
  const trimmed = (rawPrefix || DEFAULT_PREFIX).trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_PREFIX;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function safeDashboardId(input) {
  return String(input || 'dashboard').replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function computeSlug(dashboardId, markdown) {
  const safeId = safeDashboardId(dashboardId);
  const hash = crypto
    .createHash('sha256')
    .update(markdown, 'utf8')
    .digest('hex')
    .slice(0, 12);
  return `${safeId}-${hash}`;
}

async function writeFileAtomic(filePath, content) {
  const tmpPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmpPath, content, 'utf8');
  await fs.rename(tmpPath, filePath);
}

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
