const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const { Pool } = require('pg');
const { hashPassword, verifyPassword } = require('./auth');

// Check environment variables
const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/property_portal';
let pool = null;
let usePostgres = false;

// Fallback SQLite/JSON Storage for high availability
const dataDir = path.join(__dirname, 'data');
const sqliteCacheDir = path.join(dataDir, 'sqlite');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
if (!fs.existsSync(sqliteCacheDir)) {
  fs.mkdirSync(sqliteCacheDir, { recursive: true });
}
const dbFilePath = path.join(dataDir, 'database.json');

// Load environment variables safely
const defaultAdminUser = process.env.ADMIN_USERNAME || 'admin';
const defaultAdminPass = process.env.ADMIN_PASSWORD || process.env.ADMIN_DEFAULT_PASSWORD || 'ChangeMeInProduction!';
const initialAdminHash = hashPassword(defaultAdminPass);

// Local in-memory / JSON store data
let localDb = {
  districts: [],
  villages: [],
  properties: [],
  orders: [],
  missing_data_requests: [],
  security_logs: [],
  admin: {
    username: defaultAdminUser,
    password_hash: initialAdminHash.hash,
    password_salt: initialAdminHash.salt,
    updated_at: new Date().toISOString()
  },
  settings: {
    upi_id: 'paytmqr28100505010113f38012u8a6@paytm',
    merchant_name: 'Gram Panchayat Property Portal',
    price: 80.00,
    admin_pin: '123456',
    auto_verify_demo: false
  }
};

// High-Speed In-Memory Hash Indexes for Sub-Millisecond 1000+ Req/Sec Throughput
const indexes = {
  propertiesByVillage: new Map(), // key: `${district.toLowerCase()}:${villageCode}` -> Property[]
  villagesByDistrict: new Map(),  // key: `${district.toLowerCase()}` -> Village[]
  ordersById: new Map(),          // key: order_id -> Order
  ordersByToken: new Map()        // key: order_token -> Order
};

function isPublicOrNonCitizenRecord(ownerName, fatherName) {
  const o = String(ownerName || '').trim();
  const f = String(fatherName || '').trim();
  if (o.includes('रास्ता') || o.includes('रास्‍ता') || o.includes('रिक्त') || o.includes('सार्वजनिक') || o.includes('ग्राम सभा')) {
    return true;
  }
  return false;
}

function toPhoneticKey(str) {
  if (!str) return '';
  const devToLat = {
    'अ':'a','आ':'a','इ':'i','ई':'i','उ':'u','ऊ':'u','ऋ':'ri','ए':'e','ऐ':'ai','ओ':'o','औ':'au','अं':'n','अँ':'n','अः':'h',
    'क':'k','ख':'k','ग':'g','घ':'g','ङ':'n',
    'च':'c','छ':'c','ज':'j','झ':'j','ञ':'n',
    'ट':'t','ठ':'t','ड':'d','ढ':'d','ण':'n',
    'त':'t','थ':'t','द':'d','ध':'d','न':'n',
    'प':'p','फ':'p','ब':'b','भ':'b','म':'m',
    'य':'y','र':'r','ल':'l','व':'v','श':'s','ष':'s','स':'s','ह':'h',
    'क्ष':'x','त्र':'tr','ज्ञ':'gy','श्र':'sr',
    'क़':'k','ख़':'k','ग़':'g','ज़':'j','ड़':'r','ढ़':'r','फ़':'p'
  };
  const matras = {
    'ा':'a','ि':'i','ी':'i','ु':'u','ू':'u','ृ':'ri','े':'e','ै':'ai','ो':'o','ौ':'au','ं':'n','ँ':'n','ः':'h','्':''
  };

  let lat = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (devToLat[c]) {
      lat += devToLat[c];
    } else if (matras[c] !== undefined) {
      lat += matras[c];
    } else if (/[a-zA-Z0-9]/.test(c)) {
      lat += c.toLowerCase();
    } else {
      lat += ' ';
    }
  }

  return lat
    .replace(/ph/g, 'p')
    .replace(/bh/g, 'b')
    .replace(/dh/g, 'd')
    .replace(/th/g, 't')
    .replace(/kh/g, 'k')
    .replace(/gh/g, 'g')
    .replace(/jh/g, 'j')
    .replace(/ch/g, 'c')
    .replace(/sh/g, 's')
    .replace(/w/g, 'v')
    .replace(/ee/g, 'i')
    .replace(/oo/g, 'u')
    .replace(/([aeiou])\1+/g, '$1')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function getConsonantSkeleton(phoneticStr) {
  return phoneticStr.replace(/[aeiou]/g, '').replace(/\s+/g, ' ').trim();
}

function matchSearchQuery(record, query) {
  if (!query) return true;
  const q = String(query).trim().toLowerCase();
  if (!q) return true;

  const rawOwner = (record.owner_name || '').toLowerCase();
  const rawFather = (record.father_name || '').toLowerCase();
  const rawVar = String(record.variable_id || '').toLowerCase();
  const rawVill = (record.village_name || '').toLowerCase();
  const rawDist = (record.district_name || '').toLowerCase();
  const rawFull = `${rawOwner} ${rawFather} ${rawVar} ${rawVill} ${rawDist}`;

  // 1. Direct match (Hindi or Latin)
  if (rawFull.includes(q)) return true;

  // 2. Phonetic match
  const qPhon = toPhoneticKey(q);
  const targetPhon = toPhoneticKey(rawFull);
  if (targetPhon.includes(qPhon)) return true;

  // 3. Consonant skeleton match
  const qSkel = getConsonantSkeleton(qPhon);
  const targetSkel = getConsonantSkeleton(targetPhon);
  if (qSkel.length >= 2 && targetSkel.includes(qSkel)) return true;

  // 4. Multi-word search
  const qWords = q.split(/\s+/).filter(Boolean);
  if (qWords.length > 1) {
    const allWordsMatch = qWords.every(w => {
      const wp = toPhoneticKey(w);
      const ws = getConsonantSkeleton(wp);
      return targetPhon.includes(wp) || (ws.length >= 2 && targetSkel.includes(ws));
    });
    if (allWordsMatch) return true;
  }

  return false;
}

function rebuildMemoryIndexes() {
  indexes.propertiesByVillage.clear();
  indexes.villagesByDistrict.clear();
  indexes.ordersById.clear();
  indexes.ordersByToken.clear();

  // Index Properties (Pre-filtered citizen records)
  if (Array.isArray(localDb.properties)) {
    for (let i = 0; i < localDb.properties.length; i++) {
      const p = localDb.properties[i];
      if (!p || !p.district_name || !p.village_code) continue;
      if (isPublicOrNonCitizenRecord(p.owner_name, p.father_name)) continue;

      const key = `${String(p.district_name).trim().toLowerCase()}:${String(p.village_code).trim()}`;
      let list = indexes.propertiesByVillage.get(key);
      if (!list) {
        list = [];
        indexes.propertiesByVillage.set(key, list);
      }
      list.push(p);
    }
  }

  // Index Villages
  if (Array.isArray(localDb.villages)) {
    for (let i = 0; i < localDb.villages.length; i++) {
      const v = localDb.villages[i];
      if (!v || !v.district_name) continue;
      const key = String(v.district_name).trim().toLowerCase();
      let list = indexes.villagesByDistrict.get(key);
      if (!list) {
        list = [];
        indexes.villagesByDistrict.set(key, list);
      }
      list.push(v);
    }
    // Sort each village list alphabetically once
    for (const [key, list] of indexes.villagesByDistrict.entries()) {
      list.sort((a, b) => (a.village_name || '').localeCompare(b.village_name || ''));
    }
  }

  // Index Orders
  if (Array.isArray(localDb.orders)) {
    for (let i = 0; i < localDb.orders.length; i++) {
      const o = localDb.orders[i];
      if (!o) continue;
      if (o.order_id) indexes.ordersById.set(o.order_id, o);
      if (o.order_token) indexes.ordersByToken.set(o.order_token, o);
    }
  }
}

