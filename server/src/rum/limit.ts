// Token buckets for the ingestion endpoint: one per ingestion key (a site shares it across all its
// visitors) and one per client address (one visitor or script cannot use up the key's share).

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private rate: number;
  private burst: number;
  private now: () => number;

  /** `rate` requests a second on average, up to `burst` at once. */
  constructor(rate: number, burst: number, now: () => number = Date.now) {
    this.rate = rate;
    this.burst = burst;
    this.now = now;
  }

  /** Takes one token; false when the bucket is empty. Returns seconds until the next token otherwise. */
  take(key: string): { ok: true } | { ok: false; retryAfter: number } {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: t };
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 1000) * this.rate);
    b.at = t;
    this.buckets.set(key, b);
    if (this.buckets.size > 100_000) this.sweep(t);
    if (b.tokens < 1) return { ok: false, retryAfter: Math.ceil((1 - b.tokens) / this.rate) };
    b.tokens -= 1;
    return { ok: true };
  }

  /** Drop full buckets so the map does not grow with every address ever seen. */
  private sweep(t: number): void {
    for (const [k, b] of this.buckets) if (b.tokens + ((t - b.at) / 1000) * this.rate >= this.burst) this.buckets.delete(k);
  }
}
