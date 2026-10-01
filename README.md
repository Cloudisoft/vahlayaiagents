# Vahlay AI

A full-stack AI business automation platform with four integrated modules:

- **VahlayHR** — AI recruitment: job management, AI job-description analysis,
  resume parsing/scoring, automatic rejection emails, and AI phone interviews
- **Vahlay Coverage** — US phone carrier lookup: internal NPA/NXX
  intelligence with Twilio verification as a budget-capped fallback, plus
  observed (not claimed) accuracy tracking
- **Vahlay LeadGen** — US B2B lead discovery/enrichment via a source-adapter
  architecture (Google Places first), with quality scoring and CSV import/
  export
- **Vahlay Voice AI** — AI agent configuration, a real telephony-backed
  outbound call queue with server-enforced concurrency, a live call panel,
  call history, and an **AI Call Auditor** for uploaded or campaign recordings

All eight build phases from the spec are implemented (auth/org/DB/storage →
HR → Coverage → LeadGen → Voice AI config → live calling → Call Auditor →
analytics/hardening). See `apps/api/migrations/0001_init.sql` for the full
schema and each module's routes under `apps/api/src/routes`.

The UI is branded as **VahlaySmartAI** — a "Command Center" dashboard
(`apps/web/src/pages/Dashboard.tsx`) with per-user, per-module access control
layered on top of the existing role-based RBAC: sign-in accepts a username
or email (`apps/api/migrations/0002_username_and_module_access.sql`), and an
Admin Panel (`/admin`) lets a company/global admin create users, set their
role, grant or revoke access to each of the five product modules
individually, reset passwords, and deactivate/delete accounts. The org-level
"Enabled" toggle on each dashboard card (admin-only) controls whether a
module is active for the whole organization; per-user module grants control
who within an enabled org can open it. The current brand mark is a text
placeholder (`apps/web/src/components/BrandMark.tsx`) pending the real
Vahlay Consulting logo file.

## Stack

- **Frontend**: React + TypeScript + Tailwind (Vite) — `apps/web`
- **Backend**: Node.js + TypeScript + Express — `apps/api`
- **Database**: PostgreSQL (works with a local instance, RDS, or Supabase's
  Postgres — just a connection string)
- **Storage**: pluggable — local disk for dev, or any S3-compatible endpoint
  (Supabase Storage, AWS S3, MinIO) for production
