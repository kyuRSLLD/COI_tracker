# GC relationship prototype — development and synthetic data only

The GC panel is mounted on `/subcontractors` only for a signed-in GC when Vite is in development mode **and** `VITE_RELATIONSHIP_PROTOTYPE_ENABLED` is exactly `true`. The subcontractor panel is similarly gated on `/subcontractor` for a signed-in sub. Both server-side gates remain independently enforced; see `server/RELATIONSHIP_PROTOTYPE.md` for their requirements and limitations. Never deploy or expose this experiment, or use real accounts, people, COIs or files. This is not production-ready.

The sub explicitly consents to the current disclosure before creating a one-use QR. Its payload is the raw 43-character bearer token. Only the GC prototype opts into the scanner's `allowRawPrototypeToken`; the default staged scanner still uses its original same-origin `/connect-sub#...` parser. Tokens and links are parsed locally, never navigated; preview and explicit confirmation send tokens in JSON bodies to the prototype API. Successful connections refresh only the prototype list, which shows structured COI metadata and coverages, not file downloads. A sub can revoke a connection. Tokens can remain valid until expiry when a component is closed unless explicitly revoked. Protect all bearer tokens and synthetic data from logs, history, analytics, screenshots, external scripts and other disclosure.

## Invitation is disabled

The GC invitation button remains disabled. No recipient route or synchronous prototype-fragment capture has been implemented, and the staged recipient route must not be reused. Do not enable the draft flow until an independently reviewed recipient route, early fragment handling, authentication, full disclosure, exact previewed identity binding and explicit consent have been implemented and tested. The subcontractor panel's manual raw-token preview is separate and does not turn on GC invitation creation.

## Limitations and tests

Identity is self-asserted. Existing legacy routes, public file serving and client sharing remain outside this experiment, so these panels cannot guarantee application-wide privacy or secure files. The metadata link filter is incomplete, and SQLite-only development tests do not prove production security or hardware-camera behavior.

From the worktree root with Node 22, workspace dependencies, Python Playwright and Chromium:

```sh
npm run build
python3 client/tests/test_relationship_prototype_sub_ui.py
python3 client/tests/test_gc_relationship_prototype.py
python3 client/tests/test_relationship_page_gates.py
python3 client/tests/test_integrated_relationship_e2e.py
npm run test:relationships --workspace=server
```

The first three UI suites mock network responses. The last starts loopback-only frontend and backend servers, creates synthetic accounts and a disposable SQLite database, decodes the actual rendered QR, then supplies the decoded value to a simulated camera detector. It tests preview, confirmation, current and subsequently added COIs, and revocation, but not physical camera optics.
