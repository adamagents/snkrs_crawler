const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const tls = require("tls");
const { promisify } = require("util");
const { pipeline } = require("stream");
const {
  DEFAULT_FEED_URL,
  DEFAULT_USER_AGENTS,
  PACIFIC_TIME_ZONE,
  REQUEST_TIMEOUT_MS,
  US_FREE_RESIDENTIAL_HTTP_PROXIES,
} = require("./constants.cjs");

const streamPipeline = promisify(pipeline);

const PROXY_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_PROXY_ATTEMPTS_PER_REQUEST = 8;
const DEFAULT_CHROME_PROFILE_ROOT = path.join(os.tmpdir(), "snkrs-chrome-profiles");
const DEFAULT_REPO_REMOTE = "git@github.com:Molten-Bot/moltenhub-code.git";
const FOLLOW_UP_PROMPT_BASE =
  "Review the failing log paths first, identify every root cause behind the failed task, fix the underlying issues in this repository, validate locally where possible, and summarize the verified results.";

function parseListEnv(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  return String(value)
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function toBoolean(value, defaultValue = false) {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();

  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function sanitizeProfileName(name, fallbackIndex = 0) {
  if (!name) {
    return `profile-${fallbackIndex + 1}`;
  }

  const cleaned = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (cleaned.length === 0) {
    return `profile-${fallbackIndex + 1}`;
  }

  return cleaned;
}

function normalizeProfileDescriptor(value, { rootDir = DEFAULT_CHROME_PROFILE_ROOT, index = 0 } = {}) {
  if (value && path.isAbsolute(value)) {
    return {
      name: sanitizeProfileName(path.basename(value), index),
      path: value,
    };
  }

  const name = sanitizeProfileName(value, index);
  return {
    name,
    path: path.join(rootDir, name),
  };
}

function buildChromeProfiles({ requestedProfiles = [], concurrency = 1, rootDir = DEFAULT_CHROME_PROFILE_ROOT } = {}) {
  const deduped = new Map();
  const values = Array.isArray(requestedProfiles) ? requestedProfiles : parseListEnv(requestedProfiles);

  values.forEach((entry, index) => {
    if (entry && typeof entry === "object" && entry.path) {
      const descriptor = {
        name: entry.name ?? sanitizeProfileName(path.basename(entry.path), index),
        path: entry.path,
      };
      deduped.set(descriptor.path, descriptor);
      return;
    }

    const descriptor = normalizeProfileDescriptor(entry, { rootDir, index });
    deduped.set(descriptor.path, descriptor);
  });

  const targetCount = Math.max(1, Number(concurrency) || 1, deduped.size);
  let autoIndex = deduped.size;

  while (deduped.size < targetCount) {
    const descriptor = normalizeProfileDescriptor(`auto-profile-${autoIndex + 1}`, { rootDir, index: autoIndex });
    if (!deduped.has(descriptor.path)) {
      deduped.set(descriptor.path, descriptor);
    }
    autoIndex += 1;
  }

  const profiles = Array.from(deduped.values());
  profiles.forEach((descriptor) => ensureDirectory(descriptor.path));
  return profiles;
}

function createAbortError(message = "The task was aborted.") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function raceToFirstSuccess(items, worker, { concurrency } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("At least one task is required to race.");
  }

  const limit = Math.max(1, Math.min(concurrency || items.length, items.length));

  return new Promise((resolve, reject) => {
    const controllers = new Map();
    const errors = [];
    let resolved = false;
    let nextIndex = 0;
    let active = 0;

    const maybeReject = () => {
      if (!resolved && active === 0 && nextIndex >= items.length) {
        resolved = true;
        reject(
          new AggregateError(
            errors.map((entry) => entry.error),
            "All concurrent tasks failed.",
          ),
        );
      }
    };

    const startTask = () => {
      if (resolved || nextIndex >= items.length) {
        maybeReject();
        return;
      }

      const index = nextIndex;
      const item = items[index];
      nextIndex += 1;
      const controller = new AbortController();
      controllers.set(index, controller);
      active += 1;

      Promise.resolve()
        .then(() => worker(item, { signal: controller.signal }))
        .then((value) => {
          if (resolved) {
            return;
          }
          resolved = true;
          controllers.forEach((ctrl, ctrlIndex) => {
            if (ctrlIndex !== index) {
              ctrl.abort();
            }
          });
          resolve({ item, index, value });
        })
        .catch((error) => {
          controllers.delete(index);
          errors.push({ item, error });
        })
        .finally(() => {
          controllers.delete(index);
          active -= 1;
          if (!resolved) {
            if (nextIndex < items.length) {
              startTask();
            } else {
              maybeReject();
            }
          }
        });
    };

    for (let i = 0; i < limit; i += 1) {
      startTask();
    }
  });
}

let cachedPuppeteer = null;

function loadPuppeteer() {
  if (cachedPuppeteer) {
    return cachedPuppeteer;
  }

  try {
    cachedPuppeteer = require("puppeteer-core");
    return cachedPuppeteer;
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") {
      throw error;
    }
  }

  try {
    cachedPuppeteer = require("puppeteer");
    return cachedPuppeteer;
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") {
      throw new Error(
        "Browser crawling requires either 'puppeteer-core' or 'puppeteer'. Install one of them or disable browser mode.",
      );
    }
    throw error;
  }
}

