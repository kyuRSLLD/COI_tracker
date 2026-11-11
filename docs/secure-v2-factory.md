# Secure-v2 application factory (isolated, not deployed)

`server/src/secure-v2-app.ts` exports `createSecureV2App(deps)` as a separate Express 4 application. **It is not wired into `server/src/app.ts` or `server/src/index.ts`, is not deployed, and does not disable maintenance.** Constructing it does not listen on a port, initialize or migrate a database, seed data, or configure storage. There are no imports or fallbacks to the legacy app or routers, static uploads, demo/seed code, or client-share routes. This is a production-intended boundary and synthetic harness, **not a production-ready deployment or a security audit**.

## Boundary and injection contract

The factory accepts an object with optional `authRouter`, `gcRouter`, `connectionsRouter`, `certificatesRouter`, `selfReportedCoiMetadataRouter` (Express routers), and `authenticate` (an Express request middleware). The first three routers and the verifier are required to provide those services; certificates and metadata are optional. They are optional in the type so an incomplete composition fails closed at request time:

1. Apply security and no-store headers, then reject non-allowlisted or ambiguous paths.
2. Mount the public auth router at `/api/v2/auth`, after a strict 64 KiB JSON parser. Missing router: generic 503.
3. Mount `/api/v2/gc`, `/api/v2/connections`, `/api/v2/certificates`, and `/api/v2/self-reported-coi-metadata`, each in the order: injected authenticator, strict 64 KiB JSON parser, corresponding router. A missing verifier returns generic 503; with a verifier, missing or syntactically malformed bearer credentials return generic 401 without calling it. A missing private router returns generic 503 after successful authentication.
4. Unhandled endpoints return generic 404. Parser and unhandled Express errors are translated to generic 400, 413, 415, or 500 responses without the original error message or stack. If a handler has already started its response, the connection is terminated on an error because sent bytes cannot be retracted.

These are the default settings. A trusted composition can supply `beforeProtected` ahead of authentication and can set `routersOwnBodyParsing: true`, removing the factory JSON parser from all five mounts. The latter is safe only when each trusted JSON router supplies its own correctly bounded parser and binary endpoints independently validate and bound raw input. It allows the certificate router to receive an unconsumed raw stream and preserves the auth and connections routers' smaller limits. See [the strictly test-only concrete composition](./secure-v2-synthetic-composition.md); it is disconnected and must not be deployed.

Paths must have the exact lowercase prefixes and segment boundaries shown. The boundary rejects percent-encoded path characters, backslashes, duplicate slashes, whitespace/control characters and `.`/`..` segments; query strings are not subject to that path restriction. This intentionally conservative rule means URL-encoded path identifiers (including encoded Unicode) are not currently supported; design and test any canonicalization change against the actual reverse proxy before relaxing it. This factory does not enable CORS. Only JSON requests handled by its parser are subject to its JSON limit, including after decompression; uploads, multipart, forms, other content types and upstream buffering need their own reviewed limits.

The injected components are **trusted application code**, not sandboxed plugins. `authenticate` must verify the bearer token (including signature, algorithm, issuer, audience, expiry/revocation as applicable) and call `next()` only after successful validation, with a trustworthy principal/context for downstream authorization; a syntactically valid token is not verification. It must itself send a generic denial on invalid credentials or pass a safe error to `next`. The gate blocks Express `next('route')`/`next('router')`, repeated `next` calls, and advancing after an already-sent denial, but it cannot detect a verifier that incorrectly calls `next()` for an invalid credential. The auth router must expose only intentionally public authentication operations; all nonpublic actions need their own correctly reviewed protection. Routers must enforce tenant/record authorization and must not mount legacy/static/share handlers, weaken headers, send error details, or escape into other apps. Express 4 route handlers must catch asynchronous failures and forward them using `next(err)`; the factory wraps asynchronous rejections of the injected authenticator, but cannot catch unforwarded promise rejections inside arbitrary injected routers.

Composition shape (the actual reviewed dependencies must be supplied by the integrating application; these names are illustrative):

```ts
import { createSecureV2App } from './secure-v2-app.ts'

const app = createSecureV2App({
  authRouter: reviewedPublicAuthRouter,
  authenticate: reviewedTokenVerifier,
  gcRouter: reviewedGcRouter,
  connectionsRouter: reviewedConnectionsRouter,
  certificatesRouter: reviewedCertificatesRouter, // omit to deny with 503
  selfReportedCoiMetadataRouter: reviewedMetadataRouter, // omit to deny with 503
})
```

This app must eventually be used as the exclusive application at the relevant ingress. Mounting it alongside the old app, leaving other public listeners or reverse-proxy routes active, or routing `/uploads` or legacy endpoints elsewhere would defeat this boundary. Headers are set by the factory but trusted injected code and infrastructure must not overwrite them. HTTP parser errors generated before Express are outside its control.

## Tests

From the isolated worktree with the repository's Node dependencies installed, run with Node 22+ (the test uses Node's type stripping):

```sh
node --experimental-strip-types --test server/test/secure-v2-app.test.ts
```

The tests use only synthetic in-memory Express routers, spy counters, synthetic bearer strings and loopback HTTP. They verify blocked legacy/static/share and ambiguous paths (including a deliberately broad auth router), GET/POST/OPTIONS/HEAD, malformed/duplicate/missing and invalid credentials, valid gating of all four private routers, absent dependencies, parser ordering, malformed and oversized JSON (including compressed input), error sanitization, security headers, and middleware control-flow/error cases. They do not use real data, databases, credentials, or external services. They do not prove that real token verification or real application routers are secure.

## Required before production

- Keep the existing maintenance switch and startup untouched until an authorized migration and release plan explicitly changes them. The legacy frontend still calls legacy endpoints and needs migration to the new API, including new authentication and certificate flows.
- Supply and independently review real auth and v2 routers; verify cryptographic configuration, credential handling, session/token lifecycles, abuse/rate limits, endpoint-level permissions, tenant isolation, audit logging, secrets, and generic errors. Test with real adversarial scenarios and verify that no v2 router re-exposes legacy behavior.
- Plan and test database schema/data migrations, ownership and consent semantics, authorization on every record, rollback, and private certificate/object storage access. No migrations are performed by the factory.
- Review ingress/proxy canonicalization, TLS and HSTS policy, request/header/body/time limits for all media types, CORS/CSRF and cookie policy if used, operational monitoring, infrastructure error pages, and all public listeners. Conduct integration/security testing in an isolated environment before any deployment.
