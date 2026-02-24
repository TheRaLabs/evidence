import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { materializeRuntimeRoutes } from './markdown-materializer.mjs';

async function runShellCommand(command, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      stdio: 'inherit',
      shell: true,
      env: process.env,
    });
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      return reject(new Error(`command failed with exit code ${code}: ${command}`));
    });
    child.on('error', reject);
  });
}

async function readCurrentVersionHash(projectRoot, artifactDashboard) {
  const artifactBaseRoot = process.env.EVIDENCE_ARTIFACTS_ROOT?.trim();
  if (!artifactBaseRoot) {
    throw new Error('EVIDENCE_ARTIFACTS_ROOT is required');
  }
  const currentPath = path.join(artifactBaseRoot, artifactDashboard, 'current.json');
  const raw = await fs.readFile(currentPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed?.versionHash || typeof parsed.versionHash !== 'string') {
    throw new Error(`invalid current.json format at ${currentPath}`);
  }
  return parsed.versionHash;
}

export function createReleaseRunner({
  projectRoot,
  markdownPagesRoot,
  compiledPrefix,
  artifactDashboard,
  releaseCommand,
}) {
  const queue = [];
  let running = false;

  const pump = async () => {
    if (running) return;
    const item = queue.shift();
    if (!item) return;
    running = true;

    const { job, onUpdate } = item;
    try {
      onUpdate(job.jobId, { status: 'running' });
      await materializeRuntimeRoutes({
        projectRoot,
        markdownPagesRoot,
        compiledPrefix,
      });
      await runShellCommand(releaseCommand, projectRoot);
      const versionHash = await readCurrentVersionHash(projectRoot, artifactDashboard);
      onUpdate(job.jobId, { status: 'succeeded', versionHash });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      onUpdate(job.jobId, { status: 'failed', error: reason });
    } finally {
      running = false;
      void pump();
    }
  };

  return {
    enqueue(job, onUpdate) {
      queue.push({ job, onUpdate });
      void pump();
    },
  };
}
