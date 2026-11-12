# Connection-only pilot schema provisioner — local, new database only

**Not a production migration or deployment tool.** `scripts/provision-connection-pilot.ts` is a manually invoked, one-shot provisioner for a **brand-new, empty, dedicated, isolated PostgreSQL 16 database on a trusted local host**. It never accepts a remote host or URL, creates a database/role, seeds, adds application users, starts the app, applies optional features, changes maintenance, or modifies an existing production database. Do not run it against production, a shared cluster/database, existing data, an SSH tunnel, port forward, proxy, or a remote service exposed on loopback. A loopback address, a name and a confirmation do not prove isolation. Keep the cluster and its users isolated by external controls; this tool does not independently attest the server's identity or block later connections.

## Schema analysis and scope

The real secure-v2 registration, auth, GC/sub consent, fresh-profile evidence, and owner services require the legacy-shaped `users`, `user_phones`, `subcontractors` and `cois` base tables. The provisioner creates just these four (and the phone lookup index), matching their definitions in `server/src/db/db.ts`. It **does not call** that initializer: it also creates unrelated legacy tables, runs ALTER statements and backfills companies. The provisioner then calls the actual source migrations on one dedicated connection, in this order:

1. `001_owner_foundation` (needed by the GC owner router in the composition; cois needs the matching unique composite key).
2. `002_gc_sub_consent` (requires base users, subcontractors, cois).
3. `003_auth_v2` (requires base users).
4. `004_registration_v2` (requires base users/subcontractors; registration additionally writes user_phones, and fresh profiles use the previous consent and auth layers).
5. `005_fresh_sub_profile_evidence` (requires version 1 of the consent, auth and registration ledgers; references both profile mappings).

Each existing migration commits its own DDL and ledger in its own transaction. The script checks its `applied` result, calls the same function again to check `already-applied`, and compares exactly one ledger row's version and checksum to fixed expected values. Before connecting, it checks the exact source-file SHA-256 pins for all five migrations. Pins and checksums must be independently reviewed and deliberately updated if those source files change, including harmless comments. Source pinning is an accidental-drift guard, not a sandbox for untrusted code: imports execute first and local code, paths, dependencies, privileges and the machine must be trusted. The ledger checks do not prove complete schema integrity after provisioning.

No anonymous reports, private certificate metadata, self-reported COI metadata, private file, or file rate-limit migration is applied. The tool also does **not** provision `pilot_rate_buckets_v1` or any independently developed pilot limiter schema. A composition relying on such a table will fail closed until a separately reviewed, explicitly authorized provisioning procedure exists; do not mistake this schema for a fully runnable pilot. Metadata and files must remain disabled. It supplies no application DB grants, secrets, JWT keys, SES, limiter, routing, or infrastructure.

## Gates and assumptions

All are required; a refusal is not proof that every unsafe condition was detected:

- Explicit `PILOT_ALLOW=I_UNDERSTAND_DISPOSABLE_CONNECTION_ONLY`, a `pilot_connection_` database name, and an identical independently supplied `PILOT_CONFIRM_DATABASE`. Provide an explicit canonical decimal local port, database-owner user and password. No command-line arguments, URL, host override, inherited `PG*`, `SECURE_V2_DB_*`, unsupported `PILOT_DB_*` variables, or `DATABASE_URL` are accepted; `NODE_ENV=production` is refused. The tool connects only to numeric `127.0.0.1`, without TLS, for this strictly local case.
- PostgreSQL must report version 16, the exact requested database, login/session owner, loopback client/server addresses and port, and fixed `public,pg_catalog` search path. The database owner role must not itself have superuser, CREATEDB, CREATEROLE, REPLICATION, or BYPASSRLS attributes. The public schema must be owned by that user or `pg_database_owner` and be creatable by the user. PUBLIC or other roles must not be granted CONNECT on the database, nor CREATE on public. An administrator must prepare these restrictions before running the tool.
- No other active session, extra user schema, public relations/types/routines/operators/collations/conversions/operator classes/families/text-search objects/statistics, extra extension, event trigger, publication/subscription, or foreign server/wrapper may be present. The tool obtains a session advisory lock to reject cooperating parallel runs. These catalog and ACL checks are point-in-time checks, **not a database lock or comprehensive proof of pristine origin**. Superusers, inherited role membership, later sessions, proxies, malicious administrators or concurrent noncooperating writers can bypass assumptions. Independently fence every other writer and connection for the entire operation and validate all privileges/ownership outside the tool. Use only a freshly created database from a trusted pristine template and an isolated disposable cluster. No arbitrary SQL or resume mode is available.
- The default public database CONNECT privilege normally needs explicit revocation when the administrator creates the dedicated database. The provisioner does not revoke privileges, terminate sessions, or grant application permissions. Trust authentication, used by the test harness, is appropriate only on a fully isolated disposable test host. Use appropriately secured local authentication for any non-test environment.

