import http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import { URL } from 'url';
import { Config } from './config';
import { LoadBalancer, Backend } from './loadBalancer';
import { RateLimiter } from './rateLimiter';
import { HealthChecker } from './healthCheck';
import { MetricsStore } from './metrics';

// Augment Express Request so TypeScript knows about our per-request metadata
declare global {
  namespace Express {
    interface Request {
      _backend?: Backend;
      _startTime?: number;
    }
  }
}

// Reusable HTTP agent with keep-alive so the gateway maintains a connection
// pool to each backend instead of opening a new TCP socket per request.
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

/**
 * Forward `req` to `targetUrl` and pipe the backend response back to `res`.
 * Returns a Promise that resolves with the backend status code, or rejects on
 * network/timeout errors.
 */
function forward(req: Request, res: Response, targetUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);

    const options: http.RequestOptions = {
      agent,
      hostname: target.hostname,
      port: Number(target.port) || 80,
      path: req.url || '/',
      method: req.method,
      headers: {
        ...req.headers,
        host: target.host,       // rewrite Host header to the backend
        'x-forwarded-for': req.ip || '',
        'x-forwarded-host': req.hostname,
      },
      timeout: 30_000,
    };

    const proxyReq = http.request(options, (proxyRes) => {
      // Pipe backend response headers + body straight to the client
      res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
      proxyRes.on('end', () => resolve(proxyRes.statusCode ?? 200));
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      reject(new Error('Backend timeout'));
    });

    proxyReq.on('error', reject);

    // Forward the client request body (relevant for POST/PUT)
    req.pipe(proxyReq, { end: true });
  });
}

export class Gateway {
  private app: express.Application;
  private lb: LoadBalancer;
  private rateLimiter: RateLimiter;
  private healthChecker: HealthChecker;
  public metrics: MetricsStore;
  private rateLimitEnabled: boolean;

  constructor(cfg: Config) {
    this.app = express();

    // -------------------------------------------------------------------
    // Infrastructure
    // -------------------------------------------------------------------
    // Only connect to Redis when rate limiting is actually enabled.
    // This lets the gateway run in dev/benchmark environments without Redis.
    const redis = new Redis({
      host: cfg.redis.host,
      port: cfg.redis.port,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    });
    redis.on('error', () => { /* suppressed — handled per-request with fail-open */ });

    this.rateLimitEnabled = cfg.rateLimit.enabled;
    this.lb = new LoadBalancer(cfg.backends, cfg.loadBalancing.strategy);
    this.rateLimiter = new RateLimiter(redis, cfg.rateLimit);
    this.healthChecker = new HealthChecker(this.lb, cfg.healthCheck);
    this.metrics = new MetricsStore();

    cfg.backends.forEach(url => this.metrics.initBackend(url));

    if (cfg.rateLimit.enabled) {
      redis.connect().then(() => this.rateLimiter.loadScript()).catch(() => {
        console.warn('[rate-limiter] Redis unavailable — rate limiting disabled');
      });
    }

    // -------------------------------------------------------------------
    // Routes
    // -------------------------------------------------------------------
    this.app.get('/metrics', this.handleMetrics.bind(this));
    this.app.use(this.handleRequest.bind(this));
  }

  start(port: number): void {
    this.healthChecker.start();
    this.app.listen(port, () =>
      console.log(`[gateway] listening on :${port}`)
    );
  }

  stop(): void {
    this.healthChecker.stop();
  }

  // -------------------------------------------------------------------
  // Request handler — the hot path
  // -------------------------------------------------------------------
  private async handleRequest(req: Request, res: Response, _next: NextFunction): Promise<void> {
    // 1. Rate limiting (skipped entirely when disabled — no Redis round-trip)
    if (this.rateLimitEnabled) {
      try {
        const result = await this.rateLimiter.check({ ip: req.ip, headers: req.headers as any });
        if (!result.allowed) {
          this.metrics.recordRateLimit();
          res.setHeader('Retry-After', String(result.retryAfterSeconds));
          res.status(429).json({
            error: 'Too Many Requests',
            retryAfterSeconds: result.retryAfterSeconds,
          });
          return;
        }
      } catch (err) {
        // Redis is down — fail open so traffic keeps flowing
        console.error('[rate-limiter] Redis error, failing open:', (err as Error).message);
      }
    }

    // 2. Backend selection
    let backend: Backend;
    try {
      backend = this.lb.select();
    } catch {
      res.status(503).json({ error: 'Service Unavailable', message: 'No healthy backends' });
      return;
    }

    // 3. Track in-flight connections & latency
    backend.activeConnections++;
    this.metrics.incrementConnections(backend.url);
    const startTime = Date.now();

    // 4. Forward and record metrics on completion
    try {
      const statusCode = await forward(req, res, backend.url);
      const latency = Date.now() - startTime;
      backend.activeConnections = Math.max(0, backend.activeConnections - 1);
      this.metrics.decrementConnections(backend.url);
      this.metrics.recordRequest(backend.url, statusCode, latency);
    } catch (err) {
      const latency = Date.now() - startTime;
      backend.activeConnections = Math.max(0, backend.activeConnections - 1);
      this.metrics.decrementConnections(backend.url);
      this.metrics.recordRequest(backend.url, 502, latency);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Bad Gateway', message: (err as Error).message });
      }
    }
  }

  // -------------------------------------------------------------------
  // /metrics endpoint
  // -------------------------------------------------------------------
  private handleMetrics(req: Request, res: Response): void {
    const backends = this.lb.getAll() as { url: string; healthy: boolean }[];
    const snapshots = this.metrics.snapshot(backends);

    const acceptsPrometheus = (req.headers.accept || '').includes('text/plain');
    if (acceptsPrometheus) {
      res.setHeader('Content-Type', 'text/plain; version=0.0.4');
      res.send(this.metrics.toPrometheus(snapshots));
    } else {
      res.json({
        backends: snapshots,
        gateway: { rateLimitHits: this.metrics.getRateLimitHits() },
      });
    }
  }
}
