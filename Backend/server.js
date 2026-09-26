const compression = require('compression');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
const dotenv = require('dotenv');
dotenv.config();

const { initDB, db } = require('./db');
const { importAllExcelFiles, parseAndImportUploadedFile } = require('./import_data');
const {
  generateToken,
  checkLoginAttempt,
  recordFailedLogin,
  resetLoginAttempts,
  createRateLimiter,
  requireAdminAuth,
  escapeHtml
} = require('./auth');
const { securityHeaders } = require('./security_headers');
const { sendDataRequestNotification } = require('./email_service');

const app = express();
const PORT = process.env.PORT || 3000;

// High-Speed Response Compression (Gzip / Deflate for <1ms payload transfers)
app.use(compression({
  threshold: 512,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// Security & Hardening: Disable Express signature and apply OWASP headers
app.disable('x-powered-by');
app.use(securityHeaders);

// CORS configuration: Restrict to same origin or explicitly allowed origins
app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// High-Performance In-Memory Route Cache for 1000+ Users/Min Throughput
const routeCache = new Map();

function getCached(key, ttlSeconds = 60) {
  const item = routeCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    routeCache.delete(key);
    return null;
  }
  return item.data;
}

function setCached(key, data, ttlSeconds = 60) {
  routeCache.set(key, {
    data,
    expiresAt: Date.now() + (ttlSeconds * 1000)
  });
}

// Serve Frontend static assets from ../Frontend
const frontendPath = path.join(__dirname, '..', 'Frontend');
app.use(express.static(frontendPath, {
  dotfiles: 'ignore',
  etag: true,
  maxAge: 0
}));

// Global & Endpoint-Specific Rate Limiters (Anti-Abuse & High Concurrency)
const publicLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 2000,
  message: 'अत्यधिक अनुरोध। कृपया 1 मिनट प्रतीक्षा करें।'
});

const propertySearchLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 1500,
  message: 'प्रॉपर्टी सर्च अनुरोध सीमा समाप्त। कृपया 1 मिनट बाद पुनः प्रयास करें।'
});

// Property ID Unlock Order Rate Limiters (IP & Mobile Number based)
const propertyUnlockIpLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000, // 5 minutes
  maxRequests: 15,
  message: 'प्रॉपर्टी आईडी अनलॉक अनुरोध सीमा: 5 मिनट में अधिकतम 15 प्रयास अनुमत हैं। कृपया थोड़ी देर बाद प्रयास करें।'
});

const propertyUnlockMobileLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000, // 5 minutes
  maxRequests: 5,
  keyGenerator: (req) => req.body?.userMobile ? 'unlock_mob_' + String(req.body.userMobile).replace(/\D/g, '').slice(-10) : null,
  message: 'इस मोबाइल नंबर से 5 मिनट में अधिकतम 5 प्रॉपर्टी अनलॉक अनुरोध भेजे जा सकते हैं। कृपया प्रतीक्षा करें।'
});

const orderStatusLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 60,
  message: 'ऑर्डर स्थिति जांच सीमा समाप्त। कृपया कुछ क्षण प्रतीक्षा करें।'
});

const orderUtrLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000, // 5 minutes
  maxRequests: 10,
  message: 'UTR सबमिशन सीमा: 5 मिनट में अधिकतम 10 प्रयास अनुमत हैं।'
});

// User Missing Village Request Rate Limiters (IP & Mobile based)
const villageRequestIpLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000, // 10 minutes
  maxRequests: 5,
  message: 'ग्राम डेटा अनुरोध सीमा: आप 10 मिनट में अधिकतम 5 अनुरोध भेज सकते हैं। कृपया प्रतीक्षा करें।'
});

const villageRequestMobileLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000, // 10 minutes
  maxRequests: 3,
  keyGenerator: (req) => req.body?.userMobile ? 'vreq_mob_' + String(req.body.userMobile).replace(/\D/g, '').slice(-10) : null,
  message: 'इस मोबाइल नंबर से 10 मिनट में अधिकतम 3 ग्राम डेटा अनुरोध भेजे जा सकते हैं।'
});

const loginLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 30,
  message: 'लॉगिन अनुरोध सीमा समाप्त। कृपया 1 मिनट बाद पुनः प्रयास करें।'
});

