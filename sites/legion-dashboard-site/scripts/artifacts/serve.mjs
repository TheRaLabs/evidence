#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeRuntimeMarkdown, normalizeCompiledPrefix } from '../runtime/markdown-materializer.mjs';
import { createReleaseRunner } from '../runtime/release-runner.mjs';

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

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.arrow': 'application/octet-stream',
  '.parquet': 'application/octet-stream',
};

function resolveInside(baseDir, relativePath) {
  const resolved = path.resolve(baseDir, relativePath);
  const normalizedBase = `${path.resolve(baseDir)}${path.sep}`;
  if (resolved !== path.resolve(baseDir) && !resolved.startsWith(normalizedBase)) {
    return null;
  }
  return resolved;
}

async function readCurrent(currentFile) {
  const raw = await fsp.readFile(currentFile, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed?.versionHash || typeof parsed.versionHash !== 'string') {
    throw new Error(`invalid current.json at ${currentFile}`);
  }
  return parsed;
}

function createJobId() {
  return crypto.randomUUID();
}

function toJobResponse(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    slug: job.slug,
    compiledPath: job.compiledPath,
    pageUrl: job.pageUrl,
    versionHash: job.versionHash,
    error: job.error,
  };
}

async function fileExists(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

function streamFile(res, filePath, { immutable = false } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  const cacheControl = immutable
    ? 'public, max-age=31536000, immutable'
    : ext === '.html'
      ? 'no-cache'
      : 'public, max-age=60';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
  });

  fs.createReadStream(filePath).pipe(res);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dashboard = args.dashboard ?? 'example';
  const port = Number.parseInt(args.port ?? '4175', 10);
  const projectRoot = process.cwd();
  const runtimeApiToken = process.env.EVIDENCE_RUNTIME_API_TOKEN || '';
  const runtimeApiEnabled = (process.env.EVIDENCE_RUNTIME_API_ENABLED || 'true') === 'true';
  const maxMarkdownBytes = Number.parseInt(
    process.env.EVIDENCE_RUNTIME_MAX_MARKDOWN_BYTES || String(200 * 1024),
    10,
  );
  const markdownPagesRoot =
    process.env.EVIDENCE_MARKDOWN_PAGES_ROOT || path.join(projectRoot, 'runtime-storage');
  const compiledPrefix = normalizeCompiledPrefix(
    process.env.EVIDENCE_PAGES_COMPILED_PATH_PREFIX || '/runtime-generated',
  );
  const publicBaseUrl = (
    process.env.EVIDENCE_RUNTIME_PUBLIC_BASE_URL || `http://localhost:${port}`
  ).replace(/\/+$/, '');
  const releaseCommand = process.env.EVIDENCE_RUNTIME_RELEASE_COMMAND || 'pnpm run artifact:release';
  const retainPerDashboard = Number.parseInt(
    process.env.EVIDENCE_RUNTIME_RETAIN_PER_DASHBOARD || '1',
    10,
  );

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`invalid --port value: ${args.port}`);
  }

  const artifactBaseRoot = process.env.EVIDENCE_ARTIFACTS_ROOT?.trim();
  if (!artifactBaseRoot) {
    throw new Error('EVIDENCE_ARTIFACTS_ROOT is required');
  }
  const artifactsRoot = path.join(artifactBaseRoot, dashboard);
  const currentFile = path.join(artifactsRoot, 'current.json');
  const jobs = new Map();

  if (!fs.existsSync(currentFile)) {
    throw new Error(`current.json not found at ${currentFile}. Publish an artifact first.`);
  }

  const releaseRunner = createReleaseRunner({
    projectRoot,
    markdownPagesRoot,
    compiledPrefix,
    artifactDashboard: dashboard,
    releaseCommand,
  });

  const updateJob = (jobId, patch) => {
    const current = jobs.get(jobId);
    if (!current) return;
    jobs.set(jobId, {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  };

  const validateToken = (req) => {
    if (!runtimeApiToken) return true;
    const auth = req.headers.authorization || '';
    return auth === `Bearer ${runtimeApiToken}`;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? 'localhost';
      const url = new URL(req.url ?? '/', `http://${host}`);
      const pathname = decodeURIComponent(url.pathname);

      if (pathname === '/_health') {
        return send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' });
      }

      if (runtimeApiEnabled) {
        if (req.method === 'POST' && pathname === '/api/runtime-dashboards/release') {
          if (!validateToken(req)) {
            return sendJson(res, 401, { error: 'Unauthorized' });
          }

          const body = await readJsonBody(req);
          const dashboardId = String(body.dashboardId || '').trim();
          const markdown = String(body.markdown || '');
          if (!dashboardId || !markdown.trim()) {
            return sendJson(res, 400, { error: 'dashboardId and markdown are required' });
          }

          const markdownBytes = Buffer.byteLength(markdown, 'utf8');
          if (markdownBytes > maxMarkdownBytes) {
            return sendJson(res, 413, {
              error: `markdown too large: ${markdownBytes} bytes`,
            });
          }

          const { slug, compiledPath } = await writeRuntimeMarkdown({
            dashboardId,
            markdown,
            markdownPagesRoot,
            compiledPrefix,
            retainPerDashboard,
          });

          const pageUrl = `${publicBaseUrl}${compiledPath}`;
          const current = await readCurrent(currentFile);
          const existingRoutePath = path.join(
            artifactsRoot,
            current.versionHash,
            compiledPrefix.replace(/^\/+/, ''),
            slug,
            'index.html',
          );

          if (fs.existsSync(existingRoutePath)) {
            const job = {
              jobId: createJobId(),
              dashboardId,
              status: 'succeeded',
              slug,
              compiledPath,
              pageUrl,
              versionHash: current.versionHash,
              error: undefined,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            jobs.set(job.jobId, job);
            return sendJson(res, 202, toJobResponse(job));
          }

          const job = {
            jobId: createJobId(),
            dashboardId,
            status: 'queued',
            slug,
            compiledPath,
            pageUrl,
            versionHash: undefined,
            error: undefined,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          jobs.set(job.jobId, job);
          releaseRunner.enqueue(job, updateJob);
          return sendJson(res, 202, toJobResponse(job));
        }

        const releaseStatusMatch = pathname.match(
          /^\/api\/runtime-dashboards\/release\/([^/]+)$/,
        );
        if (req.method === 'GET' && releaseStatusMatch) {
          if (!validateToken(req)) {
            return sendJson(res, 401, { error: 'Unauthorized' });
          }

          const jobId = decodeURIComponent(releaseStatusMatch[1]);
          const job = jobs.get(jobId);
          if (!job) {
            return sendJson(res, 404, { error: 'job not found' });
          }
          return sendJson(res, 200, toJobResponse(job));
        }
      }

      if (pathname === '/current.json') {
        const raw = await fsp.readFile(currentFile, 'utf8');
        return send(res, 200, raw, { 'Content-Type': 'application/json; charset=utf-8' });
      }

      // Versioned immutable assets. Support both:
      // 1) /assets/<versionHash>/...
      // 2) /runtime-generated/assets/<versionHash>/... (from relative links in nested routes)
      const assetMatch = pathname.match(/(?:^|\/)assets\/([^/]+)\/(.+)$/);
      if (assetMatch) {
        const [, versionHash, relativeAssetPath] = assetMatch;
        const assetBase = path.join(artifactsRoot, versionHash, '_app');
        const filePath = resolveInside(assetBase, relativeAssetPath);
        if (!filePath || !(await fileExists(filePath))) {
          return send(res, 404, 'Not found');
        }
        return streamFile(res, filePath, { immutable: true });
      }

      const current = await readCurrent(currentFile);
      const versionDir = path.join(artifactsRoot, current.versionHash);

      if (!fs.existsSync(versionDir)) {
        return send(res, 503, `Current version directory missing: ${current.versionHash}`);
      }

      const cleanPath = pathname.replace(/^\/+/, '');
      const candidates = [];

      if (pathname === '/' || pathname === '') {
        candidates.push('index.html');
      } else {
        candidates.push(cleanPath);
        if (!path.extname(cleanPath)) {
          candidates.push(`${cleanPath}.html`);
          candidates.push(path.join(cleanPath, 'index.html'));
        }
      }

      for (const candidate of candidates) {
        const filePath = resolveInside(versionDir, candidate);
        if (!filePath) continue;
        if (await fileExists(filePath)) {
          return streamFile(res, filePath, { immutable: false });
        }
      }

      // Route fallback for non-file paths so app routes can still boot client-side.
      if (!path.extname(cleanPath)) {
        const indexFallback = resolveInside(versionDir, 'index.html');
        if (indexFallback && (await fileExists(indexFallback))) {
          return streamFile(res, indexFallback, { immutable: false });
        }
      }

      return send(res, 404, 'Not found');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return send(res, 500, `Server error: ${message}`);
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`Artifact server listening on http://0.0.0.0:${port}`);
    console.log(`Dashboard: ${dashboard}`);
    console.log(`Artifacts root: ${artifactsRoot}`);
    console.log(`Current pointer: ${currentFile}`);
    if (runtimeApiEnabled) {
      console.log(`Runtime control API enabled at http://0.0.0.0:${port}/api/runtime-dashboards`);
    }
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
