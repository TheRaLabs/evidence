# Example Project

This project includes a versioned artifact deployment flow so you can publish new dashboard builds without restarting the running service.

## Run Locally

```bash
pnpm -C /Users/longfeixing/repos/evidence/sites/example-project dev
```

## Build + Publish Artifact

```bash
pnpm -C /Users/longfeixing/repos/evidence/sites/example-project artifact:release
```

What this does:

1. Builds the site to `build/`
2. Publishes to `artifacts/example/<versionHash>/`
3. Atomically updates `artifacts/example/current.json`

## Serve Current Version

```bash
pnpm -C /Users/longfeixing/repos/evidence/sites/example-project artifact:serve
```

Behavior:

- `current.json` is read on each request
- app routes are served from the current version
- versioned assets are served at `/assets/<versionHash>/...`
- versioned assets are immutable (`Cache-Control: public, max-age=31536000, immutable`)

## Rollback

Set `artifacts/example/current.json` to an older `versionHash` and requests switch immediately.

## Notes

- Generated artifacts are ignored by git via `/Users/longfeixing/repos/evidence/sites/example-project/.gitignore` (`artifacts`)
- Detailed script docs are in `/Users/longfeixing/repos/evidence/sites/example-project/scripts/artifacts/README.md`
