# VOTE BANKER backend

Node.js / Express API. Handles phone-OTP sign in (Twilio Verify), creates Supabase sessions, and stores user profiles.

| | |
|---|---|
| Live API | https://votebankerbackend-production.up.railway.app |
| Hosting | Railway (project `faithful-freedom`, service `VoteBanker_Backend`), auto-deploys on push to `main` |
| Database / Auth | Supabase project `zlqgxqngaqsseksosfle` (region `ap-south-1`) |
| OTP | Twilio Verify service `VoteBanker` |
| Frontend | https://votebanker-frontend.vercel.app (repo: `VoteBanker_Frontend`) |

## Run locally

```bash
cd backend
npm install
cp .env.example .env      # then fill in the secrets (see below)
npm run dev               # http://127.0.0.1:5000
```

Check it: http://127.0.0.1:5000/api/health

## Getting the secrets (`.env`)

`.env` is git-ignored and must never be committed (this repo is public). Real values live in Railway:

- **Dashboard:** Railway -> project -> `VoteBanker_Backend` -> **Variables** -> *Raw Editor* -> copy into `backend/.env`.
- **CLI:**
  ```bash
  npm i -g @railway/cli
  railway login && railway link      # pick the project
  railway variables --kv > .env
  ```

You need to be invited to the Railway project first. Ask the project owner. Never paste secrets into chat, issues, or commits.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | Liveness check |
| POST | `/api/auth/otp/send` | `{ "phone": "+91...", "channel": "sms" }` |
| POST | `/api/auth/otp/verify` | `{ "phone": "+91...", "code": "123456" }` returns `access_token`, `refresh_token` |
| GET / PUT | `/api/profile` | `Authorization: Bearer <access_token>`. PUT saves onboarding answers |

How sign in works: Twilio Verify checks the code, then the backend creates or signs in a Supabase user (phone-derived email + server-computed password) and returns a normal Supabase session.

## Database

SQL migrations are in `supabase/migrations/` (already applied to the live project). Table: `public.profiles` (row-level security: users only see their own row). Users appear under Supabase -> Authentication -> Users.

## Known limits / next steps

- **Twilio is a trial account**: OTPs only reach numbers added under Twilio Console -> Phone Numbers -> **Verified Caller IDs**. Upgrade the account for real users.
- **WhatsApp OTP is off** (`WHATSAPP_OTP_ENABLED=false`): the Verify service has no WhatsApp sender, so Twilio would silently send SMS. Register a WhatsApp sender, link it to the Verify service, then set the variable to `true`.
- Email sign-in is not built yet.
- Profile photo is not saved yet (needs Supabase Storage).
- Rotate any credentials that were ever shared in chat before going live.

## Rules

- Never commit `.env` or any key. The Supabase **secret** key is server-only.
- Branch from `main`, open a pull request, and pull the latest `main` before you push (teammates work in parallel).
