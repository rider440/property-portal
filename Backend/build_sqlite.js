const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const srcDir = path.join(__dirname, 'data', 'districts');
const outDir = path.join(__dirname, 'data', 'sqlite');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

if (!fs.existsSync(srcDir)) {
  console.log('[Build SQLite] No districts directory found, skipping.');
  process.exit(0);
}

// Only take unique district names (avoid processing both .json and .json.gz)
const rawFiles = fs.readdirSync(srcDir);
const districtMap = new Map();

for (const f of rawFiles) {
  if (f.endsWith('.json.gz')) {
    const clean = f.replace('.json.gz', '');
    districtMap.set(clean, f);
  } else if (f.endsWith('.json')) {
    const clean = f.replace('.json', '');
    if (!districtMap.has(clean)) {
      districtMap.set(clean, f);
    }
  }
}

const entries = Array.from(districtMap.entries());
console.log(`[Build SQLite] Processing ${entries.length} districts for SQLite indexing...`);

let done = 0;
for (const [cleanName, file] of entries) {
  const outPath = path.join(outDir, `${cleanName}.sqlite`);

  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
    done++;
    continue;
  }

  const srcPath = path.join(srcDir, file);
  const isGz = file.endsWith('.json.gz');

  try {
    let raw = isGz ? zlib.gunzipSync(fs.readFileSync(srcPath)).toString('utf8') : fs.readFileSync(srcPath, 'utf8');
    let arr = JSON.parse(raw);
    raw = null; // Free string memory immediately

    const db = new Database(outPath);
    db.exec('PRAGMA synchronous = OFF; PRAGMA journal_mode = OFF; PRAGMA cache_size = 1000;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS properties (
        id TEXT,
        record_id TEXT,
        variable_id TEXT,
        property_card_id TEXT,
        owner_name TEXT,
        father_name TEXT,
        mobile_no TEXT,
        total_area TEXT,
        built_area TEXT,
        open_area TEXT,
        village_code TEXT,
        village_name TEXT,
        district_name TEXT,
        tehsil TEXT,
        distribution_date TEXT,
        remarks TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_vcode ON properties(village_code);
      CREATE INDEX IF NOT EXISTS idx_owner ON properties(owner_name);
      CREATE INDEX IF NOT EXISTS idx_var ON properties(variable_id);
    `);

    const insert = db.prepare(`
      INSERT INTO properties VALUES (
        @id, @record_id, @variable_id, @property_card_id, @owner_name, @father_name,
        @mobile_no, @total_area, @built_area, @open_area, @village_code, @village_name,
        @district_name, @tehsil, @distribution_date, @remarks
      )
    `);

    const insertMany = db.transaction((rows) => {
      for (let i = 0; i < rows.length; i++) {
        insert.run(rows[i]);
      }
    });

    insertMany(arr);
    arr = null; // Free array memory immediately
    db.close();

    if (global.gc) {
      global.gc();
    }

    done++;
    if (done % 10 === 0 || done === entries.length) {
      console.log(`[Build SQLite] Processed ${done}/${entries.length} districts.`);
    }
  } catch (err) {
    console.error(`[Build SQLite] Error building ${cleanName}:`, err);
  }
}

console.log('[Build SQLite] All district databases ready!');
