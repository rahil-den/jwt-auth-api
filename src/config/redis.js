// Redis configuration
// - Connect to Redis using ioredis
// - Export the redis client for use in middleware (rate limiting, token blacklisting)
import Redis from 'ioredis';

const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT,10) || 6379,
})