async function defaultChromeFetcher(
  url,
  { profile, headless = true, executablePath, waitUntil = "networkidle2", navigationTimeoutMs = REQUEST_TIMEOUT_MS, signal } = {},
) {
  const puppeteer = loadPuppeteer();
  ensureDirectory(profile.path);

  if (signal?.aborted) {
    throw createAbortError();
  }

  let browser;
  let aborted = false;

  const closeBrowser = async () => {
    if (!browser) {
      return;
    }
    const instance = browser;
    browser = null;
    await instance.close().catch(() => {});
  };

  const abortHandler = () => {
    aborted = true;
    closeBrowser();
  };

  if (signal) {
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    browser = await puppeteer.launch({
      headless,
      executablePath,
      userDataDir: profile.path,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      defaultViewport: null,
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil, timeout: navigationTimeoutMs });
    const html = await page.content();

    if (aborted || signal?.aborted) {
      throw createAbortError();
    }

    return html;
  } finally {
    if (signal) {
      signal.removeEventListener("abort", abortHandler);
    }

    await closeBrowser();
  }
}

async function fetchHtmlViaChromePool(
  url,
  {
    profiles,
    concurrency = profiles.length,
    headless = true,
    executablePath,
    waitUntil = "networkidle2",
    navigationTimeoutMs = REQUEST_TIMEOUT_MS,
    browserFetcher = defaultChromeFetcher,
  } = {},
) {
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new Error("At least one Chrome profile must be configured for browser crawling.");
  }

  const normalizedConcurrency = Math.max(1, Math.min(concurrency || profiles.length, profiles.length));
  const { item: profile, value: html } = await raceToFirstSuccess(
    profiles,
    (profileDescriptor, { signal }) =>
      browserFetcher(url, {
        profile: profileDescriptor,
        headless,
        executablePath,
        waitUntil,
        navigationTimeoutMs,
        signal,
      }),
    { concurrency: normalizedConcurrency },
  );

  return { html, profile };
}

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
  const requestHeaders = {
    "user-agent": userAgent,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    pragma: "no-cache",
    "cache-control": "no-cache",
  };
  const proxyPool = new ProxyPool(US_FREE_RESIDENTIAL_HTTP_PROXIES);
  const proxyErrors = [];

  for (let attempt = 0; attempt < Math.min(MAX_PROXY_ATTEMPTS_PER_REQUEST, proxyPool.size); attempt += 1) {
    const proxy = proxyPool.getNextProxy();

    if (!proxy) {
      break;
    }

    try {
      const response = await requestViaProxy(url, { proxy, headers: requestHeaders, timeoutMs });
      proxyPool.recordSuccess(proxy);
      return response;
    } catch (error) {
      proxyPool.recordFailure(proxy);
      proxyErrors.push({
        proxy: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
        message: error.message,
      });
    }
  }

  try {
    return await requestDirect(url, { headers: requestHeaders, timeoutMs });
  } catch (error) {
    const reason = proxyErrors.length > 0 ? ` Proxy errors: ${proxyErrors.map((entry) => `${entry.proxy} -> ${entry.message}`).join(" | ")}` : "";
    throw new Error(`Nike launch request failed without a working proxy and direct fallback failed: ${error.message}.${reason}`);
  }
}

