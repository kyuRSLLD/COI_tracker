#!/usr/bin/env bash
# Deploy COI Shield to Railway project "brilliant-nature"
# Usage:
#   1. npx --yes @railway/cli login (one-time)
#   2. bash scripts/railway-deploy.sh
# Secrets are read from the untracked .env.production file (never committed to git)
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env.production"
if [ ! -f "$ENV_FILE" ]; then
  echo "==> Creating local $ENV_FILE with generated secrets (this file is gitignored)..."
  JWT_SECRET=$(openssl rand -hex 32)
  cat > "$ENV_FILE" <<EOF
JWT_SECRET=$JWT_SECRET
CLIENT_URL=https://safecoi.com
NODE_ENV=production
EOF
fi

JWT_SECRET=$(grep -E '^JWT_SECRET=' "$ENV_FILE" | cut -d= -f2-)
CLIENT_URL=$(grep -E '^CLIENT_URL=' "$ENV_FILE" | cut -d= -f2-)
NODE_ENV_VAL=$(grep -E '^NODE_ENV=' "$ENV_FILE" | cut -d= -f2-)

echo "==> Linking Railway project brilliant-nature..."
npx --yes @railway/cli link --project brilliant-nature 2>/dev/null || npx --yes @railway/cli link

echo "==> Setting environment variables (secrets come from untracked $ENV_FILE)..."
npx --yes @railway/cli variable set JWT_SECRET="$JWT_SECRET"
npx --yes @railway/cli variable set CLIENT_URL="$CLIENT_URL"
npx --yes @railway/cli variable set NODE_ENV="$NODE_ENV_VAL"

echo "==> Deploying..."
npx --yes @railway/cli up

echo "==> Seeding database..."
npx --yes @railway/cli run npm run seed

echo "==> Deployment complete. Configure your custom domain in the Railway dashboard:"
echo "    https://railway.com/dashboard -> brilliant-nature -> Settings -> Custom Domain -> safecoi.com"
