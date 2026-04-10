export type ProxyDefinition = {
  host: string;
  port: number;
  protocol: "http";
  country?: string;
  city?: string;
};

export type PriceSummary = {
  currency: string | null;
  current: number | null;
  full: number | null;
  msrp: number | null;
};

export type AvailabilitySummary = {
  launch_status: string | null;
  available_now: boolean;
  in_stock_skus: number;
  total_skus: number;
};

export type NormalizedLaunchItem = {
  id: string;
  product_id: string;
  slug: string | null;
  name: string | null;
  color: string | null;
  price: PriceSummary;
  availability_date_pacific: string | null;
  availability: AvailabilitySummary;
  feed_url: string;
  style_color: string | null;
};

export type SuccessPayload = {
  status: "success";
  source: string;
  requested_at_utc: string;
  item_count: number;
  items: NormalizedLaunchItem[];
  warnings: string[];
};

export type FollowUpTaskPayload = {
  repos: string[];
  baseBranch: "main";
  targetSubdir: ".";
  prompt: string;
};

export type FailurePayload = {
  status: "failure";
  phase: string;
  message: string;
  calling_agent_response: string;
  error: {
    name: string;
    message: string;
    stack: string | null;
  };
  log_paths: string[];
  follow_up_task: FollowUpTaskPayload;
  callback_error?: {
    name: string;
    message: string;
  };
};

export type CrawlOptions = {
  feedUrl?: string;
  outputPath?: string;
  userAgents?: string[];
  seed?: string | number;
};

export type FetchTextOptions = {
  userAgent: string;
  timeoutMs?: number;
  proxies?: ProxyDefinition[];
};
