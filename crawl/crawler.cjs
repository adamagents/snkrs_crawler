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
      "Free proxies are volatile; the crawler rotates through a US pool and falls back to direct requests when needed.",
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
  ProxyPool,
  requestDirect,
  requestViaProxy,
  runCli,
  summarizeAvailability,
  writeFailureLog,
};
