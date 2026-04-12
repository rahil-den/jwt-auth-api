// WHY: We use Redis for rate limiting, NOT in-memory.
// In-memory rate limiting breaks the moment you run 2 Node processes (e.g., with PM2).
// Redis is shared across all instances — the counter is always correct.
//
// Strategy: Sliding window counter per IP.
// On each failed login: INCR the counter, set TTL on first increment.
// After 5 failures within the window, lock the IP for LOCK_WINDOW seconds.


const redis = require('../config/redis');

const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 15 * 60;  // 15 minutes — tracks failed attempts
const LOCK_WINDOW_SECONDS = 30 * 60; // 30 minutes — lock after max failures
//  Using function declaration instead of arrow function because it’s 
// hoisted and has its own `this`, making it safer and easier to reuse/debug in middleware.

async function loginRateLimit(req, res, next){
    const ip = req.ip || req.connection.remoteAddress;
    const key = `login_attempts:${ip}`;

    try{
     const attempts = await redis.get(key);
     
     if (attempts && parseInt(attempts, 10) >= MAX_ATTEMPTS) {
      const ttl = await redis.ttl(key);
      return res.status(429).json({
        success: false,
        message: `Too many failed login attempts. Try again in ${Math.ceil(ttl / 60)} minutes.`,
        retryAfter: ttl,
      });
    }

    next()
    }
catch(err){
    // WHY: If Redis is down, we fail OPEN (allow the request).
    // Failing closed would block all logins during a Redis outage.
    // This is a deliberate tradeoff — availability > security during outages.
    console.error('Rate limit Redis error:', err.message);
    next();
}
}


async function recordFailedAttempt(ip){
  const key = `login_attempts:${ip}`;
  
  try {
    const count = await redis.incr(key);

    
    // Only set the TTL on the first failed attempt
    // WHY: We use INCR then conditional EXPIRE, not SET with EX.
    // This prevents resetting the window on every failure.

    if( count === 1){
      await redis.expire(key, WINDOW_SECONDS);
    }

    // When they hit the limit, extend the lock window.
    if(count >= MAX_ATTEMPTS){
      await redis.expire(key, LOCK_WINDOW_SECONDS);
    }

    return count;


  } catch (error) {
    console.log('Failed to record login attempt: ', err.message);
  }
}

async function clearFailedAttempts(ip){
    const key = `login_attempts:${ip}`;

    try {
      await redis.del(key);
    } catch (error) {
      console.log('Failed to clear failed attempts: ', error.message);
    }
}

module.exports = {
  loginRateLimit,
  recordFailedAttempt,
  clearFailedAttempts,
};