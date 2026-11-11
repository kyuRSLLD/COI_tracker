# Standalone GC connections V2

`GcConnections` is an unmounted React component: `import { GcConnections } from './v2/GcConnections'`, then render `<GcConnections authorizationToken={gcAccessToken} />`. The host must supply a currently authenticated GC bearer token as a prop and unmount the component on logout. No legacy routes or startup are changed. Both V2 routers must be separately and securely composed by the host; the metadata router documented in `SELF_REPORTED_COI_METADATA_V2.md` is synthetic-only, and the contracts do not establish production readiness.

The component makes same-origin requests only to `/api/v2/connections/subcontractors`, `/api/v2/connections/qr/redeem`, and `/api/v2/self-reported-coi-metadata/granted`. It sends capabilities only in the JSON request body and never navigates to decoded QR values. It validates exactly the router's 43-character base64url syntax and clears manual input on submission. The access token and entered capability are transient in memory; neither is written to browser storage or URLs. Fetch disables caching, credentials, referrers, and redirects; the host, gateway, monitoring and server must also prevent credential and body logging, enforce TLS, and provide the authentication/rate-limit controls required by the contracts. Avoid third-party scripts in a sensitive host. Unmounting/credential changes abort outstanding requests and stop camera tracks; a request already received by the server can still complete.

This repository does not depend on `html5-qrcode`; the component uses the native `BarcodeDetector` QR API when available, which requires browser and secure-context support. Otherwise the manual entry option remains available. Camera access only begins after a click and tracks stop when scanning ends or the component unmounts. Generic 404 cannot distinguish expiry, replay, revocation or other unavailability. A network/server error has an unknown redemption outcome; refresh before trying a new code.

Profiles and separately granted records are self-reported and unverified; profile consent alone never grants COI metadata or documents. Returned metadata is displayed only under a currently listed profile with matching `profile_id`. No document or legacy API is used.

## Synthetic tests

With workspace dependencies installed and Python Playwright plus Chromium available, from the repository root run:

```sh
npm run build --workspace=client
./node_modules/.bin/vite --config client/tests/v2-gc/vite.config.ts > /tmp/gc-v2-vite.log 2>&1 &
VITE_PID=$!
python3 client/tests/v2-gc/test_gc.py
kill "$VITE_PID"
```

The isolated test harness uses a synthetic prop and intercepts every `/api/` request; it never contacts a real backend. It is not a production entry point. Tests include camera and manual redemption, invalid URL rejection, replay/expiry ambiguity, refresh, camera permission denial/unsupported mode, account changes, profile-scoped metadata, failure handling, storage and responsive layout. No QR or access tokens should be exposed in logs or screenshots in real usage.
