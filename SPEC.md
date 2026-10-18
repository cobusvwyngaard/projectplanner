# Shared Planner — Build Spec

> Spelling: South African English in all UI text.

## 1. Purpose and constraints

A private project planner for **two people**. Both:

- capture work as text or voice;
- arrange sticky notes and tasks on a canvas;
- assign tasks to each other, set due dates and tick tasks off.

Each person's own **Claude Pro** account reads the planner through a custom MCP connector. It organises captured material and writes changes **directly** to the board. Every change, whether by a human or by Claude, must be traceable. The users must be able to drill back to exactly what each human did and what Claude did on whose behalf.

| Settled decision | Choice |
|---|---|
| Hosting | Cloudflare (already set up): one Worker, D1, R2. No Cloudflare Access. |
| Login | Each user has a personal passphrase. Typing it identifies the user. Asked once per browser (long-lived session cookie). |
| Transcription | ElevenLabs Speech-to-Text, model `scribe_v2`, English |
| Messaging ingestion | Email only: the planner's address can be cc'ed (section 11). No WhatsApp, no Telegram. *(Changed by the owner on 2026-10-18; previously "None".)* |
| AI processing | Claude via custom remote MCP connector; both users have Claude Pro and add the connector separately |
| AI write policy | Claude writes straight to the board; no approval queue; full provenance and revert instead |
| Colours | User-defined labels (name + colour) managed in Settings; no fixed meaning |

## 2. Architecture

```
Browser / phone (PWA)                Claude (user A or B, Pro)
   │  REST + polling                      │  MCP over HTTPS (OAuth bearer)
   ▼                                      ▼
┌───────────────────────── one Cloudflare Worker ─────────────────────────┐
│  /login       passphrase page                                           │
│  /            static SPA (React + Vite)          auth: session cookie   │
│  /api/*       app API, audio streaming           auth: session cookie   │
│  /authorize   OAuth consent                      auth: session cookie   │
│  /mcp, /token, /register, /.well-known/*         auth: OAuth bearer     │
│  cron         retry pending/failed transcriptions                       │
└───────┬───────────────────────┬───────────────────────┬─────────────────┘
        ▼                       ▼                       ▼
   D1 (all data +          R2 (audio files,      ElevenLabs STT
   append-only events)     never public)         (outbound fetch)
```

Stack: TypeScript throughout.
- **Worker.** Hono or plain fetch router; `agents` (McpAgent) and `@cloudflare/workers-oauth-provider` for MCP.
- **Frontend.** React + Vite, React Flow (`@xyflow/react`) for the canvas.
- **Deployment.** Frontend served as Worker static assets.

## 3. Login, sessions and the Claude connector

The purpose is to keep out anyone who stumbles on the URL, with minimal friction for the two users.

### 3.1 Passphrase login
- Any unauthenticated request for the app shows one page: a single input "Enter your phrase" and a button. There are no usernames, no email and no password reset flow.
- Phrases are stored as Worker secrets `LOGIN_PHRASE_1` and `LOGIN_PHRASE_2`, mapped to the two rows in `users` via the seed or an env var. Document the mapping in SETUP.md.
- Normalise input and stored phrase identically before comparing: trim, collapse internal whitespace, lower-case.
- Compare against both phrases in constant time: compare SHA-256 digests with a timing-safe comparison, and always check both.
- Never log, echo or persist the phrase anywhere.

### 3.2 Session ("only once per browser")
- On success, create a `sessions` row (section 4).
- Set a cookie holding a random 256-bit session token. The cookie is HttpOnly, Secure, SameSite=Lax, Path=/, and valid for 400 days, refreshed on use.
- Store only the SHA-256 hash of the token in D1.
- Use a server-set cookie, never localStorage. Safari deletes script-written storage after 7 days without use.
- Signing in and revoking a session are logged as events (actor_kind='human').