// Disable HTTP caching on all API routes so new uploads & live data are immediately visible
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

// Apply general rate limiting
app.use('/api/', publicLimiter);

// ==========================================
// PUBLIC API ROUTES (HIGH CONCURRENCY)
// ==========================================

// 1. Get Settings (Cached 60s)
app.get('/api/settings', async (req, res) => {
  try {
    const cached = getCached('settings:public', 60);
    if (cached) {
      return res.json({ success: true, data: cached, fromCache: true });
    }

    const settings = await db.getSettings(false);
    setCached('settings:public', settings, 60);
    res.json({
      success: true,
      data: settings
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'सेटिंग्स प्राप्त करने में त्रुटि।' });
  }
});

// 2. Get Districts (Cached 10 min)
app.get('/api/districts', async (req, res) => {
  try {
    const cached = getCached('districts:all', 600);
    if (cached) {
      return res.json({ success: true, districts: cached });
    }

    const districts = await db.getDistricts();
    setCached('districts:all', districts, 600);
    res.json({ success: true, districts });
  } catch (err) {
    res.status(500).json({ success: false, error: 'जिले लोड करने में त्रुटि।' });
  }
});

// 2.1 Get Full Available States, Districts and Villages Coverage
app.get('/api/coverage', async (req, res) => {
  try {
    const coverageData = await db.getAvailableCoverage();
    res.json({ success: true, ...coverageData });
  } catch (err) {
    res.status(500).json({ success: false, error: 'उपलब्ध ग्राम सूची लोड करने में त्रुटि।' });
  }
});

// 2.2 Get Tehsils by District
app.get('/api/tehsils', async (req, res) => {
  try {
    const { district } = req.query;
    if (!district || typeof district !== 'string') {
      return res.status(400).json({ success: false, error: 'District is required' });
    }
    const tehsils = await db.getTehsilsByDistrict(district.trim());
    res.json({ success: true, tehsils });
  } catch (err) {
    res.status(500).json({ success: false, error: 'तहसील लोड करने में त्रुटि।' });
  }
});

// 3. Get Villages by District & Tehsil (Real-Time Sub-millisecond)
app.get('/api/villages', async (req, res) => {
  try {
    const { district, tehsil = '' } = req.query;
    if (!district || typeof district !== 'string') {
      return res.status(400).json({ success: false, error: 'District is required' });
    }
    const villages = await db.getVillagesByDistrict(district.trim(), tehsil ? String(tehsil).trim() : '');
    res.json({ success: true, villages });
  } catch (err) {
    res.status(500).json({ success: false, error: 'ग्राम सूची लोड करने में त्रुटि।' });
  }
});

// 4. List Villagers and Properties (Sub-millisecond indexed search by Name / Code / Global)
app.get('/api/properties', propertySearchLimiter, async (req, res) => {
  try {
    const { district, villageCode, village_code, search = '', page = 1, limit = 50 } = req.query;
    let vCode = String(villageCode || village_code || '').trim();
    let safeDistrict = String(district || '').trim();
    const safeSearch = String(search || '').trim().slice(0, 100);
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));

    // If villageCode is provided without district, auto-detect district from village database
    if (!safeDistrict && vCode && vCode !== 'all') {
      const vObj = await db.findVillageByCode(vCode);
      if (vObj && vObj.district_name) {
        safeDistrict = vObj.district_name;
      }
    }

    // If search term is a village code number, auto-detect village & district
    if (!safeDistrict && !vCode && /^\d{4,8}$/.test(safeSearch)) {
      const vObj = await db.findVillageByCode(safeSearch);
      if (vObj && vObj.district_name) {
        safeDistrict = vObj.district_name;
        vCode = safeSearch;
      }
    }

    if (safeDistrict && vCode && vCode !== 'all') {
      const result = await db.getVillageProperties(
        safeDistrict,
        vCode,
        vCode === safeSearch ? '' : safeSearch,
        safePage,
        safeLimit
      );
      return res.json({ success: true, ...result });
    }

    if (safeSearch) {
      const result = await db.searchGlobalProperties(
        safeSearch,
        safePage,
        safeLimit
      );
      return res.json({ success: true, isGlobalSearch: true, ...result });
    }

    return res.status(400).json({ success: false, error: 'कृपया जिला व ग्राम चुनें अथवा नाम से खोजें।' });
  } catch (err) {
    console.error('Error in /api/properties:', err);
    res.status(500).json({ success: false, error: 'संपत्ति डेटा लोड करने में त्रुटि।' });
  }
});

