import http from 'http';
import { LoadBalancer } from './loadBalancer';
import { Config } from './config';

/**
 * Periodically probes each backend's health endpoint.
 *
 * A backend is removed from the pool on the first failure and re-added only
 * after a successful probe — so a flapping backend doesn't cause thundering
 * herd (we don't need N-strikes logic for this portfolio scope).
 */
export class HealthChecker {
  private lb: LoadBalancer;
  private cfg: Config['healthCheck'];
  private timer?: NodeJS.Timeout;

  constructor(lb: LoadBalancer, cfg: Config['healthCheck']) {
    this.lb = lb;
    this.cfg = cfg;
  }

  start(): void {
    // Run immediately so the pool is accurate before the first real request
    this.runChecks();
    this.timer = setInterval(() => this.runChecks(), this.cfg.intervalMs);
    console.log(`[health] checking every ${this.cfg.intervalMs}ms via ${this.cfg.path}`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private runChecks(): void {
    for (const backend of this.lb.getAll()) {
      this.probe(backend.url).then(healthy => {
        if (healthy) {
          this.lb.markHealthy(backend.url);
        } else {
          this.lb.markUnhealthy(backend.url);
        }
      });
    }
  }

  private probe(url: string): Promise<boolean> {
    return new Promise(resolve => {
      const target = new URL(this.cfg.path, url);
      const req = http.get(
        { hostname: target.hostname, port: target.port, path: target.pathname, timeout: this.cfg.timeoutMs },
        res => resolve(res.statusCode === 200),
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }
}