## Invocation

With Node 22+, installed project dependencies, a locally created and independently verified empty dedicated database, non-elevated owner role, and every other connection excluded, inject the owner password through an approved secret mechanism. Do not paste it into a shell history or logs. For example, after setting the variables securely in the calling process, run from the repository root:

```sh
env -i HOME="$HOME" PATH="$PATH" \
  PILOT_ALLOW=I_UNDERSTAND_DISPOSABLE_CONNECTION_ONLY \
  PILOT_DB_NAME="$PILOT_DB_NAME" PILOT_CONFIRM_DATABASE="$PILOT_CONFIRM_DATABASE" \
  PILOT_DB_USER="$PILOT_DB_USER" PILOT_DB_PASSWORD="$PILOT_DB_PASSWORD" \
  PILOT_DB_PORT="$PILOT_DB_PORT" \
  node --experimental-strip-types scripts/provision-connection-pilot.ts
```

Environment variables remain visible to sufficiently privileged local processes; securely inject, limit access, protect crash dumps, and clear/rotate credentials as appropriate. Do not copy a production secret into this local pilot. No credentials or SQL error details are printed by the tool. Its static stage labels are not a substitute for an external audit.

## Commit and failure semantics

The four base tables/index are one transaction. Thereafter **each migration has its own transaction**; this is not a single all-or-nothing migration. Earlier steps remain committed if a later step fails. Each migration attempts rollback on errors, but connection loss can make even a commit/rollback outcome ambiguous. Log lines report a step only after a successful commit response; absence of a line does not prove no commit occurred. On any error, stop, independently inspect the isolated target if needed, and **discard/recreate the entire dedicated database** under a separately authorized DBA procedure. Do not blindly retry, manually clean selected tables, resume, or use this on existing data. A rerun intentionally refuses the now-nonempty schema.

## Local verification

```sh
bash scripts/test-connection-pilot.sh
./node_modules/.bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop --skipLibCheck --allowImportingTsExtensions scripts/provision-connection-pilot.ts scripts/test-connection-pilot.test.ts
```

The harness initializes and destroys a temporary loopback-only PG16 cluster under `.work`, with synthetic credentials, a non-elevated owner, and separate throwaway databases; it clears inherited PG settings. It checks pre-connection guards and source-pin rejection; refusal of existing tables, routines, extra schemas, public access, active sessions, competing lock and reruns; rollback of the real auth migration's DDL and ledger after an injected mid-step failure; the exact migration results, ledgers, empty data and omitted features; and a real synthetic registration into fresh profile evidence. It uses isolated HTTP and mocked message delivery. A port allocation/start race remains; do not retry against another server on startup failure. Stop failure preserves the test directory for manual cleanup.

These tests do not establish readiness, production schema compatibility, deployment safety, complete authorization behavior, real SES, production network/TLS, multi-instance abuse protection, concurrent noncooperating DDL protection, privilege correctness, or restore procedures. Independent review of the source and full runtime composition, security controls, grant model, operational isolation, backups/restore, and every release blocker remains necessary before separately authorized use. Do not enable maintenance bypass or expose the pilot based on these tests.
