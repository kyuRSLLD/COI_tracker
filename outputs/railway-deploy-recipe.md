# Deployment Recipe — COI Shield on Railway Project "brilliant-nature"

## 1. Open the existing project

Navigate to [railway.com](https://railway.com) (or [railway.app](https://railway.app)) and open the project named **`brilliant-nature`**.

## 2. Add PostgreSQL (if not already present)

Click **+ New → Database → PostgreSQL**. Railway creates the database and automatically exposes the `DATABASE_URL` environment variable to every service in this project.

## 3. Add the application service

Click **+ New → GitHub Repo** and select **`kyuRSLLD/COI_tracker`**. Railway will auto-detect the root `Dockerfile` and start building the container image.

## 4. Set environment variables

In the newly created COI Tracker service, open the **Variables** tab and add the following. Secrets are generated per-environment and never stored in the repository — use the values from your untracked `.env.production` file (created automatically by the deployment script), or generate one with `openssl rand -hex 32`:

| Variable | Value | Notes |
|---|---|---|
| `JWT_SECRET` | *(use value from local .env.production)* | Random 64-character signing secret |
| `CLIENT_URL` | `https://safecoi.com` | Used for share and magic-upload links |
| `NODE_ENV` | `production` | Enables production optimizations |
| `AWS_REGION` | *(optional)* `us-east-1` | S3 uploads — local disk fallback until set |
| `AWS_S3_BUCKET` | *(optional)* `coi-shield-certificates` | Private bucket |
| `AWS_ACCESS_KEY_ID` | *(optional)* | IAM credentials |
| `AWS_SECRET_ACCESS_KEY` | *(optional)* | IAM credentials |

`PORT` and `DATABASE_URL` are injected automatically by Railway — do not override them.

## 5. Seed initial data

Once the build finishes and the service shows **Active**, open the service's **Shell** tab and run:

```bash
npm run seed
```

This populates the demo account (`gc@apexconstruction.demo` / `password123`), the eight demo subcontractors with mixed expiration states, the Riverside Commerce Center project, the client share link `/share/rcc-meridian-2026`, and the upload link `/upload/upload-drywall-2026`.

## 6. Attach your custom domain safecoi.com

1. In the COI Tracker service go to **Settings → Networking → Custom Domain**.
2. Type **`safecoi.com`** and Railway will display a CNAME target domain.
3. In your [Cloudflare dashboard](https://dash.cloudflare.com) (already logged in), open **safecoi.com → DNS → Records → Add record**:
   - Type: `CNAME`, Name: `@`, Target: the Railway CNAME domain, Proxy: **DNS only** (gray cloud)
   - Add a second record for `www` with the same target.
4. Railway will verify the DNS and issue the free SSL certificate within two minutes.

## 7. Verify

Visit **https://safecoi.com** and confirm the landing page loads, then test `/demo`, `/share/rcc-meridian-2026`, and `/upload/upload-drywall-2026`.

**Fastest path:** after a one-time `npx --yes @railway/cli login`, just run `bash scripts/railway-deploy.sh` — it creates your local `.env.production` with a fresh JWT secret, sets the variables on Railway, deploys, and seeds the database automatically.
