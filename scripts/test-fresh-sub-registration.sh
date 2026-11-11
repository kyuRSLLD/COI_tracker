#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
PG_BIN="${PG16_BIN:-/usr/lib/postgresql/16/bin}"
[[ -x "$PG_BIN/initdb" && -x "$PG_BIN/pg_ctl" && -x "$PG_BIN/createdb" ]] || { echo 'Local PostgreSQL 16 binaries required' >&2; exit 1; }
mkdir -p "$ROOT/.work"
WORK="$(mktemp -d "$ROOT/.work/fresh-sub-pg.XXXXXXXX")"
cleanup() {
  if [[ -f "$WORK/data/postmaster.pid" ]]; then
    if ! env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate -w stop >/dev/null; then
      echo "Could not stop temporary PostgreSQL; preserving $WORK" >&2
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
env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" -U synthetic registration_test_disposable
for name in gc_sub_test_disposable auth_v2_test_disposable secure_v2_test_disposable owner_foundation_test_disposable; do
  env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" -U synthetic "$name"
done
printf 'Running registration and consent integration on disposable local PostgreSQL 16\n'
env -i HOME="$WORK" PATH="$PATH" NODE_ENV=test \
  REGISTRATION_TEST_PG_URL="postgresql://synthetic@127.0.0.1:$PORT/registration_test_disposable" \
  GC_SUB_TEST_PG_URL="postgresql://synthetic@127.0.0.1:$PORT/gc_sub_test_disposable" \
  AUTH_V2_TEST_PG_URL="postgresql://synthetic@127.0.0.1:$PORT/auth_v2_test_disposable" \
  GC_OWNER_V2_TEST_PG_URL="postgresql://synthetic@127.0.0.1:$PORT/owner_foundation_test_disposable" \
  SECURE_V2_TEST_PG_URL="postgresql://synthetic@127.0.0.1:$PORT/secure_v2_test_disposable" \
  node --experimental-strip-types --test server/test/registration-v2.test.ts server/test/gc-sub-consent.test.ts \
    server/test/gc-sub-connections-v2.test.ts server/test/gc-sub-auth-races.test.ts server/test/auth-v2-pg.test.ts server/test/secure-v2-synthetic.test.ts \
    server/test/gc-owner-v2.test.ts server/test/gc-owner-v2-auth-races.test.ts
