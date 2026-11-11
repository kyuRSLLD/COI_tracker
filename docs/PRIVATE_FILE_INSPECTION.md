# Private-file inspection — disconnected prototype

## Status and security boundary

This is a **not deployed** building block, exercised with the file service only in an isolated synthetic test. It does not start a service, change application routes, store/upload a file, interact with S3, expose bytes, send data to a public cloud, or initiate TCP connections. It is not called by the existing private certificate storage or any app entrypoint. The existing signature-only storage path and legacy routes remain unchanged. Do not disable maintenance mode or treat this prototype as fixing existing upload paths.

The adapter gives evidence of particular checks, **not proof a file is safe, verified, malware-free, or suitable to render or share**. Parsers can contain bugs, permissively repair some malformed content, miss bad structures, or be bypassed by polyglots; antivirus has detection gaps and depends on correct engine/signature configuration. It does not perform content disarm, sanitization, metadata stripping, script/action/attachment removal, or protect viewers. Encrypted PDFs are rejected. Full formal validation or complete malware detection is not achievable here; parser/import/render errors and missing dependencies reject, not fall back to signatures.

## API and immutable-byte binding

`inspectPrivateFile(input: Uint8Array, declaredMime, trustedConfig)` accepts a previously size-limited **in-memory** byte array and exactly one of `application/pdf`, `image/jpeg`, `image/png`, `image/webp`. It makes a private copy synchronously before its first `await`, validates it, transmits that same copy to a local scanner, and only then returns an immutable `{ mime, size, sha256 }` record. The caller can mutate the original while inspection is running without changing that snapshot. It does not return or store the snapshot. `sha256` is lowercase hexadecimal. Treat the digest and all metadata as potentially sensitive; avoid logging them or the input.

**No production upload path is wired to this building block, and no caller can safely use this record to authorize a different mutable buffer or a path.** A matching record does not automatically establish that future bytes are those inspected, and checking a path/hash then reopening it is a TOCTOU vulnerability. Before any production integration, independently review and implement an immutable quarantine/handoff that binds the exact scanned object version to its final use, including atomic storage, write access controls, size/hash verification against the exact bytes committed/read, overwrite prevention, races, cancellation and failure rollback. Merely rehashing a mutable stream while simultaneously releasing/uploading it can release unchecked bytes before mismatch detection. The synthetic file service checks a private snapshot and storage receipt, but its in-memory test is not a production immutable-storage handoff.

Failures throw `InspectionError` with a generic message and one of `invalid_input`, `format_rejected` (also includes worker failures), `scanner_failure`, or `malware_detected`. No signature name, scanner reply, parser diagnostic, filename, or document content is emitted. Untrusted clients should receive a generic error; avoid logging raw exception objects or configuration.

## Checks and limits

* Size is 1 through `maxFileBytes`, inclusive, with a hard 10 MiB maximum. The trusted caller must cap input and time **before allocating/reading** this array; this API is not an HTTP/multipart/stream reader and cannot enforce limits earlier. It copies the entire input. Apply server-wide concurrency, CPU, memory, request-duration, rate, and per-user quotas before any future use.
* Declared type must match a signature. Pillow verifies and then fully decodes each image frame, with PNG chunk CRC/end checks, JPEG end marker, and exact WebP RIFF length checks. Limits: 20 frames, 20 million pixels/frame and 40 million total pixels. Native Pillow codecs are used. These checks do not prove every structural detail or reject all polyglots.
* pypdf strict mode opens the PDF, refuses encryption, enforces 1–30 pages and at most 10,000 indexed objects, resolves indexed objects and decodes their streams, and parses page content operators. Poppler `pdftoppm` then renders all pages at a bounded 256-pixel scale to the null device. A nonzero exit or any renderer stderr rejects. Legitimate unusual files may be rejected. Parsing/rendering is not a PDF specification conformance proof, sanitization, or action/attachment inspection.
* A child process gets no inherited application environment, stdio output is not logged, no shell is used by the adapter, and it runs via an absolute `prlimit` path with configurable wall deadline, virtual-memory and CPU ceilings, plus zero core/file-size limits and 32 file descriptors. On failure/deadline the process group is killed. A zero-exit executable alone cannot pass: the worker must emit an exact fixed completion marker after checks. CPU/address-space rlimits are **per process**, not aggregate; PDF rendering launches another process. The worker/renderer must be trusted and immutable. Limits reduce impact but **are not a security sandbox**: no UID isolation, network namespace, filesystem confinement, seccomp, cgroup/aggregate process limit, or syscall policy is implemented. A compromised native decoder may access the worker's OS privileges and resources. These gaps must be closed externally before handling untrusted production documents.
* The adapter only opens a configured absolute local Unix socket (no host/port or network destination). ClamAV `zINSTREAM` is sent in at most 64 KiB data chunks, with backpressure, bounded request size, final zero-length frame, and a deadline covering connect, write and response. It requires a completed local write and an exact `stream: OK` NUL-framed response followed by connection close; `FOUND` rejects, and unavailable, connection/stream errors, timeouts, unexpected/multiple/oversized replies and all other responses reject. Detection names are discarded. This assumes a trusted genuine daemon implementing non-session ClamAV INSTREAM, not an attacker-controlled socket; the adapter cannot independently prove what that daemon did.