### 3.3 Guessing protection
- Rate limit failed attempts per IP, using D1 (no external service): after 5 failures, lock out for 15 minutes, doubling on each further lockout.
- Show the same generic message for every failure.

### 3.4 What requires a session
- All `/api/*` routes, the SPA and all audio.
- R2 objects are never public; audio is streamed through the Worker after the session check.

### 3.5 Claude connector (OAuth)
- `/mcp`, `/token`, `/register` and `/.well-known/*` are publicly reachable; the OAuth provider enforces bearer tokens on them. Claude's servers call these from Anthropic's cloud.
- `/authorize` requires a valid session. Without one, show the phrase page, then return to the consent step.
- The issued grant's props carry that user's `user_id`. Every MCP write is attributed as `actor_kind='claude', actor_user_id=<that user>`.

### 3.6 Required tests
- Phrase 1 and phrase 2 each map to the correct user; normalisation works (case, extra spaces).
- A wrong phrase is rejected; the lockout triggers after 5 failures.
- A revoked session is rejected.
- `/api/*` and audio return 401 without a session.
- `/authorize` redirects to the phrase page without a session.
- `/mcp` rejects requests without a valid bearer token.

## 4. Data model (D1)

All IDs are ULIDs (sortable). All timestamps are UTC ISO strings. Due dates are plain local dates `YYYY-MM-DD` (users are in Africa/Johannesburg). Nothing is ever hard-deleted; use `archived_at`.

```sql
users      (id, email NULL, display_name, initials, created_at)

sessions   (id, user_id, token_hash UNIQUE, created_at, last_seen_at,
            user_agent, revoked_at NULL)

login_attempts (ip, failures, locked_until NULL, lockouts, updated_at)

labels     (id, name, colour_hex, sort_order, archived_at, created_at)

notes      (id, title, body, label_id NULL,
            x, y, w, h,                        -- canvas position
            created_at, updated_at, archived_at)

tasks      (id, title, detail, label_id NULL,
            assignee_id NULL, due_date NULL,
            status TEXT CHECK (status IN ('open','done')),
            done_at NULL, done_by_user_id NULL,
            x NULL, y NULL,                    -- NULL = not placed on canvas
            created_at, updated_at, archived_at)

links      (id, a_type, a_id, b_type, b_id,    -- note↔task, note↔note, task↔task
            created_at, archived_at,
            UNIQUE(a_type,a_id,b_type,b_id))

captures   (id, kind TEXT CHECK (kind IN ('voice','text','file')),
            author_user_id, r2_key NULL, mime NULL, duration_s NULL,
            text NULL,                          -- typed text or final transcript
            transcript_json NULL,               -- raw ElevenLabs response
            transcript_status TEXT CHECK (transcript_status IN ('n/a','pending','done','failed')),
            transcript_error NULL, transcribe_attempts INTEGER DEFAULT 0,
            inbox_status TEXT CHECK (inbox_status IN ('new','claimed','processed','ignored')),
            claimed_by_run_id NULL, claimed_at NULL,
            processed_by_run_id NULL, processed_at NULL, processing_note NULL,
            created_at)

runs       (id, user_id,                       -- whose Claude account
            intent, summary NULL,
            started_at, finished_at NULL)

events     (id, ts,                            -- APPEND-ONLY, never updated or deleted
            actor_kind TEXT CHECK (actor_kind IN ('human','claude','system')),
            actor_user_id NULL,                -- human, or the user whose Claude acted
            run_id NULL,                       -- set for every Claude write
            entity_type, entity_id,
            action,                            -- create|update|archive|unarchive|complete|reopen|link|unlink|revert|login|session_revoke
            before_json NULL, after_json NULL, -- full field diff
            source_capture_ids NULL,           -- JSON array; what Claude based this on
            reverts_event_id NULL)

settings   (key PRIMARY KEY, value_json)       -- e.g. stt_keyterms, default_label_id
```