function proxyKey(proxy) {
  return `${proxy.protocol}://${proxy.host}:${proxy.port}`;
}

class ProxyPool {
  constructor(proxies, { cooldownMs = PROXY_FAILURE_COOLDOWN_MS } = {}) {
    this.proxies = Array.isArray(proxies) ? proxies.filter(Boolean) : [];
    this.cooldownMs = cooldownMs;
    this.cursor = 0;
    this.state = new Map();
  }

  get size() {
    return this.proxies.length;
  }

  getNextProxy(now = Date.now()) {
    if (this.proxies.length === 0) {
      return null;
    }

    for (let i = 0; i < this.proxies.length; i += 1) {
      const index = (this.cursor + i) % this.proxies.length;
      const proxy = this.proxies[index];
      const key = proxyKey(proxy);
      const cooldownUntil = this.state.get(key)?.cooldownUntil ?? 0;

      if (cooldownUntil <= now) {
        this.cursor = (index + 1) % this.proxies.length;
        return proxy;
      }
    }

    return null;
  }

  recordFailure(proxy, now = Date.now()) {
    const key = proxyKey(proxy);
    this.state.set(key, {
      cooldownUntil: now + this.cooldownMs,
    });
  }

  recordSuccess(proxy) {
    this.state.delete(proxyKey(proxy));
  }
}

