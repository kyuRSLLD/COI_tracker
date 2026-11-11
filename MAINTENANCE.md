# Temporary maintenance protection

This code sets `MAINTENANCE_MODE = true` in `server/src/app.ts`. When deployed, the Express app returns HTTP 503 with a maintenance message and `Cache-Control: no-store` for `/api` and `/uploads`, including their descendants, with the exception of the existing GET/HEAD health check and its OPTIONS preflight at `/api/health`. The public landing page and other non-API static routes remain available. No environment-variable change is needed or can disable the switch.

This deliberately breaks sign-in, registration, dashboards, admin/staff functions, uploads, public share and invitation links, and all other API-dependent features, including for authenticated users. Health reports configured database and storage types, not actual database connectivity or readiness.

When enabled, application startup skips the existing database initialization, which otherwise performs schema changes and a companies backfill. The maintenance change itself adds no migration, deletion or credential change. If the switch is later turned off, ordinary application startup behavior resumes, including its existing schema initialization and backfill.

This is containment, **not a fix for the underlying authorization and privacy problems**. It only covers traffic reaching this Express process. It cannot secure independently accessible direct S3/object-storage URLs, already cached or downloaded content, other services, separately routed/static/CDN content, or an older app instance that remains live. Deployment propagation or overlapping instances can delay protection. Independently investigate and address those exposures; do not assume they are protected by this patch.

## Approval and rollback

Do not push or deploy without explicit approval after reviewing business impact, routing, all running versions and the current target branch. This checkout was prepared against `47f3a20123e57904da729ab43be7e4514583c39c`; verify and integrate the current deployment branch rather than overwriting newer changes. To restore ordinary operation, after security remediation and separate approval change `MAINTENANCE_MODE` to `false` and deploy the resulting code, or roll back using the approved deployment process. **Turning it off before fixing the underlying problems reopens the insecure routes and file access.** Do not delete data or rotate credentials as part of this switch.

## Local verification

From the repository root, run `npm run build` and `npm run test:maintenance --workspace=server`. The test uses a temporary SQLite database and synthetic local file, not production data or S3. It verifies default-on behavior, health and landing, blocked reads and writes across representative sensitive routes, local file blocking, no changes from blocked requests, and the disabled-mode behavior via a test-only `createApp` option. The production entry point calls `createApp()` with the code-switch default; no request or environment variable sets this option.
