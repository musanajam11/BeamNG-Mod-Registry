# BeamNG Mod Registry — Web Submission UI

A self-hosted web frontend that lets mod authors submit mods to the registry
without a GitHub account or knowledge of Git. Submissions are funneled through
a **GitHub App** that opens pull requests against this repository on the
author's behalf — your personal GitHub credentials are **never** used by the
container.

## Goals

- Replace the manual fork → edit `.beammod` → PR workflow with a friendly form.
- Keep the existing Git/CI pipeline as the source of truth (schema validation,
  index build, GitHub Releases). The web app *generates* PRs; it does not
  replace the registry.
- Be safely hostable behind a reverse proxy on Unraid as a single Docker
  container with a SQLite bind-mount.

## Trust Tiers

Every account is assigned one of three tiers. Admins change tiers from the
admin panel.

| Tier       | Behavior                                                                          |
| ---------- | --------------------------------------------------------------------------------- |
| **green**  | Submissions are auto-processed → PR opened → auto-merge after CI passes.          |
| **yellow** | Submissions land in a moderation queue. Admin approval triggers the same pipeline. |
| **red**    | Submissions are rejected at the API. Account is effectively suspended.            |

New signups default to **yellow**. Admins are a separate role flag.

## Architecture

```
┌──────────────────┐    HTTPS    ┌──────────────────────────────────────┐
│ Author's browser │ ──────────► │ Reverse proxy on Unraid (SWAG/Caddy) │
└──────────────────┘             └────────────────┬─────────────────────┘
                                                  │ HTTP (loopback)
                                                  ▼
                                  ┌─────────────────────────────────────┐
                                  │ Docker container: registry-web      │
                                  │  - Fastify API (port 8080)          │
                                  │  - Static React bundle              │
                                  │  - SQLite at /data/registry-web.db  │
                                  │  - Working clone at /var/repo       │
                                  └────────────────┬────────────────────┘
                                                   │ GitHub App token
                                                   ▼
                                  ┌─────────────────────────────────────┐
                                  │ github.com/<you>/BeamNG-Mod-Registry │
                                  │  - PRs opened by registry-bot[bot]   │
                                  │  - main protected, CI-gated merge    │
                                  └─────────────────────────────────────┘
```

### Why a GitHub App and not a PAT?

- An App can be installed **per-repository** with the minimum scopes
  (`contents: write`, `pull_requests: write`, `metadata: read`). A PAT is
  always tied to your user identity and grants broader access.
- Compromise of the container leaks an installation token scoped to one repo
  and rotatable without touching your account.
- All commits/PRs are authored by `registry-bot[bot]`, making provenance
  obvious in the Git history.

## Submission Pipeline

```
POST /api/submissions
        │
        ▼
┌─────────────────────────────┐
│ 1. CSRF + auth + rate limit │
│ 2. AJV schema validation    │  ← uses schema/beammod.schema.json
│ 3. Ownership check          │     and schema/netbeammod.schema.json
│ 4. URL pre-validation       │     directly from this repo
│ 5. Trust-tier branch        │
└──────────┬──────────────────┘
           │
   ┌───────┴────────┐
   │ green          │ yellow                   red
   ▼                ▼                          ▼
status=auto      status=pending            403 Forbidden
   │                │                          (audit log)
   │       ┌────────┴───────┐
   │       │ Admin approves │
   │       └────────┬───────┘
   ▼                ▼
┌──────────────────────────────┐
│ Worker (in-process queue)    │
│  - git pull                  │
│  - write files               │
│  - run scripts/inflate.mjs   │  (only for netbeammod)
│  - run scripts/validate.mjs  │
│  - branch + commit + push    │
│  - open PR via App           │
│  - enable auto-merge         │
│  - record pr_url + audit log │
└──────────────────────────────┘
```

## Supported Submission Types (v1)

1. **NetBeamMod GitHub** — author provides `$kref: #/github/<owner>/<repo>`
2. **NetBeamMod BeamNG.com** — author provides `$kref: #/beamng/<id>`
3. **Manual `.beammod`** — author provides direct download URL; we fetch +
   compute SHA256 server-side
