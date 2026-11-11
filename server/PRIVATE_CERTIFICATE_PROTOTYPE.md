# Synthetic private certificate retrieval prototype

**Development experiment only: do not merge, deploy, expose to untrusted networks, or use real customer data or files.** This is not production private storage. Existing legacy COI, upload, client-share, and other routes remain globally unsafe and unchanged; in particular, legacy `/uploads` is public. This feature does not secure or replace those routes, and their behavior can undermine application-wide privacy and data integrity. Existing identities are not verified, legacy authorization and JWT issuance may be unsafe, and this prototype does not provide a UI, audit-grade consent, rate limiting, CSRF protection, malware scanning, production file validation, migrations, or PostgreSQL support. It cannot establish that files or database content are genuinely synthetic or defend against a malicious local process.

The existing relationship v1 disclosure explicitly excludes files. It is **not** sufficient file consent. A separate file disclosure and explicit opt-in grant are required for a GC. The grant is bound to a specific active relationship instance and current unambiguous profiles. Revoking the file grant or connection denies subsequent downloads. Reconnecting does not revive an old file grant. The sub can download their own COI's file without granting GC access. No client access is added. Authorization, file opening, and relationship revocation use SQLite transactions; a download authorized/opened before revocation can continue after it, and already delivered bytes cannot be recalled.

## Fail-closed startup

At process boot all existing relationship prototype gates must pass: `RELATIONSHIP_PROTOTYPE_ENABLED=true`, `NODE_ENV=test` or `development`, no `DATABASE_URL`, an explicit absolute `SQLITE_PATH` within a real `/tmp` subdirectory, and the existing strong configured JWT secret (at least 32 bytes, not its fallback). In addition, set both:

* `PRIVATE_CERTIFICATE_PROTOTYPE_ENABLED=true`
* `PRIVATE_CERTIFICATE_TEST_DIR` to an existing absolute, normalized, non-symlink path in `/tmp`, with basename beginning `coi-synthetic-certificates-`, owned by the process user, and mode 0700 (or otherwise with no group/other permissions). It must not overlap legacy local uploads, including their real symlink target.

Linux and `/proc/self/fd` are required. The directory inode and all gate settings are captured at boot and rechecked for each request; swapping the directory, changing the configuration, or a failed check disables the file feature. Its separate grant table is created only at startup when all gates pass. Creating or enabling the directory later will not turn it on. These are accident-reduction checks, not proof of isolation from local attackers. No S3 client, production bucket, stored certificate key, or certificate URL is consulted by this prototype. No file upload or file copy endpoint is provided.

Populate the disposable test database with synthetic COI rows and the directory by hand or with tests. Each synthetic file is a **flat filename equal to its COI's lowercase canonical UUID** (e.g. `00000000-0000-4000-8000-000000000001`); the filename has no extension. The COI's `certificate_mime` must be one of `application/pdf`, `image/png`, `image/jpeg`, or `image/webp`. Basic matching file magic is required, and the file must be a regular, non-symlink, single-link file between 12 bytes and 20 MiB. Magic checks only reject obvious mismatches; they do not prove safety or parse the format. All file names are derived from validated IDs, never from `certificate_key`, `certificate_url`, or a client-provided path. The root is opened and pinned by descriptor and the final name is opened with `O_NOFOLLOW`; parent/root and final symlink escapes are rejected. No `Range` or resume support is implemented. Responses are attachments with fixed filenames, `nosniff`, a sandbox CSP and `Cache-Control: no-store`, including errors.

## API

All endpoints below are beneath `/api/relationship-prototype`, require a valid bearer JWT, and recheck the current database role and unique profile association. Invalid/missing authentication receives 401; role mismatch 403; inaccessible, unsupported, or missing files generally receive the same generic 404; gates return 503. IDs are opaque record identifiers, not storage keys or URLs. These routes never return raw storage keys or object URLs.

1. A sub with an active connection calls `GET /sub/connections/:gcId/certificate-disclosure`. Display the complete `scope`, GC identity and disclosure before asking for consent; retain `version`, `gc_user_id`, `gc_company_name` and `connection_id`. The preview is bound to that connection instance and self-asserted GC name.
2. After an unchecked, affirmative opt-in, the same sub calls `POST /sub/connections/:gcId/certificate-access` with JSON `{ "consent": true, "consent_version": "<version>", "gc_user_id": "<gc_user_id>", "gc_company_name": "<gc_company_name>", "connection_id": "<connection_id>" }`. A changed identity/connection or stale disclosure fails closed. The grant covers all current/future synthetic files belonging to that sub's associated profile.
3. That GC calls `GET /gc/certificates/:coiId` with its bearer JWT; both the relationship and this file grant must currently be active and unrevoked, with matching identities and connection instance. A sub owner calls `GET /sub/certificates/:coiId` with its own JWT; it must currently own the record. These stream the synthetic file bytes, never its storage location.
4. The sub calls `DELETE /sub/connections/:gcId/certificate-access` to revoke only the file grant. Existing `DELETE /sub/connections/:gcId` revokes the relationship as well. Each new connection requires a fresh file disclosure and grant.

These are backend endpoints only; there is no new UI, browser session design, or production use case. Token theft and the permissive legacy app remain outside the guarantee.

## Exact tests

With Node 22 and dependencies installed, from the worktree root:

```sh
npm run test:private-certificates --workspace=server
npm run test:relationships --workspace=server
npm run test:invitations --workspace=server
npm run build --workspace=server
```

The new suite uses only temporary synthetic SQLite databases and temporary synthetic files. It covers PDF and allowed image streams; default-off and production gates; authentication and database role changes; owner and cross-tenant access; separate affirmative, identity/connection-bound consent; grant and connection revocation and reconnection; `no-store`; MIME allowlist and magic mismatches; unsafe IDs, missing files, directory and file symlinks, hard links and non-files; configuration changes and private-root permissions. These tests do not establish application-wide confidentiality or production security.
