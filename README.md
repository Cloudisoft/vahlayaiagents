# Vahlay AI

An AI business automation platform with four modules: **VahlayHR** (AI
recruitment + interviews), **Vahlay Coverage** (US carrier lookup), **Vahlay
LeadGen** (US B2B lead discovery), and **Vahlay Voice AI** (AI calling +
Call Auditor). See the build plan's phase order — this repo currently ships
**Phase 1**: the shared platform (auth, orgs, database, storage, settings,
background jobs, telephony adapter). The four product modules are scaffolded
in the UI but intentionally show no data yet — no module fakes a working
integration before it's actually built.

## Stack

- **Frontend**: React + TypeScript + Tailwind (Vite) — `apps/web`
- **Backend**: Node.js + TypeScript + Express — `apps/api`
- **Database**: PostgreSQL (works with a local instance, RDS, or Supabase's
  Postgres — just a connection string)
- **Storage**: pluggable — local disk for dev, or any S3-compatible endpoint
  (Supabase Storage, AWS S3, MinIO) for production
- **Background jobs**: BullMQ + Redis (disabled gracefully until `REDIS_URL`
  is set — no jobs silently pretend to run)
- **Telephony**: provider-agnostic `TelephonyProvider` interface; Plivo
  implemented first per spec, more providers plug in without touching
  business logic

## Why no Supabase/Twilio/OpenAI lock-in yet

No provider credentials existed in the build environment, and the brief is
explicit: never fake a provider response. So every integration point is a
real adapter behind an interface that throws a real, descriptive
"not configured" error until you add credentials — in `Settings` (encrypted,
per-organization, server-side only) or as server env vars.

## Local development

### 1. Database

```bash
docker compose up -d postgres redis   # or point DATABASE_URL/REDIS_URL at existing instances
```

### 2. API

```bash
cd apps/api
cp .env.example .env
# Fill in DATABASE_URL, JWT_SECRET, CREDENTIALS_ENCRYPTION_KEY at minimum:
#   openssl rand -hex 32      -> JWT_SECRET
#   openssl rand -base64 32   -> CREDENTIALS_ENCRYPTION_KEY
npm install
npm run migrate
npm run dev        # http://localhost:4000
```

### 3. Web

```bash
cd apps/web
npm install
npm run dev         # http://localhost:5173 (proxies /api to :4000)
```

### 4. Background workers (optional until Redis is configured)

```bash
cd apps/api
npm run worker
```

## What's implemented (Phase 1)

- Sign up / log in / log out / forgot password / reset password, with
  bcrypt-hashed passwords and server-side sessions (JWT access token +
  rotating refresh token)
- Organizations, roles (`super_admin`, `company_admin`, `hr`, `recruiter`,
  `agent_manager`, `user`), and backend-enforced authorization — every
  organization-scoped query is filtered server-side, never trusted from the
  client
- Full relational schema (`apps/api/migrations/0001_init.sql`) for every
  entity in the spec across all four modules, with indexes and foreign keys,
  ready for Phase 2+ to build business logic against
- File storage abstraction with local-disk and S3-compatible drivers, signed/
  private URLs, 200MB upload limit, allow-listed file types
- Encrypted (AES-256-GCM) per-organization provider credentials, managed from
  Settings, never returned to the browser in plaintext
- Real SMTP/Resend email sending (no fake "sent" responses)
- BullMQ/Redis job queue harness with `background_jobs` status tracking
  (queued/processing/completed/failed), ready for each module's workers
- `TelephonyProvider` interface with a working Plivo implementation (call
  create/end/status/recording/transfer, number listing, webhook signature
  verification) and India/US phone normalization utilities

## What's next

Phases 2–8 build the four product modules and cross-cutting analytics/
hardening on top of this foundation, in the order the build plan specifies.

## Environment variables

See `apps/api/.env.example` for the full list (AI providers, telephony,
voice, lead sources, email, storage). Nothing here is committed to source
control, and secrets are never exposed to the frontend.
