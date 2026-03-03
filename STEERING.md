# CCS Scheduler Bot Steering

## Purpose
This bot manages Rocket League league operations in Discord:
- Match scheduling and rescheduling
- Weekly channel rebuilds
- Team availability collection and suggestion logic
- Ballchasing link intake and stats imports
- Match reminder pings

Keep behavior predictable and staff-safe. Prefer explicit confirmations for destructive/overwriting actions.

## Core Guardrails
- Never write to Google Sheets tabs other than configured targets:
  - `RawSchedule` for schedule/link fields
  - `PlayerInput` and `TeamInput` for stats imports
- Never overwrite unrelated sheet columns.
- Staff/admin-only flows must always verify elevated access via `isAdminAuthorized`.
- Team-member flows must not grant staff-only capabilities.
- Use ephemeral responses for sensitive setup/confirmation flows.

## Channel/Match Identity Rules
- Matchup channels use slug format: `team-a-at-team-b` (with optional confirmed suffixes).
- Channel topic should contain match identity when available (plain `match_id` or `match_id=...` pattern).
- All match resolution logic should prefer:
  1. `match_id` from topic
  2. Channel-name + league category fallback

## Command Access Intent
- Staff/Admin:
  - `/schedule`, `/reschedule`, `/rebuild_week`, `/suggest`, `/upload_admin`, `/availability_admin`
- Team members (+ staff):
  - `/upload` (match channel context)
- Everyone (where allowed by channel context):
  - `/availability`, `/help`
- Proposal command (`/propose_time`) follows current staff-level gate unless intentionally changed.

## Scheduling/Rescheduling Rules
- `/schedule` and `/reschedule` only accept:
  - Date: `M/D`
  - Time: `H` or `H:MM` (PM EST semantics)
- On success, post formatted match line in:
  - Match channel
  - League game-times channel
- `/reschedule` must:
  - Fail early if match is not yet scheduled
  - Ask for explicit confirmation
  - Update `RawSchedule` date/time
  - Remove prior scheduled post when identifiable

## Availability + Suggestion Rules
- `/availability` should support weekly edit flow (not duplicate spam).
- Prefer latest full schedule per user for `/suggest`.
- Conversational schedule lines may be used, but should not override a user’s full schedule unless intended.
- Exclude rejected `/propose_time` windows when reactions indicate rejection (`❌ > ✅`).
- Ignore known schedule-template boilerplate messages.

## Upload/Stats Rules
- `/upload`:
  - Accept group links only
  - Respect duplicate protection unless explicitly overridden in staff flow
- `/upload_admin`:
  - Allow overwrite with explicit confirm/cancel step
- Stats import behavior is append-based unless replacement logic is intentionally added.
- On import mismatch/failure, alert staff roles clearly in-channel.

## Reminder Rules
- Reminder types:
  - 12h before (`h12`)
  - 30m before (`m30`)
  - match start (`start`)
- Skip reminders for matches that appear already played (ballchasing field populated).
- Polling should be minute-aligned and tolerant to minor drift.
- If channel lookup fails, log the reason clearly.

## Environment & Deployment
- Production runs on Oracle via PM2 (`ccs-scheduler-bot`).
- GitHub Actions deploys from `main`.
- `.env` is environment-specific and must not be committed.
- If env changes are made on server, restart with `--update-env`.

## Change Discipline
- Keep modules focused:
  - `commands/` for interaction handling
  - `services/` for external/data logic
  - `utils/` for pure helpers
- Preserve existing command names and user-facing message formats unless requested.
- For behavior changes, prefer backward-compatible defaults.
- Add concise logs for operational debugging (channel resolution, skips, retries, failures).