- **Background jobs**: BullMQ + Redis, plus an independent campaign-dialer
  tick loop for Voice AI (doesn't require Redis)
- **Realtime**: a WebSocket server (JWT-authenticated, per-org) for the Voice
  AI live call panel
- **Telephony**: provider-agnostic `TelephonyProvider` interface; Plivo
  implemented first per spec (India-first HR interviews, US Voice AI
  campaigns), more providers plug in without touching business logic
- **AI**: OpenAI (chat completions for scoring/analysis/conversation,
  Whisper for transcription), Cartesia (voice library)
- **Audio**: ffmpeg-static for real long-recording segmentation ahead of
  Whisper's 25MB-per-request limit

## Why every "not configured" error is real, not a placeholder

No provider credentials existed in the build environment, and the brief is
explicit: never fake a provider response. So every integration point is a
real adapter behind an interface that throws a real, descriptive
"not configured" error until you add credentials — in `Settings` (encrypted,
per-organization, server-side only) or as server env vars. That pattern was
verified end-to-end for OpenAI, Twilio, Plivo, Google Places, Cartesia, and
SMTP/Resend during development — the app never substitutes fabricated data
when a provider is missing.

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
npm run dev         # http://localhost:5173 (proxies /api and /ws to :4000)
```

### 4. Background workers

```bash
cd apps/api
npm run worker
```

Resume parsing, coverage bulk lookups, LeadGen discovery, and call audits run
as BullMQ jobs once `REDIS_URL` is set (they no-op without it, or process
inline with a safety cap so nothing silently stalls in dev). The Voice AI
campaign dialer runs in the worker independently of Redis (5 s tick, plus an
immediate refill whenever a call ends). Only one worker dials at a time — a
database lease prevents double-dialing if you run several.

### 5. Tests

```bash
cd apps/api
npm test
```

## What's implemented, by phase

**Phase 1 — Platform**: auth (signup/login/logout/forgot+reset password,
bcrypt, JWT + rotating refresh sessions), organizations/roles/backend-enforced
authorization, the full relational schema, file storage (local + S3-
compatible), encrypted per-org provider credentials, SMTP/Resend email,
BullMQ/Redis job harness, `TelephonyProvider` interface with Plivo.

**Phase 2 — VahlayHR**: job CRUD + publish/archive/duplicate, AI job-
description analysis, public application form, resume parsing + job-fit
scoring, auto-rejection with configurable email templates, and an AI phone
interview engine (Plivo call flow, Whisper transcription, OpenAI scoring) —
documented as turn-based/recorded, not full-duplex streaming.

**Phase 3 — Vahlay Coverage**: NPA/NXX-based carrier prediction, Twilio
verification only when confidence is low or forced, a hard $7 default
verification budget, and observed (calculated, never hard-coded) accuracy.

**Phase 4 — Vahlay LeadGen**: source-adapter discovery (Google Places),
dedupe, best-effort website contact extraction (robots.txt-respecting),
real completeness-based quality scoring, lead lists, CSV import/export.

**Phase 5 — Vahlay Voice AI (config)**: AI agent configuration (8 types, 8
tones), Cartesia voice library sync, DID sync/assignment, campaign CRUD with
a real stats card, lead assignment from LeadGen lists.

**Phase 6 — Live calling (VAPI engine)**: US campaigns call through VAPI
using your Twilio numbers, Cartesia voices and a per-call assistant built
from the campaign's *published* version.

- *Save & publish*: edits are drafts until published; each publish freezes
  agent, voice, script, knowledge base, calling and voicemail rules into a
  version. Calls already in progress finish on their version. You're warned
  if the linked agent changed since the last publish.
- *Dialer*: concurrency, per-lead calling windows (lead's own time zone,
  optional lunch break), max attempts, retry delay, lead cooldown, ring
  timeout, DNC check before every dial, number pool with area-code
  matching then least-recently-used, scheduled starts, pause/resume/stop/
  restart. Ten identical provider errors in a row pause the campaign with
  the reason shown, instead of burning through the list.
- *Call behaviour*: the caller can interrupt instantly, the agent waits for
  them to finish, checks in after 7 s of silence, voicemail detection with a
  personalised voicemail, warm transfer, DNC requests honoured mid-call,
  callbacks booked in the lead's time zone, live knowledge-base lookups.
- *Dispositions*: one per call, first match wins (DNC → voicemail →
  transferred → disconnected in transfer → not in service → busy/no answer
  → hung up → disconnected → AI outcome). Manual dispositions always win.
- *Reliability*: missed webhooks are covered by sweeps that reconcile with
  VAPI, close calls that never rang, and hang up stuck calls.
- *Live Monitor*: live transcripts, listen-in (server-relayed audio — VAPI's
  listen URL never reaches the browser), whisper to the AI, barge, transfer
  and end, each behind its own permission.
- *Call Records*: filters (digits-only phone search, transcript full-text
  search, campaign, result, direction, talk time, dates), a detail drawer
  with recording, summary, score, transcript and timeline, and CSV export.

Getting a campaign dialing: add your VAPI private key (Settings → AI
Providers), Twilio credentials (Settings → Telephony) and optionally Cartesia;
then Voice AI → Numbers → *Sync from VAPI* (or buy a number, which also
connects it to VAPI), Agents → *Import from VAPI* or *Spectrum Business
template*, create a campaign, add numbers + leads, *Save & publish*, *Start*.

**Phase 7 — AI Call Auditor**: real long-recording transcription (ffmpeg
segmentation around Whisper's actual size limit), best-effort speaker
labeling, 14 default (extensible) audit criteria, AI scoring + coaching
reports, from an upload or an existing call.

**Phase 8 — Analytics & hardening**: a unified dashboard with real
cross-module KPIs, a usage/spend page (tracked spend by category, storage
usage, provider balances where an API exists — honestly "unavailable"
where it doesn't), in-app notifications, and rate limiting on auth and
public-facing endpoints.

## Environment variables

See `apps/api/.env.example` for the full list (AI providers, telephony,
voice, lead sources, email, storage). Nothing here is committed to source
control, and secrets are never exposed to the frontend.
