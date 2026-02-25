#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { InfisicalSDK } from '@infisical/sdk';

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

async function loadInfisicalSecrets() {
  const clientId = process.env.INFISICAL_CLIENT_ID;
  const clientSecret = process.env.INFISICAL_CLIENT_SECRET;
  const projectId = process.env.INFISICAL_PROJECT_ID;

  if (!clientId || !clientSecret || !projectId) {
    throw new Error('Missing INFISICAL_CLIENT_ID/INFISICAL_CLIENT_SECRET/INFISICAL_PROJECT_ID');
  }

  const configClient = new InfisicalSDK({
    siteUrl: 'https://app.infisical.com',
  });

  await configClient.auth().universalAuth.login({
    clientId,
    clientSecret,
  });

  const environment = 'dev';
  const allSecrets = await configClient.secrets().listSecrets({
    environment,
    projectId,
  });

  for (const secret of allSecrets.secrets) {
    if (!(secret.secretKey in process.env) || !process.env[secret.secretKey]) {
      process.env[secret.secretKey] = secret.secretValue;
    }
  }
}

async function runCommand(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      return reject(new Error(`Command failed: ${command} ${args.join(' ')}`));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dashboard = args.dashboard ?? 'legion-dashboard-site';
  const port = args.port ?? '3002';

  // Local/dev fallback: allow direct token injection without Infisical bootstrap.
  if (!process.env.INTERNAL_SERVICE_TOKEN?.trim()) {
    await loadInfisicalSecrets();
  }

  if (!process.env.INTERNAL_SERVICE_TOKEN?.trim()) {
    throw new Error('INTERNAL_SERVICE_TOKEN is missing after Infisical bootstrap');
  }

  await runCommand('pnpm', ['run', 'artifact:release']);
  await runCommand('node', [
    './scripts/artifacts/serve.mjs',
    '--dashboard',
    dashboard,
    '--port',
    String(port),
  ]);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