4. **Claim auto-scraped mod** — convert an existing BeamNG.com-sourced
   `.netbeammod` to a GitHub-sourced one
5. **New version of owned mod** — shortcut form prefilled from the latest
   `.beammod` on file

## Tech Stack

| Layer    | Choice                                                                 |
| -------- | ---------------------------------------------------------------------- |
| Backend  | Node 20 + Fastify + TypeScript                                         |
| DB       | SQLite (`better-sqlite3`)                                              |
| Auth     | Email + argon2id, signed httpOnly cookie sessions, double-submit CSRF  |
| GitHub   | `@octokit/app` for App auth, `simple-git` for local clone operations   |
| Frontend | React + Vite + TS, TanStack Router/Query, Mantine UI                   |
| Build    | Multi-stage Docker, frontend served as static files by Fastify         |

## Data Model (SQLite)

```sql
users          (id, email UNIQUE, password_hash, display_name, role, trust,
                github_username, email_verified, created_at, last_login_at,
                failed_logins, locked_until)
mod_ownership  (identifier PK, user_id FK, claimed_at)
submissions    (id, user_id, kind, identifier, version, payload_json,
                status, pr_url, branch, reviewer_id, review_note, error,
                created_at, decided_at)
sessions       (id, user_id, expires_at, ip, user_agent)
audit_log      (id, actor_id, action, target, details_json, created_at)
rate_limit     (key, count, window_start)
```

`status` ∈ `pending_review | queued | processing | pr_opened | merged | rejected | failed`

## Security Posture

- argon2id password hashing (memCost 64MiB, timeCost 3, parallelism 4)
- httpOnly + Secure + SameSite=Lax session cookies, 30-day rolling
- Double-submit CSRF tokens on every mutating route
- Helmet (CSP, HSTS, etc.), no inline scripts in frontend bundle
- Per-IP and per-user rate limits on auth + submission routes
- Account lockout after 10 failed logins / 15 min
- Disposable-email-domain blocklist on signup
- All secrets via env vars / mounted files; nothing in DB or source
- Audit log entries for: signup, login, password change, trust change, role
  change, submission decision, PR opened/merged/failed
- Branch protection on `main` (configured on GitHub) prevents the bot from
  bypassing review/CI even if compromised

## Development

```bash
cd web
npm install
cp .env.example .env
# Fill in dev values (GitHub App optional in dev — submissions can be stubbed)
npm run dev
```

This runs the backend on `:8080` and the Vite frontend on `:5173` with a
proxy to the API.

## Production / Unraid Deploy

### 1. GitHub App
1. Create a GitHub App at https://github.com/settings/apps/new with permissions:
   `contents=write`, `pull_requests=write`, `metadata=read`.
2. Install it **only on your registry repository**.
3. Generate and download the private key (`*.pem`).

### 2. Cloudflare (recommended)
- Point your domain at the Unraid box via Cloudflare proxy.
- SSL mode: **Full (strict)** — terminate TLS at Cloudflare; the container
  itself stays plain HTTP behind your reverse proxy.
- Optional: create a free **Turnstile** site at
  https://dash.cloudflare.com/?to=/:account/turnstile and grab the site +
  secret keys for `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`.

### 3. Reverse proxy on Unraid (SWAG / nginx-proxy-manager)
Forward `https://registry.example.com` → `http://registry-web:8080`.
The proxy must set `X-Forwarded-For` and `X-Forwarded-Proto`. Add the proxy's
internal IP to `TRUST_PROXY` so Fastify honors those headers.

### 4. SMTP (optional, required if `EMAIL_VERIFICATION_REQUIRED=true`)
Any provider works — Mailgun, Postmark, SES, or your own server.

### 5. Container
Place the App private key under
`/mnt/user/appdata/registry-web/secrets/app.pem` and a populated `.env` next
to `docker-compose.yml`. For Unraid, add these to `.env` so the bind-mounts
land under `/mnt/user/appdata` (the compose file reads them with sane
defaults so it also works locally on Docker Desktop):