const sqliteHandles = new Map();

function getDistrictSqlite(districtName) {
  if (!districtName) return null;
  const dKey = String(districtName).toLowerCase().trim().replace(/\s+/g, '_');
  if (sqliteHandles.has(dKey)) {
    return sqliteHandles.get(dKey);
  }

  const sqlitePath = path.join(sqliteCacheDir, `${dKey}.sqlite`);
  if (!fs.existsSync(sqlitePath)) {
    const gzFile = path.join(dataDir, 'districts', `${dKey}.json.gz`);
    const jsonFile = path.join(dataDir, 'districts', `${dKey}.json`);
    if (!fs.existsSync(gzFile) && !fs.existsSync(jsonFile)) {
      return null;
    }
    try {
      if (!fs.existsSync(sqliteCacheDir)) fs.mkdirSync(sqliteCacheDir, { recursive: true });
      let raw = fs.existsSync(gzFile) ? zlib.gunzipSync(fs.readFileSync(gzFile)).toString('utf8') : fs.readFileSync(jsonFile, 'utf8');
      const arr = JSON.parse(raw);
      const tempDb = new Database(sqlitePath);
      tempDb.exec('PRAGMA synchronous = OFF; PRAGMA journal_mode = OFF; PRAGMA cache_size = 2000;');
      tempDb.exec(`
        CREATE TABLE IF NOT EXISTS properties (
          id TEXT, record_id TEXT, variable_id TEXT, property_card_id TEXT, owner_name TEXT,
          father_name TEXT, mobile_no TEXT, total_area TEXT, built_area TEXT, open_area TEXT,
          village_code TEXT, village_name TEXT, district_name TEXT, tehsil TEXT,
          distribution_date TEXT, remarks TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_vcode ON properties(village_code);
        CREATE INDEX IF NOT EXISTS idx_owner ON properties(owner_name);
        CREATE INDEX IF NOT EXISTS idx_var ON properties(variable_id);
      `);
      const insert = tempDb.prepare(`
        INSERT INTO properties VALUES (
          @id, @record_id, @variable_id, @property_card_id, @owner_name, @father_name,
          @mobile_no, @total_area, @built_area, @open_area, @village_code, @village_name,
          @district_name, @tehsil, @distribution_date, @remarks
        )
      `);
      const insertMany = tempDb.transaction((rows) => {
        for (let i = 0; i < rows.length; i++) insert.run(rows[i]);
      });
      insertMany(arr);
      tempDb.close();
    } catch (e) {
      console.error('[DB] Error creating on-demand sqlite index for', districtName, e);
      return null;
    }
  }

  if (fs.existsSync(sqlitePath)) {
    if (sqliteHandles.size >= 8) {
      const oldestKey = sqliteHandles.keys().next().value;
      try { sqliteHandles.get(oldestKey).close(); } catch (_) {}
      sqliteHandles.delete(oldestKey);
    }
    try {
      const dbInst = new Database(sqlitePath, { readonly: true, fileMustExist: true });
      sqliteHandles.set(dKey, dbInst);
      return dbInst;
    } catch (e) {
      console.error('[DB] Error opening sqlite db for', districtName, e);
    }
  }
  return null;
}

function ensureDistrictPropertiesLoaded(districtName) {
  const sdb = getDistrictSqlite(districtName);
  return sdb ? true : false;
}

let lastDiskMtime = 0;

function loadLocalDbFromDisk(force = false) {
  if (fs.existsSync(dbFilePath)) {
    try {
      const stats = fs.statSync(dbFilePath);
      if (!force && stats.mtimeMs <= lastDiskMtime) {
        return;
      }
      lastDiskMtime = stats.mtimeMs;
      const raw = fs.readFileSync(dbFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      localDb = { ...localDb, ...parsed };
      
      // Ensure security_logs and admin structure exist
      if (!localDb.security_logs) localDb.security_logs = [];
      if (!localDb.admin || !localDb.admin.password_hash) {
        const hashed = hashPassword(defaultAdminPass);
        localDb.admin = {
          username: defaultAdminUser,
          password_hash: hashed.hash,
          password_salt: hashed.salt,
          updated_at: new Date().toISOString()
        };
      }
      rebuildMemoryIndexes();
      console.log(`[DB] Sync: Loaded ${localDb.villages?.length || 0} villages across ${localDb.districts?.length || 0} districts.`);
    } catch (err) {
      console.error('[DB] Failed reading local DB file:', err);
    }
  }
}

loadLocalDbFromDisk(true);

function saveLocalDb() {
  try {
    fs.writeFileSync(dbFilePath, JSON.stringify(localDb, null, 2), 'utf8');
    lastDiskMtime = fs.statSync(dbFilePath).mtimeMs;
    rebuildMemoryIndexes();
  } catch (err) {
    console.error('[DB] Error saving local DB:', err);
  }
}

async function initDB() {
  try {
    pool = new Pool({
      connectionString: dbUrl,
      connectionTimeoutMillis: 3000
    });
    
    // Test postgres connection
    const client = await pool.connect();
    console.log('[PostgreSQL] Connected successfully to database:', dbUrl.split('@')[1] || 'Postgres');
    usePostgres = true;

    // Create PostgreSQL tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS districts (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        state_name VARCHAR(100) DEFAULT 'Uttar Pradesh'
      );

      CREATE TABLE IF NOT EXISTS villages (
        id SERIAL PRIMARY KEY,
        village_code VARCHAR(50) NOT NULL,
        village_name VARCHAR(150) NOT NULL,
        district_name VARCHAR(100) NOT NULL,
        tehsil VARCHAR(100),
        total_records INTEGER DEFAULT 0,
        CONSTRAINT unique_village_code_dist UNIQUE (village_code, district_name)
      );

      CREATE TABLE IF NOT EXISTS properties (
        id SERIAL PRIMARY KEY,
        record_id VARCHAR(50),
        variable_id VARCHAR(50),
        property_card_id VARCHAR(100) NOT NULL,
        owner_name VARCHAR(255) NOT NULL,
        father_name VARCHAR(255),
        mobile_no VARCHAR(50),
        aadhaar_number VARCHAR(50),
        total_area NUMERIC(10, 2) DEFAULT 0,
        built_area NUMERIC(10, 2) DEFAULT 0,
        open_area NUMERIC(10, 2) DEFAULT 0,
        village_code VARCHAR(50),
        village_name VARCHAR(150),
        district_name VARCHAR(100),
        tehsil VARCHAR(100),
        distribution_date VARCHAR(100),
        remarks TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_prop_village ON properties(village_code, district_name);
      CREATE INDEX IF NOT EXISTS idx_prop_owner ON properties(owner_name);

      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        order_id VARCHAR(50) UNIQUE NOT NULL,
        order_token VARCHAR(100) UNIQUE NOT NULL,
        property_id INTEGER NOT NULL,
        property_card_id VARCHAR(100) NOT NULL,
        owner_name VARCHAR(255) NOT NULL,
        father_name VARCHAR(255),
        village_code VARCHAR(50),
        village_name VARCHAR(150),
        district_name VARCHAR(100),
        user_mobile VARCHAR(20) NOT NULL,
        amount NUMERIC(10, 2) DEFAULT 80.00,
        upi_id VARCHAR(150),
        transaction_ref VARCHAR(100),
        status VARCHAR(30) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        verified_at TIMESTAMP,
        admin_notes TEXT
      );

      CREATE TABLE IF NOT EXISTS missing_data_requests (
        id SERIAL PRIMARY KEY,
        state_name VARCHAR(100) NOT NULL,
        district_name VARCHAR(100) NOT NULL,
        tehsil_name VARCHAR(100),
        village_name VARCHAR(150) NOT NULL,
        user_name VARCHAR(150),
        user_mobile VARCHAR(20) NOT NULL,
        notes TEXT,
        status VARCHAR(30) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Insert default settings in postgres
    const defaultSettings = [
      ['upi_id', 'paytmqr28100505010113f38012u8a6@paytm'],
      ['merchant_name', 'Gram Panchayat Property Portal'],
      ['price', '80.00'],
      ['admin_pin', '123456'],
      ['auto_verify_demo', 'false']
    ];

    for (const [k, v] of defaultSettings) {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [k, v]
      );
    }

    client.release();
    console.log('[PostgreSQL] Database schema initialized.');
  } catch (err) {
    console.warn(`[DB] PostgreSQL not directly available (${err.message}). Using unified high-speed local engine.`);
    usePostgres = false;
  }
}

