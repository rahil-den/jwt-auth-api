
const bcrypt = require('bcrypt');
const pool = require('../config/db');
const redis = require('../config/redis');
const {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  hashToken,
} = require('../utils/tokens');
const {
  recordFailedAttempt,
  clearFailedAttempts,
} = require('../middleware/rateLimit');

const BCRYPT_ROUNDS = 12;
// WHY 12 rounds? Each round doubles the time.
// 10 rounds ≈ 65ms, 12 rounds ≈ 250ms, 14 rounds ≈ 1s.
// 12 is the industry sweet spot — slow enough to deter brute force,
// fast enough for real users.

// ─────────────────────────────────────────────
// POST /api/auth/register
// ─────────────────────────────────────────────

async function register(req, res) {
  const { email, password } = req.body;

  // Basic validation — in production you'd use Zod or Joi here
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }

  if (typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'Invalid email format' });
  }

  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
  }

  try {
    // WHY: We check for duplicate email BEFORE hashing.
    // bcrypt takes ~250ms — checking first avoids wasting that time
    // on a request that will fail anyway.
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      // WHY: Return 409 Conflict, not 400.
      // 409 semantically means "this resource already exists".
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }

    // Hash the password — bcrypt auto-generates a salt and embeds it in the hash
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at',
      [email.toLowerCase(), passwordHash]
    );

    const user = result.rows[0];

    return res.status(201).json({
      success: true,
      message: 'User registered successfully',
      user: { id: user.id, email: user.email, createdAt: user.created_at },
    });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ─────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────

async function login(req,res){
    const { email, password} = req.body;
    const ip = req.ip || req.connection.remoteAddress;

    if(!email || !password){
        return res.status(400).json({success: false, message: 'Email and password are required'})
    }

   try {
    const result = await pool.query(
        'SELECT id, email, password_hash FROM users WHERE email = $1',
        [email.toLowerCase()]
    );

    const user = result.rows[0];

    // WHY: We ALWAYS run bcrypt.compare, even if the user doesn't exist.
    // If we return early on "user not found", an attacker can time the response
    // to enumerate which emails exist. Constant-time comparison defeats this.

    const dummyHash = '$ab$12$$2b$12$invalidhashfortimingattackprevention00000000';
    const isValid = user ?
    await bcrypt.compare(password, user.password_hash)
    : await bcrypt.compare(password, dummyHash);

    if(!user || !isValid){
     if (user !== undefined || isValid === false) {
        await recordFailedAttempt(ip);
      }    
      // WHY: Return the same error message whether email or password is wrong.
      // Different messages ("user not found" vs "wrong password") help attackers
      // enumerate valid emails.
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    
    }

    await clearFailedAttempts(ip);

    const accessToken = generateAccessToken(user.id);
    const refreshToken = generateRefreshToken(user.id);

    // Store HASHED refresh token in Redis with TTL
    // Key pattern: rt:<userId> — one active session per user
    // WHY: Storing per userId (not per device) means a new login invalidates
    // all previous sessions. For multi-device support you'd use rt:<userId>:<deviceId>


    const tokenHash = hashToken(refreshToken);

    await redis.setex(
        `rt:${user.id}`,
        parseInt(process.env.REFRESH_TOKEN_EXPIRY_SECONDS, 10),
        tokenHash
    );

    return res.status(200).json({
        success:true,
        accessToken,
        refreshToken,
        user: {id:user.id, email:user.email},
    });

   } catch (error) {
    console.log('Login error: ',err);
    return res.status(500).json({success:false, message:'Internal server error'});
   }
}

// ─────────────────────────────────────────────
// POST /api/auth/refresh
// ─────────────────────────────────────────────

async function refresh(req, res){
    const { refreshToken  } = req.body;

    if(!refreshToken ){
        return res.status(400).json({success:false, message:'Refresh token is required'});
    }
    //  Step 1. lets decoded and check / Verify JWT signature and expiry

    try {
        let decoded;

        try{
            decoded = verifyRefreshToken(refreshToken);
        }catch(err){
        return res.status(401).json({success:false, message:'Invalid or expired refresh token'});
        }

        const userId = decoded.sub; // sub = subject (user id)
        const redisKey = `rt:${userId}`;

        // Step 2: dekho stored hash redis me.
        const storedHash = await redis.get(redisKey);

        if(!storedHash){
            // WHY: This happens when:
      // 1. The user logged out (we deleted it)
      // 2. The token expired in Redis
      // 3. An attacker is replaying a token from a previous session
      return res.status(401).json({ success: false, message: 'Refresh token not found — please login again' });
    }
     // Step 3: Compare karo token hash to stored hash
    const incomingHash = hashToken(refreshToken);

    if(incomingHash !== storedHash){
        // REUSE DETECTION: The token signature is valid (passed Step 1)
      // but the hash doesn't match what's in Redis.
      // This means someone already rotated this token.
      // SECURITY RESPONSE: Invalidate ALL sessions for this user.
      // WHY: A valid JWT with a mismatched Redis hash means either:
      // a) An attacker stole the old token before rotation, OR
      // b) The legitimate user's token was intercepted.
      // The only safe response is to force a full re-login.
      await redis.del(redisKey); 
        console.warn(`🚨 Refresh token reuse detected for user ${userId}`);
      return res.status(401).json({
        success: false,
        message: 'Refresh token reuse detected — all sessions invalidated',
        code: 'TOKEN_REUSE',
      });
    }
    // Step 4: Rotate - generate new tokens, overwrite Redis
     const newAccessToken = generateAccessToken(userId);
    const newRefreshToken = generateRefreshToken(userId);
    const newHash = hashToken(newRefreshToken);

    await redis.setex(
        redisKey,
        parseInt(process.env.REFRESH_TOKEN_EXPIRY_SECONDS,  10),
        newHash // Overwrite old hash with new one
    );

    return res.status(200).json({
        success:true,
        accessToken:newAccessToken,
        refreshToken:newRefreshToken
    });
    } catch (error) {
        console.error('Referesh error: ',error);
        return res.status(500).json({ success:false, message:'Internal server error'});

        
    }
}

// ─────────────────────────────────────────────
// POST /api/auth/logout
// ─────────────────────────────────────────────
async function logout(req, res) {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ success: false, message: 'Refresh token required' });
  }

  try {
    // Verify the token so we know WHICH user to log out
    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch {
      // WHY: Even if the token is expired/invalid, return 200.
      // The client wants to log out — if the token is already invalid,
      // the session is already effectively dead. Don't punish the client.
      return res.status(200).json({ success: true, message: 'Logged out' });
    }

    await redis.del(`rt:${decoded.sub}`);

    return res.status(200).json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    console.error('Logout error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}





// ─────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────
async function me(req, res) {
  // req.userId is set by the authenticate middleware
  try {
    const result = await pool.query(
      'SELECT id, email, created_at FROM users WHERE id = $1',
      [req.userId]
    );

    if (!result.rows.length) {
      // Edge case: user was deleted from DB but their token is still valid
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = result.rows[0];
    return res.status(200).json({
      success: true,
      user: { id: user.id, email: user.email, createdAt: user.created_at },
    });
  } catch (err) {
    console.error('Me error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}


module.exports = { register, login, refresh, logout, me };