### 4.1 The single mutation path (non-negotiable)
All writes to board data, from the app API and from MCP tools alike, go through **one** module, e.g. `mutate(actor, entity, action, patch, ctx)`. In one `db.batch([...])`, it:

1. reads the current row (`before`);
2. applies the change;
3. inserts the `events` row with the full before/after diff.

The entity write and the event row must commit together. No code path may write to `notes`, `tasks`, `links` or `labels` without producing an event. Add a test that fails if any table write happens outside `mutate`.

### 4.2 Change feed
The `events` table doubles as the sync feed. `GET /api/changes?since=<event_id>` returns newer events plus the affected rows. The app polls every 5 s while the tab is visible, and once on focus. No websockets for v1.

## 5. Provenance and revert ("drill back to what the humans did")

- **Badges.** Every note and task shows who created it and who last changed it. Examples: "Cobus" vs "Claude (via Cobus)".
- **Item history panel.** Shows that item's full event timeline with field-level diffs. For Claude events, it also shows:
  - the run summary;
  - links to the source captures (play the audio, read the transcript).
- **Activity view.** A global feed with filters:
  - **Humans only** — the "what did the people actually do" view;
  - Claude only;
  - by person;
  - by run;
  - by date range.
- **Revert one event.** Writes a compensating event (`action='revert'`, `reverts_event_id`); history is never rewritten. If a later event touched the same field, show a warning and require confirmation.
- **Revert a whole run.** Reverts all of that run's events in reverse order, with the same conflict check per field.
- **Guardrails on Claude.** These are enforced in the MCP layer, not just in the prompt.
  - No MCP tool can archive or delete. Claude can create, update, link/unlink, complete/reopen. Archiving is human-only.
  - Claude cannot change `labels`, `settings`, `users` or `sessions`.
  - Every Claude write must carry a `run_id` from `start_run`. Writes without an open run are rejected.

## 6. Capture and transcription

### 6.1 Capture UI
- A large **Record** button (MediaRecorder) that is reachable in one tap on the phone.
- **Upload audio** for existing recordings (`audio/*`).
- **Quick text** box.
- Install as a PWA: manifest plus a minimal service worker. The service worker handles the app shell only; no offline sync in v1.
- **Format note.** Chrome/Android records `audio/webm;codecs=opus`; iOS Safari records `audio/mp4`. Store whatever arrives, with its real MIME type, and test transcription of both in Phase 2.

### 6.2 Pipeline
1. `POST /api/captures` (multipart, session required). Store audio in R2 at `captures/<yyyy>/<mm>/<id>.<ext>` and insert a `captures` row (`transcript_status='pending'`, `inbox_status='new'`).
2. Transcribe in `ctx.waitUntil()` right away.
3. A **cron trigger** every 10 minutes retries `pending`/`failed` captures with fewer than 5 attempts, using backoff.
4. The UI shows status, offers a manual "Retry transcription", and lets the user **edit the transcript**. A transcript edit is a human event on the capture.
5. Playback streams through `GET /api/captures/<id>/audio` after the session check. Support Range requests so audio can be scrubbed.

### 6.3 ElevenLabs call
```
POST https://api.elevenlabs.io/v1/speech-to-text
Header: xi-api-key: <env.ELEVENLABS_API_KEY>
Multipart: file=<audio bytes>, model_id=scribe_v2, language_code=<English — confirm accepted code in docs>
Optional:  keyterms = settings.stt_keyterms (people/project names)
```
- Store `text` in `captures.text` and the full JSON in `transcript_json`.
- Handle 401 (bad key: surface in the UI) and 429 (rate limit: leave `pending`, cron retries).
- Keyterm prompting is billed as an extra per hour on ElevenLabs. Make it a setting, off by default.
- **Secret handling:** `wrangler secret put ELEVENLABS_API_KEY`. Never commit it, never log it, never paste it into a chat.

## 7. MCP server (what Claude sees)

Server name: `planner`. Keep tool descriptions precise, because they are Claude's main instructions.

