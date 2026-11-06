# 🛡 COI Shield — Certificate of Insurance Tracker

> **Collect subcontractor certificates of insurance in seconds. Stay audit-ready. Share verified compliance with clients — with client-safe privacy built in.**

Official domain: **[safecoi.com](https://safecoi.com)** (registered on Cloudflare, nameservers `dane.ns.cloudflare.com` / `karina.ns.cloudflare.com`).

Inspired by [Ripley Fieldwork Tracker's](https://ripleyfieldworktracker.com/) "both sides of supervision, one place" model, COI Shield unifies all **three sides** of insurance compliance in one platform:

| Role | What they do |
|---|---|
| **General Contractor** | Request COIs, review coverage limits against company standards, track 30-day expiration countdowns, generate client portals |
| **Subcontractor** | Open a magic link — no app, no password — complete a 4-step wizard, attach ACORD PDF/photo, receive renewal reminders |
| **Client / Owner** | View live project compliance scorecards, verified coverage limits per trade, print reports — **with subcontractor contact info strictly stripped** |

The design and project structure match the patterns used for **lldrestaurantsupply.com** (`rs-lld-website`): a **React 18 + Vite + Tailwind CSS** frontend with a **Node/Express TypeScript** API backend, deployed to **Railway** with a **PostgreSQL** database and **Amazon S3** file storage.

---

## Key Features

- **Live expiration countdowns** — green (compliant), amber (expires ≤30 days), red (expired) badges on every policy and subcontractor row.
- **Client-safe sharing** — generate tokenized project share links (`/share/:token`). Subcontractor phone numbers, emails, contact persons, and addresses are stripped at the **API level and the UI level**. Clients see verified company names, coverage limits, policy numbers, carrier ratings, and expiration dates — all inquiries route back to the GC.
- **Self-service subcontractor upload wizard** — magic upload links (`/upload/:token`) with pre-filled company info, coverage line entry with Additional Insured / Waiver of Subrogation checkboxes, and file attachments.
- **GC review workflow** — verify submitted COIs against required GL/Auto/WC/Umbrella limits, mark Compliant / Needs Revision / Rejected with notes.
- **Printable compliance reports** — browser-print-ready client reports matching the shared table.
- **Email audit log** — every COI request and renewal reminder is logged for proof-of-notice compliance (simulation mode until SMTP is configured).
- **Batch renewal reminders** — one-click reminder to all subcontractors expiring within 30 days.
- **Railway + AWS S3 ready** — Dockerfile, `railway.json`, `Procfile`, `.env.example`, Postgres + SQLite dual adapter, S3 storage with local fallback.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite 5, Tailwind CSS 3, Lucide React, date-fns, canvas-confetti |
| Backend | Node.js 26 (native TS execution), Express 4, TypeScript, esbuild |
| Database | PostgreSQL (Railway) with automatic SQLite fallback for local development |
| Storage | Amazon AWS S3 with automatic local disk (`uploads/`) fallback |
| Auth | JWT bearer tokens + bcrypt password hashing |

---

## Quick Start (Local Development)

### 1. Prerequisites

Node.js 20+ (Node 26.13.0 + npm 11.20.0 already present on this machine).

### 2. Configure environment (optional for local)

```bash
cp .env.example .env
# SQLite + local uploads work out of the box with default values.
```

### 3. Seed demo data

```bash
npm run seed
```

This populates:
- Demo GC account: `gc@apexconstruction.demo` / `password123`
- 8 realistic subcontractors with varied COI expiration states (compliant, expiring in 14d, expiring in 5d, expired 18d ago, missing, pending review)
- Project "Riverside Commerce Center" with client share link `/share/rcc-meridian-2026`
- Sample magic upload links and simulated email audit logs

### 4. Start frontend and backend

```bash
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:5001`
- Or open the production build: `npm run build && npm start`

### 5. Demo shortcuts

- Click **"Live Demo"** on the landing page (or visit `/demo`) to auto-login as Apex Construction Group
- Client portal sample: `/share/rcc-meridian-2026`
- Subcontractor upload sample: `/upload/upload-drywall-2026`

---

## Railway Deployment (Project "brilliant-nature")

For the full step-by-step checklist with screenshots-ready instructions, see **[outputs/railway-deploy-recipe.md](outputs/railway-deploy-recipe.md)**.

1. Open your existing Railway project **`brilliant-nature`** at [railway.com](https://railway.com)
2. **Add a PostgreSQL service**: + New → Database → PostgreSQL (auto-injects `DATABASE_URL`)
3. **Connect this repository**: + New → GitHub Repo → select **`kyuRSLLD/COI_tracker`** (Railway auto-detects `Dockerfile`)
4. Set environment variables on the COI Tracker service (secrets are generated locally and never stored in the repo):
   - `JWT_SECRET` — random 64-char string (e.g. `openssl rand -hex 32`)
   - `CLIENT_URL` — `https://safecoi.com`
   - `NODE_ENV` — `production`
   - `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (optional)
5. After build succeeds, open the service shell tab and run `npm run seed` once
6. **Attach custom domain**: Settings → Networking → Custom Domain → **`safecoi.com`** → copy the Railway CNAME domain, then in your Cloudflare dashboard add CNAME `@` and `www` pointing to it with proxy **DNS only** (gray cloud). Railway issues free SSL automatically.

**Fastest path — CLI option** (after `npx --yes @railway/cli login` once, it generates your local `.env.production` secret file and deploys):

```bash
bash scripts/railway-deploy.sh
```

---

## Amazon S3 Configuration

1. Create a private S3 bucket (e.g. `coi-shield-certificates`)
2. Create an IAM user with this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::coi-shield-certificates/*"
    }
  ]
}
```

3. Add the four AWS env vars to `.env` (or Railway variables):
   `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`

When AWS vars are blank, the app gracefully falls back to local disk storage (`uploads/`).

---

## GitHub Repository

Source is live at **[github.com/kyuRSLLD/COI_tracker](https://github.com/kyuRSLLD/COI_tracker)**. To pull future changes:

```bash
cd "/Users/kyu/Desktop/COI Tracker"
git pull origin main
```

---

## Test Suite

16 automated integration tests including the **privacy verification** (confirms subcontractor phone numbers, emails, contact persons, and addresses are null in client share responses, and that GC contact info is preserved):

```bash
npm test --workspace=server
```

---

## License

ISC
