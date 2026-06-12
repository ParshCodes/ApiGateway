/**
 * In-memory metrics store.
 *
 * Latency percentiles are computed from a fixed-size circular buffer (last
 * WINDOW_SIZE samples per backend). This is O(n log n) per /metrics call but
 * keeps the implementation dependency-free and easy to explain.
 */

const LATENCY_WINDOW = 1000; // samples per backend

interface BackendStats {
  totalRequests: number;
  successRequests: number;  // 2xx / 3xx
  errorRequests: number;    // 4xx / 5xx / timeout
  activeConnections: number;
  latencies: number[];      // circular buffer, unit: ms
  latencyIndex: number;
}

export interface BackendMetricsSnapshot {
  url: string;
  healthy: boolean;
  totalRequests: number;
  successRequests: number;
  errorRequests: number;
  activeConnections: number;
  p50: number;
  p95: number;
  p99: number;
  rps: number; // requests per second over the last measurement window
}

export class MetricsStore {
  private stats = new Map<string, BackendStats>();
  private rateLimitHits = 0;
  private windowStart = Date.now();
  private requestsInWindow = 0;

  initBackend(url: string): void {
    if (!this.stats.has(url)) {
      this.stats.set(url, {
        totalRequests: 0,
        successRequests: 0,
        errorRequests: 0,
        activeConnections: 0,
        latencies: new Array(LATENCY_WINDOW).fill(0),
        latencyIndex: 0,
      });
    }
  }

  recordRequest(url: string, statusCode: number, latencyMs: number): void {
    const s = this.stats.get(url);
    if (!s) return;

    s.totalRequests++;
    if (statusCode < 400) {
      s.successRequests++;
    } else {
      s.errorRequests++;
    }

    // Write into circular buffer
    s.latencies[s.latencyIndex % LATENCY_WINDOW] = latencyMs;
    s.latencyIndex++;

    this.requestsInWindow++;
  }

  recordRateLimit(): void {
    this.rateLimitHits++;
  }

  incrementConnections(url: string): void {
    const s = this.stats.get(url);
    if (s) s.activeConnections++;
  }

  decrementConnections(url: string): void {
    const s = this.stats.get(url);
    if (s && s.activeConnections > 0) s.activeConnections--;
  }

  snapshot(backends: { url: string; healthy: boolean }[]): BackendMetricsSnapshot[] {
    const now = Date.now();
    const elapsed = (now - this.windowStart) / 1000; // seconds
    const gatewayRps = elapsed > 0 ? this.requestsInWindow / elapsed : 0;

    // Reset the RPS window every 10 s
    if (elapsed >= 10) {
      this.requestsInWindow = 0;
      this.windowStart = now;
    }

    return backends.map(b => {
      const s = this.stats.get(b.url) ?? {
        totalRequests: 0,
        successRequests: 0,
        errorRequests: 0,
        activeConnections: 0,
        latencies: [],
        latencyIndex: 0,
      };

      const filled = s.latencies.slice(0, Math.min(s.latencyIndex, LATENCY_WINDOW));
      const sorted = [...filled].sort((a, z) => a - z);

      return {
        url: b.url,
        healthy: b.healthy,
        totalRequests: s.totalRequests,
        successRequests: s.successRequests,
        errorRequests: s.errorRequests,
        activeConnections: s.activeConnections,
        p50: percentile(sorted, 0.50),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
        rps: gatewayRps / Math.max(backends.filter(x => x.healthy).length, 1),
      };
    });
  }

  getRateLimitHits(): number {
    return this.rateLimitHits;
  }

  /** Build a Prometheus-compatible text payload. */
  toPrometheus(snapshots: BackendMetricsSnapshot[]): string {
    const lines: string[] = [];

    const metric = (name: string, help: string, type: string, rows: string[]) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      lines.push(...rows);
      lines.push('');
    };

    metric(
      'gateway_requests_total',
      'Total requests forwarded to each backend',
      'counter',
      snapshots.map(s => `gateway_requests_total{backend="${s.url}"} ${s.totalRequests}`),
    );

    metric(
      'gateway_request_errors_total',
      'Total error responses (4xx/5xx) from backends',
      'counter',
      snapshots.map(s => `gateway_request_errors_total{backend="${s.url}"} ${s.errorRequests}`),
    );

    metric(
      'gateway_active_connections',
      'Current in-flight requests per backend',
      'gauge',
      snapshots.map(s => `gateway_active_connections{backend="${s.url}"} ${s.activeConnections}`),
    );

    metric(
      'gateway_backend_healthy',
      '1 if backend is in the active pool, 0 if removed by health checker',
      'gauge',
      snapshots.map(s => `gateway_backend_healthy{backend="${s.url}"} ${s.healthy ? 1 : 0}`),
    );

    for (const q of [50, 95, 99] as const) {
      const key = `p${q}` as 'p50' | 'p95' | 'p99';
      metric(
        `gateway_latency_${key}_ms`,
        `P${q} request latency in milliseconds`,
        'gauge',
        snapshots.map(s => `gateway_latency_${key}_ms{backend="${s.url}"} ${s[key].toFixed(2)}`),
      );
    }

    metric(
      'gateway_rate_limit_hits_total',
      'Total requests rejected by the rate limiter',
      'counter',
      [`gateway_rate_limit_hits_total ${this.rateLimitHits}`],
    );

    return lines.join('\n');
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, idx)];
}
