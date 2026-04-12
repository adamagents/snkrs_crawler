import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import type { FetchTextOptions, ProxyDefinition } from "./types";
import { MAX_PROXY_ATTEMPTS_PER_REQUEST, REQUEST_TIMEOUT_MS, US_FREE_RESIDENTIAL_HTTP_PROXIES } from "./utils/constants";
import { ProxyPool, proxyKey } from "./proxy";

type RequestHeaders = Record<string, string>;

export type FetchLike = typeof fetch;

export async function requestDirect(
  url: string,
  {
    headers,
    timeoutMs,
    fetchImpl = fetch,
  }: { headers: RequestHeaders; timeoutMs: number; fetchImpl?: FetchLike },
): Promise<string> {
  const response = await fetchImpl(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Nike launch request failed with ${response.status} ${response.statusText}`);
  }

  return response.text();
}

export function requestViaProxy(
  url: string,
  {
    proxy,
    headers,
    timeoutMs,
  }: { proxy: ProxyDefinition; headers: RequestHeaders; timeoutMs: number },
): Promise<string> {
  const targetUrl = new URL(url);

  if (targetUrl.protocol === "https:") {
    return requestHttpsViaHttpProxy(targetUrl, { proxy, headers, timeoutMs });
  }

  if (targetUrl.protocol === "http:") {
    return requestHttpViaHttpProxy(targetUrl, { proxy, headers, timeoutMs });
  }

  return Promise.reject(new Error(`Unsupported URL protocol: ${targetUrl.protocol}`));
}

export function requestHttpViaHttpProxy(
  targetUrl: URL,
  {
    proxy,
    headers,
    timeoutMs,
    httpModule = http,
  }: { proxy: ProxyDefinition; headers: RequestHeaders; timeoutMs: number; httpModule?: typeof http },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = httpModule.request(
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
        const bodyParts: string[] = [];
        response.setEncoding("utf8");
        response.on("data", (chunk) => bodyParts.push(chunk));
        response.on("end", () => {
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
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

export function requestHttpsViaHttpProxy(
  targetUrl: URL,
  {
    proxy,
    headers,
    timeoutMs,
    httpModule = http,
    httpsModule = https,
    tlsModule = tls,
  }: {
    proxy: ProxyDefinition;
    headers: RequestHeaders;
    timeoutMs: number;
    httpModule?: typeof http;
    httpsModule?: typeof https;
    tlsModule?: typeof tls;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const connectRequest = httpModule.request({
      host: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: `${targetUrl.hostname}:${targetUrl.port || 443}`,
      headers: {
        host: `${targetUrl.hostname}:${targetUrl.port || 443}`,
        "proxy-connection": "keep-alive",
      },
    });

    const fail = (error: unknown) => reject(error instanceof Error ? error : new Error(String(error)));
    connectRequest.setTimeout(timeoutMs, () => connectRequest.destroy(new Error(`Proxy tunnel timed out after ${timeoutMs}ms`)));
    connectRequest.on("error", fail);

    connectRequest.on("connect", (connectResponse, socket) => {
      if (connectResponse.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`Proxy tunnel failed with ${connectResponse.statusCode} ${connectResponse.statusMessage}`));
        return;
      }

      const tunnel = tlsModule.connect({
        socket,
        servername: targetUrl.hostname,
      });

      const request = httpsModule.request(
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
          const bodyParts: string[] = [];
          response.setEncoding("utf8");
          response.on("data", (chunk) => bodyParts.push(chunk));
          response.on("end", () => {
            if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
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

export async function fetchText(
  url: string,
  { userAgent, timeoutMs = REQUEST_TIMEOUT_MS, proxies = US_FREE_RESIDENTIAL_HTTP_PROXIES }: FetchTextOptions,
  deps: {
    requestViaProxyImpl?: typeof requestViaProxy;
    requestDirectImpl?: typeof requestDirect;
  } = {},
): Promise<string> {
  const requestHeaders: RequestHeaders = {
    "user-agent": userAgent,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    pragma: "no-cache",
    "cache-control": "no-cache",
  };
  const requestViaProxyImpl = deps.requestViaProxyImpl ?? requestViaProxy;
  const requestDirectImpl = deps.requestDirectImpl ?? requestDirect;

  const proxyPool = new ProxyPool(proxies);
  const proxyErrors: Array<{ proxy: string; message: string }> = [];

  for (let attempt = 0; attempt < Math.min(MAX_PROXY_ATTEMPTS_PER_REQUEST, proxyPool.size); attempt += 1) {
    const proxy = proxyPool.getNextProxy();

    if (!proxy) {
      break;
    }

    try {
      const response = await requestViaProxyImpl(url, { proxy, headers: requestHeaders, timeoutMs });
      proxyPool.recordSuccess(proxy);
      return response;
    } catch (error) {
      proxyPool.recordFailure(proxy);
      proxyErrors.push({
        proxy: proxyKey(proxy),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    return await requestDirectImpl(url, { headers: requestHeaders, timeoutMs });
  } catch (error) {
    const reason =
      proxyErrors.length > 0
        ? ` Proxy errors: ${proxyErrors.map((entry) => `${entry.proxy} -> ${entry.message}`).join(" | ")}`
        : "";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Nike launch request failed without a working proxy and direct fallback failed: ${message}.${reason}`);
  }
}
