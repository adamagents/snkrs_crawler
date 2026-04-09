const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const { pipeline } = require("stream");

const streamPipeline = promisify(pipeline);

const DEFAULT_FEED_URL = "https://www.nike.com/launch";
const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
];

function pickUserAgent(userAgents = DEFAULT_USER_AGENTS, seed = Date.now()) {
  if (!Array.isArray(userAgents) || userAgents.length === 0) {
    throw new Error("At least one user agent must be configured.");
  }

  const index = Math.abs(Number(seed)) % userAgents.length;
  return userAgents[index];
}

function extractNextDataJson(html) {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);

  if (!match) {
    throw new Error("Unable to find Nike launch data in the page response.");
  }

  return JSON.parse(match[1]);
}

function parseInitialState(html) {
  const nextData = extractNextDataJson(html);

  if (!nextData?.props?.pageProps?.initialState) {
    throw new Error("The Nike launch page did not include the expected initial state payload.");
  }

  return JSON.parse(nextData.props.pageProps.initialState);
}

function formatPacificDate(isoDate) {
  if (!isoDate) {
    return null;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });

  const parts = formatter.formatToParts(new Date(isoDate));
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));

  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second} ${values.timeZoneName}`;
}

function summarizeAvailability(product, availability) {
  const liveSkuCount = Array.isArray(product?.skus) ? product.skus.filter((sku) => sku.available).length : 0;

  return {
    launch_status: product?.launchStatus ?? null,
    available_now: Boolean(availability?.available),
    in_stock_skus: liveSkuCount,
    total_skus: Array.isArray(product?.skus) ? product.skus.length : 0,
  };
}

function normalizeThread(thread, state) {
  if (!thread?.productId) {
    return null;
  }

  const product = state?.product?.products?.data?.items?.[thread.productId];
  const availability = state?.product?.availabilities?.data?.items?.[thread.productId];

  if (!product) {
    return null;
  }

  return {
    id: thread.id,
    product_id: thread.productId,
    slug: thread.seo?.slug ?? null,
    name: product.title ?? thread.title ?? thread.coverCard?.subtitle ?? null,
    color: thread.coverCard?.title ?? null,
    price: {
      currency: product.currency ?? null,
      current: product.currentPrice ?? null,
      full: product.fullPrice ?? null,
      msrp: product.msrp ?? null,
    },
    availability_date_pacific: formatPacificDate(product.commerceStartDate),
    availability: summarizeAvailability(product, availability),
    feed_url: `${DEFAULT_FEED_URL}/${thread.seo?.slug ?? ""}`.replace(/\/$/, ""),
    style_color: product.styleColor ?? null,
  };
}

function normalizeLaunchItems(state) {
  const threadIds = state?.product?.threads?.data?.ids;
  const threadItems = state?.product?.threads?.data?.items;

  if (!Array.isArray(threadIds) || !threadItems) {
    throw new Error("The Nike launch payload does not expose the expected product thread data.");
  }

  return threadIds
    .map((threadId) => normalizeThread(threadItems[threadId], state))
    .filter(Boolean);
}

async function fetchText(url, { userAgent, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const response = await fetch(url, {
    headers: {
      "user-agent": userAgent,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      pragma: "no-cache",
      "cache-control": "no-cache",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Nike launch request failed with ${response.status} ${response.statusText}.`);
  }

  return response.text();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Hub callback failed with ${response.status} ${response.statusText}.`);
  }
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function writeFailureLog(errorPayload, logDirectory = path.join(process.cwd(), "logs")) {
  ensureDirectory(logDirectory);
  const fileName = `snkrs-crawler-${new Date().toISOString().replace(/[:.]/g, "-")}.log.json`;
  const filePath = path.join(logDirectory, fileName);

  fs.writeFileSync(filePath, `${JSON.stringify(errorPayload, null, 2)}${os.EOL}`, "utf8");
  return filePath;
}

function buildFollowUpTask(repoPath, logPaths) {
  const logSummary = logPaths.length > 0 ? ` Failing log paths: ${logPaths.join(", ")}.` : "";

  return {
    repos: [repoPath],
    baseBranch: "main",
    targetSubdir: ".",
    prompt: `Review the failing log paths first, identify every root cause behind the failed task, fix the underlying issues in this repository, validate locally where possible, and summarize the verified results.${logSummary}`,
  };
}

function buildFailurePayload(error, { repoPath = process.cwd(), logPaths = [], phase = "crawl" } = {}) {
  return {
    status: "failure",
    phase,
    message: "Crawler execution failed.",
    error: {
      name: error?.name ?? "Error",
      message: error?.message ?? "Unknown error",
      stack: error?.stack ?? null,
    },
    log_paths: logPaths,
    follow_up_task: buildFollowUpTask(repoPath, logPaths),
  };
}

async function maybeSendFailureCallback(payload) {
  const callbackUrl = process.env.MOLTENBOT_FAILURE_CALLBACK_URL;

  if (!callbackUrl) {
    return;
  }

  await postJson(callbackUrl, payload);
}

async function writeStdoutJson(payload, targetPath) {
  const text = `${JSON.stringify(payload, null, 2)}${os.EOL}`;

  if (targetPath) {
    fs.writeFileSync(targetPath, text, "utf8");
    return;
  }

  process.stdout.write(text);
}

async function crawlSnkrs({
  feedUrl = process.env.SNKRS_FEED_URL || DEFAULT_FEED_URL,
  outputPath = process.env.SNKRS_OUTPUT_PATH,
  userAgents = process.env.SNKRS_USER_AGENTS ? process.env.SNKRS_USER_AGENTS.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean) : DEFAULT_USER_AGENTS,
  seed = process.env.SNKRS_USER_AGENT_SEED || Date.now(),
} = {}) {
  const userAgent = pickUserAgent(userAgents, seed);
  const html = await fetchText(feedUrl, { userAgent });
  const state = parseInitialState(html);
  const items = normalizeLaunchItems(state);

  const payload = {
    status: "success",
    source: feedUrl,
    requested_at_utc: new Date().toISOString(),
    item_count: items.length,
    items,
    warnings: [
      "This implementation uses the public Nike launch page only.",
      "Proxy rotation, captcha handling, and anti-bot bypass logic are intentionally not implemented.",
    ],
  };

  await writeStdoutJson(payload, outputPath);
  return payload;
}

async function runCli() {
  try {
    await crawlSnkrs();
  } catch (error) {
    const preliminaryPayload = buildFailurePayload(error, { repoPath: process.cwd() });
    const logPath = writeFailureLog(preliminaryPayload);
    const failurePayload = buildFailurePayload(error, {
      repoPath: process.cwd(),
      logPaths: [logPath],
    });

    try {
      await maybeSendFailureCallback(failurePayload);
    } catch (callbackError) {
      failurePayload.callback_error = {
        name: callbackError.name,
        message: callbackError.message,
      };
    }

    await writeStdoutJson(failurePayload);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_FEED_URL,
  DEFAULT_USER_AGENTS,
  buildFailurePayload,
  buildFollowUpTask,
  crawlSnkrs,
  extractNextDataJson,
  formatPacificDate,
  normalizeLaunchItems,
  parseInitialState,
  pickUserAgent,
  runCli,
  summarizeAvailability,
  writeFailureLog,
};
