#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
PG_BIN="${PG16_BIN:-/usr/lib/postgresql/16/bin}"
[[ -x "$PG_BIN/initdb" && -x "$PG_BIN/pg_ctl" && -x "$PG_BIN/psql" && -x "$PG_BIN/createdb" ]] || { echo 'Local PostgreSQL 16 binaries required' >&2; exit 1; }
mkdir -p "$ROOT/.work"
WORK="$(mktemp -d "$ROOT/.work/connection-pilot-pg.XXXXXXXX")"
cleanup() {
  if [[ -f "$WORK/data/postmaster.pid" ]]; then
    if ! env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate -w stop >/dev/null; then
      echo "Could not stop temporary PostgreSQL; preserving $WORK" >&2; return 1
    fi
  fi
  rm -rf -- "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/initdb" -D "$WORK/data" -U pilot_admin -A trust --no-instructions >/dev/null
env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/pg_ctl" -D "$WORK/data" -l "$WORK/postgres.log" -o "-F -h 127.0.0.1 -p $PORT -k $WORK" -w start >/dev/null
psql_clean() { env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U pilot_admin "$@"; }
psql_clean postgres -c "CREATE ROLE pilot_owner LOGIN PASSWORD 'synthetic-only'" >/dev/null
for name in pilot_connection_success pilot_connection_dirty pilot_connection_function pilot_connection_schema pilot_connection_grant pilot_connection_failure pilot_connection_active pilot_connection_lock; do
  env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" -U pilot_admin -O pilot_owner "$name"
  psql_clean postgres -c "REVOKE CONNECT ON DATABASE $name FROM PUBLIC" >/dev/null
done
printf 'Running connection pilot tests on a disposable loopback PostgreSQL 16 cluster\n'
env -i HOME="$WORK" PATH="$PATH" NODE_ENV=test PILOT_TEST_PORT="$PORT" node --experimental-strip-types --test --test-concurrency=1 scripts/test-connection-pilot.test.ts
