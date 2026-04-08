const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildFailurePayload,
  formatPacificDate,
  normalizeLaunchItems,
  parseInitialState,
  pickUserAgent,
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
    logPaths: ["/repo/crawl/logs/failure.log.json"],
    phase: "parse",
  });

  assert.equal(payload.status, "failure");
  assert.equal(payload.phase, "parse");
  assert.equal(payload.error.message, "Boom");
  assert.deepEqual(payload.log_paths, ["/repo/crawl/logs/failure.log.json"]);
  assert.deepEqual(payload.follow_up_task.repos, ["/repo/crawl"]);
  assert.match(payload.follow_up_task.prompt, /\/repo\/crawl\/logs\/failure\.log\.json/);
});
