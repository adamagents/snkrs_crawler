import { PROXY_FAILURE_COOLDOWN_MS } from "./utils/constants";
import type { ProxyDefinition } from "./types";

export function proxyKey(proxy: ProxyDefinition): string {
  return `${proxy.protocol}://${proxy.host}:${proxy.port}`;
}

export class ProxyPool {
  private readonly proxies: ProxyDefinition[];

  private readonly cooldownMs: number;

  private cursor = 0;

  private readonly state = new Map<string, { cooldownUntil: number }>();

  constructor(proxies: ProxyDefinition[], { cooldownMs = PROXY_FAILURE_COOLDOWN_MS }: { cooldownMs?: number } = {}) {
    this.proxies = Array.isArray(proxies) ? proxies.filter(Boolean) : [];
    this.cooldownMs = cooldownMs;
  }

  get size(): number {
    return this.proxies.length;
  }

  getNextProxy(now = Date.now()): ProxyDefinition | null {
    if (this.proxies.length === 0) {
      return null;
    }

    for (let i = 0; i < this.proxies.length; i += 1) {
      const index = (this.cursor + i) % this.proxies.length;
      const proxy = this.proxies[index];
      const cooldownUntil = this.state.get(proxyKey(proxy))?.cooldownUntil ?? 0;

      if (cooldownUntil <= now) {
        this.cursor = (index + 1) % this.proxies.length;
        return proxy;
      }
    }

    return null;
  }

  recordFailure(proxy: ProxyDefinition, now = Date.now()): void {
    this.state.set(proxyKey(proxy), {
      cooldownUntil: now + this.cooldownMs,
    });
  }

  recordSuccess(proxy: ProxyDefinition): void {
    this.state.delete(proxyKey(proxy));
  }
}
