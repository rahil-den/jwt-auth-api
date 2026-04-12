// Auth Middleware
// - Extract JWT from Authorization header (Bearer token)
// - Verify token using jsonwebtoken
// - Check if token is blacklisted in Redis
// - Attach decoded user payload to req.user
// - Call next() or return 401 Unauthorized

const verifyAccessToken = require('../utils/tokens').verifyAccessToken;

function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];

  // Format: "Bearer <token>"
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Authorization header missing or malformed',
    });
  }

  const token = authHeader.split(' ')[1];

  try{
    const decoded = verifyAccessToken(token);
    req.userId = decoded.sub;
    next() // pass control to the next middleware or route handler
  }catch(err){
    if(err.name === 'TokenExpiredError'){
        return res.status(401).json({
            success:false,
            message:"Access token expired",
            code:'TokenExpired' // helps frontend to decide whether to call refresh token endpoint or not
        })
    }
    return res.status(401).json({
        success:false,
        message:'Invalid access token',
        
    });
}
}

module.exports = {authenticate}