/**
 * All configuration is read from environment variables so the same image runs
 * in Docker, locally, or in CI without code changes.
 */

export type LBStrategy = 'round-robin' | 'least-connections';
export type RateLimitKey = 'ip' | 'api-key';

export interface Config {
  port: number;
  backends: string[];
  loadBalancing: { strategy: LBStrategy };
  rateLimit: {
    enabled: boolean;
    windowMs: number;   // sliding-window size
    maxRequests: number; // max requests per window
    keyBy: RateLimitKey;
  };
  healthCheck: {
    intervalMs: number;
    path: string;
    timeoutMs: number;
  };
  redis: { host: string; port: number };
}

export const config: Config = {
  port: Number(process.env.PORT) || 3000,

  // Comma-separated list of backend URLs
  backends: (
    process.env.BACKENDS ||
    'http://localhost:3001,http://localhost:3002,http://localhost:3003'
  ).split(',').map(u => u.trim()),

  loadBalancing: {
    strategy: (process.env.LB_STRATEGY as LBStrategy) || 'round-robin',
  },

  rateLimit: {
    enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
    maxRequests: Number(process.env.RATE_LIMIT_MAX) || 100,
    keyBy: (process.env.RATE_LIMIT_KEY_BY as RateLimitKey) || 'ip',
  },

  healthCheck: {
    intervalMs: Number(process.env.HEALTH_CHECK_INTERVAL_MS) || 10_000,
    path: process.env.HEALTH_CHECK_PATH || '/health',
    timeoutMs: Number(process.env.HEALTH_CHECK_TIMEOUT_MS) || 3_000,
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
  },
};