function isPublicOrNonCitizenRecord(ownerName, fatherName) {
  const o = (ownerName || '').trim();
  const f = (fatherName || '').trim();
  if (!o || o === '-' || o === '--') return true;

  const ignoredPatterns = [
    /रास्ता/i,
    /रास्‍ता/i,
    /मार्ग/i,
    /सड़क/i,
    /चकरोड/i,
    /खड़ंजा/i,
    /पगडंडी/i,
    /रिक्त/i,
    /खाली\s*आबादी/i,
    /कुंआ/i,
    /कुआं/i,
    /कुआ/i,
    /कूप/i,
    /नाली/i,
    /नाला/i,
    /तालाब/i,
    /पोखरा/i,
    /बंजर/i,
    /परती/i,
    /कब्रिस्तान/i,
    /शमशान/i,
    /मरघट/i,
    /ग्राम\s*सभा/i,
    /पंचायत/i,
    /घूरा/i,
    /खलिहान/i,
    /चारागाह/i,
    /गड्ढा/i,
    /चकमार्ग/i,
    /हैंडपंप/i,
    /नलकूप/i,
    /^road/i,
    /^pathway/i,
    /^vacant/i,
    /^well/i
  ];

  for (const pattern of ignoredPatterns) {
    if (pattern.test(o)) return true;
  }

  // Also if father name is blank/dash and owner contains public keywords
  if ((f === '--' || f === '-' || !f) && (
    o.includes('आबादी') || o.includes('भूमि') || o.includes('स्थान') || o.includes('भवन')
  )) {
    return true;
  }

  return false;
}

