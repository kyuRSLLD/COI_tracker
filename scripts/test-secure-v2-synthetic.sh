#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
PG_BIN="${PG16_BIN:-/usr/lib/postgresql/16/bin}"
[[ -x "$PG_BIN/initdb" && -x "$PG_BIN/pg_ctl" && -x "$PG_BIN/createdb" ]] || { echo 'Local PostgreSQL 16 binaries required' >&2; exit 1; }
mkdir -p "$ROOT/.work"
WORK="$(mktemp -d "$ROOT/.work/secure-v2-pg.XXXXXXXX")"
cleanup() {
  if [[ -f "$WORK/data/postmaster.pid" ]]; then
    if ! env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate -w stop >/dev/null; then
      echo "Could not stop temporary PostgreSQL; preserving $WORK for manual cleanup" >&2
      return 1
    fi
  fi
  rm -rf -- "$WORK"
}
trap cleanup EXIT INT TERM
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
# Never inherit PGHOST, PGOPTIONS, SSL settings, credentials, or application config.
env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/initdb" -D "$WORK/data" -U synthetic -A trust --no-instructions >/dev/null
env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/pg_ctl" -D "$WORK/data" -l "$WORK/postgres.log" -o "-F -h 127.0.0.1 -p $PORT -k $WORK" -w start >/dev/null
env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" -U synthetic secure_v2_test_disposable
printf 'Running synthetic HTTP integration on disposable local PostgreSQL 16\n'
env -i HOME="$WORK" PATH="$PATH" NODE_ENV=test SECURE_V2_TEST_PG_URL="postgresql://synthetic@127.0.0.1:$PORT/secure_v2_test_disposable" node --experimental-strip-types --test server/test/secure-v2-synthetic.test.ts
