// Auth Middleware
// - Extract JWT from Authorization header (Bearer token)
// - Verify token using jsonwebtoken
// - Check if token is blacklisted in Redis
// - Attach decoded user payload to req.user
// - Call next() or return 401 Unauthorized
