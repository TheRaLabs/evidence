import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { materializeRuntimeRoutes } from './markdown-materializer.mjs';

/**
 * Execute a shell command and stream stdio directly to the current process.
 *
 * This is used for release/build commands so operators can see live logs in the
 * same terminal where this script runs.
 */
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

/**
 * Read the currently served artifact version from:
 *   <EVIDENCE_ARTIFACTS_ROOT>/<dashboard>/current.json
 *
 * The return value is the version hash that the artifact server should now
 * expose after a successful release command.
 */
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

/**
 * Build a single-flight release runner.
 *
 * Responsibilities:
 * - enforce one release at a time (`running` guard)
 * - materialize runtime markdown routes before release
 * - execute the configured release command
 * - read and publish resulting version hash through job updates
 *
 * The returned `run(job, onUpdate)` function updates lifecycle states:
 * `running` -> (`succeeded` with versionHash | `failed` with error)
 */
export function createReleaseRunner({
  projectRoot,
  markdownPagesRoot,
  compiledPrefix,
  artifactDashboard,
  releaseCommand,
}) {
  let running = false;

  const run = async (job, onUpdate) => {
    if (running) {
      throw new Error('release already running');
    }
    running = true;
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
    }
  };

  return {
    isRunning() {
      return running;
    },
    run,
  };
}