| Tool | Purpose |
|---|---|
| `get_overview()` | Users, labels (name + colour), counts, today's date (Africa/Johannesburg) |
| `get_board(filter?)` | Compact JSON of open notes, tasks, links. Filters: label, assignee, status, due range, include_done |
| `get_inbox(limit=20)` | Captures with `inbox_status='new'` and a finished transcript (or typed text): author, timestamp, text |
| `start_run(intent, capture_ids[])` | Opens a run and **atomically claims** those captures (`new`→`claimed`). Fails for captures already claimed, so the two Claude accounts can't double-process |
| `create_note(run_id, title, body?, label_id?, source_capture_ids[])` | Auto-places the note in a free area of the canvas |
| `update_note(run_id, id, patch, source_capture_ids[])` | |
| `create_task(run_id, title, detail?, assignee_id?, due_date?, label_id?, link_to?[], source_capture_ids[])` | |
| `update_task(run_id, id, patch, source_capture_ids[])` | Includes complete/reopen |
| `link_items(run_id, a, b)` / `unlink_items(run_id, a, b)` | |
| `get_history(entity_type, entity_id)` | Lets Claude see what humans changed before it edits something |
| `mark_captures(run_id, capture_ids[], status: processed|ignored, note)` | |
| `finish_run(run_id, summary)` | Summary appears in the app's Activity view. Unfinished runs auto-close after 2 h; their claimed captures return to `new` |

Server-side rules: reject unknown IDs; reject `assignee_id` values outside `users`; validate `due_date` format; cap list sizes.

### 7.1 Claude Project instructions (each user pastes into a Claude Project)
```
You organise our shared planner through the "planner" connector.
When asked to process the inbox:
1. get_overview, then get_inbox. If empty, say so and stop.
2. start_run with the capture ids you will handle.
3. get_board to see what already exists. Prefer updating or linking existing
   notes/tasks over creating duplicates. Use get_history before changing
   anything a human recently edited, and do not undo human decisions.
4. Turn actionable statements into tasks (assignee and due date only when the
   capture states or clearly implies them; otherwise leave blank). Put
   context, ideas and background into notes, and link tasks to notes.
5. Pass source_capture_ids on every write.
6. mark_captures each one processed (or ignored, with a reason).
7. finish_run with a short summary: what you created, changed, and anything
   ambiguous the humans should decide.
Never invent dates or owners.
```

## 8. Board and views

- **Canvas** (React Flow).
  - Notes are sticky cards filled with their label colour.
  - Tasks are smaller cards with a checkbox, assignee initials, and a due-date chip (amber when due soon, red when overdue).
  - Links are edges.
  - Dragging persists `x,y` through `mutate`. Debounce drags and log one event per drag end, not per pixel.
  - Unplaced tasks (x,y NULL) live in a side tray; dragging one onto the canvas places it.
- **List view** (mobile default): tabs Mine / Theirs / Overdue / This week / Done; filter by label. Tick off inline.
- **Inbox view**: each capture with an audio player, editable transcript, status, and which run processed it. Links to the items that run created or changed.
- **Activity view**: section 5.
- **Settings**:
  - labels: create, rename, recolour, reorder, archive; offer a preset palette of ~10 colours with readable text contrast, plus custom hex;
  - user display names and initials;
  - STT keyterms and the keyterm on/off switch;
  - **Signed-in browsers**: active sessions (device or user agent, last seen), with "Sign out" per session, "Sign out everywhere" and "Sign out this browser".
- Text colour on any label colour is chosen for contrast. Test with light and dark labels.

## 9. Build phases and acceptance checks

**Phase 1 — Login and core board**
- D1 schema and migrations; passphrase login, sessions and rate limiting (section 3).
- The `mutate` module with tests; app API.
- Canvas, list and settings views.
- Accept when:
  - each phrase logs in as the correct user and the browser stays signed in across restarts;
  - all section 3.6 tests pass;
  - both users can create, assign, date, link and tick off items;
  - every change shows in the Activity view with correct attribution;
  - single-event revert works.

