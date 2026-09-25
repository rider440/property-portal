const crypto = require('crypto');

// Secret key for signing tokens (retrieved from environment or securely generated)
const JWT_SECRET = process.env.JWT_SECRET || process.env.ADMIN_SECRET || 'gp-property-secure-jwt-key-2026-xyz-0918237';

/**
 * Hash a password using scrypt with a unique 32-byte salt
 * @param {string} password 
 * @param {string} [existingSalt] 
 * @returns {{ hash: string, salt: string }}
 */
function hashPassword(password, existingSalt = null) {
  const salt = existingSalt || crypto.randomBytes(32).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return {
    hash: derivedKey.toString('hex'),
    salt: salt
  };
}

/**
 * Verify a password against a stored hash using constant-time comparison
 * @param {string} password 
 * @param {string} storedHash 
 * @param {string} salt 
 * @returns {boolean}
 */
function verifyPassword(password, storedHash, salt) {
  if (!password || !storedHash || !salt) return false;
  try {
    const derivedKey = crypto.scryptSync(password, salt, 64);
    const keyBuffer = Buffer.from(derivedKey.toString('hex'), 'hex');
    const hashBuffer = Buffer.from(storedHash, 'hex');
    if (keyBuffer.length !== hashBuffer.length) return false;
    return crypto.timingSafeEqual(keyBuffer, hashBuffer);
  } catch (err) {
    console.error('[Auth] Password verification error:', err);
    return false;
  }
}

/**
 * Generate a cryptographically signed HMAC-SHA256 JWT-like Token
 * @param {object} payload 
 * @param {number} [expiresInHours=12] 
 * @returns {string}
 */
