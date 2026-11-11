#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PG_BIN="${PG16_BIN:-/usr/lib/postgresql/16/bin}"
[[ -x "$PG_BIN/initdb" && -x "$PG_BIN/pg_ctl" && -x "$PG_BIN/createdb" ]] || { echo 'Local PostgreSQL 16 required' >&2; exit 1; }
mkdir -p .work
WORK="$(mktemp -d "$PWD/.work/private-files-pg.XXXXXXXX")"
cleanup() {
  if [[ -f "$WORK/data/postmaster.pid" ]]; then
    if ! env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate -w stop >/dev/null; then echo "Could not stop temporary PostgreSQL; preserving $WORK" >&2; return 1; fi
  fi
  rm -rf -- "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/initdb" -D "$WORK/data" -U synthetic -A trust --no-instructions >/dev/null
env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/pg_ctl" -D "$WORK/data" -l "$WORK/postgres.log" -o "-F -h 127.0.0.1 -p $PORT -k $WORK" -w start >/dev/null
env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" -U synthetic gc_sub_test_disposable
env -i HOME="$WORK" TMPDIR="$PWD/.work" PATH="$PATH" NODE_ENV=test \
  PRIVATE_INSPECTION_TEST_PYTHON="${PRIVATE_INSPECTION_TEST_PYTHON:-}" \
  GC_SUB_TEST_PG_URL="postgresql://synthetic@127.0.0.1:$PORT/gc_sub_test_disposable" \
  node --experimental-strip-types --test server/test/self-reported-private-files.test.ts