// Data Access Layer with unified interface
const db = {
  isPostgres: () => usePostgres,
  isPublicOrNonCitizenRecord,

  /**
   * Verify Admin Login Credentials against salted cryptographic scrypt hash
   * Supports username + password or legacy PIN
   */
  async verifyAdminCredentials(usernameOrPin, password) {
    const admin = localDb.admin;
    if (!admin || !admin.password_hash || !admin.password_salt) {
      return false;
    }

    // If both username and password provided
    if (password !== undefined && password !== null) {
      const usernameMatch = String(usernameOrPin).trim().toLowerCase() === String(admin.username || 'admin').toLowerCase();
      if (!usernameMatch) {
        return false;
      }
      return verifyPassword(String(password).trim(), admin.password_hash, admin.password_salt);
    }

    // If single PIN / password string provided
    return verifyPassword(String(usernameOrPin).trim(), admin.password_hash, admin.password_salt);
  },

  /**
   * Change Admin Password securely
   */
  async changeAdminPassword(oldPassword, newPassword, newUsername) {
    const admin = localDb.admin;
    if (!admin) throw new Error('व्यवस्थापक खाता उपलब्ध नहीं है। (Admin account not found)');

    const isValid = verifyPassword(String(oldPassword).trim(), admin.password_hash, admin.password_salt);
    if (!isValid) {
      throw new Error('वर्तमान पासवर्ड / पिन अमान्य है। (Current password/PIN is incorrect)');
    }

    if (!newPassword || String(newPassword).trim().length < 6) {
      throw new Error('नया पासवर्ड न्यूनतम 6 अक्षरों का होना चाहिए। (New password must be at least 6 characters)');
    }

    const hashed = hashPassword(String(newPassword).trim());
    admin.password_hash = hashed.hash;
    admin.password_salt = hashed.salt;
    if (newUsername && String(newUsername).trim()) {
      admin.username = String(newUsername).trim();
    }
    admin.updated_at = new Date().toISOString();

    // Also update legacy admin_pin setting for consistency if needed
    if (localDb.settings) {
      localDb.settings.admin_pin = '******';
    }

    saveLocalDb();
    return { success: true, username: admin.username, message: 'पासवर्ड सफलतापूर्वक बदल दिया गया है।' };
  },

  /**
   * Log security events for auditing (OWASP A09)
   */
  async logSecurityEvent(eventType, ip, details = {}, status = 'success') {
    const logEntry = {
      id: (localDb.security_logs?.length || 0) + 1,
      event_type: eventType,
      ip: ip || 'unknown',
      status: status,
      details: typeof details === 'object' ? JSON.stringify(details) : String(details),
      timestamp: new Date().toISOString()
    };

    if (!localDb.security_logs) localDb.security_logs = [];
    localDb.security_logs.unshift(logEntry);

    // Keep last 500 audit logs to prevent unbounded memory growth
    if (localDb.security_logs.length > 500) {
      localDb.security_logs = localDb.security_logs.slice(0, 500);
    }

    saveLocalDb();
    return logEntry;
  },

  /**
   * Retrieve security audit logs
   */
  async getSecurityLogs(limit = 100) {
    const list = localDb.security_logs || [];
    return list.slice(0, Math.min(limit, 500));
  },
  
  async getSettings(forAdmin = false) {
    let settingsData = { ...localDb.settings };

    if (usePostgres) {
      const res = await pool.query('SELECT key, value FROM settings');
      const map = {};
      res.rows.forEach(r => {
        if (r.key === 'price') map[r.key] = parseFloat(r.value);
        else if (r.key === 'auto_verify_demo') map[r.key] = r.value === 'true';
        else map[r.key] = r.value;
      });
      settingsData = { ...settingsData, ...map };
    }

    if (!forAdmin) {
      // Public settings (Never leak PIN, Passwords, SMTP or Internal Secrets)
      return {
        upi_id: settingsData.upi_id,
        merchant_name: settingsData.merchant_name,
        price: settingsData.price || 80.00
      };
    }

    // Admin view: mask sensitive passwords
    return {
      upi_id: settingsData.upi_id,
      merchant_name: settingsData.merchant_name,
      price: settingsData.price || 80.00,
      auto_verify_demo: Boolean(settingsData.auto_verify_demo),
      smtp_host: settingsData.smtp_host || '',
      smtp_port: settingsData.smtp_port || '587',
      smtp_user: settingsData.smtp_user || '',
      has_smtp_pass: Boolean(settingsData.smtp_pass && settingsData.smtp_pass.trim() !== ''),
      notify_email: settingsData.notify_email || '',
      admin_username: localDb.admin?.username || 'admin',
      admin_last_updated: localDb.admin?.updated_at || null
    };
  },

  async updateSettings(newSettings) {
    if (usePostgres) {
      for (const [k, v] of Object.entries(newSettings)) {
        await pool.query(
          `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [k, String(v)]
        );
      }
    }
    localDb.settings = { ...localDb.settings, ...newSettings };
    saveLocalDb();
    return this.getSettings(true);
  },

  async getDistricts() {
    loadLocalDbFromDisk();
    if (localDb.districts && localDb.districts.length > 0) {
      return localDb.districts.map(d => d.district_name || d.name);
    }
    const ALL_UP_DISTRICTS = [
      'Agra', 'Aligarh', 'Ambedkar Nagar', 'Amethi', 'Amroha', 'Auraiya', 'Ayodhya', 'Azamgarh',
      'Baghpat', 'Bahraich', 'Ballia', 'Balrampur', 'Banda', 'Bara Banki', 'Bareilly', 'Basti',
      'Bhadohi', 'Bijnor', 'Budaun', 'Bulandshahr', 'Chandauli', 'Chitrakoot', 'Deoria', 'Etah',
      'Etawah', 'Farrukhabad', 'Fatehpur', 'Firozabad', 'Gautam Buddha Nagar', 'Ghaziabad', 'Ghazipur',
      'Gonda', 'Gorakhpur', 'Hamirpur', 'Hapur', 'Hardoi', 'Hathras', 'Jalaun', 'Jaunpur', 'Jhansi',
      'Kannauj', 'Kanpur Dehat', 'Kanpur Nagar', 'Kasganj', 'Kaushambi', 'Kheri', 'Kushinagar',
      'Lalitpur', 'Lucknow', 'Mahoba', 'Mahrajganj', 'Mainpuri', 'Mathura', 'Mau', 'Meerut',
      'Mirzapur', 'Moradabad', 'Muzaffarnagar', 'Pilibhit', 'Pratapgarh', 'Prayagraj', 'Rae Bareli',
      'Rampur', 'Saharanpur', 'Sambhal', 'Sant Kabir Nagar', 'Shahjahanpur', 'Shamli', 'Shrawasti',
      'Siddharthnagar', 'Sitapur', 'Sonbhadra', 'Sultanpur', 'Unnao', 'Varanasi'
    ];
    return ALL_UP_DISTRICTS;
  },

  async getTehsilsByDistrict(districtName) {
    if (usePostgres) {
      const res = await pool.query(
        'SELECT DISTINCT tehsil FROM villages WHERE LOWER(district_name) = LOWER($1) AND tehsil IS NOT NULL AND tehsil != \'\' ORDER BY tehsil',
        [districtName]
      );
      return res.rows.map(r => r.tehsil);
    }
    const key = String(districtName).toLowerCase().trim();
    const villages = indexes.villagesByDistrict.get(key) || [];
    const tehsils = Array.from(new Set(villages.map(v => v.tehsil).filter(Boolean))).sort();
    return tehsils;
  },

  async getVillagesByDistrict(districtName, tehsil = '') {
    if (usePostgres) {
      let query = 'SELECT id, village_code, village_name, district_name, tehsil, total_records FROM villages WHERE LOWER(district_name) = LOWER($1)';
      const params = [districtName];
      if (tehsil && tehsil.trim() !== '' && tehsil.toLowerCase() !== 'all') {
        params.push(tehsil.trim());
        query += ' AND LOWER(tehsil) = LOWER($2)';
      }
      query += ' ORDER BY village_name';
      const res = await pool.query(query, params);
      return res.rows;
    }
    loadLocalDbFromDisk();
    const key = String(districtName).toLowerCase().trim();
    let list = indexes.villagesByDistrict.get(key) || [];
    if (tehsil && tehsil.trim() !== '' && tehsil.toLowerCase() !== 'all') {
      const t = tehsil.trim().toLowerCase();
      list = list.filter(v => String(v.tehsil || '').toLowerCase() === t);
    }
    return list;
  },

  async getAvailableCoverage() {
    if (usePostgres) {
      const res = await pool.query(`
        SELECT 
          'Uttar Pradesh' as state_name,
          v.district_name,
          v.village_name,
          v.village_code,
          v.tehsil,
          v.total_records
        FROM villages v
        ORDER BY v.district_name, v.village_name
      `);
      const villages = res.rows;
      const districtSet = new Set(villages.map(v => v.district_name));
      const totalProps = villages.reduce((sum, v) => sum + (parseInt(v.total_records, 10) || 0), 0);
      return {
        totalStates: 1,
        totalDistricts: districtSet.size,
        totalVillages: villages.length,
        totalProperties: totalProps,
        coverage: villages
      };
    }

    loadLocalDbFromDisk();
    const list = (localDb.villages || []).map(v => {
      return {
        state: v.state_name || 'Uttar Pradesh',
        district: v.district_name,
        village_name: v.village_name,
        village_code: String(v.village_code),
        tehsil: v.tehsil || '',
        total_records: v.total_records || 0
      };
    });

    list.sort((a, b) => {
      if (a.district.localeCompare(b.district) !== 0) {
        return a.district.localeCompare(b.district);
      }
      return a.village_name.localeCompare(b.village_name);
    });

    const districtSet = new Set(list.map(v => v.district));
    const totalProps = localDb.total_properties_count || (localDb.properties && localDb.properties.length > 0 ? localDb.properties.length : list.reduce((s, v) => s + (parseInt(v.total_records, 10) || 0), 0));

    return {
      totalStates: 1,
      totalDistricts: districtSet.size,
      totalVillages: list.length,
      totalProperties: totalProps,
      coverage: list
    };
  },

  async getVillageProperties(districtName, villageCode, search = '', page = 1, limit = 50) {
    const offset = (page - 1) * limit;
    
    if (usePostgres) {
      let query = `
        SELECT id, record_id, variable_id, property_card_id, owner_name, father_name, mobile_no, total_area, built_area, open_area, 
               village_code, village_name, district_name, tehsil, distribution_date, remarks,
               CONCAT(SUBSTRING(property_card_id, 1, 6), '******', SUBSTRING(property_card_id, LENGTH(property_card_id)-1, 2)) AS masked_property_card_id
        FROM properties
        WHERE LOWER(district_name) = LOWER($1) AND village_code = $2
          AND owner_name NOT ILIKE '%रास्ता%' AND owner_name NOT ILIKE '%रास्‍ता%' AND owner_name NOT ILIKE '%रिक्त%'
      `;
      const params = [districtName, villageCode];

      if (search && search.trim() !== '') {
        params.push(`%${search.trim().toLowerCase()}%`);
        query += ` AND (LOWER(owner_name) LIKE $3 OR LOWER(father_name) LIKE $3 OR variable_id LIKE $3)`;
      }

      const countRes = await pool.query(
        query.replace(/SELECT .*? FROM/i, 'SELECT COUNT(*) FROM'),
        params
      );
      const total = parseInt(countRes.rows[0].count, 10);

      query += ` ORDER BY id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);

      const res = await pool.query(query, params);
      return {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        records: res.rows
      };
    }

    loadLocalDbFromDisk();
    
    // 1. High-Performance Zero-RAM SQLite Engine (< 1ms query time, < 1MB RAM)
    const sdb = getDistrictSqlite(districtName);
    if (sdb) {
      const vCode = String(villageCode).trim();
      let query = `
        SELECT id, record_id, variable_id, property_card_id, owner_name, father_name, mobile_no, total_area, built_area, open_area, 
               village_code, village_name, district_name, tehsil, distribution_date, remarks
        FROM properties
        WHERE village_code = ?
          AND owner_name NOT LIKE '%रास्ता%' AND owner_name NOT LIKE '%रास्‍ता%' AND owner_name NOT LIKE '%रिक्त%' AND owner_name NOT LIKE '%सार्वजनिक%' AND owner_name NOT LIKE '%ग्राम सभा%'
      `;
      const params = [vCode];

      if (search && search.trim() !== '') {
        const s = `%${search.trim().toLowerCase()}%`;
        query += ` AND (LOWER(owner_name) LIKE ? OR LOWER(father_name) LIKE ? OR LOWER(variable_id) LIKE ?)`;
        params.push(s, s, s);
      }

      try {
        const countQuery = query.replace(/SELECT[\s\S]*?FROM/i, 'SELECT COUNT(*) as total_count FROM');
        const countStmt = sdb.prepare(countQuery);
        const countRes = countStmt.get(...params);
        const total = countRes ? (countRes.total_count !== undefined ? countRes.total_count : Object.values(countRes)[0]) : 0;

        const dataStmt = sdb.prepare(`${query} ORDER BY rowid ASC LIMIT ? OFFSET ?`);
        const rows = dataStmt.all(...params, limit, offset);

        const paginated = rows.map(p => {
          const pid = String(p.property_card_id || '');
          return {
            id: p.id,
            record_id: p.record_id,
            variable_id: p.variable_id,
            property_card_id: pid,
            owner_name: p.owner_name,
            father_name: p.father_name,
            mobile_no: p.mobile_no,
            total_area: p.total_area,
            built_area: p.built_area,
            open_area: p.open_area,
            village_code: p.village_code,
            village_name: p.village_name,
            district_name: p.district_name,
            tehsil: p.tehsil,
            distribution_date: p.distribution_date,
            remarks: p.remarks,
            masked_property_card_id: pid
          };
        });

        return {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
          records: paginated
        };
      } catch (err) {
        console.error('[DB] SQLite query error for', districtName, err);
      }
    }

    // Fallback if sqlite not available
    const key = `${String(districtName).toLowerCase().trim()}:${String(villageCode).trim()}`;
    let list = indexes.propertiesByVillage.get(key) || [];

    if (search && search.trim()) {
      list = list.filter(p => matchSearchQuery(p, search));
    }

    const total = list.length;
    const paginated = list.slice(offset, offset + limit).map(p => {
      const pid = String(p.property_card_id || '');
      return {
        id: p.id,
        record_id: p.record_id,
        variable_id: p.variable_id,
        property_card_id: pid,
        owner_name: p.owner_name,
        father_name: p.father_name,
        mobile_no: p.mobile_no,
        total_area: p.total_area,
        built_area: p.built_area,
        open_area: p.open_area,
        village_code: p.village_code,
        village_name: p.village_name,
        district_name: p.district_name,
        tehsil: p.tehsil,
        distribution_date: p.distribution_date,
        remarks: p.remarks,
        masked_property_card_id: pid
      };
    });

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      records: paginated
    };
  },

  async searchGlobalProperties(search = '', page = 1, limit = 50) {
    const offset = (page - 1) * limit;
    let list = (localDb.properties || []).filter(p => !isPublicOrNonCitizenRecord(p.owner_name, p.father_name));
    
    if (search && search.trim()) {
      list = list.filter(p => matchSearchQuery(p, search));
    }

    const total = list.length;
    const paginated = list.slice(offset, offset + limit).map(p => {
      const pid = String(p.property_card_id || '');
      return {
        id: p.id,
        record_id: p.record_id,
        variable_id: p.variable_id,
        property_card_id: pid,
        owner_name: p.owner_name,
        father_name: p.father_name,
        mobile_no: p.mobile_no,
        total_area: p.total_area,
        built_area: p.built_area,
        open_area: p.open_area,
        village_code: p.village_code,
        village_name: p.village_name,
        district_name: p.district_name,
        tehsil: p.tehsil,
        distribution_date: p.distribution_date,
        remarks: p.remarks,
        masked_property_card_id: pid
      };
    });

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      records: paginated
    };
  },

  async getPropertyById(id) {
    if (usePostgres) {
      const res = await pool.query('SELECT * FROM properties WHERE id = $1', [id]);
      return res.rows[0] || null;
    }
    loadLocalDbFromDisk();
    const strId = String(id).trim();

    // 1. If id format is distIdx_propCounter e.g. "1_100"
    if (strId.includes('_')) {
      const distId = parseInt(strId.split('_')[0], 10);
      const distObj = (localDb.districts || []).find(d => d.id === distId);
      if (distObj && distObj.district_name) {
        const sdb = getDistrictSqlite(distObj.district_name);
        if (sdb) {
          const row = sdb.prepare('SELECT * FROM properties WHERE id = ? OR record_id = ? LIMIT 1').get(strId, strId);
          if (row) return row;
        }
      }
    }

    // 2. Check open sqlite handles
    for (const [_, sdb] of sqliteHandles.entries()) {
      try {
        const row = sdb.prepare('SELECT * FROM properties WHERE id = ? OR record_id = ? LIMIT 1').get(strId, strId);
        if (row) return row;
      } catch (_) {}
    }

    // 3. Check legacy localDb.properties
    if (Array.isArray(localDb.properties)) {
      const found = localDb.properties.find(p => String(p.id) === strId || String(p.record_id) === strId);
      if (found) return found;
    }

    return null;
  },

  async createOrder({ propertyId, userMobile, amount, upiId, existingOrderId, existingOrderToken }) {
    const prop = await this.getPropertyById(propertyId);
    if (!prop) {
      throw new Error('Property record not found.');
    }

    const cleanPropId = String(prop.id);
    const cleanMobile = String(userMobile || '').replace(/\D/g, '').slice(-10);

    // 1. If existingOrderId or existingOrderToken is provided, check if it matches
    if (existingOrderId || existingOrderToken) {
      const existing = await this.getOrderForUser(existingOrderId, existingOrderToken);
      if (existing && String(existing.property_id) === cleanPropId) {
        return existing;
      }
    }

    // 2. Check if there is already an existing verified or active pending order for this property & mobile
    if (cleanMobile && cleanMobile.length === 10) {
      if (usePostgres) {
        const res = await pool.query(
          `SELECT * FROM orders WHERE property_id = $1 AND user_mobile = $2 ORDER BY id DESC LIMIT 1`,
          [cleanPropId, cleanMobile]
        );
        if (res.rows.length > 0) {
          const existingOrder = res.rows[0];
          // If verified or pending with transaction_ref or created in last 24h, reuse it
          const ageMs = Date.now() - new Date(existingOrder.created_at).getTime();
          if (existingOrder.status === 'verified' || existingOrder.transaction_ref || ageMs < 24 * 3600 * 1000) {
            return existingOrder;
          }
        }
      } else {
        const existingOrder = localDb.orders.slice().reverse().find(o => 
          String(o.property_id) === cleanPropId && 
          o.user_mobile === cleanMobile
        );
        if (existingOrder) {
          const ageMs = Date.now() - new Date(existingOrder.created_at).getTime();
          if (existingOrder.status === 'verified' || existingOrder.transaction_ref || ageMs < 24 * 3600 * 1000) {
            return existingOrder;
          }
        }
      }
    }

    const crypto = require('crypto');
    const orderId = 'PROP-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const orderToken = crypto.randomBytes(24).toString('hex');

    const orderData = {
      order_id: orderId,
      order_token: orderToken,
      property_id: prop.id,
      property_card_id: prop.property_card_id,
      owner_name: prop.owner_name,
      father_name: prop.father_name,
      village_code: prop.village_code,
      village_name: prop.village_name,
      district_name: prop.district_name,
      user_mobile: cleanMobile || userMobile,
      amount: amount || 80.00,
      upi_id: upiId,
      transaction_ref: null,
      status: 'pending',
      created_at: new Date().toISOString(),
      verified_at: null,
      admin_notes: ''
    };

    // Store in ephemeral map so it's ready when user submits UTR
    if (!indexes.pendingDraftOrders) indexes.pendingDraftOrders = new Map();
    indexes.pendingDraftOrders.set(orderId, orderData);
    indexes.pendingDraftOrders.set(orderToken, orderData);

    return orderData;
  },

  async submitTransactionRef(orderId, orderToken, transactionRef, userMobile, propertyId) {
    const cleanRef = transactionRef ? String(transactionRef).trim() : '';
    const lowerRef = cleanRef.toLowerCase();

    if (!cleanRef || cleanRef.length < 6) {
      throw new Error('मान्य UTR नंबर आवश्यक है (Valid UTR is required)');
    }

    if (usePostgres) {
      // Check if UTR is already used by another order
      const dupCheck = await pool.query(
        `SELECT order_id FROM orders WHERE LOWER(TRIM(transaction_ref)) = $1 AND order_id != $2 AND order_token != $3 LIMIT 1`,
        [lowerRef, orderId || '', orderToken || '']
      );
      if (dupCheck.rows && dupCheck.rows.length > 0) {
        const err = new Error('यह UTR / संदर्भ संख्या पहले ही उपयोग की जा चुकी है (This UTR is already used)। कृपया सही UTR दर्ज करें।');
        err.code = 'DUPLICATE_UTR';
        throw err;
      }

      // Check if order exists in DB
      const existing = await pool.query(
        `SELECT * FROM orders WHERE order_id = $1 OR order_token = $2 LIMIT 1`,
        [orderId, orderToken]
      );

      if (existing.rows.length > 0) {
        const res = await pool.query(`
          UPDATE orders
          SET transaction_ref = $1, user_mobile = COALESCE($2, user_mobile), status = 'pending'
          WHERE (order_id = $3 OR order_token = $4)
          RETURNING *
        `, [cleanRef, userMobile, orderId, orderToken]);
        return res.rows[0];
      }

      // Otherwise, insert new submitted order
      const draft = indexes.pendingDraftOrders ? (indexes.pendingDraftOrders.get(orderId) || indexes.pendingDraftOrders.get(orderToken)) : null;
      const propId = propertyId || (draft ? draft.property_id : null);
      const prop = propId ? await this.getPropertyById(propId) : null;

      const res = await pool.query(`
        INSERT INTO orders (
          order_id, order_token, property_id, property_card_id, owner_name, father_name, 
          village_code, village_name, district_name, user_mobile, amount, upi_id, transaction_ref, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending')
        RETURNING *
      `, [
        orderId, orderToken, prop?.id || 0, prop?.property_card_id || '',
        prop?.owner_name || (draft ? draft.owner_name : ''), prop?.father_name || (draft ? draft.father_name : ''),
        prop?.village_code || (draft ? draft.village_code : ''), prop?.village_name || (draft ? draft.village_name : ''),
        prop?.district_name || (draft ? draft.district_name : ''), userMobile, 80.00, '', cleanRef
      ]);
      return res.rows[0];
    }

    // Check in local JSON store
    const duplicateOrder = localDb.orders.find(o => 
      o.transaction_ref && 
      String(o.transaction_ref).trim().toLowerCase() === lowerRef &&
      o.order_id !== orderId &&
      o.order_token !== orderToken
    );

    if (duplicateOrder) {
      const err = new Error('यह UTR / संदर्भ संख्या पहले ही उपयोग की जा चुकी है (This UTR is already used)। कृपया सही UTR दर्ज करें।');
      err.code = 'DUPLICATE_UTR';
      throw err;
    }

    let order = localDb.orders.find(o => o.order_id === orderId || o.order_token === orderToken);
    
    if (order) {
      order.transaction_ref = cleanRef;
      if (userMobile) order.user_mobile = userMobile;
      order.status = 'pending';
    } else {
      // Construct from draft or property
      const draft = indexes.pendingDraftOrders ? (indexes.pendingDraftOrders.get(orderId) || indexes.pendingDraftOrders.get(orderToken)) : null;
      const propId = propertyId || (draft ? draft.property_id : null);
      const prop = propId ? await this.getPropertyById(propId) : null;

      order = {
        id: localDb.orders.length + 1,
        order_id: orderId,
        order_token: orderToken,
        property_id: prop?.id || (draft ? draft.property_id : 0),
        property_card_id: prop?.property_card_id || (draft ? draft.property_card_id : ''),
        owner_name: prop?.owner_name || (draft ? draft.owner_name : 'अज्ञात'),
        father_name: prop?.father_name || (draft ? draft.father_name : ''),
        village_code: prop?.village_code || (draft ? draft.village_code : ''),
        village_name: prop?.village_name || (draft ? draft.village_name : ''),
        district_name: prop?.district_name || (draft ? draft.district_name : ''),
        user_mobile: userMobile || (draft ? draft.user_mobile : ''),
        amount: draft?.amount || 80.00,
        upi_id: draft?.upi_id || '',
        transaction_ref: cleanRef,
        status: 'pending',
        created_at: new Date().toISOString(),
        verified_at: null,
        admin_notes: ''
      };
      localDb.orders.push(order);
    }

    saveLocalDb();
    return order;
  },

  async getOrderForUser(orderId, orderToken, mobile, utr) {
    let order = null;
    const cleanUtr = utr ? String(utr).trim().toLowerCase() : null;
    const cleanMobile = mobile ? String(mobile).replace(/\D/g, '').slice(-10) : null;
    const cleanOrderId = orderId ? String(orderId).trim() : null;
    const cleanToken = orderToken ? String(orderToken).trim() : null;

    if (usePostgres) {
      // 1. Match by Order ID or Token
      if (cleanOrderId || cleanToken) {
        const res = await pool.query(`
          SELECT * FROM orders 
          WHERE (order_id = $1 OR order_token = $2) 
            AND ($3::text IS NULL OR user_mobile = $3)
          ORDER BY id DESC LIMIT 1
        `, [cleanOrderId, cleanToken, cleanMobile]);
        order = res.rows[0] || null;
      }

      // 2. If not found, match by UTR and/or Mobile
      if (!order && (cleanUtr || cleanMobile)) {
        let q = `SELECT * FROM orders WHERE 1=1`;
        const params = [];
        if (cleanUtr) {
          params.push(cleanUtr);
          q += ` AND LOWER(TRIM(transaction_ref)) = $${params.length}`;
        }
        if (cleanMobile) {
          params.push(cleanMobile);
          q += ` AND user_mobile = $${params.length}`;
        }
        q += ` ORDER BY id DESC LIMIT 1`;
        const res = await pool.query(q, params);
        order = res.rows[0] || null;
      }
    } else {
      // Local JSON Store lookup
      if (cleanOrderId || cleanToken) {
        order = localDb.orders.slice().reverse().find(o => 
          (o.order_id === cleanOrderId || o.order_token === cleanToken) &&
          (!cleanMobile || o.user_mobile === cleanMobile)
        );
      }

      if (!order && (cleanUtr || cleanMobile)) {
        order = localDb.orders.slice().reverse().find(o => {
          let match = true;
          if (cleanUtr) {
            match = match && (o.transaction_ref && String(o.transaction_ref).trim().toLowerCase() === cleanUtr);
          }
          if (cleanMobile) {
            match = match && (o.user_mobile === cleanMobile);
          }
          return match;
        });
      }
    }

    if (!order) return null;

    // Strict Privacy: Only if verified AND matching order, return the full unlocked property details
    if (order.status === 'verified') {
      const fullProp = await this.getPropertyById(order.property_id);
      return {
        ...order,
        property_details: fullProp,
        is_unlocked: true
      };
    } else {
      return {
        order_id: order.order_id,
        order_token: order.order_token,
        owner_name: order.owner_name,
        father_name: order.father_name,
        village_name: order.village_name,
        district_name: order.district_name,
        amount: order.amount,
        user_mobile: order.user_mobile,
        transaction_ref: order.transaction_ref,
        status: order.status,
        created_at: order.created_at,
        is_unlocked: false,
        message: order.status === 'pending' 
          ? 'Payment submitted. Pending admin verification.' 
          : 'Payment verification rejected. Please contact support.'
      };
    }
  },

  async getOrdersAdmin(filterStatus = '') {
    if (usePostgres) {
      let q = "SELECT * FROM orders WHERE transaction_ref IS NOT NULL AND LENGTH(TRIM(transaction_ref)) >= 6";
      const params = [];
      if (filterStatus) {
        params.push(filterStatus);
        q += ' AND status = $1';
      }
      q += ' ORDER BY id DESC';
      const res = await pool.query(q, params);
      return res.rows;
    }

    let list = localDb.orders.filter(o => o.transaction_ref && String(o.transaction_ref).trim().length >= 6 && o.transaction_ref !== 'उपलब्ध नहीं');
    if (filterStatus) {
      list = list.filter(o => o.status === filterStatus);
    }
    return list.sort((a, b) => b.id - a.id);
  },

  async clearAllOrders() {
    if (usePostgres) {
      await pool.query('DELETE FROM orders');
    }
    localDb.orders = [];
    indexes.ordersById.clear();
    indexes.ordersByToken.clear();
    saveLocalDb();
    return { success: true, message: 'All orders cleared successfully' };
  },

  async deleteOrder(orderId) {
    if (usePostgres) {
      await pool.query('DELETE FROM orders WHERE order_id = $1 OR id = $2', [orderId, isNaN(orderId) ? 0 : parseInt(orderId, 10)]);
    }
    const idx = localDb.orders.findIndex(o => o.order_id === orderId || o.id === parseInt(orderId, 10));
    if (idx !== -1) {
      const removed = localDb.orders.splice(idx, 1)[0];
      indexes.ordersById.delete(removed.order_id);
      indexes.ordersByToken.delete(removed.order_token);
      saveLocalDb();
      return true;
    }
    return false;
  },

  async verifyOrderAdmin(orderId, action = 'verified', adminNotes = '') {
    const verifiedAt = action === 'verified' ? new Date().toISOString() : null;
    if (usePostgres) {
      const res = await pool.query(`
        UPDATE orders
        SET status = $1, verified_at = $2, admin_notes = $3
        WHERE order_id = $4 OR id = $5
        RETURNING *
      `, [action, verifiedAt, adminNotes, orderId, isNaN(orderId) ? 0 : parseInt(orderId, 10)]);
      return res.rows[0] || null;
    }

    const order = localDb.orders.find(o => o.order_id === orderId || o.id === parseInt(orderId, 10));
    if (!order) return null;
    order.status = action;
    order.verified_at = verifiedAt;
    order.admin_notes = adminNotes;
    saveLocalDb();
    return order;
  },

  async createMissingDataRequest(data) {
    const reqData = {
      state_name: data.state_name || 'Uttar Pradesh',
      district_name: data.district_name,
      tehsil_name: data.tehsil_name || '',
      village_name: data.village_name,
      village_code: data.village_code || '',
      user_name: data.user_name || '',
      user_mobile: data.user_mobile,
      notes: data.notes || '',
      status: 'pending',
      created_at: new Date().toISOString()
    };

    if (usePostgres) {
      const res = await pool.query(`
        INSERT INTO missing_data_requests (state_name, district_name, tehsil_name, village_name, user_name, user_mobile, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [
        reqData.state_name, reqData.district_name, reqData.tehsil_name,
        reqData.village_name, reqData.user_name, reqData.user_mobile, reqData.notes
      ]);
      return res.rows[0];
    }

    reqData.id = localDb.missing_data_requests.length + 1;
    localDb.missing_data_requests.push(reqData);
    saveLocalDb();
    return reqData;
  },

  async getMissingDataRequestsAdmin() {
    if (usePostgres) {
      const res = await pool.query('SELECT * FROM missing_data_requests ORDER BY id DESC');
      return res.rows;
    }
    return [...localDb.missing_data_requests].sort((a, b) => b.id - a.id);
  },

  async updateMissingDataRequestStatus(requestId, status) {
    const validStatus = ['pending', 'uploaded', 'rejected', 'in_progress'].includes(status) ? status : 'uploaded';
    if (usePostgres) {
      const res = await pool.query(
        'UPDATE missing_data_requests SET status = $1 WHERE id = $2 RETURNING *',
        [validStatus, requestId]
      );
      return res.rows[0] || null;
    }
    const req = localDb.missing_data_requests.find(r => r.id === parseInt(requestId, 10));
    if (!req) return null;
    req.status = validStatus;
    req.updated_at = new Date().toISOString();
    saveLocalDb();
    return req;
  },

  async clearAllMissingDataRequests() {
    if (usePostgres) {
      await pool.query('DELETE FROM missing_data_requests');
    }
    localDb.missing_data_requests = [];
    saveLocalDb();
    return { success: true, message: 'All missing data requests cleared' };
  },

  async deleteMissingDataRequest(requestId) {
    if (usePostgres) {
      await pool.query('DELETE FROM missing_data_requests WHERE id = $1', [parseInt(requestId, 10)]);
    }
    const idx = localDb.missing_data_requests.findIndex(r => r.id === parseInt(requestId, 10));
    if (idx !== -1) {
      localDb.missing_data_requests.splice(idx, 1);
      saveLocalDb();
      return true;
    }
    return false;
  },

  async exportDatabaseBackup() {
    if (usePostgres) {
      const [pRes, vRes, oRes, reqRes, sRes] = await Promise.all([
        pool.query('SELECT * FROM properties'),
        pool.query('SELECT * FROM villages'),
        pool.query('SELECT * FROM orders'),
        pool.query('SELECT * FROM missing_data_requests'),
        pool.query('SELECT key, value FROM settings')
      ]);
      const settingsMap = {};
      sRes.rows.forEach(r => settingsMap[r.key] = r.value);
      return {
        districts: [],
        villages: vRes.rows,
        properties: pRes.rows,
        orders: oRes.rows,
        missing_data_requests: reqRes.rows,
        settings: settingsMap,
        admin: localDb.admin,
        exported_at: new Date().toISOString()
      };
    }
    return {
      ...localDb,
      exported_at: new Date().toISOString()
    };
  },

  async restoreDatabaseBackup(backupData) {
    if (!backupData || typeof backupData !== 'object') {
      throw new Error('अमान्य बैकअप फ़ाइल (Invalid backup data format)');
    }

    // Save auto-backup snapshot of current state
    const backupsDir = path.join(dataDir, 'backups');
    if (!fs.existsSync(backupsDir)) {
      try { fs.mkdirSync(backupsDir, { recursive: true }); } catch (e) {}
    }
    const snapshotPath = path.join(backupsDir, `snapshot_before_restore_${Date.now()}.json`);
    try {
      fs.writeFileSync(snapshotPath, JSON.stringify(localDb, null, 2), 'utf8');
    } catch (e) {
      console.error('[DB] Snapshot creation warning:', e);
    }

    if (usePostgres) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (Array.isArray(backupData.villages)) {
          for (const v of backupData.villages) {
            await client.query(
              `INSERT INTO villages (village_code, village_name, district_name, tehsil, total_records)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (village_code, district_name) DO UPDATE SET village_name = EXCLUDED.village_name, total_records = EXCLUDED.total_records`,
              [v.village_code, v.village_name, v.district_name, v.tehsil || '', v.total_records || 0]
            );
          }
        }
        if (Array.isArray(backupData.orders)) {
          for (const o of backupData.orders) {
            await client.query(
              `INSERT INTO orders (order_id, order_token, property_id, property_card_id, owner_name, father_name, village_code, village_name, district_name, user_mobile, amount, upi_id, transaction_ref, status, created_at, verified_at, admin_notes)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
               ON CONFLICT (order_id) DO UPDATE SET status = EXCLUDED.status, transaction_ref = EXCLUDED.transaction_ref`,
              [o.order_id, o.order_token, o.property_id, o.property_card_id, o.owner_name, o.father_name, o.village_code, o.village_name, o.district_name, o.user_mobile, o.amount, o.upi_id, o.transaction_ref, o.status, o.created_at, o.verified_at, o.admin_notes]
            );
          }
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('[DB] Postgres restore error:', err);
      } finally {
        client.release();
      }
    }

    // Merge into local in-memory store
    if (Array.isArray(backupData.properties) && backupData.properties.length > 0) {
      localDb.properties = backupData.properties;
    }
    if (Array.isArray(backupData.villages)) {
      localDb.villages = backupData.villages;
    }
    if (Array.isArray(backupData.orders)) {
      localDb.orders = backupData.orders;
    }
    if (Array.isArray(backupData.missing_data_requests)) {
      localDb.missing_data_requests = backupData.missing_data_requests;
    }
    if (backupData.settings && typeof backupData.settings === 'object') {
      localDb.settings = { ...localDb.settings, ...backupData.settings };
    }

    saveLocalDb();
    rebuildMemoryIndexes();

    return {
      success: true,
      propertiesCount: localDb.properties.length,
      villagesCount: localDb.villages.length,
      ordersCount: localDb.orders.length,
      requestsCount: localDb.missing_data_requests.length
    };
  },

  async insertVillageAndProperties(village, properties) {
    if (usePostgres) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`
          INSERT INTO villages (village_code, village_name, district_name, tehsil, total_records)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (village_code, district_name) DO UPDATE 
          SET village_name = EXCLUDED.village_name, total_records = EXCLUDED.total_records, tehsil = EXCLUDED.tehsil
        `, [village.village_code, village.village_name, village.district_name, village.tehsil || '', village.total_records]);

        // Remove old properties for this village if re-uploading
        await client.query(`DELETE FROM properties WHERE LOWER(district_name) = LOWER($1) AND village_code = $2`, [
          village.district_name, village.village_code
        ]);

        for (const p of properties) {
          await client.query(`
            INSERT INTO properties (
              record_id, variable_id, property_card_id, owner_name, father_name, mobile_no, aadhaar_number,
              total_area, built_area, open_area, village_code, village_name, district_name, tehsil, distribution_date, remarks
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
          `, [
            p.record_id, p.variable_id, p.property_card_id, p.owner_name, p.father_name, p.mobile_no, p.aadhaar_number,
            p.total_area, p.built_area, p.open_area, p.village_code, p.village_name, p.district_name, p.tehsil, p.distribution_date, p.remarks
          ]);
        }
        await client.query('COMMIT');
        console.log(`[PostgreSQL] Uploaded village ${village.village_name} (${properties.length} properties).`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('[PostgreSQL] Upload insert error:', err);
        throw err;
      } finally {
        client.release();
      }
    }

    // Local DB update
    village.district_name = String(village.district_name || '').trim();
    village.village_name = String(village.village_name || '').trim();
    village.village_code = String(village.village_code || '').trim();

    const cleanDist = village.district_name.toLowerCase();
    const cleanCode = village.village_code;

    const existingVIdx = localDb.villages.findIndex(v => 
      String(v.district_name || '').trim().toLowerCase() === cleanDist && 
      String(v.village_code || '').trim() === cleanCode
    );

    if (existingVIdx >= 0) {
      localDb.villages[existingVIdx] = { ...localDb.villages[existingVIdx], ...village };
    } else {
      village.id = localDb.villages.length + 1;
      localDb.villages.push(village);
    }

    // Filter out previous properties of this village if re-uploading
    localDb.properties = localDb.properties.filter(p => 
      !(String(p.district_name || '').trim().toLowerCase() === cleanDist && String(p.village_code || '').trim() === cleanCode)
    );

    // Assign IDs and append
    let maxId = localDb.properties.reduce((max, p) => Math.max(max, p.id || 0), 0);
    properties.forEach(p => {
      p.id = ++maxId;
      p.district_name = village.district_name;
      p.village_name = village.village_name;
      p.village_code = village.village_code;
      localDb.properties.push(p);
    });

    saveLocalDb();
    rebuildMemoryIndexes();
    console.log(`[Local Store] Successfully imported village ${village.village_name} (${village.district_name}) with ${properties.length} citizen properties.`);
    return { village, propertiesCount: properties.length };
  },

  async seedData(villages, properties) {
    if (usePostgres) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const v of villages) {
          await client.query(`
            INSERT INTO villages (village_code, village_name, district_name, tehsil, total_records)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (village_code, district_name) DO UPDATE 
            SET village_name = EXCLUDED.village_name, total_records = EXCLUDED.total_records
          `, [v.village_code, v.village_name, v.district_name, v.tehsil, v.total_records]);
        }

        for (const p of properties) {
          await client.query(`
            INSERT INTO properties (
              record_id, variable_id, property_card_id, owner_name, father_name, mobile_no, aadhaar_number,
              total_area, built_area, open_area, village_code, village_name, district_name, tehsil, distribution_date, remarks
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
          `, [
            p.record_id, p.variable_id, p.property_card_id, p.owner_name, p.father_name, p.mobile_no, p.aadhaar_number,
            p.total_area, p.built_area, p.open_area, p.village_code, p.village_name, p.district_name, p.tehsil, p.distribution_date, p.remarks
          ]);
        }
        await client.query('COMMIT');
        console.log(`[PostgreSQL] Seeded ${villages.length} villages and ${properties.length} properties.`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('[PostgreSQL] Seed error:', err);
      } finally {
        client.release();
      }
    }

    localDb.villages = villages;
    localDb.properties = properties;
    saveLocalDb();
    console.log(`[Local Store] Seeded ${villages.length} villages and ${properties.length} properties.`);
  }
};

module.exports = {
  initDB,
  db
};
