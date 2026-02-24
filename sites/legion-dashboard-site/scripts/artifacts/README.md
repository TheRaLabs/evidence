# Artifact Scripts

## publish.mjs

- Requires an existing `build/` directory.
- Copies build output to `artifacts/<dashboard>/<versionHash>/`.
- Rewrites static HTML references from `_app` to `/assets/<versionHash>/...`.
- Atomically updates `artifacts/<dashboard>/current.json`.
- `EVIDENCE_ARTIFACTS_ROOT` is required and is used as artifact base root.

Usage:

```bash
node ./scripts/artifacts/publish.mjs --dashboard legion-dashboard-site
```

## serve.mjs

- Serves the dashboard version pointed to by `artifacts/<dashboard>/current.json`.
- Reads `current.json` on every request.
- Serves immutable versioned assets from `/assets/<versionHash>/...`.
- Uses the same required `EVIDENCE_ARTIFACTS_ROOT` as `publish.mjs`.

Usage:

```bash
node ./scripts/artifacts/serve.mjs --dashboard legion-dashboard-site --port 4175
```
