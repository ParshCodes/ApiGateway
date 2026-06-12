import { LBStrategy } from './config';

export interface Backend {
  url: string;
  healthy: boolean;
  activeConnections: number;
  totalRequests: number;
}

// ---------------------------------------------------------------------------
// Strategy interface + implementations
// ---------------------------------------------------------------------------

interface LoadBalancingStrategy {
  select(backends: Backend[]): Backend | null;
  /** Called when the backend pool changes shape so counters can be reset. */
  reset(): void;
}

/**
 * Round-robin: cycles through healthy backends in order.
 * The index is intentionally not reset when backends become unhealthy —
 * this avoids thundering-herd onto backend[0] after recovery.
 */
class RoundRobinStrategy implements LoadBalancingStrategy {
  private index = 0;

  select(backends: Backend[]): Backend | null {
    const healthy = backends.filter(b => b.healthy);
    if (healthy.length === 0) return null;

    const backend = healthy[this.index % healthy.length];
    this.index = (this.index + 1) % Number.MAX_SAFE_INTEGER; // prevent overflow
    return backend;
  }

  reset(): void {
    this.index = 0;
  }
}

/**
 * Least-connections: always routes to the backend handling the fewest
 * in-flight requests. Ideal for backends with highly variable latency.
 */
class LeastConnectionsStrategy implements LoadBalancingStrategy {
  select(backends: Backend[]): Backend | null {
    const healthy = backends.filter(b => b.healthy);
    if (healthy.length === 0) return null;

    return healthy.reduce((min, b) =>
      b.activeConnections < min.activeConnections ? b : min
    );
  }

  reset(): void { /* stateless */ }
}

// ---------------------------------------------------------------------------
// LoadBalancer — owns the backend pool and delegates selection to a strategy
// ---------------------------------------------------------------------------

export class LoadBalancer {
  private backends: Backend[];
  private strategy: LoadBalancingStrategy;

  constructor(urls: string[], strategy: LBStrategy) {
    this.backends = urls.map(url => ({
      url,
      healthy: true, // optimistic — health checker will correct this quickly
      activeConnections: 0,
      totalRequests: 0,
    }));

    this.strategy = strategy === 'least-connections'
      ? new LeastConnectionsStrategy()
      : new RoundRobinStrategy();
  }

  /**
   * Returns the next backend to use. Throws if no healthy backend exists
   * so callers can return 503 immediately.
   */
  select(): Backend {
    const backend = this.strategy.select(this.backends);
    if (!backend) {
      throw new Error('No healthy backends available');
    }
    backend.totalRequests++;
    return backend;
  }

  markHealthy(url: string): void {
    const b = this.find(url);
    if (b && !b.healthy) {
      console.log(`[health] backend recovered: ${url}`);
      b.healthy = true;
    }
  }

  markUnhealthy(url: string): void {
    const b = this.find(url);
    if (b && b.healthy) {
      console.warn(`[health] backend removed from pool: ${url}`);
      b.healthy = false;
    }
  }

  getAll(): Readonly<Backend>[] {
    return this.backends;
  }

  private find(url: string): Backend | undefined {
    return this.backends.find(b => b.url === url);
  }
}
