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

const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.json.gz') || f.endsWith('.json'));
console.log(`[Build SQLite] Converting ${files.length} districts to high-speed SQLite indexes...`);

let done = 0;
for (const file of files) {
  const isGz = file.endsWith('.json.gz');
  const cleanName = file.replace(/\.json\.gz$/, '').replace(/\.json$/, '');
  const outPath = path.join(outDir, `${cleanName}.sqlite`);

  if (fs.existsSync(outPath)) {
    done++;
    continue;
  }

  const srcPath = path.join(srcDir, file);
  try {
    let raw = '';
    if (isGz) {
      raw = zlib.gunzipSync(fs.readFileSync(srcPath)).toString('utf8');
    } else {
      raw = fs.readFileSync(srcPath, 'utf8');
    }

    const arr = JSON.parse(raw);
    const db = new Database(outPath);
    db.exec('PRAGMA synchronous = OFF; PRAGMA journal_mode = OFF; PRAGMA cache_size = 2000;');
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
    db.close();
    done++;
    if (done % 10 === 0 || done === files.length) {
      console.log(`[Build SQLite] Processed ${done}/${files.length} districts.`);
    }
  } catch (err) {
    console.error(`[Build SQLite] Error building ${cleanName}:`, err);
  }
}

console.log('[Build SQLite] All district databases built successfully!');
