import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { Config } from './config';

/**
 * Sliding-window rate limiter backed by a Redis sorted set.
 *
 * Each key maps to a sorted set where:
 *   - member = unique request ID
 *   - score  = request timestamp (ms)
 *
 * On every request we atomically:
 *   1. Remove members older than (now - windowMs)
 *   2. Count remaining members
 *   3. Reject if count >= maxRequests
 *   4. Otherwise insert and return allowed
 *
 * The entire check-and-insert runs in a single Lua script so there are no
 * race conditions under concurrent load.
 */

const SLIDING_WINDOW_SCRIPT = `
local key         = KEYS[1]
local now         = tonumber(ARGV[1])
local window_ms   = tonumber(ARGV[2])
local max         = tonumber(ARGV[3])
local request_id  = ARGV[4]

-- Remove entries that have fallen outside the window
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window_ms)

-- Count how many requests are still in the window
local count = redis.call('ZCARD', key)

if count >= max then
  -- Tell the caller how many seconds until the oldest entry expires
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry_ms = window_ms
  if #oldest >= 2 then
    retry_ms = window_ms - (now - tonumber(oldest[2]))
    if retry_ms < 0 then retry_ms = 0 end
  end
  return {0, math.ceil(retry_ms / 1000)}
end

-- Record this request; score = timestamp so we can expire it later
redis.call('ZADD', key, now, request_id)

-- The key should auto-expire slightly after the window to avoid orphaned keys
redis.call('PEXPIRE', key, window_ms + 1000)

return {1, 0}
`;

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the client may retry (only set when allowed=false). */
  retryAfterSeconds: number;
}

export class RateLimiter {
  private redis: Redis;
  private windowMs: number;
  private maxRequests: number;
  private keyBy: Config['rateLimit']['keyBy'];
  private scriptSha?: string;

  constructor(redis: Redis, cfg: Config['rateLimit']) {
    this.redis = redis;
    this.windowMs = cfg.windowMs;
    this.maxRequests = cfg.maxRequests;
    this.keyBy = cfg.keyBy;
  }

  /** Pre-load the Lua script into Redis so we send the SHA on hot paths. */
  async loadScript(): Promise<void> {
    this.scriptSha = await this.redis.script('LOAD', SLIDING_WINDOW_SCRIPT) as string;
    console.log('[rate-limiter] Lua script loaded, sha:', this.scriptSha);
  }

  async check(req: { ip?: string; headers: Record<string, string | string[] | undefined> }): Promise<RateLimitResult> {
    const identifier = this.keyBy === 'api-key'
      ? (req.headers['x-api-key'] as string) || req.ip || 'anonymous'
      : req.ip || 'anonymous';

    const key = `ratelimit:${identifier}`;
    const now = Date.now();
    const requestId = randomUUID();

    let result: [number, number];

    if (this.scriptSha) {
      try {
        result = await this.redis.evalsha(
          this.scriptSha, 1, key, now, this.windowMs, this.maxRequests, requestId,
        ) as [number, number];
      } catch {
        // NOSCRIPT error: script was flushed from Redis; fall back to EVAL
        this.scriptSha = undefined;
        result = await this.redis.eval(
          SLIDING_WINDOW_SCRIPT, 1, key, now, this.windowMs, this.maxRequests, requestId,
        ) as [number, number];
      }
    } else {
      result = await this.redis.eval(
        SLIDING_WINDOW_SCRIPT, 1, key, now, this.windowMs, this.maxRequests, requestId,
      ) as [number, number];
    }

    return {
      allowed: result[0] === 1,
      retryAfterSeconds: result[1],
    };
  }
}
