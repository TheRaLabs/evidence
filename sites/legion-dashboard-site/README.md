# Legion Dashboard Site

This is a dedicated Evidence site for runtime markdown releases only.

## Run Locally

```bash
pnpm -C /Users/yuhanmin/legion-2/evidence/sites/legion-dashboard-site dev
```

## Build + Publish Artifact

```bash
pnpm -C /Users/yuhanmin/legion-2/evidence/sites/legion-dashboard-site artifact:release
```

What this does:

1. Builds the site to `build/`
2. Publishes to `artifacts/legion-dashboard-site/<versionHash>/`
3. Atomically updates `artifacts/legion-dashboard-site/current.json`

## Serve Current Version (+ Runtime Control API)

```bash
cd /Users/yuhanmin/legion-2/evidence/sites/legion-dashboard-site
EVIDENCE_RUNTIME_API_ENABLED=true \
EVIDENCE_RUNTIME_PUBLIC_BASE_URL=http://localhost:3002 \
EVIDENCE_MARKDOWN_PAGES_ROOT=/tmp/legion-evidence-shared \
EVIDENCE_ARTIFACTS_ROOT=/tmp/legion-evidence-shared/artifacts \
EVIDENCE_PAGES_COMPILED_PATH_PREFIX=/runtime-generated \
EVIDENCE_RUNTIME_API_TOKEN=dev-token \
node ./scripts/artifacts/serve.mjs --dashboard legion-dashboard-site --port 3002
```

Notes:
- `EVIDENCE_ARTIFACTS_ROOT` is required and must point to your EFS mount path.

Trigger release:

```bash
curl -X POST http://localhost:3002/api/runtime-dashboards/release \
  -H 'Authorization: Bearer dev-token' \
  -H 'Content-Type: application/json' \
  -d '{"dashboardId":"db_123","markdown":"# Runtime Dashboard"}'
```

Check job:

```bash
curl -H 'Authorization: Bearer dev-token' \
  http://localhost:3002/api/runtime-dashboards/release/<jobId>
```