**Phase 2 — Capture and transcription**
- Record, upload and text capture; R2 storage; ElevenLabs transcription; cron retry; editable transcripts; Inbox view; session-protected audio streaming.
- Accept when a voice note recorded on an iPhone *and* on Android/Chrome both transcribe correctly.

**Phase 3 — Claude connector**
- OAuth provider with session-gated `/authorize`, McpAgent and all tools in section 7.
- Run claiming and run revert.
- Accept when:
  - both users connect from their own claude.ai accounts;
  - a run processes the inbox and the summary shows in Activity;
  - every Claude item links back to its source captures;
  - a whole run can be reverted;
  - two concurrent `start_run` calls on the same capture: exactly one succeeds.

**Phase 4 — Email capture** (section 11)
- Inbound email to the planner address becomes a capture; per-user email addresses in Settings; attachments kept; Claude turns emails into notes and tasks assigned to the people in them.
- Accept when:
  - an email cc'ed to the planner by either user appears in the Inbox within a minute, with its participants mapped to the right users;
  - an email involving no registered address is rejected and never stored;
  - a forged sender (failing SPF/DKIM/DMARC) is not trusted;
  - a Claude run turns an email into tasks assigned to the right people, with provenance back to the email.

**Phase 5 — Polish**
- PWA install, overdue highlighting, keyboard shortcuts on the canvas.
- Optional: a scheduled task in Claude (paid plans) that runs "process the inbox" nightly through the connector.

**Phase 6 — Several planners** (section 12; after the two-person planner has run in practice)
- Accept when:
  - a second planner is deployed from the same code with its own resources, address, phrases and connector, and shares no data with the first;
  - a planner with three or more people works throughout (sign-in, assignment, lists, email matching, Claude);
  - an admin can add, deactivate and reset the phrase of a person entirely in the app, each action appears in Activity, and no phrase or hash is ever shown or logged;
  - one command deploys a code update to every planner and applies its migrations.

## 10. Items to verify during the build (do not assume)
- The claude.ai custom connector flow (Customize → Connectors → Add custom connector) completes against `/authorize` with the phrase page, for both accounts.
- ElevenLabs: the exact `language_code` value for English, and acceptance of `audio/mp4` (iOS) and `audio/webm` uploads.
- `db.batch` atomicity covers the entity write plus the event insert as described.
- Worker request size limits against the longest voice note you expect. Voice notes are normally small, but test a 10-minute recording.
- On iPhone, a home-screen PWA may keep its own cookies separate from Safari. Document in SETUP.md that users may need to enter their phrase once in each.

## 11. Email capture (added by the owner, 2026-10-18)

The planner has one email address (for example `inbox@planner.vanwyngaard.co.za`). Either user cc's it on an email (or forwards an email to it); the email becomes a capture in the Inbox, and Claude processes it like any other capture.

### 11.1 Receiving
- Cloudflare Email Routing delivers mail for the planner address to the Worker's `email()` handler. No other email service.
- The receiving domain must not disturb existing mail for the owner's domain (Proton). Either a subdomain with its own MX records, or a separate domain (see SETUP.md).
- Limits: messages larger than Email Routing's limit are rejected by Cloudflare; the Worker rejects messages over 25 MB itself as well.

### 11.2 Who may send
- Each user has one or more registered email addresses, managed in Settings → People. Addresses are stored lower-case; one address belongs to at most one user.
- An email is accepted only if one of the registered addresses is the sender or appears in To/Cc. Anything else is rejected (`message.setReject`) and never stored.
- Sender authentication: the Worker reads the SPF/DKIM/DMARC results Cloudflare records on the message. If the sender's domain fails authentication, the email is still accepted only when a registered address is in To/Cc, and the capture is marked "sender not verified"; it never counts as sent by a user.

