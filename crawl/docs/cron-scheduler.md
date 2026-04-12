# Cron Scheduler

This crawler can be executed as an unattended Cron workload so that Nike Launch drops are ingested on a fixed cadence and the Moltenbot Hub is notified of both successes and failures.

## Baseline Cron Entry

1. Install dependencies once: `npm install`.
2. Export sensitive configuration (proxies, callback URL, etc.) from your shell profile.
3. Add a Cron entry that runs the CLI via `npm run crawl`.

Example (runs every 30 minutes using the browser cluster):

```
*/30 * * * * cd /opt/moltenhub/crawl && \
  SNKRS_BROWSER_MODE=browser \
  SNKRS_BROWSER_CONCURRENCY=3 \
  SNKRS_CHROME_PROFILES=west,central,east \
  SNKRS_CHROME_PROFILE_ROOT=/var/lib/moltenhub/chrome-profiles \
  SNKRS_BROWSER_HEADLESS=true \
  MOLTENBOT_FAILURE_CALLBACK_URL=https://na.hub.molten.bot/callbacks/crawl-failures \
  npm run crawl >> /var/log/moltenhub/crawl.log 2>&1
```

Key notes:

- The scheduler should run inside the repository root so Chrome profile directories are stable across runs.
- `MOLTENBOT_FAILURE_CALLBACK_URL` ensures failures are posted back to the calling agent; this is required for the “When failures occur…” acceptance criteria.
- Logs are written to `./logs` automatically and are referenced in the follow-up task payload should anything break.

## Browser Concurrency & Chrome Profiles

The crawler now supports spinning up multiple Chromium instances with isolated profiles:

| Variable | Purpose |
| --- | --- |
| `SNKRS_BROWSER_MODE` | Set to `browser` to force Chrome-based fetching (defaults to HTTP/proxy mode). |
| `SNKRS_BROWSER_CONCURRENCY` | Number of browsers to race in parallel. Missing profiles are auto-generated under the profile root. |
| `SNKRS_CHROME_PROFILES` | Optional comma/newline list of profile names or absolute paths. |
| `SNKRS_CHROME_PROFILE_ROOT` | Directory where relative profile names are materialized (defaults to the system temp dir). |
| `SNKRS_CHROME_EXECUTABLE_PATH` | Point to a system Chrome build if Chromium from `puppeteer-core` is not available. |

Profiles are created lazily and re-used between runs, so you can pre-authenticate or pin persistent cookies in each directory when needed. The crawler records which profile wins the race in the JSON payload under `context.browser_profile`.

If every browser attempt fails, the crawler can optionally fall back to the legacy HTTP + proxy code path by setting `SNKRS_BROWSER_FALLBACK_TO_HTTP=true` (default). Disable the fallback if you want Moltenbot to treat browser failures as hard errors.

## Issuing Offline Runs to Moltenbot Hub

Use `na.hub.molten.bot.openapi.yaml` to understand the REST contract for creating offline jobs and handling callbacks. In most deployments:

1. Create or update an offline task via `POST /offline-tasks` (see the OpenAPI file for the request/response schema).
2. Provide the Cron expression, environment variables (including the Chrome concurrency settings above), and the callback URL the hub should invoke on failure.
3. When the crawler fails, it automatically emits a follow-up run payload shaped exactly as required in the user story. Those follow-up tasks should be queued through the same Hub endpoint so engineers can triage the referenced log files first.

Referencing the OpenAPI definition keeps the scheduler definition, crawler callback contract, and Moltenbot workflow aligned as the integration evolves.
