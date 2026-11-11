# Unmounted V2 shell

`client/src/v2/V2Shell.tsx` exports `V2Shell`; it is intentionally not imported by `main.tsx`, the legacy application, or a production route. The host must include the project's Tailwind stylesheet (the existing `V2Auth` uses utility classes). `PrivateFiles.tsx` and `private-files.css` are prerequisites copied unchanged from the separately developed private-files component; this worktree intentionally does not change those files. They must be brought into the target tree once, not duplicated when integrating patches.

Authentication is in React memory only; nothing is persisted across reloads. The shell obtains the subject and role only from authenticated `/api/v2/auth/me`, caps the local expiry at the login response TTL and 15 minutes, verifies on sign-in, focus, return to a visible tab, and approximately every 10 seconds while running, and hides the workspace on identity-service errors. A `401` from `/me` or local TTL expiry discards the session. Individual child components report their own request failures; their `401` responses do **not** immediately notify the shell, so the next `/me` check detects revocation. Browser timer throttling or a pending request may delay checks. Server authorization on every protected request remains mandatory and is the security boundary. The shell makes a bearer-authenticated logout POST and immediately drops local access; a failed request is reported as unconfirmed rather than claimed revoked. Reloading without logging out drops the local token but does not revoke the server session.

The existing children independently retrieve their real profile, metadata, file and connected GC account IDs from the server. The shell makes no ID assumptions. An optional `hideUnavailableFiles` prop suppresses the older standalone sub workflow's no-upload panel only when the private-files screen is available; its standalone default is unchanged. Camera access is requested only after the GC clicks Start camera, and the browser may still deny it; manual raw-code input remains available.

Run from repository root with workspace dependencies, Python Playwright, and `/usr/bin/chromium` installed:

```sh
npm run build
python3 client/tests/v2-shell/test_shell.py
(cd client && ../node_modules/.bin/vite build --config tests/v2-shell/vite.config.ts)
```

The browser harness intercepts every API request with synthetic fixtures and blocks off-origin traffic. It tests signup, server-authoritative role navigation, GC/sub switch, actual fixture IDs, file-consent grant, camera denial, session expiry and revocation, confirmed and unconfirmed logout, 403/503 and recovery, no browser persistence, and responsive widths. It does not test the real database, authentication security, object storage, malware scanning, camera hardware, or backend deployment.

**Before mounting or deployment:** secure V2 routers are staged/default-off and need independently reviewed production wiring, rate limiting, registration delivery, storage and scanning configuration. Review the host document's CSP, camera Permissions-Policy, and private PDF/blob preview policy without weakening existing server headers. An API response Permissions-Policy does not itself authorize camera access in a host document. Camera can be unavailable due to the existing restrictive policy or browser support; no server security headers were changed. Do not treat email control, self-reported data, uploaded files or scanning as insurance verification.