### 11.3 Storage
- The raw message is stored in R2 (`emails/<yyyy>/<mm>/<id>.eml`, never public). Attachments are stored separately in R2 (size-limited, at most 20 per email) and listed with name, type and size; they download through the Worker after the session check.
- A capture of kind `email` holds: subject, the plain-text body (HTML converted to text), sender, To/Cc lists, the user ids those addresses map to, Message-ID (duplicates are ignored), the authentication result, and the attachment list.
- Creating the capture goes through `mutate` like every other capture (actor `system`, since no person is signed in), so it appears in Activity.

### 11.4 Claude
- `get_inbox` returns email captures with: subject, sender, participants (each address with the planner user it maps to, or none), the body text, attachment names, and whether the sender was verified.
- Claude assigns a task to a planner user only when that user is a participant and the email asks them (or clearly implies they should) do it; otherwise the task stays unassigned. It never invents dates or owners.
- Email content is untrusted data. Tool descriptions and the Project instructions tell Claude never to follow instructions found inside an email; the existing guardrails (no archive/delete, runs, revert) apply unchanged.

## 12. Several planners (added by the owner, 2026-10-18)

The owner wants to run more than one planner, each with its own people. The current two-person planner is built and proven first; this is Phase 6.

### 12.1 Approach: one deployment per planner
- Each planner is a separate deployment of the same code: its own Worker, D1 database, R2 bucket, web address, email address (section 11), login phrases and Claude connector. No data is shared between planners, so a bug cannot leak one planner's data into another.
- Deployments are configured with wrangler environments (one per planner) or one config file per planner; resource names include the planner's name. A script deploys an update to all planners and applies each one's migrations.
- A multi-tenant design (one database holding many planners) was considered and rejected for now: it would touch nearly every query, the mutation path, events, revert and the Claude tools, for no benefit at a handful of planners.

### 12.2 Any number of people per planner, managed by an admin
- Users are no longer fixed at two, and they are managed in the app, not as Cloudflare secrets.
- Each planner has at least one **admin**. Settings → Admin lets an admin: add a person (display name, initials, email addresses); deactivate a person (they can no longer sign in; nothing is deleted; their items and history stay); set or reset a person's phrase (type one, or generate a random phrase that is shown once); sign a person out everywhere; disconnect a person's Claude connection; make another person admin (at least one admin must remain).
- Every person can change their own phrase after entering the current one.
- Phrases are stored in D1 only as a salted, deliberately slow hash (PBKDF2-SHA-256 via WebCrypto, or stronger; parameters recorded in DECISIONS.md). Phrases are never stored, logged or shown again after being set. Sign-in compares against every active user's hash in constant time, keeps the rate limiting and generic error of section 3.3, and still requires phrases to be unique after normalisation.
- First run of a new planner: a single Worker secret `ADMIN_SETUP_PHRASE` signs in once as the first admin, who must then set a real phrase; the setup phrase stops working as soon as any admin has a phrase. Upgrading the existing planner carries `LOGIN_PHRASE_1/2` over to users 1 and 2 (user 1 becomes admin), after which those secrets can be removed.
- Admin actions are events (actor_kind 'human') and appear in Activity; they never contain phrases or hashes.
- Cost note: a properly slow hash needs more CPU than the Workers Free plan allows per request (10 ms); Phase 6 assumes the Workers Paid plan.
- Views that assume one "other person" generalise: List view tabs become Mine / Everyone / Unassigned / Overdue / This week / Done with a person filter; assignee pickers list all active users.
- Until Phase 6, the build keeps two users, but new code (Phases 3 to 5) must not add new assumptions that there are exactly two: work from the users table, not from "the other person".

### 12.3 This changes sections 1 and 3
Section 1 says "Two users only" and section 3.1 stores phrases as Worker secrets. Both stay true until Phase 6; Phase 6 replaces them, at the owner's request, with admin-managed users whose phrases are stored as slow hashes in D1.