async function requestDirect(url, { headers, timeoutMs }) {
  const response = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Nike launch request failed with ${response.status} ${response.statusText}`);
  }

  return response.text();
}

function requestViaProxy(url, { proxy, headers, timeoutMs }) {
  const targetUrl = new URL(url);

  if (targetUrl.protocol === "https:") {
    return requestHttpsViaHttpProxy(targetUrl, { proxy, headers, timeoutMs });
  }

  if (targetUrl.protocol === "http:") {
    return requestHttpViaHttpProxy(targetUrl, { proxy, headers, timeoutMs });
  }

  return Promise.reject(new Error(`Unsupported URL protocol: ${targetUrl.protocol}`));
}

function requestHttpViaHttpProxy(targetUrl, { proxy, headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: proxy.host,
        port: proxy.port,
        method: "GET",
        path: targetUrl.href,
        headers: {
          ...headers,
          host: targetUrl.host,
          connection: "close",
        },
      },
      (response) => {
        const bodyParts = [];
        response.setEncoding("utf8");
        response.on("data", (chunk) => bodyParts.push(chunk));
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Proxy request failed with ${response.statusCode} ${response.statusMessage}`));
            return;
          }

          resolve(bodyParts.join(""));
        });
      },
    );

    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Proxy request timed out after ${timeoutMs}ms`)));
    request.on("error", reject);
    request.end();
  });
}

function requestHttpsViaHttpProxy(targetUrl, { proxy, headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const connectRequest = http.request({
      host: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: `${targetUrl.hostname}:${targetUrl.port || 443}`,
      headers: {
        host: `${targetUrl.hostname}:${targetUrl.port || 443}`,
        "proxy-connection": "keep-alive",
      },
    });

    const fail = (error) => reject(error instanceof Error ? error : new Error(String(error)));
    connectRequest.setTimeout(timeoutMs, () => connectRequest.destroy(new Error(`Proxy tunnel timed out after ${timeoutMs}ms`)));
    connectRequest.on("error", fail);

    connectRequest.on("connect", (connectResponse, socket) => {
      if (connectResponse.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`Proxy tunnel failed with ${connectResponse.statusCode} ${connectResponse.statusMessage}`));
        return;
      }

      const tunnel = tls.connect({
        socket,
        servername: targetUrl.hostname,
      });

      const request = https.request(
        {
          host: targetUrl.hostname,
          port: targetUrl.port || 443,
          method: "GET",
          path: `${targetUrl.pathname}${targetUrl.search}`,
          headers: {
            ...headers,
            host: targetUrl.host,
            connection: "close",
          },
          createConnection: () => tunnel,
          agent: false,
        },
        (response) => {
          const bodyParts = [];
          response.setEncoding("utf8");
          response.on("data", (chunk) => bodyParts.push(chunk));
          response.on("end", () => {
            if (response.statusCode < 200 || response.statusCode >= 300) {
              fail(new Error(`Proxy response failed with ${response.statusCode} ${response.statusMessage}`));
              return;
            }

            resolve(bodyParts.join(""));
          });
        },
      );

      request.setTimeout(timeoutMs, () => request.destroy(new Error(`Proxy HTTPS request timed out after ${timeoutMs}ms`)));
      request.on("error", fail);
      request.end();
    });

    connectRequest.end();
  });
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

function buildFollowUpTask(repoPath = DEFAULT_REPO_REMOTE, logPaths = []) {
  const logSummary = logPaths.length > 0 ? ` Failing log paths: ${logPaths.join(", ")}.` : "";

  return {
    repos: [repoPath || DEFAULT_REPO_REMOTE],
    baseBranch: "main",
    targetSubdir: ".",
    prompt: `${FOLLOW_UP_PROMPT_BASE}${logSummary}`,
  };
}

function buildFailurePayload(error, { repoPath = process.cwd(), repoRemote = DEFAULT_REPO_REMOTE, logPaths = [], phase = "crawl" } = {}) {
  return {
    status: "failure",
    phase,
    message: "Crawler execution failed.",
    error: {
      name: error?.name ?? "Error",
      message: error?.message ?? "Unknown error",
      stack: error?.stack ?? null,
    },
    repository: {
      path: repoPath,
      remote: repoRemote,
    },
    log_paths: logPaths,
    follow_up_task: buildFollowUpTask(repoRemote, logPaths),
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
  userAgents = process.env.SNKRS_USER_AGENTS ? parseListEnv(process.env.SNKRS_USER_AGENTS) : DEFAULT_USER_AGENTS,
  seed = process.env.SNKRS_USER_AGENT_SEED || Date.now(),
  requestMode = (process.env.SNKRS_REQUEST_MODE || process.env.SNKRS_BROWSER_MODE || "http").toLowerCase(),
  chromeProfiles = process.env.SNKRS_CHROME_PROFILES,
  chromeProfileRoot = process.env.SNKRS_CHROME_PROFILE_ROOT || DEFAULT_CHROME_PROFILE_ROOT,
  browserConcurrency = process.env.SNKRS_BROWSER_CONCURRENCY,
  browserHeadless = toBoolean(process.env.SNKRS_BROWSER_HEADLESS ?? "true", true),
  chromeExecutablePath = process.env.SNKRS_CHROME_EXECUTABLE_PATH,
  browserWaitUntil = process.env.SNKRS_BROWSER_WAIT_UNTIL || "networkidle2",
  browserNavigationTimeoutMs = Number(process.env.SNKRS_BROWSER_TIMEOUT_MS) || REQUEST_TIMEOUT_MS,
  browserFallbackToHttp = toBoolean(process.env.SNKRS_BROWSER_FALLBACK_TO_HTTP ?? "true", true),
  browserFetcher,
} = {}) {
  const normalizedUserAgents = Array.isArray(userAgents) ? userAgents : parseListEnv(userAgents);
  const agentPool = normalizedUserAgents.length > 0 ? normalizedUserAgents : DEFAULT_USER_AGENTS;
  const userAgent = pickUserAgent(agentPool, seed);

  const requestedConcurrency = Number(browserConcurrency);
  const hasExplicitConcurrency = Number.isFinite(requestedConcurrency) && requestedConcurrency > 0;
  const profileInput = chromeProfiles;
  const shouldPreferBrowser = ["browser", "chrome", "puppeteer"].includes(requestMode);
  const profileCountHint = Array.isArray(profileInput) ? profileInput.length : parseListEnv(profileInput).length;
  const hasProfileConfig = profileCountHint > 0;
  const useBrowser = shouldPreferBrowser || hasProfileConfig || hasExplicitConcurrency;

  let html;
  let htmlSource = { mode: "http", concurrency: 1 };

  if (useBrowser) {
    const profiles = buildChromeProfiles({
      requestedProfiles: profileInput,
      concurrency: hasExplicitConcurrency ? requestedConcurrency : undefined,
      rootDir: chromeProfileRoot,
    });
    const effectiveConcurrency = Math.max(1, hasExplicitConcurrency ? requestedConcurrency : profiles.length);

    try {
      const { html: browserHtml, profile } = await fetchHtmlViaChromePool(feedUrl, {
        profiles,
        concurrency: effectiveConcurrency,
        headless: browserHeadless,
        executablePath: chromeExecutablePath,
        waitUntil: browserWaitUntil,
        navigationTimeoutMs: browserNavigationTimeoutMs,
        browserFetcher,
      });
      html = browserHtml;
      htmlSource = {
        mode: "browser",
        profile,
        concurrency: effectiveConcurrency,
      };
    } catch (browserError) {
      if (!browserFallbackToHttp) {
        throw browserError;
      }

      html = await fetchText(feedUrl, { userAgent });
      htmlSource = {
        mode: "http",
        concurrency: 1,
        fallback: "http",
        browser_error: browserError.message,
      };
    }
  } else {
    html = await fetchText(feedUrl, { userAgent });
  }

  const state = parseInitialState(html);
  const items = normalizeLaunchItems(state);

  const warnings = [
    "This implementation uses the public Nike launch page only.",
  ];

  if (htmlSource.mode === "http") {
    warnings.push("Free proxies are volatile; the crawler rotates through a US pool and falls back to direct requests when needed.");
  } else {
    warnings.push("Browser crawling depends on local Chrome profiles; keep them isolated per worker to avoid state collisions.");
  }

  if (htmlSource.browser_error) {
    warnings.push(`Browser mode failed (${htmlSource.browser_error}); HTTP fallback succeeded.`);
  }

  const payload = {
    status: "success",
    source: feedUrl,
    requested_at_utc: new Date().toISOString(),
    item_count: items.length,
    items,
    warnings,
    context: {
      request_mode: htmlSource.mode,
      browser_profile: htmlSource.profile?.name ?? null,
      browser_profile_path: htmlSource.profile?.path ?? null,
      browser_concurrency: htmlSource.concurrency ?? null,
      fallback_mode: htmlSource.fallback ?? null,
    },
  };

  await writeStdoutJson(payload, outputPath);
  return payload;
}

async function runCli() {
  try {
    await crawlSnkrs();
  } catch (error) {
    const repoRemote = process.env.MOLTENBOT_REPO_REMOTE || DEFAULT_REPO_REMOTE;
    const repoDetails = { repoPath: process.cwd(), repoRemote };
    const preliminaryPayload = buildFailurePayload(error, repoDetails);
    const logPath = writeFailureLog(preliminaryPayload);
    const failurePayload = buildFailurePayload(error, {
      ...repoDetails,
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
  buildChromeProfiles,
  buildFailurePayload,
  buildFollowUpTask,
  crawlSnkrs,
  extractNextDataJson,
  fetchHtmlViaChromePool,
  formatPacificDate,
  normalizeLaunchItems,
  parseInitialState,
  pickUserAgent,
  ProxyPool,
  raceToFirstSuccess,
  requestDirect,
  requestViaProxy,
  runCli,
  summarizeAvailability,
  writeFailureLog,
};
