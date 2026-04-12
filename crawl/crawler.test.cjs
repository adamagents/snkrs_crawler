const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const {
  buildChromeProfiles,
  ProxyPool,
  buildFailurePayload,
  raceToFirstSuccess,
  formatPacificDate,
  normalizeLaunchItems,
  parseInitialState,
  pickUserAgent,
  crawlSnkrs,
} = require("./crawler.cjs");

function buildHtmlFromState(state) {
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: {
      pageProps: {
        initialState: JSON.stringify(state),
      },
    },
  })}</script></body></html>`;
}

test("pickUserAgent selects a stable entry from the configured list", () => {
  const userAgent = pickUserAgent(["ua-1", "ua-2", "ua-3"], 4);
  assert.equal(userAgent, "ua-2");
});

test("formatPacificDate converts UTC launch times into Pacific local time", () => {
  assert.equal(formatPacificDate("2026-01-15T16:00:00.000Z"), "2026-01-15 08:00:00 PST");
  assert.equal(formatPacificDate("2026-04-18T14:00:00.000Z"), "2026-04-18 07:00:00 PDT");
});

test("parseInitialState extracts the embedded Nike payload", () => {
  const state = { ok: true, product: { threads: { data: { ids: [], items: {} } } } };
  const parsed = parseInitialState(buildHtmlFromState(state));
  assert.deepEqual(parsed, state);
});

test("normalizeLaunchItems returns only launch products with the requested fields", () => {
  const state = {
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

  assert.deepEqual(normalizeLaunchItems(state), [
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
});

test("buildFailurePayload includes explicit failure details and a follow-up task", () => {
  const payload = buildFailurePayload(new Error("Boom"), {
    repoPath: "/repo/crawl",
    repoRemote: "git@github.com:Molten-Bot/moltenhub-code.git",
    logPaths: ["/repo/crawl/logs/failure.log.json"],
    phase: "parse",
  });

  assert.equal(payload.status, "failure");
  assert.equal(payload.phase, "parse");
  assert.equal(payload.error.message, "Boom");
  assert.deepEqual(payload.repository, {
    path: "/repo/crawl",
    remote: "git@github.com:Molten-Bot/moltenhub-code.git",
  });
  assert.deepEqual(payload.log_paths, ["/repo/crawl/logs/failure.log.json"]);
  assert.deepEqual(payload.follow_up_task.repos, ["git@github.com:Molten-Bot/moltenhub-code.git"]);
  assert.match(payload.follow_up_task.prompt, /\/repo\/crawl\/logs\/failure\.log\.json/);
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
  assert.equal(`${first.host}:${first.port}`, "proxy-1:8001");
  assert.equal(`${second.host}:${second.port}`, "proxy-2:8002");

  pool.recordFailure(first, 0);
  const afterFailure = pool.getNextProxy(200);
  assert.equal(`${afterFailure.host}:${afterFailure.port}`, "proxy-2:8002");

  const afterCooldown = pool.getNextProxy(1200);
  assert.equal(`${afterCooldown.host}:${afterCooldown.port}`, "proxy-1:8001");
});

test("buildChromeProfiles ensures unique directories and auto-fills concurrency gaps", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snkrs-chrome-profiles-test-"));
  try {
    const absoluteProfile = path.join(tempRoot, "abs-profile");
    const profiles = buildChromeProfiles({
      requestedProfiles: ["custom-one", { path: absoluteProfile, name: "absolute-custom" }],
      concurrency: 3,
      rootDir: tempRoot,
    });

    assert.equal(profiles.length, 3);
    assert(profiles.some((profile) => profile.name === "custom-one" && profile.path === path.join(tempRoot, "custom-one")));
    assert(profiles.some((profile) => profile.path === absoluteProfile));
    profiles.forEach((profile) => {
      assert.ok(fs.existsSync(profile.path));
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("crawlSnkrs surfaces browser metadata when Chrome concurrency is configured", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snkrs-crawler-browser-test-"));
  const minimalState = {
    product: {
      threads: { data: { ids: [], items: {} } },
      products: { data: { items: {} } },
      availabilities: { data: { items: {} } },
    },
  };
  const html = buildHtmlFromState(minimalState);
  let poolInvocation = null;

  const chromePoolFetcher = async (url, options) => {
    poolInvocation = options;
    assert.equal(options.concurrency, 2);
    assert.equal(options.profiles.length, 2);
    return { html, profile: options.profiles[1] };
  };

  try {
    const outputPath = path.join(tempRoot, "result.json");
    const payload = await crawlSnkrs({
      feedUrl: "https://example.com/launch",
      requestMode: "browser",
      chromeProfiles: ["west", "central"],
      chromeProfileRoot: tempRoot,
      browserConcurrency: 2,
      browserFallbackToHttp: false,
      outputPath,
      chromePoolFetcher,
    });

    assert(poolInvocation, "Expected chromePoolFetcher to be invoked");
    assert.equal(payload.context.request_mode, "browser");
    assert.equal(payload.context.browser_concurrency, 2);
    assert.equal(payload.context.browser_profile, "central");
    assert.deepEqual(payload.items, []);
    assert.equal(fs.existsSync(outputPath), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("raceToFirstSuccess resolves with the first successful task and aborts the rest", async () => {
  const aborted = new Set();
  const result = await raceToFirstSuccess(
    ["slow", "winner", "fail"],
    async (id, { signal }) => {
      signal?.addEventListener("abort", () => aborted.add(id));
      if (id === "winner") {
        await delay(5);
        return "ok";
      }

      await delay(id === "slow" ? 50 : 10);
      throw new Error(`fail-${id}`);
    },
    { concurrency: 2 },
  );

  assert.equal(result.item, "winner");
  assert.equal(result.value, "ok");
  assert(aborted.has("slow"));
});

test("raceToFirstSuccess rejects with an AggregateError when every task fails", async () => {
  await assert.rejects(
    raceToFirstSuccess(
      ["one", "two"],
      async () => {
        throw new Error("nope");
      },
      { concurrency: 2 },
    ),
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
});