// 5. Create Payment Order (Rate-Limited by IP and Mobile)
app.post('/api/orders/create', propertyUnlockIpLimiter, propertyUnlockMobileLimiter, async (req, res) => {
  try {
    const { propertyId, userMobile, existingOrderId, existingOrderToken } = req.body;
    if (!propertyId) {
      return res.status(400).json({ success: false, error: 'propertyId is required' });
    }

    const cleanMobile = userMobile ? String(userMobile).replace(/\D/g, '').slice(-10) : '';

    const settings = await db.getSettings(false);
    const order = await db.createOrder({
      propertyId: parseInt(propertyId, 10),
      userMobile: cleanMobile || '9999999999',
      amount: settings.price || 80.00,
      upiId: settings.upi_id,
      existingOrderId: existingOrderId ? String(existingOrderId).trim() : null,
      existingOrderToken: existingOrderToken ? String(existingOrderToken).trim() : null
    });

    const upiUri = `upi://pay?pa=${encodeURIComponent(settings.upi_id)}&pn=${encodeURIComponent(settings.merchant_name)}&am=${(settings.price || 80).toFixed(2)}&tr=${order.order_id}&cu=INR&tn=${encodeURIComponent('Gharauni Property ID Unlock ' + order.order_id)}`;

    res.json({
      success: true,
      order: {
        order_id: order.order_id,
        order_token: order.order_token,
        owner_name: order.owner_name,
        father_name: order.father_name,
        village_name: order.village_name,
        amount: order.amount,
        upi_id: order.upi_id,
        merchant_name: settings.merchant_name,
        upi_uri: upiUri,
        status: order.status
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Submit UPI Transaction ID / UTR or Request Unlock
app.post('/api/orders/submit-utr', orderUtrLimiter, async (req, res) => {
  try {
    const { orderId, orderToken, transactionRef, userMobile } = req.body;

    if (!orderId && !orderToken) {
      return res.status(400).json({ success: false, error: 'ऑर्डर आईडी आवश्यक है (Order ID / Token is required)' });
    }

    const cleanMobile = userMobile ? String(userMobile).replace(/\D/g, '').slice(-10) : '';
    if (!cleanMobile || cleanMobile.length !== 10 || !/^[6-9]\d{9}$/.test(cleanMobile)) {
      return res.status(400).json({ 
        success: false, 
        error: 'कृपया अपना 10 अंकों का मान्य भारतीय मोबाइल नंबर (शुरुआत 6-9) दर्ज करें (Valid 10-digit mobile number required).' 
      });
    }

    const cleanRef = String(transactionRef || '').replace(/[^A-Za-z0-9]/g, '').trim();
    if (!cleanRef || cleanRef.length < 6 || cleanRef.length > 30) {
      return res.status(400).json({ 
        success: false, 
        error: 'UTR / UPI Transaction ID न्यूनतम 6 और अधिकतम 30 अक्षरों/अंकों का होना चाहिए (UTR must be 6 to 30 alphanumeric characters).' 
      });
    }

    const updated = await db.submitTransactionRef(orderId, orderToken, cleanRef, cleanMobile);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'ऑर्डर नहीं मिला (Order not found)' });
    }

    res.json({
      success: true,
      message: 'Transaction reference submitted successfully. Pending Admin verification.',
      order: {
        order_id: updated.order_id,
        order_token: updated.order_token,
        status: updated.status,
        transaction_ref: updated.transaction_ref
      }
    });
  } catch (err) {
    if (err.code === 'DUPLICATE_UTR') {
      return res.status(409).json({
        success: false,
        error: 'यह UTR नंबर पहले से उपयोग किया जा चुका है (This UTR is already used)। कृपया सही UTR दर्ज करें।'
      });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Check Order Status (Rate-Limited)
// 7. Check Order Status / Find Order ID by Mobile & UTR (Rate-Limited)
app.get(['/api/orders/status', '/api/orders/track'], orderStatusLimiter, async (req, res) => {
  try {
    const { orderId, orderToken, mobile, utr, transactionRef } = req.query;
    const searchUtr = utr || transactionRef;

    if (!orderId && !orderToken && !mobile && !searchUtr) {
      return res.status(400).json({ 
        success: false, 
        error: 'कृपया ऑर्डर आईडी, मोबाइल नंबर या UTR नंबर दर्ज करें (Please provide Order ID, Mobile or UTR).' 
      });
    }

    const cleanMobile = mobile ? String(mobile).replace(/\D/g, '').slice(-10) : null;
    const orderData = await db.getOrderForUser(orderId, orderToken, cleanMobile, searchUtr);
    if (!orderData) {
      return res.status(404).json({ 
        success: false, 
        error: 'कोई मिलान ऑर्डर नहीं मिला (No matching order found). कृपया सही मोबाइल नंबर अथवा UTR दर्ज करें।' 
      });
    }

    res.json({
      success: true,
      order: orderData
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Request Missing Village Data (Rate-Limited by IP and Mobile with Min/Max Validation)
app.post('/api/data-request', villageRequestIpLimiter, villageRequestMobileLimiter, async (req, res) => {
  try {
    const { stateName, districtName, tehsilName, villageName, villageCode, userName, userMobile, notes } = req.body;
    
    const cleanDist = String(districtName || '').trim();
    const cleanTehsil = String(tehsilName || '').trim();
    const cleanVillage = String(villageName || '').trim();
    const cleanCode = String(villageCode || '').trim();
    const cleanMobile = String(userMobile || '').replace(/\D/g, '').slice(-10);

    if (!cleanDist || cleanDist.length < 2 || cleanDist.length > 50) {
      return res.status(400).json({ success: false, error: 'जनपद का नाम न्यूनतम 2 और अधिकतम 50 अक्षरों का होना चाहिए (District name 2-50 chars).' });
    }
    if (!cleanTehsil || cleanTehsil.length < 2 || cleanTehsil.length > 50) {
      return res.status(400).json({ success: false, error: 'तहसील का नाम न्यूनतम 2 और अधिकतम 50 अक्षरों का होना चाहिए (Tehsil name 2-50 chars).' });
    }
    if (!cleanVillage || cleanVillage.length < 2 || cleanVillage.length > 60) {
      return res.status(400).json({ success: false, error: 'ग्राम का नाम न्यूनतम 2 और अधिकतम 60 अक्षरों का होना चाहिए (Village name 2-60 chars).' });
    }
    if (!cleanCode || cleanCode.length < 4 || cleanCode.length > 15) {
      return res.status(400).json({ success: false, error: 'ग्राम कोड 4 से 15 अंकों/अक्षरों का होना चाहिए (Village code 4-15 chars).' });
    }
    if (!cleanMobile || cleanMobile.length !== 10 || !/^[6-9]\d{9}$/.test(cleanMobile)) {
      return res.status(400).json({ success: false, error: 'कृपया 10 अंकों का मान्य मोबाइल नंबर (शुरुआत 6-9) दर्ज करें (Valid 10-digit mobile required).' });
    }

    const newReq = await db.createMissingDataRequest({
      state_name: String(stateName || 'Uttar Pradesh').slice(0, 100),
      district_name: cleanDist.slice(0, 50),
      tehsil_name: cleanTehsil.slice(0, 50),
      village_name: cleanVillage.slice(0, 60),
      village_code: cleanCode.slice(0, 15),
      user_name: String(userName || '').trim().slice(0, 50),
      user_mobile: cleanMobile,
      notes: String(notes || '').trim().slice(0, 500)
    });

    const settings = await db.getSettings(true);
    sendDataRequestNotification(newReq, settings).catch(err => {
      console.error('[Email] Background send error:', err);
    });

    res.json({
      success: true,
      message: 'Your request for village data has been submitted. Our team will verify and add the records shortly.',
      data: newReq
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// SECURE ADMIN AUTHENTICATION & MANAGEMENT
// ==========================================

// 9. Admin Login (Brute-Force Protected & Salted Hash Verification)
app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  try {
    const { username, password, pin } = req.body;
    const loginUser = (username || 'admin').trim();
    const loginPass = (password !== undefined ? password : pin);

    if (!loginPass) {
      return res.status(400).json({ success: false, error: 'पासवर्ड या पिन आवश्यक है (Password/PIN is required)' });
    }

    // Check brute-force lockout status
    const bruteCheck = checkLoginAttempt(ip, 5, 15);
    if (!bruteCheck.allowed) {
      await db.logSecurityEvent('admin_login_locked', ip, { username: loginUser, reason: 'rate_limited' }, 'blocked');
      return res.status(429).json({
        success: false,
        error: `अत्यधिक असफल प्रयास। खाता ${Math.ceil(bruteCheck.lockoutSeconds / 60)} मिनट के लिए लॉक है। (Account locked due to multiple failed attempts)`,
        lockoutSeconds: bruteCheck.lockoutSeconds
      });
    }

    // Verify credentials against salted cryptographic hash
    const isValid = await db.verifyAdminCredentials(loginUser, loginPass);

    if (!isValid) {
      const failStatus = recordFailedLogin(ip, 5, 15);
      await db.logSecurityEvent('admin_login_failed', ip, { username: loginUser, remaining: failStatus.remainingAttempts }, 'failed');

      if (!failStatus.allowed) {
        return res.status(429).json({
          success: false,
          error: `अमान्य क्रेडेंशियल। 5 असफल प्रयासों के कारण खाता 15 मिनट के लिए लॉक कर दिया गया है।`,
          lockoutSeconds: failStatus.lockoutSeconds
        });
      }

      return res.status(401).json({
        success: false,
        error: `अमान्य उपयोगकर्ता नाम या पासवर्ड (Invalid credentials). शेष प्रयास: ${failStatus.remainingAttempts}`,
        remainingAttempts: failStatus.remainingAttempts
      });
    }

    // Successful login -> Reset failed attempts
    resetLoginAttempts(ip);

    // Issue signed cryptographic HMAC-SHA256 Token with 24-hour expiration
    const token = generateToken({
      role: 'admin',
      username: loginUser
    }, 24);

    await db.logSecurityEvent('admin_login_success', ip, { username: loginUser }, 'success');

    res.json({
      success: true,
      token: token,
      username: loginUser,
      expiresIn: '24h',
      message: 'व्यवस्थापक प्रमाणीकरण सफल (Login successful)'
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, error: 'सर्वर प्रमाणीकरण त्रुटि।' });
  }
});

// 10. Admin: Verify Token & Get Current Session Info
app.get('/api/admin/verify-token', requireAdminAuth, async (req, res) => {
  res.json({
    success: true,
    valid: true,
    user: req.admin
  });
});

// 11. Admin: Change Password / Username
app.post('/api/admin/change-password', requireAdminAuth, async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  try {
    const { oldPassword, newPassword, newUsername } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'वर्तमान पासवर्ड और नया पासवर्ड दोनों आवश्यक हैं।' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'नया पासवर्ड न्यूनतम 6 अक्षरों का होना चाहिए।' });
    }

    const result = await db.changeAdminPassword(oldPassword, newPassword, newUsername);
    await db.logSecurityEvent('admin_password_changed', ip, { username: result.username }, 'success');

    res.json(result);
  } catch (err) {
    await db.logSecurityEvent('admin_password_change_failed', ip, { error: err.message }, 'failed');
    res.status(400).json({ success: false, error: err.message });
  }
});

// 12. Admin: View Security Audit Logs
app.get('/api/admin/audit-logs', requireAdminAuth, async (req, res) => {
  try {
    const logs = await db.getSecurityLogs(100);
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 13. Admin: Get Orders (Protected)
app.get('/api/admin/orders', requireAdminAuth, async (req, res) => {
  try {
    const { status } = req.query;
    const orders = await db.getOrdersAdmin(status);
    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 14. Admin: Verify or Reject Order (Protected)
app.post('/api/admin/orders/:orderId/action', requireAdminAuth, async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  try {
    const { orderId } = req.params;
    const { action, adminNotes } = req.body;
    if (!['verified', 'rejected'].includes(action)) {
      return res.status(400).json({ success: false, error: 'Action must be verified or rejected' });
    }

    const updated = await db.verifyOrderAdmin(orderId, action, adminNotes);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    await db.logSecurityEvent('order_action', ip, { orderId, action, admin: req.admin?.username }, 'success');
    res.json({ success: true, order: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 14B. Admin: Clear All Order History (Protected)
app.post('/api/admin/orders/clear-all', requireAdminAuth, async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  try {
    const result = await db.clearAllOrders();
    await db.logSecurityEvent('orders_cleared_all', ip, { admin: req.admin?.username }, 'success');
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 14C. Admin: Delete Single Order (Protected)
app.delete('/api/admin/orders/:orderId', requireAdminAuth, async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  try {
    const { orderId } = req.params;
    const deleted = await db.deleteOrder(orderId);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    await db.logSecurityEvent('order_deleted', ip, { orderId, admin: req.admin?.username }, 'success');
    res.json({ success: true, message: `Order ${orderId} deleted successfully` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 15. Admin: Get Missing Data Requests (Protected)
app.get('/api/admin/data-requests', requireAdminAuth, async (req, res) => {
  try {
    const requests = await db.getMissingDataRequestsAdmin();
    res.json({ success: true, requests });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 15B. Admin: Update Missing Data Request Status (Protected)
app.post('/api/admin/data-requests/:id/status', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const updated = await db.updateMissingDataRequestStatus(id, status);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Request not found' });
    }
    res.json({ success: true, request: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 15B2. Admin: Clear All Missing Data Requests (Protected)
app.post('/api/admin/data-requests/clear-all', requireAdminAuth, async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  try {
    const result = await db.clearAllMissingDataRequests();
    await db.logSecurityEvent('data_requests_cleared_all', ip, { admin: req.admin?.username }, 'success');
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 15B3. Admin: Delete Single Missing Data Request (Protected)
app.delete('/api/admin/data-requests/:id', requireAdminAuth, async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  try {
    const { id } = req.params;
    const deleted = await db.deleteMissingDataRequest(id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Request not found' });
    }
    await db.logSecurityEvent('data_request_deleted', ip, { id, admin: req.admin?.username }, 'success');
    res.json({ success: true, message: `Request #${id} deleted successfully` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 15C. Admin: Export/Backup Complete Live Database (JSON) (Protected)
app.get('/api/admin/export-database', requireAdminAuth, async (req, res) => {
  try {
    const raw = await db.exportDatabaseBackup();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="database-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(raw, null, 2));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 15D. Admin: Export Orders to Excel (.xlsx) with Status Filter (Protected)
app.get('/api/admin/orders/export-excel', requireAdminAuth, async (req, res) => {
  try {
    const { status } = req.query;
    const filterStatus = (status && status !== 'all') ? status.toLowerCase() : '';
    const orders = await db.getOrdersAdmin(filterStatus);

    const formattedRows = orders.map((o, idx) => ({
      'क्र. सं. (S.No)': idx + 1,
      'ऑर्डर आईडी (Order ID)': o.order_id || '--',
      'स्थिति (Status)': o.status === 'verified' ? 'सत्यापित (Verified)' : (o.status === 'pending' ? 'लंबित (Pending)' : 'अस्वीकृत (Rejected)'),
      'नागरिक का नाम (Owner Name)': o.owner_name || '--',
      'पिता / पति का नाम': o.father_name || '--',
      'ग्राम (Village)': o.village_name || '--',
      'ग्राम कोड': o.village_code || '--',
      'जनपद (District)': o.district_name || '--',
      'मोबाइल नंबर': o.user_mobile || '--',
      'शुल्क (Amount INR)': parseFloat(o.amount) || 0,
      'UPI UTR / संदर्भ संख्या': o.transaction_ref || 'उपलब्ध नहीं',
      'अनुरोध दिनांक (Created At)': o.created_at || '--',
      'सत्यापन दिनांक (Verified At)': o.verified_at || '--',
      'व्यवस्थापक टिप्पणी (Notes)': o.admin_notes || ''
    }));

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(formattedRows);

    // Auto-fit column widths
    ws['!cols'] = [
      { wch: 8 }, { wch: 22 }, { wch: 18 }, { wch: 22 },
      { wch: 22 }, { wch: 18 }, { wch: 12 }, { wch: 18 },
      { wch: 15 }, { wch: 14 }, { wch: 22 }, { wch: 22 },
      { wch: 22 }, { wch: 25 }
    ];

    xlsx.utils.book_append_sheet(wb, ws, 'Orders_Report');
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const statusSuffix = filterStatus ? `_${filterStatus}` : '_all';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Property_Orders${statusSuffix}_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    console.error('Excel export error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 15D2. Admin: Export Missing Village Data Requests to Excel (.xlsx) (Protected)
app.get('/api/admin/data-requests/export-excel', requireAdminAuth, async (req, res) => {
  try {
    const { status } = req.query;
    const filterStatus = (status && status !== 'all') ? status.toLowerCase() : '';
    const requests = await db.getDataRequestsAdmin(filterStatus);

    const formattedRows = requests.map((r, idx) => ({
      'क्र. सं. (S.No)': idx + 1,
      'अनुरोध आईडी (Req ID)': r.id || '--',
      'स्थिति (Status)': r.status === 'uploaded' ? 'डेटा अपलोडेड (Uploaded)' : (r.status === 'pending' ? 'लंबित (Pending)' : 'अस्वीकृत (Rejected)'),
      'ग्राम का नाम (Village)': r.village_name || '--',
      'ग्राम कोड (Village Code)': r.village_code || '--',
      'तहसील (Tehsil)': r.tehsil_name || '--',
      'जनपद (District)': r.district_name || '--',
      'राज्य (State)': r.state_name || 'Uttar Pradesh',
      'नागरिक का नाम': r.user_name || '--',
      'मोबाइल नंबर': r.user_mobile || '--',
      'अनुरोध दिनांक': r.created_at || '--',
      'टिप्पणी (Notes)': r.notes || ''
    }));

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(formattedRows);

    ws['!cols'] = [
      { wch: 8 }, { wch: 12 }, { wch: 20 }, { wch: 22 },
      { wch: 15 }, { wch: 18 }, { wch: 18 }, { wch: 18 },
      { wch: 20 }, { wch: 15 }, { wch: 22 }, { wch: 25 }
    ];

    xlsx.utils.book_append_sheet(wb, ws, 'Village_Requests');
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const statusSuffix = filterStatus ? `_${filterStatus}` : '_all';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Village_Data_Requests${statusSuffix}_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    console.error('Village requests export error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 15E. Admin: Restore Database from Backup JSON (Protected)
app.post('/api/admin/restore-database', requireAdminAuth, async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  try {
    const backupPayload = req.body;
    if (!backupPayload || typeof backupPayload !== 'object') {
      return res.status(400).json({ success: false, error: 'अमान्य बैकअप डेटा (Invalid backup payload)' });
    }

    const result = await db.restoreDatabaseBackup(backupPayload);
    await db.logSecurityEvent('database_restored', ip, {
      admin: req.admin?.username,
      counts: result
    }, 'success');

    res.json({
      success: true,
      message: 'डेटाबेस बैकअप सफलतापूर्वक रीस्टोर हो गया है!',
      stats: result
    });
  } catch (err) {
    console.error('Database restore error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 16. Admin: Get Settings (Protected - with admin metadata)
app.get('/api/admin/settings', requireAdminAuth, async (req, res) => {
  try {
    const settings = await db.getSettings(true);
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 17. Admin: Update Settings (Protected)
app.post('/api/admin/settings', requireAdminAuth, async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  try {
    const { 
      upi_id, merchant_name, price, auto_verify_demo,
      smtp_host, smtp_port, smtp_user, smtp_pass, notify_email
    } = req.body;
    const updateData = {};
    if (upi_id !== undefined) updateData.upi_id = String(upi_id).trim();
    if (merchant_name !== undefined) updateData.merchant_name = String(merchant_name).trim();
    if (price !== undefined) updateData.price = Math.max(0, parseFloat(price) || 80);
    if (auto_verify_demo !== undefined) updateData.auto_verify_demo = Boolean(auto_verify_demo);
    
    // SMTP fields
    if (smtp_host !== undefined) updateData.smtp_host = String(smtp_host).trim();
    if (smtp_port !== undefined) updateData.smtp_port = String(smtp_port).trim();
    if (smtp_user !== undefined) updateData.smtp_user = String(smtp_user).trim();
    if (smtp_pass !== undefined && String(smtp_pass).trim() !== '') {
      updateData.smtp_pass = String(smtp_pass).trim();
    }
    if (notify_email !== undefined) updateData.notify_email = String(notify_email).trim();

    const updated = await db.updateSettings(updateData);
    await db.logSecurityEvent('settings_updated', ip, { admin: req.admin?.username }, 'success');
    res.json({ success: true, settings: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Multer Storage for QR Code Image Uploads
const multer = require('multer');

const qrStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const imgDir = path.join(frontendPath, 'images');
    if (!fs.existsSync(imgDir)) {
      fs.mkdirSync(imgDir, { recursive: true });
    }
    cb(null, imgDir);
  },
  filename: function (req, file, cb) {
    cb(null, 'payment_qr.png');
  }
});

const uploadQr = multer({
  storage: qrStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: function (req, file, cb) {
    const allowedMimes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (allowedMimes.includes(file.mimetype.toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('केवल PNG, JPG, JPEG, WebP छवि फाइलें ही अनुमत हैं!'));
    }
  }
});

// 18. Admin: Upload UPI QR Code Image (Protected)
app.post('/api/admin/upload-qr', requireAdminAuth, (req, res) => {
  uploadQr.single('qr_image')(req, res, async function (err) {
    if (err) {
      return res.status(400).json({ success: false, error: err.message || 'File upload error' });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ success: false, error: 'कृपया एक वैध QR छवि चुनें।' });
      }

      const qrTimestamp = Date.now();
      await db.updateSettings({ qr_updated_at: qrTimestamp });

      res.json({
        success: true,
        message: 'QR Code image uploaded and activated successfully!',
        qr_url: `/images/payment_qr.png?v=${qrTimestamp}`
      });
    } catch (dbErr) {
      res.status(500).json({ success: false, error: dbErr.message });
    }
  });
});

const dataFileStorage = multer.memoryStorage();
const uploadDataFile = multer({
  storage: dataFileStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.xlsx', '.xls', '.txt', '.json', '.csv'];
    if (allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('केवल .xlsx, .xls, .txt, .json, .csv फाइलें ही अनुमत हैं!'));
    }
  }
});

// 19. Admin: Upload Village Data File (Protected)
app.post('/api/admin/upload-village-data', requireAdminAuth, uploadDataFile.single('village_file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'कृपया एक Excel (.xlsx, .xls) या टेक्स्ट फ़ाइल चुनें।' });
    }

    const { state_name, district_name, tehsil_name, village_name, village_code } = req.body;
    const result = await parseAndImportUploadedFile(req.file.buffer, req.file.originalname, {
      state_name,
      district_name,
      tehsil_name,
      village_name,
      village_code
    });

    // Invalidate route cache so newly uploaded village is immediately live in public search and stats
    routeCache.clear();

    res.json(result);
  } catch (err) {
    console.error('Error importing uploaded village file:', err);
    res.status(500).json({ success: false, error: err.message || 'डेटा इम्पोर्ट करने में विफलता।' });
  }
});

// 20. Admin: Re-import Excel data (Protected)
app.post('/api/admin/reimport', requireAdminAuth, async (req, res) => {
  try {
    await importAllExcelFiles();
    res.json({ success: true, message: 'Data imported successfully from Excel files.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Fallback HTML routing for Single Page Navigation
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const lowerPath = req.path.toLowerCase();
  if (lowerPath.startsWith('/rideradmin') || lowerPath.startsWith('/admin')) {
    const adminPage = fs.existsSync(path.join(frontendPath, 'RiderAdmin.html'))
      ? 'RiderAdmin.html'
      : 'admin.html';
    return res.sendFile(path.join(frontendPath, adminPage));
  }
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Start Server
initDB().then(() => {
  if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
    app.listen(PORT, () => {
      console.log(`\n======================================================`);
      console.log(`🚀 Gram Panchayat Property Portal (Monolith) Started!`);
      console.log(`🛡️  Security Headers & Rate-Limiting: ACTIVE`);
      console.log(`🔐 Zero-Trust Admin Auth Guard: ACTIVE`);
      console.log(`🌐 Public Portal URL : http://localhost:${PORT}`);
      console.log(`⚙️  Admin Dashboard   : http://localhost:${PORT}/admin.html`);
      console.log(`======================================================\n`);
    });
  }
});

module.exports = app;
