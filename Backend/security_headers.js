/**
 * OWASP HTTP Security Headers Middleware
 * Implements Defense-in-Depth protections against XSS, Clickjacking, MIME-sniffing, and MITM.
 */
function securityHeaders(req, res, next) {
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent Clickjacking (disallow embedding in iframes from other domains)
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  // Strict Content-Security-Policy (allows self-hosted scripts, styles, images, inline scripts for portal logic)
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self';"
  );

  // Referrer Policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions Policy (Disable dangerous browser APIs)
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');

  // HTTP Strict Transport Security (HSTS) in production
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  // Disable caching for sensitive API routes
  if (req.path.startsWith('/api/admin') || req.path.startsWith('/api/orders')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  next();
}

module.exports = { securityHeaders };
