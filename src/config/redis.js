// WHY: ioredis auto-reconnects on failure and supports promises natively.
// The 'node_redis' package is the alternative but ioredis is more battle-tested
// for production retry logic.

const Redis = require('ioredis');

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  // Retry strategy: exponential backoff up to 3s, stop after 10 retries
  retryStrategy(times) {
    if (times > 10) {
      console.error('❌ Redis: too many retries, giving up');
      return null; // stop retrying
    }
    return Math.min(times * 200, 3000);
  },
  enableReadyCheck: true,
  maxRetriesPerRequest: 3,
});

redis.on('connect', () => console.log(' Redis connected'));
redis.on('error', (err) => console.error(' Redis error:', err.message));

module.exports = redis;