```env
DATA_DIR=/mnt/user/appdata/registry-web/data
SECRETS_DIR=/mnt/user/appdata/registry-web/secrets
REGISTRY_WEB_PORT=8080
```

Then:

```bash
docker compose up -d --build
```

Compose mounts:

- `${REGISTRY_WEB_PORT:-8080}:8080` — internal HTTP (reverse proxy in front for HTTPS)
- `${DATA_DIR:-./data}` → `/data` (SQLite + working clone)
- `${SECRETS_DIR:-./secrets}/app.pem` → `/run/secrets/app.pem` (read-only)

The container has a built-in `HEALTHCHECK` against `/api/health`; Unraid's
Docker tab will show it as healthy/unhealthy.

### 6. First admin
Set `BOOTSTRAP_ADMIN_EMAIL=you@example.com` in `.env` **before** signing up;
the first signup with that email is auto-promoted. Or after the fact:

```bash
docker exec -it registry-web node backend/dist/cli/bootstrap-admin.js \
  you@example.com 'YourStrongPassword' 'Display Name'
```

### 7. Production safety checks
The container will refuse to start if any of these are true:

- `SESSION_SECRET` missing, < 32 chars, or contains the dev placeholder
- `PUBLIC_ORIGIN` is plain `http://` for a non-localhost origin
- `COOKIE_SECURE=false` in production
- `EMAIL_VERIFICATION_REQUIRED=true` without `SMTP_HOST`

Generate a session secret with:

```bash
openssl rand -hex 32
```

### 8. Backups
Snapshot `/mnt/user/appdata/registry-web/data/` on whatever schedule you use
for other appdata. SQLite is a single file (`registry-web.db`); the working
clone (`repo/`) can be regenerated from GitHub if lost.

### 9. Healthcheck
The container exposes `GET /api/health` and a `HEALTHCHECK` directive is
baked in. Unraid's container UI will show green/red accordingly.

## Live Demo

Interact with the running registry at: [https://bmr.musanet.xyz/](https://bmr.musanet.xyz/)

- Public mod browser, submission, and admin UI (if you sign up with the admin email)
- Hosted on Unraid with Nginx Proxy Manager and Cloudflare

## Implementation Status

This is a phased build. Current state:

- [x] Architecture & plan
- [x] Project scaffold + Docker
- [x] DB + auth foundation
- [x] GitHub App + git working copy service
- [x] Manual `.beammod` end-to-end submission
- [x] Admin moderation panel (approve / reject / request changes)
- [x] Public mod browsing UI
- [x] Author dashboard with submission inspection + edit-and-resubmit
- [x] Rate limiting + abuse hardening (Turnstile, configurable upload cap)
- [x] Email verification (optional, gated by SMTP config)
- [x] Audit log viewer
- [x] Production Dockerfile + boot-time config validation
- [ ] NetBeamMod GitHub submission (stub)
- [ ] NetBeamMod BeamNG.com submission (stub)
- [ ] Claim auto-scraped mod (stub)
- [ ] New-version-of-owned-mod shortcut (stub)

Each item lands as an isolated, reviewable change.

## How mod authors can submit or update mods

There are two supported ways for authors to interact with the registry:

1. **Pull request (PR) workflow:**
   - Fork this repository, edit or add your `.beammod`/`.netbeammod` file, and open a PR as before.
   - This remains fully supported and is the source of truth for all mods.

2. **Web submission UI:**
   - Use the hosted web frontend at [https://bmr.musanet.xyz/](https://bmr.musanet.xyz/) to submit new mods, claim ownership, or update existing mods.
   - No GitHub account required; just sign up and follow the form-based workflow.
   - Submissions are funneled through a GitHub App that opens PRs on your behalf, subject to admin/moderator review and the same CI pipeline.

Both methods result in a PR and full audit trail. The web UI is ideal for non-technical authors or quick updates, while the PR workflow is best for advanced users or bulk changes.