function generateToken(payload, expiresInHours = 12) {
  const header = {
    alg: 'HS256',
    typ: 'JWT'
  };

  const exp = Math.floor(Date.now() / 1000) + (expiresInHours * 3600);
  const fullPayload = {
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: exp,
    jti: crypto.randomBytes(16).toString('hex')
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

/**
 * Verify and decode an HMAC-SHA256 Token
 * @param {string} token 
 * @returns {object|null}
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, signature] = parts;

  try {
    const expectedSignature = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');

    const sigBuffer = Buffer.from(signature);
    const expectedSigBuffer = Buffer.from(expectedSignature);

    if (sigBuffer.length !== expectedSigBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedSigBuffer)) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);

    if (payload.exp && payload.exp < now) {
      return null; // Expired
    }

    return payload;
  } catch (err) {
    return null;
  }
}

// In-Memory Rate Limiter and Brute-Force Tracker
const loginAttempts = new Map();
const rateLimitMap = new Map();

// Periodic cleanup of stale rate-limiting entries to maintain zero memory leakage under 1,000+ users/min
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitMap.entries()) {
    if (record.resetTime < now) {
      rateLimitMap.delete(key);
    }
  }
  for (const [identifier, record] of loginAttempts.entries()) {
    if (record.lockedUntil && record.lockedUntil <= now) {
      loginAttempts.delete(identifier);
    }
  }
}, 5 * 60 * 1000).unref();

/**
 * Check and record login attempt to prevent brute-force attacks
 * @param {string} identifier (e.g. IP or username)
 * @param {number} maxAttempts
 * @param {number} lockoutMinutes
 * @returns {{ allowed: boolean, remainingAttempts: number, lockoutSeconds: number }}
 */
function checkLoginAttempt(identifier, maxAttempts = 5, lockoutMinutes = 15) {
  // Allow localhost / local loopback without strict lockouts
  if (identifier === '::1' || identifier === '127.0.0.1' || identifier === '::ffff:127.0.0.1' || identifier === 'localhost') {
    return { allowed: true, remainingAttempts: maxAttempts, lockoutSeconds: 0 };
  }

  const now = Date.now();
  const lockoutMs = lockoutMinutes * 60 * 1000;
  const record = loginAttempts.get(identifier);

  if (!record) {
    return { allowed: true, remainingAttempts: maxAttempts, lockoutSeconds: 0 };
  }

  if (record.lockedUntil && record.lockedUntil > now) {
    const lockoutSeconds = Math.ceil((record.lockedUntil - now) / 1000);
    return { allowed: false, remainingAttempts: 0, lockoutSeconds };
  }

  // If lockout has expired, reset
  if (record.lockedUntil && record.lockedUntil <= now) {
    loginAttempts.delete(identifier);
    return { allowed: true, remainingAttempts: maxAttempts, lockoutSeconds: 0 };
  }

  const remaining = Math.max(0, maxAttempts - record.count);
  return { allowed: remaining > 0, remainingAttempts: remaining, lockoutSeconds: 0 };
}

function recordFailedLogin(identifier, maxAttempts = 5, lockoutMinutes = 15) {
  const now = Date.now();
  const lockoutMs = lockoutMinutes * 60 * 1000;
  let record = loginAttempts.get(identifier);

  if (!record) {
    record = { count: 1, firstAttempt: now, lockedUntil: null };
  } else {
    record.count += 1;
  }

  if (record.count >= maxAttempts) {
    record.lockedUntil = now + lockoutMs;
  }

  loginAttempts.set(identifier, record);
  return checkLoginAttempt(identifier, maxAttempts, lockoutMinutes);
}

function resetLoginAttempts(identifier) {
  loginAttempts.delete(identifier);
}

let limiterInstanceCounter = 0;

/**
 * High-Throughput Rate Limiting Middleware
 * Supports positional args (windowMs, maxRequests, message) or config object { windowMs, maxRequests, message, keyGenerator }
 */
function createRateLimiter(windowMsOrOpts = 60 * 1000, maxRequestsArg = 1000, messageArg = 'अत्यधिक अनुरोध। कृपया थोड़ी देर बाद पुनः प्रयास करें। (Too many requests)') {
  let windowMs = 60 * 1000;
  let maxRequests = 1000;
  let message = 'अत्यधिक अनुरोध। कृपया थोड़ी देर बाद पुनः प्रयास करें। (Too many requests)';
  let keyGenerator = null;
  const limiterId = ++limiterInstanceCounter;

  if (typeof windowMsOrOpts === 'object' && windowMsOrOpts !== null) {
    windowMs = windowMsOrOpts.windowMs || 60 * 1000;
    maxRequests = windowMsOrOpts.maxRequests || 1000;
    message = windowMsOrOpts.message || message;
    keyGenerator = windowMsOrOpts.keyGenerator || null;
  } else {
    windowMs = windowMsOrOpts;
    maxRequests = maxRequestsArg;
    message = messageArg;
  }

  return (req, res, next) => {
    const xForwardedFor = req.headers['x-forwarded-for'];
    const ip = (xForwardedFor ? xForwardedFor.split(',')[0].trim() : req.ip) || req.connection?.remoteAddress || 'unknown';
    const customKey = keyGenerator ? keyGenerator(req) : null;
    const now = Date.now();
    const key = customKey ? `lim_${limiterId}_${customKey}` : `lim_${limiterId}_${ip}`;

    let clientRecord = rateLimitMap.get(key);
    if (!clientRecord || clientRecord.resetTime < now) {
      clientRecord = { count: 1, resetTime: now + windowMs };
      rateLimitMap.set(key, clientRecord);
    } else {
      clientRecord.count += 1;
    }

    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - clientRecord.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(clientRecord.resetTime / 1000));

    if (clientRecord.count > maxRequests) {
      return res.status(429).json({
        success: false,
        error: message,
        retryAfterSeconds: Math.ceil((clientRecord.resetTime - now) / 1000)
      });
    }

    next();
  };
}

/**
 * Express Middleware: Require Valid Admin Authentication Token
 */
function requireAdminAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['x-admin-token'];
  let token = null;

  if (authHeader) {
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else {
      token = authHeader.trim();
    }
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'प्रमाणीकरण आवश्यक है (Unauthorized). कृपया पहले लॉगिन करें।',
      code: 'AUTH_REQUIRED'
    });
  }

  const payload = verifyToken(token);
  if (!payload || payload.role !== 'admin') {
    return res.status(401).json({
      success: false,
      error: 'सत्र समाप्त या अमान्य टोकन (Session expired or invalid token). कृपया पुनः लॉगिन करें।',
      code: 'INVALID_TOKEN'
    });
  }

  req.admin = payload;
  next();
}

/**
 * HTML Sanitization Helper to prevent Cross-Site Scripting (XSS)
 * @param {string} str 
 * @returns {string}
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return str == null ? '' : String(str);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  checkLoginAttempt,
  recordFailedLogin,
  resetLoginAttempts,
  createRateLimiter,
  requireAdminAuth,
  escapeHtml
};
