# Legion Dashboard Site

This is a dedicated Evidence site for runtime markdown releases only.

## Run Locally

```bash
pnpm --filter @evidence-dev/legion-dashboard-site dev
```

## Build + Publish Artifact

```bash
pnpm --filter @evidence-dev/legion-dashboard-site artifact:release
```

What this does:

1. Builds the site to `build/`
2. Publishes to `artifacts/legion-dashboard-site/<versionHash>/`
3. Atomically updates `artifacts/legion-dashboard-site/current.json`

## Serve Current Version (+ Runtime API)

```bash
pnpm --filter @evidence-dev/legion-dashboard-site runtime:start
```

Notes:
- Scripts read config from `.env.prod` by default.
- Copy `.env.template` to `.env.prod` and adjust values if needed.
- Minimum required vars: `EVIDENCE_MARKDOWN_PAGES_ROOT`, `EVIDENCE_ARTIFACTS_ROOT`, `INTERNAL_SERVICE_TOKEN`.
- `EVIDENCE_ARTIFACTS_ROOT` must point to your shared path/EFS.
- Runtime startup loads secrets from Infisical `dev` environment.

Trigger release:

```bash
curl -X POST http://localhost:3002/api/runtime-dashboards/release \
  -H 'Authorization: Bearer <INTERNAL_SERVICE_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"dashboardId":"db_123","markdown":"# Runtime Dashboard"}'
```

Check job:

```bash
curl -H 'Authorization: Bearer <INTERNAL_SERVICE_TOKEN>' \
  http://localhost:3002/api/runtime-dashboards/release/<jobId>
```
