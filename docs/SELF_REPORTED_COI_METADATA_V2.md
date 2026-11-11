# Self-reported COI metadata v2 — isolated implementation

This code is mounted only in the **synthetic-only**, independently opted-in test composition at `/api/v2/self-reported-coi-metadata`; it is not wired into the actual app or startup and remains production-disabled. No production database, AWS service, legacy table, certificate, client endpoint, or deployment is touched. There is no UI, rate limiter implementation, client sharing, document access, legacy backfill, or link based on a name or email. The profile QR creates only the existing profile connection and never creates a COI metadata grant.

## Data and consent

A currently authenticated `sub` with an active fresh email-control-only profile may create an immutable new record. The input is exactly `{carrier, effectiveDate, expirationDate, coverage}`. Dates are real `YYYY-MM-DD` calendar dates and expiration must not precede effective date. Carrier is trimmed, nonempty, and at most 200 characters. `coverage` contains 1–12 unique case-insensitive coverage-type labels (trimmed, nonempty, at most 100 characters), each with exactly `{type, limitCents}`; `limitCents` is an integer from 0 to 1,000,000,000,000, in USD cents. These are validation bounds, not assertions of insurance. No profile ID or ownership input is accepted. A correction/replacement is a new record and receives no inherited grants.

Records and grant history are separate from legacy `cois`, `gc_sub_coi_ownership`, and private certificates. The GC receives only record ID, profile ID, carrier, effective and expiration dates, allowed coverage fields, creation timestamp, and `reporting_status: self_reported_unverified`. Neither an expired policy date nor any other business deadline causes an automatic grant expiration: the dates are self-reported policy metadata, not an access guarantee or verification.

The owner can discover currently connected eligible GC account IDs and self-reported names; a GC role and name do not establish the business identity or authority of the account. Owner must affirm `share-one-self-reported-coi-metadata-v1` for one record and one selected GC. Display the exact consent returned by `/consent` **alongside the chosen record and GC account** before the owner affirms. Do not change that text under the same version. Every grant is revocable; a revoked grant cannot be restored. A later explicit grant creates a new history row. Connection revocation, connection replacement/reconsent, profile suspension, role change, account disabling, or account deletion durably revoke affected child grants. Reconnection, role restoration, or account recreation does not restore access. Current connection, profile, account, and role conditions are also checked on reads. No grant authorizes a file, public share, client access, future file, or replacement COI.

## Manual migration

`server/src/db/migrations/006_self_reported_coi_metadata.ts` exports `migrateSelfReportedCoiMetadataV1(client)`. An operator must review and explicitly invoke it on an **exclusive idle PostgreSQL connection**, only after backup, review of the schema and deployment plan, and review of the four prerequisite migrations. It begins/commits or rolls back its own transaction, takes an advisory lock, checks the exact known prerequisite versions and SHA-256 checksums, and stores/checks its own SHA-256 DDL checksum. Changed or unknown history fails closed. There is no automatic migration and no backfill. In the disposable combined test only, the metadata 006 is applied before anonymous reports 006. They use separate ledgers and distinct advisory locks, with idempotency, checksum isolation, and non-blocking lock independence tested. Runtime database credentials should have least privilege; the triggers protect application workflows, not a malicious database superuser or an operator who disables them.

## Router contract

`createSelfReportedCoiMetadataV2Router` is unmounted in production and enabled in the synthetic composition only by `unsafeTestOnlyEnableMetadata: true`. It requires an injected real `createV2Auth(...).requireAuth` and a shared atomic fail-closed rate limiter; use TLS, appropriate body/log redaction, and production security review before considering any future integration. The service independently validates the RS256 token and current auth-v2 user, account and session, locks state in the consent-service order, and rechecks session expiry after potentially blocking locks and before commit. API requests have no query parameters, use the bearer token, and return no-store responses; POSTs require JSON with no extra keys. Generic errors do not reveal record existence.

| Method | Path | Role | Request / response |
|---|---|---|---|
| GET | `/consent` | sub or GC | Exact version and text |
| GET | `/own` | sub | Own fresh-profile metadata records |
| POST | `/own` | sub | Strict metadata fields; returns new `{id}` |
| GET | `/connected-gcs` | sub | Eligible connected GC IDs/names |
| POST | `/grant` | sub | `{coiId, gcUserId, consentVersion, affirmative: true}` |
| POST | `/revoke` | sub | `{coiId, gcUserId}`; idempotent generic 204 |
| GET | `/granted` | GC | Explicitly granted records meeting current eligibility |

Integration tests use a disposable loopback PostgreSQL 16 database named `gc_sub_test_*` and real auth-v2 sessions. Example, after provisioning such a database: `GC_SUB_TEST_PG_URL=postgresql://USER@127.0.0.1:PORT/gc_sub_test_NAME node --experimental-strip-types --test server/test/self-reported-coi-metadata.test.ts`. The database URL guard is not a substitute for ensuring the database contains only synthetic disposable data.

**GC certificate/document access is NOT implemented in this metadata router.** Metadata consent is not document consent. The separate private-file service and its distinct v1 file consent exist only as a disconnected prototype; no anonymous report or file-service route or scanner is mounted in this composition. The test rate callback is not a production limiter. Run `bash scripts/test-fresh-sub-registration.sh` for the isolated combined PostgreSQL 16 suite; it contains both 006 migrations and file migration 007 in one synthetic schema, plus separate metadata, report and file-grant tests. The independent migration ledgers each use version 1; filename numbers are not their ledger versions.
