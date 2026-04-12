# Cron Scheduler

This crawler can be executed as an unattended Cron workload so that Nike Launch drops are ingested on a fixed cadence and the Moltenbot Hub is notified of both successes and failures. Everything in this guide assumes you have already run `npm install` and can execute `npm run crawl` successfully from the repository root.

> Need the on-wire contract? See [`na.hub.molten.bot.openapi.yaml`](../na.hub.molten.bot.openapi.yaml) for the Moltenbot Hub REST shapes referenced below.

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
- Failures produce a follow-up payload shaped like:

  ```jsonc
  {
    "repos": ["git@github.com:Molten-Bot/moltenhub-code.git"],
    "baseBranch": "main",
    "targetSubdir": ".",
    "prompt": "Review the failing log paths first, identify every root cause behind the failed task, fix the underlying issues in this repository, validate locally where possible, and summarize the verified results. Failing log paths: /opt/moltenhub/crawl/logs/snkrs-crawler-....log.json"
  }
  ```

  The JSON above mirrors the acceptance criteria so engineers who pick up the follow-up task know which logs to inspect first.

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

### Quick concurrency recipes

- **Fixed region split:** `SNKRS_CHROME_PROFILES=west,central,east` and `SNKRS_BROWSER_CONCURRENCY=3` spreads work across three persistent regions. Each profile keeps its own cookies and local storage.
- **Auto-provisioned burst:** omit `SNKRS_CHROME_PROFILES` but set `SNKRS_BROWSER_CONCURRENCY=5`. The crawler auto-creates five profile directories under `SNKRS_CHROME_PROFILE_ROOT`.
- **Absolute paths:** provide `/var/chrome/profiles/west` style entries if the scheduler runs outside the repo root.

## Issuing Offline Runs to Moltenbot Hub

Use `na.hub.molten.bot.openapi.yaml` to understand the REST contract for creating offline jobs and handling callbacks. In most deployments:

1. Create or update an offline task via `POST /offline-tasks` (see the OpenAPI file for the request/response schema).
2. Provide the Cron expression, environment variables (including the Chrome concurrency settings above), and the callback URL the hub should invoke on failure.
3. When the crawler fails, it automatically emits a follow-up run payload shaped exactly as required in the user story. Those follow-up tasks should be queued through the same Hub endpoint so engineers can triage the referenced log files first.

### Offline task example

```json
{
  "name": "snkrs-us-launch-monitor",
  "schedule": "*/30 * * * *",
  "command": "npm run crawl",
  "workingDirectory": "/opt/moltenhub/crawl",
  "environment": {
    "SNKRS_BROWSER_MODE": "browser",
    "SNKRS_BROWSER_CONCURRENCY": "3",
    "SNKRS_CHROME_PROFILES": "west,central,east",
    "SNKRS_CHROME_PROFILE_ROOT": "/var/lib/moltenhub/chrome-profiles",
    "SNKRS_BROWSER_HEADLESS": "true",
    "MOLTENBOT_FAILURE_CALLBACK_URL": "https://na.hub.molten.bot/callbacks/crawl-failures",
    "SNKRS_BROWSER_FALLBACK_TO_HTTP": "true"
  },
  "failureCallback": "https://na.hub.molten.bot/callbacks/crawl-failures",
  "successCallback": "https://na.hub.molten.bot/callbacks/crawl-results",
  "replaceIfExists": true
}
```

Referencing the OpenAPI definition keeps the scheduler definition, crawler callback contract, and Moltenbot workflow aligned as the integration evolves.
