#!/usr/bin/env bash
# Synthetic local integration only. Never points at an existing database.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
PG_BIN="${PG16_BIN:-/usr/lib/postgresql/16/bin}"
for bin in initdb pg_ctl psql createdb; do [[ -x "$PG_BIN/$bin" ]] || { echo 'PostgreSQL 16 binaries required' >&2; exit 1; }; done
umask 077
mkdir -p "$ROOT/.work"
WORK="$(mktemp -d "$ROOT/.work/pilot-e2e.XXXXXXXX")"
CHILD=""
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$CHILD" ]]; then kill -TERM "$CHILD" 2>/dev/null || true; wait "$CHILD" 2>/dev/null || true; fi
  if (( status != 0 )); then
    for log in "$WORK/server.log" "$WORK/vite.log" "$WORK/postgres.log"; do
      if [[ -f "$log" ]]; then printf '\n--- %s ---\n' "${log##*/}" >&2; tail -n 40 "$log" >&2; fi
    done
  fi
  if [[ -f "$WORK/data/postmaster.pid" ]]; then
    if ! env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate -w stop >/dev/null; then
      echo "Unable to stop disposable PostgreSQL; preserved $WORK for manual cleanup" >&2; return 1
    fi
  fi
  rm -rf -- "$WORK"
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/initdb" -D "$WORK/data" -U pilot_admin -A trust --no-instructions >/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=Synthetic Pilot Test CA' -keyout "$WORK/ca.key" -out "$WORK/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' -keyout "$WORK/data/server.key" -out "$WORK/server.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > "$WORK/server.ext"
openssl x509 -req -in "$WORK/server.csr" -CA "$WORK/ca.crt" -CAkey "$WORK/ca.key" -CAcreateserial -days 1 -extfile "$WORK/server.ext" -out "$WORK/data/server.crt" >/dev/null 2>&1
chmod 600 "$WORK/data/server.key"
env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/pg_ctl" -D "$WORK/data" -l "$WORK/postgres.log" -o "-F -h 127.0.0.1 -p $PORT -k $WORK -c ssl=on" -w start >/dev/null
psql_clean() { env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U pilot_admin "$@"; }
psql_clean postgres -c "CREATE ROLE pilot_owner LOGIN PASSWORD 'synthetic-only-password'" >/dev/null
env -i HOME="$WORK" PATH=/usr/bin:/bin "$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" -U pilot_admin -O pilot_owner pilot_connection_e2e
psql_clean postgres -c 'REVOKE CONNECT ON DATABASE pilot_connection_e2e FROM PUBLIC' >/dev/null
env -i HOME="$WORK" PATH="$PATH" NODE_ENV=test PILOT_ALLOW=I_UNDERSTAND_DISPOSABLE_CONNECTION_ONLY PILOT_DB_NAME=pilot_connection_e2e PILOT_CONFIRM_DATABASE=pilot_connection_e2e PILOT_DB_USER=pilot_owner PILOT_DB_PASSWORD=synthetic-only-password PILOT_DB_PORT="$PORT" node --experimental-strip-types scripts/provision-connection-pilot.ts
printf 'Running actual pilot + limiter + connection-only shell on synthetic loopback data\n'
env -i HOME="$WORK" PATH="$PATH" NODE_ENV=test E2E_WORK="$WORK" E2E_PG_PORT="$PORT" python3 client/tests/pilot-e2e/test_pilot.py &
CHILD=$!
if wait "$CHILD"; then CHILD=""; else result=$?; CHILD=""; exit "$result"; fi
