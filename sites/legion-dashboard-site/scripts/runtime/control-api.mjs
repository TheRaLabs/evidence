#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { writeRuntimeMarkdown, normalizeCompiledPrefix } from './markdown-materializer.mjs';
import { createReleaseRunner } from './release-runner.mjs';

const DEFAULT_MAX_MARKDOWN_BYTES = 200 * 1024;

function getConfig() {
  const projectRoot = process.cwd();
  const markdownPagesRoot =
    process.env.EVIDENCE_MARKDOWN_PAGES_ROOT || path.join(projectRoot, 'runtime-storage');
  const compiledPrefix = normalizeCompiledPrefix(
    process.env.EVIDENCE_PAGES_COMPILED_PATH_PREFIX || '/runtime-generated',
  );
  const artifactDashboard = process.env.EVIDENCE_RUNTIME_ARTIFACT_DASHBOARD || 'example';
  const artifactsRoot = process.env.EVIDENCE_ARTIFACTS_ROOT?.trim();
  if (!artifactsRoot) {
    throw new Error('EVIDENCE_ARTIFACTS_ROOT is required');
  }
  const publicBaseUrl =
    (process.env.EVIDENCE_RUNTIME_PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || '4175'}`).replace(
      /\/+$/,
      '',
    );

  return {
    port: Number.parseInt(process.env.EVIDENCE_RUNTIME_API_PORT || '8080', 10),
    token: process.env.INTERNAL_SERVICE_TOKEN || '',
    maxMarkdownBytes: Number.parseInt(
      process.env.EVIDENCE_RUNTIME_MAX_MARKDOWN_BYTES ||
        String(DEFAULT_MAX_MARKDOWN_BYTES),
      10,
    ),
    retainPerDashboard: Number.parseInt(
      process.env.EVIDENCE_RUNTIME_RETAIN_PER_DASHBOARD || '1',
      10,
    ),
    releaseCommand: process.env.EVIDENCE_RUNTIME_RELEASE_COMMAND || 'pnpm run artifact:release',
    projectRoot,
    markdownPagesRoot,
    compiledPrefix,
    artifactDashboard,
    artifactsRoot,
    publicBaseUrl,
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function unauthorized(res) {
  sendJson(res, 401, { error: 'Unauthorized' });
}

function validateToken(req, token) {
  if (!token) return true;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${token}`;
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

async function resolveCurrentVersionHash(artifactsRoot, artifactDashboard) {
  const currentPath = path.join(artifactsRoot, artifactDashboard, 'current.json');
  if (!existsSync(currentPath)) {
    return undefined;
  }

  try {
    const raw = await fs.readFile(currentPath, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.versionHash === 'string' ? parsed.versionHash : undefined;
  } catch {
    return undefined;
  }
}

function resolveCompiledRouteIndexPath({
  artifactsRoot,
  artifactDashboard,
  versionHash,
  compiledPrefix,
  slug,
}) {
  return path.join(
    artifactsRoot,
    artifactDashboard,
    versionHash,
    compiledPrefix.replace(/^\/+/, ''),
    slug,
    'index.html',
  );
}

async function main() {
  const config = getConfig();
  const jobs = new Map();
  const releaseRunner = createReleaseRunner({
    projectRoot: config.projectRoot,
    markdownPagesRoot: config.markdownPagesRoot,
    compiledPrefix: config.compiledPrefix,
    artifactDashboard: config.artifactDashboard,
    releaseCommand: config.releaseCommand,
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

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (url.pathname === '/_health') {
        return sendJson(res, 200, { status: 'ok' });
      }

      if (!validateToken(req, config.token)) {
        return unauthorized(res);
      }

      if (
        req.method === 'POST' &&
        url.pathname === '/api/runtime-dashboards/release'
      ) {
        const body = await readJsonBody(req);
        const dashboardId = String(body.dashboardId || '').trim();
        const markdown = String(body.markdown || '');

        if (!dashboardId || !markdown.trim()) {
          return sendJson(res, 400, {
            error: 'dashboardId and markdown are required',
          });
        }

        const markdownBytes = Buffer.byteLength(markdown, 'utf8');
        if (markdownBytes > config.maxMarkdownBytes) {
          return sendJson(res, 413, {
            error: `markdown too large: ${markdownBytes} bytes`,
          });
        }

        const { slug, compiledPath } = await writeRuntimeMarkdown({
          dashboardId,
          markdown,
          markdownPagesRoot: config.markdownPagesRoot,
          compiledPrefix: config.compiledPrefix,
          retainPerDashboard: config.retainPerDashboard,
        });

        const pageUrl = `${config.publicBaseUrl}${compiledPath}`;
        const currentVersionHash = await resolveCurrentVersionHash(
          config.artifactsRoot,
          config.artifactDashboard,
        );
        const existingRoutePath = currentVersionHash
          ? resolveCompiledRouteIndexPath({
              artifactsRoot: config.artifactsRoot,
              artifactDashboard: config.artifactDashboard,
              versionHash: currentVersionHash,
              compiledPrefix: config.compiledPrefix,
              slug,
            })
          : undefined;

        if (currentVersionHash && existingRoutePath && existsSync(existingRoutePath)) {
          const job = {
            jobId: createJobId(),
            dashboardId,
            status: 'succeeded',
            slug,
            compiledPath,
            pageUrl,
            versionHash: currentVersionHash,
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

      const match = url.pathname.match(
        /^\/api\/runtime-dashboards\/release\/([^/]+)$/,
      );
      if (req.method === 'GET' && match) {
        const jobId = decodeURIComponent(match[1]);
        const job = jobs.get(jobId);
        if (!job) {
          return sendJson(res, 404, { error: 'job not found' });
        }
        return sendJson(res, 200, toJobResponse(job));
      }

      return sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return sendJson(res, 500, { error: reason });
    }
  });

  server.listen(config.port, '0.0.0.0', () => {
    console.log(`Runtime control API listening on http://0.0.0.0:${config.port}`);
    console.log(`markdown root: ${config.markdownPagesRoot}`);
    console.log(`compiled prefix: ${config.compiledPrefix}`);
    console.log(`release command: ${config.releaseCommand}`);
  });
}

main().catch((error) => {
  const reason = error instanceof Error ? error.stack || error.message : String(error);
  console.error(reason);
  process.exit(1);
});
