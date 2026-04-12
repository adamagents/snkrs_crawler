import { normalizedLaunchItemSchema, nextDataSchema, threadsDataSchema } from "./schemas";
import type { AvailabilitySummary, NormalizedLaunchItem } from "./types";
import { DEFAULT_FEED_URL, PACIFIC_TIME_ZONE } from "./utils/constants";

export function pickUserAgent(userAgents: readonly string[], seed: string | number = Date.now()): string {
  if (!Array.isArray(userAgents) || userAgents.length === 0) {
    throw new Error("At least one user agent must be configured.");
  }

  const numericSeed = Number(seed);
  const stableSeed = Number.isFinite(numericSeed) ? numericSeed : Date.now();
  const index = Math.abs(stableSeed) % userAgents.length;
  return userAgents[index] as string;
}

export function extractNextDataJson(html: string): unknown {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);

  if (!match) {
    throw new Error("Unable to find Nike launch data in the page response.");
  }

  return JSON.parse(match[1]);
}

export function parseInitialState(html: string): Record<string, unknown> {
  const nextData = nextDataSchema.parse(extractNextDataJson(html));
  const parsedState = JSON.parse(nextData.props.pageProps.initialState);

  if (!parsedState || typeof parsedState !== "object") {
    throw new Error("The Nike launch page did not include the expected initial state payload.");
  }

  return parsedState as Record<string, unknown>;
}

export function formatPacificDate(isoDate?: string | null): string | null {
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

export function summarizeAvailability(product: any, availability: any): AvailabilitySummary {
  const liveSkuCount = Array.isArray(product?.skus) ? product.skus.filter((sku: any) => sku.available).length : 0;

  return {
    launch_status: product?.launchStatus ?? null,
    available_now: Boolean(availability?.available),
    in_stock_skus: liveSkuCount,
    total_skus: Array.isArray(product?.skus) ? product.skus.length : 0,
  };
}

export function normalizeThread(thread: any, state: Record<string, any>): NormalizedLaunchItem | null {
  if (!thread?.productId) {
    return null;
  }

  const product = state?.product?.products?.data?.items?.[thread.productId];
  const availability = state?.product?.availabilities?.data?.items?.[thread.productId];

  if (!product) {
    return null;
  }

  const normalized: NormalizedLaunchItem = {
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

  return normalizedLaunchItemSchema.parse(normalized);
}

export function normalizeLaunchItems(state: Record<string, any>): NormalizedLaunchItem[] {
  const threads = threadsDataSchema.safeParse(state);

  if (!threads.success) {
    throw new Error("The Nike launch payload does not expose the expected product thread data.");
  }

  const threadIds = threads.data.product.threads.data.ids;
  const threadItems = threads.data.product.threads.data.items as Record<string, any>;

  return threadIds
    .map((threadId: string) => normalizeThread(threadItems[threadId], state))
    .filter((value: NormalizedLaunchItem | null): value is NormalizedLaunchItem => Boolean(value));
}
