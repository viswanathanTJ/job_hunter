# Design: Playwright Scraper Revamp for job-hunter

**Date:** 2026-07-04
**Status:** Approved pending user spec review
**Replaces:** Apify-based LinkedIn fetch (`server/services/apify.mjs`)

## Goal

Replace the paid Apify cloud scraper with local Playwright scraping running on this
machine. Default sources: LinkedIn (guest) and Naukri. User-added companies are fetched
via their ATS public APIs with a Playwright fallback. The whole automation — config and
the scraper scripts themselves — is editable from the web UI, and run output streams
live into the same page.

## Decisions (locked with user)

1. **UI editing model:** config form for everyday knobs PLUS a code editor for each
   source's scraper script, with a Run button streaming logs/results into the page.
2. **LinkedIn access:** guest/public search only. No login, no account risk. Authwall
   detection → backoff + visible "blocked" state, never a hard failure.
3. **Company fetch:** ATS API first (Greenhouse → Lever → Ashby → Workable public JSON),
   Playwright fallback on careers page or company-filtered portal search.
4. **Scheduling:** on-demand button + built-in scheduler (off / every N hours / daily at
   HH:MM) editable in the Automation page.
5. **Architecture:** source-adapter plugins — one script per source with a shared
   contract (Approach A).

## Architecture

```
job-hunter/
├─ config/automation.json        ← automation config (single source of truth)
├─ server/
│  ├─ scrapers/
│  │   ├─ linkedin.mjs           guest search via Playwright
│  │   ├─ naukri.mjs             search page + JSON API network interception
│  │   └─ company.mjs            ATS resolver + Playwright fallback
│  ├─ services/
│  │   ├─ scraper-engine.mjs     orchestrator: load scrapers fresh, run, dedup, import
│  │   ├─ scheduler.mjs          fires runs from config.schedule
│  │   └─ automation-config.mjs  read/validate/write automation.json
│  └─ routes/automation.mjs      config CRUD, script CRUD, run trigger, SSE stream
└─ web/src/pages/Automation.jsx  config form + script editor + live run panel
```

**Removed:** `server/services/apify.mjs`; env vars `APIFY_TOKEN`, `APIFY_ACTOR`,
`JOB_SEARCH_QUERY`, `LOOKBACK_HOURS`, `FETCH_COUNT` (search config moves to
`automation.json`). `.env` keeps `PORT`, `CLAUDE_MODEL`, `RESUME_PDF_NAME`.

**Unchanged:** SQLite import pipeline (`importJobs`), analysis (`claude.mjs`), resume,
tracker, Dashboard/Jobs/Pipeline views. Scrapers are the new front door; everything
downstream keeps working.

**New dependencies:** `playwright` (server), plus `npx playwright install chromium` as a
documented setup step. Web: CodeMirror 6 (`@uiw/react-codemirror` +
`@codemirror/lang-javascript`). Headless Chromium by default; `debugHeaded: true` in
config runs headed for troubleshooting.

## Scraper contract

Each file in `server/scrapers/` exports:

```js
export const meta = { id: 'linkedin', label: 'LinkedIn (guest)', kind: 'portal' };
// kind: 'portal' | 'company'

export async function fetchJobs(ctx) { ... }
```

`ctx` provides:

- `ctx.browser` — shared Playwright Browser instance (each scraper creates its own
  context with realistic UA/viewport/locale)
- `ctx.config` — the parsed `automation.json`
- `ctx.log(msg, level?)` — appends to run log, streams to UI via SSE
- `ctx.emit(job)` — submit one normalized job (validated, deduped, imported by engine)
- `ctx.blocked(reason)` — declare the source blocked (authwall/captcha); engine records
  a cooldown timestamp and marks the source status
- `ctx.signal` — AbortSignal for run cancellation

Normalized job shape (matches existing importer):

```js
{ title, company, location, postedAt, employmentType, seniorityLevel,
  jobLink, jobDescription }
```

Engine adds `source` (scraper id). Dedup key: `jobLink` (same as today). Parsing
functions (HTML/JSON → job objects) are exported separately from `fetchJobs` so they are
unit-testable against fixtures.

The engine re-imports scraper modules fresh on every run (cache-busting import URL), so
UI edits apply on the next run without a server restart.

