import express, { Request, Response, NextFunction } from 'express';
import httpProxy from 'http-proxy';
import Redis from 'ioredis';
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

export class Gateway {
  private app: express.Application;
  private proxy: httpProxy;
  private lb: LoadBalancer;
  private rateLimiter: RateLimiter;
  private healthChecker: HealthChecker;
  public metrics: MetricsStore;

  constructor(cfg: Config) {
    this.app = express();

    // -------------------------------------------------------------------
    // Infrastructure
    // -------------------------------------------------------------------
    const redis = new Redis({ host: cfg.redis.host, port: cfg.redis.port, lazyConnect: true });
    redis.on('error', err => console.error('[redis] connection error:', err.message));

    this.lb = new LoadBalancer(cfg.backends, cfg.loadBalancing.strategy);
    this.rateLimiter = new RateLimiter(redis, cfg.rateLimit);
    this.healthChecker = new HealthChecker(this.lb, cfg.healthCheck);
    this.metrics = new MetricsStore();

    // Pre-initialise per-backend metric buckets
    cfg.backends.forEach(url => this.metrics.initBackend(url));

    // -------------------------------------------------------------------
    // HTTP proxy server
    // -------------------------------------------------------------------
    this.proxy = httpProxy.createProxyServer({ changeOrigin: true, proxyTimeout: 30_000 });

    // Fires when the backend sends a response (connection returns to pool)
    this.proxy.on('proxyRes', (_proxyRes, req) => {
      const r = req as Request;
      if (r._backend) {
        this.metrics.decrementConnections(r._backend.url);
        r._backend.activeConnections = Math.max(0, r._backend.activeConnections - 1);
      }
    });

    // Fires on network-level failures (backend unreachable, timeout, etc.)
    this.proxy.on('error', (err, req, res) => {
      const r = req as Request;
      const latency = r._startTime ? Date.now() - r._startTime : 0;

      if (r._backend) {
        this.metrics.decrementConnections(r._backend.url);
        r._backend.activeConnections = Math.max(0, r._backend.activeConnections - 1);
        this.metrics.recordRequest(r._backend.url, 502, latency);
      }

      const response = res as Response;
      if (!response.headersSent) {
        response.status(502).json({ error: 'Bad Gateway', message: err.message });
      }
    });

    // -------------------------------------------------------------------
    // Routes
    // -------------------------------------------------------------------
    this.app.get('/metrics', this.handleMetrics.bind(this));
    this.app.use(this.handleRequest.bind(this));

    // Initialise async dependencies
    redis.connect().then(() => this.rateLimiter.loadScript()).catch(console.error);
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
    // 1. Rate limiting
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
      // If Redis is down, fail open so traffic continues (log the error)
      console.error('[rate-limiter] Redis error, failing open:', (err as Error).message);
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
    req._backend = backend;
    req._startTime = Date.now();
    backend.activeConnections++;
    this.metrics.incrementConnections(backend.url);

    // The finish event fires after the full response is flushed to the client.
    // We record request-level metrics here for 2xx/3xx paths (the proxy's
    // proxyRes event already decrements connections; we only record the stat).
    res.on('finish', () => {
      if (req._startTime && req._backend) {
        const latency = Date.now() - req._startTime;
        // Only record if proxyRes didn't already handle it via the error path
        if (!res.headersSent || res.statusCode < 500) {
          this.metrics.recordRequest(req._backend.url, res.statusCode, latency);
        }
      }
    });

    // 4. Forward
    this.proxy.web(req, res, { target: backend.url });
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
