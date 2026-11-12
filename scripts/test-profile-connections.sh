#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PG_BIN="${PG16_BIN:-/usr/lib/postgresql/16/bin}"
[[ -x "$PG_BIN/initdb" && -x "$PG_BIN/pg_ctl" && -x "$PG_BIN/createdb" ]] || { echo 'Local PostgreSQL 16 binaries required' >&2; exit 1; }
WORK="$(mktemp -d /tmp/profile-connections-test.XXXXXXXX)"
cleanup() {
  if [[ -f "$WORK/data/postmaster.pid" ]]; then
    if ! env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate -w stop >/dev/null; then
      echo "Could not stop temporary PostgreSQL; preserving $WORK for manual cleanup" >&2
      return 1
    fi
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
printf 'Running connection route and consent tests on disposable local PostgreSQL 16\n'
env -i HOME="$WORK" PATH="$PATH" GC_SUB_TEST_PG_URL="postgresql://synthetic@127.0.0.1:$PORT/gc_sub_test_disposable" node --experimental-strip-types --test server/test/gc-sub-connections-v2.test.ts server/test/gc-sub-consent.test.ts
