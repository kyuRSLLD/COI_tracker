# SafeCOI: staged verification and admin MFA

This branch is a development build, **not production-ready**. It must not be merged into the Railway deployment until the release blockers below are resolved. Do not upload real insurance documents to a development environment.

## What is implemented

- Subcontractors can choose a PDF, JPEG, or PNG from a device or take a photo. The server validates file contents and saves a private draft; no policy, coverage, date, or approval is invented. Production upload requires a properly configured private S3 bucket.
- An extensible directory lists Travelers, The Hartford, and Nationwide as **not connected**. No carrier sign-in or policy retrieval is implemented. Carrier credentials must never be entered into SafeCOI unless a separately approved, secure integration is designed.
- When AWS S3 and Textract are configured, a request-driven asynchronous Textract analysis can return lines and cautious, sourced field proposals. Those proposals are unverified and may be unavailable. No real AWS job has been tested. The caller must poll the status endpoint.
- General contractors can enter project requirements, and a separate rules engine compares structured observations to those requirements while treating ambiguous or missing evidence as needing review. A passing comparison is not insurance verification, an endorsement check, or approval.
- Admin sign-in has an authenticator-app TOTP enrollment and challenge implemented in code, with encrypted secrets and server-side session enforcement. This has been tested in an isolated SQLite environment only. It is **not live or enabled** and does not provide SMS or backup/recovery codes.

## Important gaps

1. Uploaded drafts are visible only to their subcontractor. They are **not yet delivered to a GC review queue**, and OCR proposals are **not yet linked to project requirements for a review-and-approve workflow**.
2. Carrier login requires carrier/partner approval and a real, consent-based integration; placeholder cards do not provide it. AWS account, bucket, permissions, and Textract configuration have not been provided or tested.
3. The existing production application's legacy routes have serious cross-account authorization and document privacy gaps. Restrict and test every tenant-owned resource, share link and file before using with real customer records. Legacy documents and previously issued URLs may remain accessible; hiding original document links in a client report does not fix every access path.
4. Admin MFA requires secure first-enrollment and account recovery, password throttling, transaction/race fixes, session revocation, and PostgreSQL integration tests. Default or known administrator passwords must be replaced before enrollment. An unclaimed account protected only by a known password could be enrolled by an attacker.
5. Configure a stable, random `MFA_ENCRYPTION_KEY` and strong `JWT_SECRET` in Railway's secret manager, securely back up the MFA encryption key, and establish an operator-controlled recovery process **before** enabling MFA. Never put secrets in the repository or chat. A missing or changed MFA key prevents administrator sign-in or makes existing factors inaccessible.
6. Disable destructive/demo bootstrap and seed processes in production and verify Railway deployment configuration. Never run `seed` against a production database; the seed erases data.
7. The existing legacy integration test invokes destructive `seed()`. Run it only inside a disposable database. Update that suite for administrator MFA and the new upload behavior. Review dependencies, pin the deployment build, and perform production-equivalent tests before release.

## Isolated tests

Run the focused tests with no production environment variables; each creates disposable local data:

```sh
for f in server/test/phone.test.ts server/test/admin-mfa.test.ts server/test/ocr-extract.test.ts server/test/verification.test.ts server/test/sub-documents.test.ts; do
  env -i PATH="$PATH" HOME=/tmp AWS_EC2_METADATA_DISABLED=true node --experimental-strip-types --test "$f" || exit 1
done
npm run build
```

Mocked tests are not a substitute for testing a private S3 bucket, Textract, approved insurance integrations, Railway Postgres, and full multi-tenant access controls.