## automation.json schema

```jsonc
{
  "search": {
    "keywords": "Backend Engineer OR Senior Backend Engineer",
    "lookbackHours": 24,
    "maxJobsPerSource": 25,
    "locations": {
      "onsite": ["Bengaluru", "Chennai"],   // on-site/hybrid cities
      "remote": ["India", "Worldwide"]      // "Worldwide" = no location filter on the remote search
    }
  },
  "filters": {
    "titleInclude": [],      // empty = allow all
    "titleExclude": []
  },
  "sources": {
    "linkedin": { "enabled": true },
    "naukri":   { "enabled": true },
    "company":  { "enabled": true }
  },
  "companies": [
    { "name": "Zoho", "careersUrl": "" }    // careersUrl optional fallback hint
  ],
  "schedule": { "mode": "off", "everyHours": 6, "dailyAt": "09:00" },
  "debugHeaded": false
}
```

Validation on write: unknown keys rejected, types checked, schedule values sane. The
server seeds this file with defaults (mirroring today's env-based search) if missing.

## Scrapers

### linkedin.mjs (guest)

- Builds guest search URLs from `search.*` — same four-URL pattern as today
  (Bengaluru + Chennai on-site/hybrid `f_WT=1,3`, India remote `f_WT=2`, worldwide
  remote, `f_TPR=r{lookback}` and `sortBy=DD`).
- Loads search results via Playwright, paginates through the guest job-card fragments,
  extracts card fields, then visits each job detail page for the full description.
- Human-like pacing: randomized 2–6s delays between page loads, max
  `maxJobsPerSource` detail visits per run.
- Authwall/captcha/login-redirect detection → `ctx.blocked('authwall')`: engine stores a
  cooldown (default 6h) and the UI shows the source as blocked-until. Jobs already
  emitted in the run are kept (partial success).

### naukri.mjs

- Drives the Naukri search page for keywords + locations; captures the site's internal
  `jobapi/v3/search` JSON responses via Playwright network interception (stabler than
  DOM selectors), paginates within limits.
- Fetches job detail pages for the full JD text.
- Same pacing, limits, and blocked-detection behavior as LinkedIn.

### company.mjs

For each entry in `companies`:

1. **ATS probe (no browser, plain fetch):** generate slug candidates from the name
   (lowercase, strip punctuation, hyphenated variant) and probe in order:
   - Greenhouse: `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true`
   - Lever: `https://api.lever.co/v0/postings/{slug}?mode=json`
   - Ashby: `https://api.ashbyhq.com/posting-api/job-board/{slug}`
   - Workable: `https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true`
   First HTTP 200 with a parseable job list wins. Result cached in a new `company_ats`
   table (`company, ats, slug, resolved_at`) so future runs skip probing; a failed
   resolution is also cached (retry after 7 days).
2. **Fallback:** if no ATS resolves — when `careersUrl` is set, render it with
   Playwright and extract job links/titles heuristically; otherwise run a
   company-filtered search on the enabled portals.
3. ATS boards list every open role, so results are filtered by
   `filters.titleInclude/titleExclude` and the location policy before emitting: keep a
   job only if its location matches a `locations.onsite` city, mentions India, or is
   remote. Roles requiring relocation outside India are dropped.

## HTTP API

| Method & path | Purpose |
|---|---|
| `GET  /api/automation/config` | Current automation.json |
| `PUT  /api/automation/config` | Validate + write config; scheduler re-reads |
| `GET  /api/automation/scripts` | List scrapers: id, label, mtime, hasBackup |
| `GET  /api/automation/scripts/:id` | Script source text |
| `PUT  /api/automation/scripts/:id` | Syntax-check (`node --check`), write `.bak` of previous version, save |
| `POST /api/automation/scripts/:id/restore` | Restore from `.bak` |
| `POST /api/automation/run` | Body `{ sources?: string[], dryRun?: boolean }` → `{ runId }` |
| `POST /api/automation/run/:id/cancel` | Abort a running run |
| `GET  /api/automation/runs` | Run history with per-source breakdown |
| `GET  /api/automation/runs/:id/stream` | SSE: live events for a run |

Script editing is restricted to files inside `server/scrapers/` (path-traversal guarded).
The app binds to localhost; the editor executes local JS by design — same trust level as
editing the file on disk.

SSE event shapes:

```jsonc
{ "type": "log",           "source": "linkedin", "level": "info", "msg": "...", "ts": "..." }
{ "type": "job",           "source": "naukri",   "job": { ...normalized } }
{ "type": "source-status", "source": "linkedin", "status": "running|done|blocked|error",
  "counts": { "found": 12, "imported": 8, "duplicates": 4 } }
{ "type": "run-end",       "summary": { "found": 30, "imported": 19, "errors": [] } }
```

## Database changes (migrations in db.mjs, additive)

- `fetch_runs`: add `trigger` (`manual` | `schedule`), `sources_json` (per-source
  breakdown), `dry_run` (0/1).
- New table `company_ats(company TEXT PRIMARY KEY, ats TEXT, slug TEXT, resolved_at TEXT)`.
- New table `source_state(source TEXT PRIMARY KEY, blocked_until TEXT, last_error TEXT)`.

## Automation page (web UI)

New "Automation" tab with three panels:

1. **Config form** — keywords, locations (chips), lookback, max per source, source
   on/off toggles, companies chip input (add "Zoho" → next run picks it up; shows
   resolved ATS badge per company after a run), schedule controls, headed-debug toggle.
   Save → `PUT /config`.
2. **Script editor** — scraper selector, CodeMirror JS editor, Save (server syntax
   check; inline error on failure), Restore last good, short contract cheat-sheet above
   the editor (`meta`, `fetchJobs(ctx)`, `ctx.emit/log/blocked`).
3. **Run panel** — Run all / run one source / dry-run toggle / cancel. Live SSE feed:
   log lines, found-job mini cards, per-source status chips with counts, blocked-until
   notices. Run history table below (reuses `fetch_runs`).

The existing Dashboard "Fetch" button now triggers `POST /api/automation/run` (all
enabled sources).

## Scheduler

`scheduler.mjs`: 60s tick; if `schedule.mode` is `interval`, fire when
`now - lastRun >= everyHours`; if `daily`, fire at `dailyAt` (once per day). Skips when
a run is already active. Scheduled runs are recorded with `trigger = 'schedule'` and
appear in the same history/SSE feed.

## Error handling

- Scraper crash → caught by engine, stack into run log, source marked `error`, other
  sources continue. Run ends `done` with per-source statuses (a run only ends `error`
  if every source failed).
- Blocked source → cooldown in `source_state`, shown in UI; scheduler and Run-all skip
  sources still in cooldown (manual single-source run overrides).
- Script save with syntax error → rejected with the error message; file untouched.
- Runtime contract violation (missing `fetchJobs`) → clear error in run log naming the
  script.
- Emitted jobs missing required fields (`title`, `jobLink`, `jobDescription` ≥ 50 chars)
  → dropped with a warning log (mirrors current Apify parser rules).

## Testing

- **Parser unit tests** (`node --test`, new `npm test`): fixtures in `fixtures/` —
  saved LinkedIn card/detail HTML, Naukri API JSON, one JSON sample per ATS — drive the
  exported parse functions. No network.
- **Engine test:** a `fixtures`-backed fake scraper validates orchestration: emit →
  dedup → import → run summary.
- **Smoke test:** extend `server/smoke-test.mjs` to cover automation routes (config
  round-trip, script GET/PUT with a syntax error rejected, dry-run with fake scraper).
- **Dry-run mode** from the UI: full scrape, no import — the safe way to verify a script
  edit against the live sites.

## Out of scope

- Logged-in LinkedIn scraping, proxy rotation, captcha solving
- Auto-submitting applications (career-ops rule: user reviews everything before send)
- Multi-user/auth on the dashboard (stays localhost-only)
- Editing non-scraper server code from the UI

## Build order (for the implementation plan)

1. Engine + contract + `automation.json` + routes (with fake scraper, dry-run, SSE)
2. Scrapers: company (ATS, easiest to verify) → naukri → linkedin
3. Automation UI page (form → run panel → editor)
4. Scheduler
5. Apify removal, README/env updates, fixtures + tests polish
