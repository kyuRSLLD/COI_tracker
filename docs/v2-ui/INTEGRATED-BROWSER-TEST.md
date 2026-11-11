# Disposable V2 browser integration

This is a test-only host, **not** a production entry point or a release recommendation. It mounts the standalone `V2Auth`, `SubcontractorWorkflow`, and `GcConnections` components. Its Vite server proxies same-origin `/api` traffic unchanged to `createSecureV2SyntheticTestApp`; no API responses, routers, business logic, or database operations are mocked. A separate instance uses the same real authentication and default factory options to verify both experimental features remain disabled without explicit test-only opt-in. Nothing mounts these components or routes in `app.ts` or production startup.

## Run

On an isolated, trusted Linux machine with Node 22+, workspace dependencies, PostgreSQL 16 binaries, Python Playwright, Pillow, system `libzbar.so.0` and Chromium at `/usr/bin/chromium`:

```sh
npm run build
python3 client/tests/v2-sub/test_sub.py
(
  set -e
  ./node_modules/.bin/vite --config client/tests/v2-gc/vite.config.ts &
  VITE_PID=$!
  trap 'kill "$VITE_PID" 2>/dev/null || true' EXIT
  for i in $(seq 1 100); do
    kill -0 "$VITE_PID" || exit 1
    curl -fsS http://127.0.0.1:5183/tests/v2-gc/index.html >/dev/null 2>&1 && break
    sleep .1
  done
  kill -0 "$VITE_PID"
  python3 client/tests/v2-gc/test_gc.py
)
bash scripts/test-v2-browser-e2e.sh
```

`PG16_BIN` may specify the PostgreSQL 16 binary directory. The E2E runner creates a private directory under `.work`, initializes a fresh loopback-only cluster and database (`secure_v2_test_browser`), strips inherited environment variables (including AWS/database configuration), and stops/removes the cluster on exit. If PostgreSQL cannot be stopped, the runner preserves its directory for manual cleanup. A small free-port selection race exists; a startup failure must not be retried against an existing cluster. Trust authentication is appropriate only for an isolated machine. This is not safe against other users with local access or a hostile local machine.

The real SES adapter sends to a test transport which accepts only three fixed `example.test` recipients and writes the verification codes as mode-0600 files in the private temporary directory so the browser test can enter them; they are removed with the cluster. No AWS SDK client, SES or S3 endpoint is contacted, and file routes are left disabled rather than using S3. Camera and `BarcodeDetector` are simulated for one scanner path; the QR image itself is decoded independently with zbar, and the other GC uses the real manual input path. The factory requires synthetic rate-limit callbacks: these permit requests in the test and are **not** production rate limits. Browser requests outside the Vite origin are blocked; requests to `/api` pass through without interception. No real identity, external account, persistent credential, or production data is used.

The test performs actual browser registration and login for one sub and two distinct GCs, captures their identities from `/me` and records from real API responses (never infers IDs), verifies exact server-provided disclosure and affirmative payload, decodes each raw QR, redeems through manual and simulated camera paths, verifies automatic list refresh, creates self-reported metadata, grants only to the intended connected GC using separate exact consent, confirms the other connected GC gets no record, revokes access, and checks the intended GC's refreshed view and API result. The connected-GC list and profile are not proof of business or insurance identity. The sub opens a second session to create a second QR; as the UI warns, reload/session loss does not revoke an issued capability. Test-only access tokens and capabilities are not intentionally logged or written to browser storage.

The existing individual browser suites are different: they intercept API calls with fixtures and cover many UI error, expiry, responsive and isolation cases independently. This integration test does not validate a deployed frontend, real camera optics or permissions, S3/SES, production schemas or policies, real rate limits, file access, client sharing, all races, business ownership, revocation of already seen data, or production readiness. See `docs/secure-v2-synthetic-composition.md` for the underlying limitations and release blockers.
