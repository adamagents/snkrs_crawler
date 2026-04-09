const DEFAULT_FEED_URL = "https://www.nike.com/launch";
const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const REQUEST_TIMEOUT_MS = 30000;

const DEFAULT_USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
];

// Source: https://iproyal.com/free-proxy-list/ (United States entries, fetched on 2026-04-09)
// Note: free lists are volatile; stale or dead proxies are expected and handled by runtime fallback.
const US_FREE_RESIDENTIAL_HTTP_PROXIES = [
  { host: "198.199.86.11", port: 3128, protocol: "http", country: "United States", city: "North Bergen" },
  { host: "209.97.150.167", port: 8080, protocol: "http", country: "United States", city: "Clifton" },
  { host: "68.185.57.66", port: 80, protocol: "http", country: "United States", city: "Yakima" },
  { host: "68.188.59.198", port: 80, protocol: "http", country: "United States", city: "St Louis" },
  { host: "23.107.176.100", port: 32180, protocol: "http", country: "United States", city: "Manassas" },
  { host: "172.105.153.129", port: 9091, protocol: "http", country: "United States", city: "Atlanta" },
  { host: "50.206.25.109", port: 80, protocol: "http", country: "United States", city: "New York" },
  { host: "50.206.25.104", port: 80, protocol: "http", country: "United States", city: "Pittsburgh" },
  { host: "47.251.12.225", port: 3128, protocol: "http", country: "United States", city: "Santa Clara" },
  { host: "35.171.220.192", port: 80, protocol: "http", country: "United States", city: "Ashburn" },
  { host: "50.206.25.110", port: 80, protocol: "http", country: "United States", city: "New York" },
  { host: "54.68.38.141", port: 8888, protocol: "http", country: "United States", city: "Portland" },
  { host: "162.159.242.151", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "50.206.25.111", port: 80, protocol: "http", country: "United States", city: "New York" },
  { host: "162.159.242.46", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "104.17.120.81", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.242.210", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.250.182", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "104.24.133.167", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "50.201.51.216", port: 8080, protocol: "http", country: "United States", city: "Ashburn" },
  { host: "104.25.14.8", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.242.6", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.242.136", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.242.110", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.242.138", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "104.20.18.237", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.243.178", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.253.194", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.242.164", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.251.132", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.248.115", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "104.16.24.3", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.242.160", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.243.139", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.242.147", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.242.229", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.242.225", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.242.131", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.242.222", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "104.25.228.156", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.246.74", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.242.44", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.250.137", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.242.125", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "104.16.111.78", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "96.95.164.41", port: 3128, protocol: "http", country: "United States", city: "Boston" },
  { host: "162.159.242.198", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.242.143", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.241.165", port: 80, protocol: "http", country: "United States", city: "Newark" },
  { host: "162.159.242.32", port: 80, protocol: "http", country: "United States", city: "Newark" },
];

module.exports = {
  DEFAULT_FEED_URL,
  DEFAULT_USER_AGENTS,
  PACIFIC_TIME_ZONE,
  REQUEST_TIMEOUT_MS,
  US_FREE_RESIDENTIAL_HTTP_PROXIES,
};