## Trusted configuration example (not wired or enabled)

All values must come from trusted deployment configuration, never a request. For example:

```ts
const config = {
  socketPath: '/run/clamav/clamd.ctl', // access-controlled local Unix socket
  maxFileBytes: 10 * 1024 * 1024,
  scannerDeadlineMs: 10000,
  parserDeadlineMs: 10000,
  pythonPath: '/opt/private-inspection-venv/bin/python',
  prlimitPath: '/usr/bin/prlimit',
  pdfRendererPath: '/usr/bin/pdftoppm',
  parserMemoryBytes: 512 * 1024 * 1024,
  parserCpuSeconds: 10,
}
// A trusted server caller may await inspectPrivateFile(boundedBytes, mime, config).
// The record by itself must NOT be used to release different or mutable bytes.
```

Permitted configuration ranges are enforced in the adapter: 1 byte–10 MiB for max bytes, 10–120,000 ms deadlines, 128 MiB–1 GiB parser virtual memory and 1–60 CPU seconds; all paths must be absolute. Socket path is limited to 100 UTF-8 bytes. The worker path is resolved alongside the adapter from `import.meta.url`; any future transpilation/bundle/container build must explicitly copy `privateFileInspectionWorker.py` to the correct runtime location and test that artifact. Existing `npm run build` does not build or package this disconnected module.

## Host dependencies and deployment gaps

Tested locally with Node 22.23.4, Python 3.12, Pillow 13.0.0 (WebP enabled), pypdf 6.21.4, Poppler `pdftoppm` 24.02.0, and Linux util-linux `prlimit`. `server/private-file-inspection-requirements.txt` lists tested direct Python versions; it is **not a complete hash-locked environment**, does not pin native codecs/system libraries/Poppler or establish vulnerability status, and does not replace supply-chain review. The worker does not check installed library versions. Before deployment, create a reviewed, reproducible, patched Python/native/system dependency lock and image, including WebP support; test upgrades and set explicit trusted executable paths. Missing Pillow/pypdf/codec/Poppler/prlimit or incompatible parser behavior fails closed. The isolated test environment installs the listed Python packages only into a disposable local virtualenv, not system Python. The existing npm dependencies were used for a project build and targeted TypeScript check; `npm ci`, dependency audit, and reproducible supply-chain verification were not run. The scanner and worker are not included in the application build.

Before production consideration, at minimum:

1. Run the parser and ClamAV under separately isolated, non-root identities in constrained containers/sandboxes with read-only filesystems, no credentials, denied egress/network except the explicitly required local socket, seccomp/AppArmor or equivalent, aggregate CPU/memory/PID/disk limits, tight timeouts, process cleanup and an independently reviewed executable/worker supply chain. `prlimit` is defense in depth, not the isolation itself. Consider parser and scanner compromise and all host/socket permissions.
2. Provision and test a maintained local clamd, current signatures, least-privilege socket directory/ownership/permissions, availability/health monitoring, daemon resource quotas and alerting. Set its INSTREAM size and scan limits to cover the adapter cap, and ensure limit-exceeded, encrypted/unsupported content, partial scans and scan errors are reported as failures rather than silent clean verdicts. Validate actual configuration and behavior with the exact daemon version. An out-of-date/misconfigured or spoofed local socket can return `OK` without adequate scanning. The tests use a mock, not a real clamd.
3. Design immutable quarantine and final-object binding as above, authoritative authorization/consent and revocation, private access controls, retention/deletion, viewer/download defenses, logging/redaction and incident handling. Add upstream request caps and concurrency management, test ambiguous failures and real-world image/PDF corpora, and conduct an independent security review. Do not deploy or wire the app until these gaps are addressed.

## Local verification

From the worktree root, with Python venv support, Poppler and prlimit available, use an isolated virtualenv and local mock scanner:

```sh
python3 -m venv .work/inspection-venv
.work/inspection-venv/bin/pip install -r server/private-file-inspection-requirements.txt
PRIVATE_INSPECTION_TEST_PYTHON="$PWD/.work/inspection-venv/bin/python" node --experimental-strip-types --test server/test/private-file-inspection.test.ts
```

The test suite uses generated, synthetic PDF/JPEG/PNG/WebP fixtures and local temporary Unix-socket mock scanners only. It tests format spoofing, truncation and corruption, encrypted PDF, image dimension limit, declared MIME and byte boundaries, clean/malware/error/malformed/oversized scanner responses, unavailable and stalled scanners, parser executable failure/timeout, multi-chunk streaming, and concurrent mutation of the caller's bytes. It makes no AWS calls and does not start the production app. The PDF fixtures and other inputs contain no real user content. Passing these tests does not validate daemon configuration, sandbox enforcement, deployment, every malformed file, app authorization, or any real cloud infrastructure.

The optional file-service composition test described in `docs/SELF_REPORTED_PRIVATE_FILES.md` uses the real parser for a synthetic PNG, a mock ClamAV socket, and synthetic in-memory storage. It is not a real ClamAV or S3 test.
