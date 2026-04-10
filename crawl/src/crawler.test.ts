import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildFailurePayload,
  buildFollowUpTask,
  crawlSnkrsWithDeps,
  extractNextDataJson,
  fetchText,
  formatPacificDate,
  maybeSendFailureCallback,
  normalizeLaunchItems,
  parseInitialState,
  pickUserAgent,
  postJson,
  ProxyPool,
  crawlSnkrs,
  requestDirect,
  requestHttpViaHttpProxy,
  requestHttpsViaHttpProxy,
  requestViaProxy,
  runCli,
  writeFailureLog,
} from "./index";

function buildHtmlFromState(state: unknown): string {
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: {
      pageProps: {
        initialState: JSON.stringify(state),
      },
    },
  })}</script></body></html>`;
}

function buildLaunchState() {
  return {
    product: {
      threads: {
        data: {
          ids: ["story", "product-thread"],
          items: {
            story: {
              id: "story",
              threadType: "story_format",
              productId: null,
            },
            "product-thread": {
              id: "product-thread",
              threadType: "product",
              productId: "product-1",
              title: "Ignored Thread Title",
              seo: { slug: "air-jordan-11-retro-low-university-blue" },
              coverCard: {
                title: "University Blue",
              },
            },
          },
        },
      },
      products: {
        data: {
          items: {
            "product-1": {
              id: "product-1",
              title: 'Air Jordan 11 Retro Low "University Blue"',
              currency: "USD",
              currentPrice: 195,
              fullPrice: 195,
              msrp: 195,
              styleColor: "FV5104-100",
              commerceStartDate: "2026-04-18T14:00:00.000Z",
              launchStatus: "ACTIVE",
              skus: [
                { id: "sku-1", available: true },
                { id: "sku-2", available: false },
              ],
            },
          },
        },
      },
      availabilities: {
        data: {
          items: {
            "product-1": {
              id: "product-1",
              available: false,
            },
          },
        },
      },
    },
  };
}

test("pickUserAgent selects a stable entry from the configured list", () => {
  const userAgent = pickUserAgent(["ua-1", "ua-2", "ua-3"], 4);
  assert.equal(userAgent, "ua-2");
});

test("pickUserAgent throws for empty user agent list", () => {
  assert.throws(() => pickUserAgent([], 1), /At least one user agent/);
});

test("formatPacificDate converts UTC launch times into Pacific local time", () => {
  assert.equal(formatPacificDate("2026-01-15T16:00:00.000Z"), "2026-01-15 08:00:00 PST");
  assert.equal(formatPacificDate("2026-04-18T14:00:00.000Z"), "2026-04-18 07:00:00 PDT");
  assert.equal(formatPacificDate(undefined), null);
});

test("extractNextDataJson and parseInitialState handle valid and invalid html payloads", () => {
  const state = { ok: true, product: { threads: { data: { ids: [], items: {} } } } };
  const html = buildHtmlFromState(state);

  assert.deepEqual(parseInitialState(html), state);
  assert.deepEqual(extractNextDataJson(html), {
    props: {
      pageProps: {
        initialState: JSON.stringify(state),
      },
    },
  });

  assert.throws(() => extractNextDataJson("<html></html>"), /Unable to find Nike launch data/);
  assert.throws(
    () => parseInitialState(`<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>`),
    /The Nike launch page did not include the expected initial state payload|Invalid input|Required/,
  );
  assert.throws(
    () =>
      parseInitialState(
        `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
          props: {
            pageProps: {
              initialState: JSON.stringify(null),
            },
          },
        })}</script>`,
      ),
    /expected initial state payload/,
  );
});

test("normalizeLaunchItems returns only launch products with the requested fields", () => {
  assert.deepEqual(normalizeLaunchItems(buildLaunchState()), [
    {
      id: "product-thread",
      product_id: "product-1",
      slug: "air-jordan-11-retro-low-university-blue",
      name: 'Air Jordan 11 Retro Low "University Blue"',
      color: "University Blue",
      price: {
        currency: "USD",
        current: 195,
        full: 195,
        msrp: 195,
      },
      availability_date_pacific: "2026-04-18 07:00:00 PDT",
      availability: {
        launch_status: "ACTIVE",
        available_now: false,
        in_stock_skus: 1,
        total_skus: 2,
      },
      feed_url: "https://www.nike.com/launch/air-jordan-11-retro-low-university-blue",
      style_color: "FV5104-100",
    },
  ]);

  assert.throws(() => normalizeLaunchItems({}), /expected product thread data/);
});

test("ProxyPool rotates proxies and applies cooldowns after failure", () => {
  const pool = new ProxyPool(
    [
      { protocol: "http", host: "proxy-1", port: 8001 },
      { protocol: "http", host: "proxy-2", port: 8002 },
    ],
    { cooldownMs: 1000 },
  );

  const first = pool.getNextProxy(0);
  const second = pool.getNextProxy(0);
  assert.equal(`${first?.host}:${first?.port}`, "proxy-1:8001");
  assert.equal(`${second?.host}:${second?.port}`, "proxy-2:8002");

  pool.recordFailure(first!, 0);
  const afterFailure = pool.getNextProxy(200);
  assert.equal(`${afterFailure?.host}:${afterFailure?.port}`, "proxy-2:8002");

  const afterCooldown = pool.getNextProxy(1200);
  assert.equal(`${afterCooldown?.host}:${afterCooldown?.port}`, "proxy-1:8001");
});

test("fetchText uses proxy first, then direct fallback, and surfaces detailed failures", async () => {
  const proxies = [{ protocol: "http" as const, host: "p1", port: 80 }];
  const successFromProxy = await fetchText(
    "https://example.com",
    { userAgent: "ua", proxies },
    {
      requestViaProxyImpl: async () => "proxy-body",
      requestDirectImpl: async () => {
        throw new Error("unexpected");
      },
    },
  );
  assert.equal(successFromProxy, "proxy-body");

  const successFromDirect = await fetchText(
    "https://example.com",
    { userAgent: "ua", proxies },
    {
      requestViaProxyImpl: async () => {
        throw new Error("proxy down");
      },
      requestDirectImpl: async () => "direct-body",
    },
  );
  assert.equal(successFromDirect, "direct-body");

  await assert.rejects(
    () =>
      fetchText(
        "https://example.com",
        { userAgent: "ua", proxies },
        {
          requestViaProxyImpl: async () => {
            throw new Error("proxy crash");
          },
          requestDirectImpl: async () => {
            throw new Error("direct crash");
          },
        },
      ),
    /direct crash\. Proxy errors: http:\/\/p1:80 -> proxy crash/,
  );
});

test("requestViaProxy routes by protocol and rejects unsupported protocol", async () => {
  const proxy = { protocol: "http" as const, host: "proxy", port: 8080 };
  await assert.rejects(
    () =>
      requestViaProxy("http://example.com", {
        proxy,
        headers: {},
        timeoutMs: 10,
      }),
    /ENOTFOUND|ECONNREFUSED|Proxy request/,
  );
  await assert.rejects(
    () =>
      requestViaProxy("https://example.com", {
        proxy,
        headers: {},
        timeoutMs: 10,
      }),
    /ENOTFOUND|ECONNREFUSED|Proxy tunnel|Proxy HTTPS request/,
  );
  await assert.rejects(() => requestViaProxy("ftp://example.com", { proxy, headers: {}, timeoutMs: 10 }), /Unsupported URL protocol/);
});

test("requestDirect validates HTTP status", async () => {
  const okText = await requestDirect("https://example.com", {
    headers: {},
    timeoutMs: 10,
    fetchImpl: async () => ({ ok: true, status: 200, statusText: "OK", text: async () => "body" }) as Response,
  });
  assert.equal(okText, "body");

  await assert.rejects(
    () =>
      requestDirect("https://example.com", {
        headers: {},
        timeoutMs: 10,
        fetchImpl: async () => ({ ok: false, status: 403, statusText: "Forbidden", text: async () => "" }) as Response,
      }),
    /403 Forbidden/,
  );
});

test("requestHttpViaHttpProxy handles success and non-2xx responses", async () => {
  const proxy = { protocol: "http" as const, host: "proxy", port: 8080 };

  const makeRequest = (statusCode: number, body: string) => ({
    request: (_opts: any, onResponse: (response: any) => void) => {
      const req = new EventEmitter() as any;
      req.setTimeout = (_ms: number, _fn: () => void) => {};
      req.destroy = (_err?: unknown) => {};
      req.end = () => {
        const res = new EventEmitter() as any;
        res.statusCode = statusCode;
        res.statusMessage = statusCode === 200 ? "OK" : "Bad";
        res.setEncoding = () => {};
        onResponse(res);
        res.emit("data", body);
        res.emit("end");
      };
      return req;
    },
  });

  const ok = await requestHttpViaHttpProxy(new URL("http://example.com/path"), {
    proxy,
    headers: {},
    timeoutMs: 10,
    httpModule: makeRequest(200, "ok") as any,
  });
  assert.equal(ok, "ok");

  await assert.rejects(
    () =>
      requestHttpViaHttpProxy(new URL("http://example.com/path"), {
        proxy,
        headers: {},
        timeoutMs: 10,
        httpModule: makeRequest(500, "bad") as any,
      }),
    /Proxy request failed with 500 Bad/,
  );

  await assert.rejects(
    () =>
      requestHttpViaHttpProxy(new URL("http://example.com/path"), {
        proxy,
        headers: {},
        timeoutMs: 10,
        httpModule: {
          request: () => {
            const req = new EventEmitter() as any;
            req.setTimeout = (_ms: number, fn: () => void) => fn();
            req.destroy = (error?: unknown) => req.emit("error", error);
            req.end = () => {};
            req.on = req.addListener.bind(req);
            return req;
          },
        } as any,
      }),
    /Proxy request timed out after 10ms/,
  );
});

test("requestHttpsViaHttpProxy handles CONNECT and downstream response failures", async () => {
  const proxy = { protocol: "http" as const, host: "proxy", port: 8080 };

  const successConnectModule = {
    request: () => {
      const req = new EventEmitter() as any;
      req.setTimeout = (_ms: number, _fn: () => void) => {};
      req.destroy = (_err?: unknown) => {};
      req.end = () => {
        const socket = { destroy: () => {} };
        req.emit("connect", { statusCode: 200, statusMessage: "OK" }, socket);
      };
      return req;
    },
  };

  const failConnectModule = {
    request: () => {
      const req = new EventEmitter() as any;
      req.setTimeout = (_ms: number, _fn: () => void) => {};
      req.destroy = (_err?: unknown) => {};
      req.end = () => {
        const socket = { destroy: () => {} };
        req.emit("connect", { statusCode: 407, statusMessage: "Proxy Auth" }, socket);
      };
      return req;
    },
  };

  const httpsModule = {
    request: (_opts: any, onResponse: (response: any) => void) => {
      const req = new EventEmitter() as any;
      req.setTimeout = (_ms: number, _fn: () => void) => {};
      req.destroy = (_err?: unknown) => {};
      req.end = () => {
        const res = new EventEmitter() as any;
        res.statusCode = 200;
        res.statusMessage = "OK";
        res.setEncoding = () => {};
        onResponse(res);
        res.emit("data", "secure-ok");
        res.emit("end");
      };
      return req;
    },
  };

  const tlsModule = {
    connect: () => ({ on: () => {}, once: () => {} }),
  };

  const secure = await requestHttpsViaHttpProxy(new URL("https://example.com/path"), {
    proxy,
    headers: {},
    timeoutMs: 10,
    httpModule: successConnectModule as any,
    httpsModule: httpsModule as any,
    tlsModule: tlsModule as any,
  });
  assert.equal(secure, "secure-ok");

  await assert.rejects(
    () =>
      requestHttpsViaHttpProxy(new URL("https://example.com/path"), {
        proxy,
        headers: {},
        timeoutMs: 10,
        httpModule: failConnectModule as any,
        httpsModule: httpsModule as any,
        tlsModule: tlsModule as any,
      }),
    /Proxy tunnel failed with 407 Proxy Auth/,
  );

  await assert.rejects(
    () =>
      requestHttpsViaHttpProxy(new URL("https://example.com/path"), {
        proxy,
        headers: {},
        timeoutMs: 10,
        httpModule: successConnectModule as any,
        httpsModule: {
          request: (_opts: any, onResponse: (response: any) => void) => {
            const req = new EventEmitter() as any;
            req.setTimeout = (_ms: number, _fn: () => void) => {};
            req.destroy = (_err?: unknown) => {};
            req.end = () => {
              const res = new EventEmitter() as any;
              res.statusCode = 502;
              res.statusMessage = "Bad Gateway";
              res.setEncoding = () => {};
              onResponse(res);
              res.emit("end");
            };
            return req;
          },
        } as any,
        tlsModule: tlsModule as any,
      }),
    /Proxy response failed with 502 Bad Gateway/,
  );
});

test("buildFailurePayload includes explicit failure details and follow-up task", () => {
  const payload = buildFailurePayload(new Error("Boom"), {
    repoPath: "/repo/crawl",
    logPaths: ["/repo/crawl/logs/failure.log.json"],
    phase: "parse",
  });

  assert.equal(payload.status, "failure");
  assert.equal(payload.phase, "parse");
  assert.equal(payload.error.message, "Boom");
  assert.match(payload.calling_agent_response, /Failure during parse: Boom/);
  assert.deepEqual(payload.log_paths, ["/repo/crawl/logs/failure.log.json"]);
  assert.deepEqual(payload.follow_up_task.repos, ["/repo/crawl"]);
  assert.match(payload.follow_up_task.prompt, /\/repo\/crawl\/logs\/failure\.log\.json/);

  assert.deepEqual(buildFollowUpTask("/repo/crawl", []), {
    repos: ["/repo/crawl"],
    baseBranch: "main",
    targetSubdir: ".",
    prompt:
      "Review the failing log paths first, identify every root cause behind the failed task, fix the underlying issues in this repository, validate locally where possible, and summarize the verified results.",
  });
});

test("postJson and maybeSendFailureCallback honor callback behavior", async () => {
  await postJson(
    "https://hub.test/callback",
    { ok: true },
    async () => ({ ok: true, status: 200, statusText: "OK", text: async () => "" }) as Response,
  );

  await assert.rejects(
    () =>
      postJson(
        "https://hub.test/callback",
        { ok: true },
        async () => ({ ok: false, status: 500, statusText: "Fail", text: async () => "" }) as Response,
      ),
    /Hub callback failed with 500 Fail/,
  );

  const original = process.env.MOLTENBOT_FAILURE_CALLBACK_URL;
  delete process.env.MOLTENBOT_FAILURE_CALLBACK_URL;
  await maybeSendFailureCallback(buildFailurePayload(new Error("x")), async () => {
    throw new Error("should not call");
  });

  process.env.MOLTENBOT_FAILURE_CALLBACK_URL = "https://hub.test/callback";
  let called = false;
  await maybeSendFailureCallback(buildFailurePayload(new Error("x")), async () => {
    called = true;
    return { ok: true, status: 200, statusText: "OK", text: async () => "" } as Response;
  });
  assert.equal(called, true);

  if (original) {
    process.env.MOLTENBOT_FAILURE_CALLBACK_URL = original;
  } else {
    delete process.env.MOLTENBOT_FAILURE_CALLBACK_URL;
  }
});

test("writeFailureLog persists failure payload to disk", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snkrs-log-test-"));
  const payload = buildFailurePayload(new Error("disk boom"), { repoPath: "/repo/crawl" });

  const logPath = writeFailureLog(payload, tmpDir);
  const text = fs.readFileSync(logPath, "utf8");
  const parsed = JSON.parse(text);

  assert.equal(parsed.status, "failure");
  assert.equal(parsed.error.message, "disk boom");
});

test("crawlSnkrsWithDeps and runCli success/failure orchestration", async () => {
  const writes: unknown[] = [];
  const payload = await crawlSnkrsWithDeps(
    {
      feedUrl: "https://nike.example/launch",
      userAgents: ["ua-a"],
      seed: 1,
    },
    {
      fetchTextImpl: async () => buildHtmlFromState(buildLaunchState()),
      parseInitialStateImpl: parseInitialState,
      normalizeLaunchItemsImpl: normalizeLaunchItems,
      writeStdoutJsonImpl: async (value: unknown) => {
        writes.push(value);
      },
    },
  );

  assert.equal(payload.status, "success");
  assert.equal(payload.item_count, 1);
  assert.equal((writes[0] as any).status, "success");

  const emitted: unknown[] = [];
  const previousExit = process.exitCode;
  process.exitCode = 0;

  await runCli({
    crawlSnkrsImpl: async () => {
      throw new Error("runtime fail");
    },
    writeFailureLogImpl: () => "/tmp/failure.log.json",
    maybeSendFailureCallbackImpl: async () => {
      throw new Error("callback failed");
    },
    writeStdoutJsonImpl: async (value: unknown) => {
      emitted.push(value);
    },
  });

  const failureOutput = emitted[0] as any;
  assert.equal(failureOutput.status, "failure");
  assert.match(failureOutput.calling_agent_response, /runtime fail/);
  assert.equal(failureOutput.callback_error.message, "callback failed");
  assert.equal(process.exitCode, 1);

  process.exitCode = previousExit;
});

test("crawlSnkrs wrapper reads environment defaults and writeStdoutJson writes file", async () => {
  const previousEnv = {
    feed: process.env.SNKRS_FEED_URL,
    output: process.env.SNKRS_OUTPUT_PATH,
    agents: process.env.SNKRS_USER_AGENTS,
    seed: process.env.SNKRS_USER_AGENT_SEED,
  };

  const outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "snkrs-out-")), "payload.json");
  process.env.SNKRS_FEED_URL = "https://env.example/launch";
  process.env.SNKRS_OUTPUT_PATH = outputPath;
  process.env.SNKRS_USER_AGENTS = "ua-env-1,ua-env-2";
  process.env.SNKRS_USER_AGENT_SEED = "0";

  try {
    const result = await crawlSnkrs(
      {},
      {
        fetchTextImpl: async () => buildHtmlFromState(buildLaunchState()),
        parseInitialStateImpl: parseInitialState,
        normalizeLaunchItemsImpl: normalizeLaunchItems,
      },
    );
    assert.equal(result.source, "https://env.example/launch");
    assert.equal(result.status, "success");
    const written = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(written.status, "success");

    const customOutputPath = path.join(path.dirname(outputPath), "manual.json");
    const { writeStdoutJson } = await import("./crawler");
    await writeStdoutJson({ ok: true }, customOutputPath);
    assert.equal(JSON.parse(fs.readFileSync(customOutputPath, "utf8")).ok, true);
  } finally {
    process.env.SNKRS_FEED_URL = previousEnv.feed;
    process.env.SNKRS_OUTPUT_PATH = previousEnv.output;
    process.env.SNKRS_USER_AGENTS = previousEnv.agents;
    process.env.SNKRS_USER_AGENT_SEED = previousEnv.seed;
  }
});
