const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { initDB, db } = require('./db');

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

async function importAllExcelFiles() {
  await initDB();
  const excelBaseDir = path.join(__dirname, '..', '..', 'excel villages');
  console.log('Reading Excel files recursively from:', excelBaseDir);

  if (!fs.existsSync(excelBaseDir)) {
    console.error('Directory does not exist:', excelBaseDir);
    return;
  }

  function findExcelFiles(baseDir) {
    const results = [];
    function walk(currentDir) {
      const items = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(currentDir, item.name);
        if (item.isDirectory()) {
          walk(fullPath);
        } else if (item.name.endsWith('.xlsx') && !item.name.startsWith('~$') && !item.name.includes('Total') && !item.name.includes('Summary') && !item.name.includes('List')) {
          results.push(fullPath);
        }
      }
    }
    walk(baseDir);
    return results;
  }

  const allFiles = findExcelFiles(excelBaseDir);
  console.log(`Found ${allFiles.length} Excel village data files to process.`);

  const allVillagesMap = new Map();
  const allProperties = [];
  let propIdCounter = 1;

  for (const filePath of allFiles) {
    const rel = path.relative(excelBaseDir, filePath);
    const parts = rel.split(path.sep);
    const fileName = parts[parts.length - 1];

    let stateName = 'Uttar Pradesh';
    let districtName = 'Uttar Pradesh';

    if (parts.length >= 3) {
      stateName = parts[0];
      districtName = parts[1];
    } else if (parts.length === 2) {
      districtName = parts[0];
    }

    if (districtName.toLowerCase() === 'prayagraj') {
      districtName = 'Prayagraj';
    } else {
      districtName = districtName.replace(/\b\w/g, c => c.toUpperCase());
    }

    console.log(`Processing [${stateName} / ${districtName}] ${fileName}...`);

    try {
      const wb = xlsx.readFile(filePath);
      const sheetName = wb.SheetNames[0];
      const rows = xlsx.utils.sheet_to_json(wb.Sheets[sheetName]);

      if (!rows || rows.length === 0) continue;

      // Parse village name and code from filename or row
      const baseName = path.parse(fileName).name;
      let vName = baseName;
      let vCode = '';

      const codeMatch = baseName.match(/^(.*?)\s+(\d+)$/);
      if (codeMatch) {
        vName = codeMatch[1].trim();
        vCode = codeMatch[2].trim();
      } else {
        vName = baseName.replace(/_decoded/gi, '').trim();
      }

      if (!vCode && rows[0].villageCode) {
        vCode = String(rows[0].villageCode);
      }
      if (!vName && rows[0].villageName) {
        vName = String(rows[0].villageName);
      }

      const tehsil = rows[0].tehsil ? String(rows[0].tehsil) : '';
      const villageKey = `${stateName}__${districtName}__${vCode || vName}`;

      let citizenCount = 0;

      for (const row of rows) {
        const ownerName = String(row.nameOfWwner || row.owner_name || row['भूस्वामी का नाम'] || row.Name || '').trim();
        const fatherName = String(row.fatherName || row.father_name || row['पिता का नाम'] || row.Father || '').trim();
        const cardId = String(row.propertyCardId || row.property_card_id || row['संपत्ति आईडी'] || row.PropertyID || '').trim();

        if (!ownerName || isPublicOrNonCitizenRecord(ownerName, fatherName)) {
          continue; // HIDE non-citizen / public land records
        }

        citizenCount++;
        allProperties.push({
          id: propIdCounter++,
          record_id: String(row.id || row.record_id || propIdCounter),
          variable_id: String(row.variable_id || row.khasra || `s${citizenCount}`),
          property_card_id: cardId || `${vCode}${String(citizenCount).padStart(4, '0')}`,
          owner_name: ownerName,
          father_name: fatherName,
          mobile_no: String(row.mobileNo || row.mobile_no || '--'),
          aadhaar_number: String(row.aadhaarNumber || row.aadhaar_number || '0'),
          total_area: parseFloat(row.totalArea || row.total_area || 0) || 0,
          built_area: parseFloat(row.builtArea || row.built_area || 0) || 0,
          open_area: parseFloat(row.openArea || row.open_area || 0) || 0,
          village_code: vCode || String(row.villageCode || 'N/A'),
          village_name: vName,
          district_name: districtName,
          state_name: stateName,
          tehsil: tehsil,
          distribution_date: String(row.distributionDate || row.distribution_date || ''),
          remarks: String(row.remarks || row.Remarks || '')
        });
      }

      if (!allVillagesMap.has(villageKey)) {
        allVillagesMap.set(villageKey, {
          id: allVillagesMap.size + 1,
          village_code: vCode || 'N/A',
          village_name: vName,
          district_name: districtName,
          state_name: stateName,
          tehsil: tehsil,
          total_records: citizenCount
        });
      } else {
        allVillagesMap.get(villageKey).total_records += citizenCount;
      }

    } catch (err) {
      console.error(`Error reading ${filePath}:`, err.message);
    }
  }

  const villageList = Array.from(allVillagesMap.values());
  console.log(`\nFound ${villageList.length} unique villages and ${allProperties.length} total citizen property records.`);

  await db.seedData(villageList, allProperties);
  console.log('Import completed successfully with public land filtered out!');
}

function decodeUnicodeEscapes(text) {
  if (!text) return '';
  return String(text).replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
}

function parseDwrVal(valStr) {
  if (!valStr) return '';
  valStr = valStr.trim();
  if ((valStr.startsWith('"') && valStr.endsWith('"')) || (valStr.startsWith("'") && valStr.endsWith("'"))) {
    return decodeUnicodeEscapes(valStr.slice(1, -1));
  } else if (valStr.startsWith('new Date(')) {
    const m = valStr.match(/new Date\((\d+)\)/);
    if (m) {
      return new Date(parseInt(m[1], 10)).toISOString().replace('T', ' ').slice(0, 19);
    }
    return valStr;
  } else if (valStr === 'true') {
    return true;
  } else if (valStr === 'false') {
    return false;
  } else if (valStr === 'null') {
    return null;
  } else if (!isNaN(Number(valStr)) && valStr !== '') {
    return Number(valStr);
  }
  return decodeUnicodeEscapes(valStr);
}

function parseDwrText(text) {
  const objects = {};
  const lines = text.split(/\r?\n/);
  const assignmentPattern = /^(s\d+)\.(\w+)\s*=\s*(.*);$/;

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(assignmentPattern);
    if (match) {
      const objName = match[1];
      const fieldName = match[2];
      const rawVal = match[3];

      if (!objects[objName]) objects[objName] = {};
      objects[objName][fieldName] = parseDwrVal(rawVal);
    }
  }

  const keys = Object.keys(objects);
  if (keys.length === 0) return [];

  keys.sort((a, b) => {
    const numA = parseInt(a.replace('s', ''), 10) || 0;
    const numB = parseInt(b.replace('s', ''), 10) || 0;
    return numA - numB;
  });

  return keys.map(k => objects[k]);
}

async function parseAndImportUploadedFile(fileBuffer, originalname, overrides = {}) {
  await initDB();

  let rows = [];
  const ext = path.extname(originalname).toLowerCase();
  const baseName = path.parse(originalname).name;

  if (ext === '.xlsx' || ext === '.xls') {
    const wb = xlsx.read(fileBuffer, { type: 'buffer' });
    const sheetName = wb.SheetNames[0];
    rows = xlsx.utils.sheet_to_json(wb.Sheets[sheetName]);
  } else {
    const str = fileBuffer.toString('utf8');
    // 1. Try DWR script parsing first if contains DWR or s0.
    if (str.includes('//#DWR') || str.includes('allowScriptTagRemoting') || /^s\d+\./m.test(str)) {
      rows = parseDwrText(str);
    }
    
    // 2. Try JSON parse
    if (!rows || rows.length === 0) {
      try {
        const parsed = JSON.parse(str);
        rows = Array.isArray(parsed) ? parsed : [parsed];
      } catch (e) {}
    }

    // 3. Try CSV / TSV parse
    if (!rows || rows.length === 0) {
      const lines = str.split(/\r?\n/).filter(l => l.trim().length > 0);
      if (lines.length > 1) {
        const delimiter = lines[0].includes('\t') ? '\t' : ',';
        const header = lines[0].split(delimiter).map(h => h.trim().replace(/^["']|["']$/g, ''));
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].split(delimiter);
          const obj = {};
          header.forEach((h, idx) => {
            let v = parts[idx] ? parts[idx].trim().replace(/^["']|["']$/g, '') : '';
            obj[h] = decodeUnicodeEscapes(v);
          });
          rows.push(obj);
        }
      }
    }
  }

  if (!rows || rows.length === 0) {
    throw new Error('फ़ाइल में कोई मान्य डेटा पंक्तियाँ (rows) नहीं मिलीं।');
  }

  // Determine State, District, Village Name, Village Code, Tehsil
  let stateName = (overrides.state_name || '').trim();
  let districtName = (overrides.district_name || '').trim();
  let vName = (overrides.village_name || '').trim();
  let vCode = (overrides.village_code || '').trim();
  let tehsil = (overrides.tehsil_name || '').trim();

  // Try parsing from filename if not overridden
  if (!vName || !vCode) {
    const codeMatch = baseName.match(/^(.*?)\s+(\d+)$/);
    if (codeMatch) {
      if (!vName) vName = codeMatch[1].trim();
      if (!vCode) vCode = codeMatch[2].trim();
    } else {
      if (!vName) vName = baseName.replace(/_decoded/gi, '').trim();
    }
  }

  // Inspect first non-empty row
  const firstRow = rows.find(r => r && (r.villageCode || r.nameOfWwner || r.owner_name)) || rows[0] || {};
  if (!stateName) {
    stateName = firstRow.state_name || firstRow.state || 'Uttar Pradesh';
  }
  if (!districtName) {
    districtName = firstRow.district_name || firstRow.district || 'Uttar Pradesh';
  }
  if (!vCode && (firstRow.villageCode || firstRow.village_code)) {
    vCode = String(firstRow.villageCode || firstRow.village_code).trim();
  }
  if (!vName && (firstRow.villageName || firstRow.village_name)) {
    vName = String(firstRow.villageName || firstRow.village_name).trim();
  }
  if (!tehsil && (firstRow.tehsil || firstRow.tehsil_name)) {
    tehsil = String(firstRow.tehsil || firstRow.tehsil_name).trim();
  }

  if (!stateName) stateName = 'Uttar Pradesh';
  if (!districtName) districtName = 'Uttar Pradesh';
  if (!vName) vName = 'अज्ञात ग्राम';
  if (!vCode) vCode = 'V-' + Math.floor(100000 + Math.random() * 900000);

  const cleanProperties = [];
  let skippedPublicCount = 0;

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    if (!row) continue;

    const ownerName = String(row.nameOfWwner || row.owner_name || row['भूस्वामी का नाम'] || row.Name || row.name || '').trim();
    const fatherName = String(row.fatherName || row.father_name || row['पिता का नाम'] || row.Father || '').trim();
    const cardId = String(row.propertyCardId || row.property_card_id || row['संपत्ति आईडी'] || row.PropertyID || '').trim() ||
                   `${vCode}${String(idx + 1).padStart(4, '0')}`;

    if (!ownerName || isPublicOrNonCitizenRecord(ownerName, fatherName)) {
      skippedPublicCount++;
      continue; // Filter out public land records
    }

    cleanProperties.push({
      record_id: String(row.id || row.record_id || (cleanProperties.length + 1)),
      variable_id: String(row.variable_id || row.khasra || `s${idx + 1}`),
      property_card_id: cardId,
      owner_name: ownerName,
      father_name: fatherName || '--',
      mobile_no: String(row.mobileNo || row.mobile_no || row.Mobile || '--'),
      aadhaar_number: String(row.aadhaarNumber || row.aadhaar_number || '0'),
      total_area: parseFloat(row.totalArea || row.total_area || row['कुल क्षेत्रफल'] || 0) || 0,
      built_area: parseFloat(row.builtArea || row.built_area || row['निर्मित क्षेत्रफल'] || 0) || 0,
      open_area: parseFloat(row.openArea || row.open_area || row['खुला क्षेत्रफल'] || 0) || 0,
      village_code: vCode,
      village_name: vName,
      district_name: districtName,
      state_name: stateName,
      tehsil: tehsil,
      distribution_date: String(row.distributionDate || row.distribution_date || ''),
      remarks: String(row.remarks || row.Remarks || 'Uploaded via RiderAdmin')
    });
  }

  const villageObj = {
    village_code: vCode,
    village_name: vName,
    district_name: districtName,
    state_name: stateName,
    tehsil: tehsil,
    total_records: cleanProperties.length
  };

  const result = await db.insertVillageAndProperties(villageObj, cleanProperties);

  return {
    success: true,
    stateName: stateName,
    villageName: vName,
    villageCode: vCode,
    districtName: districtName,
    tehsil: tehsil,
    totalRows: rows.length,
    validPropertiesCount: cleanProperties.length,
    skippedPublicCount: skippedPublicCount,
    message: `ग्राम '${vName}' (${districtName}, ${stateName}) के ${cleanProperties.length} संपत्ति रिकॉर्ड्स सफलतापूर्वक डेटाबेस में सेव व लाइव कर दिए गए हैं। (${skippedPublicCount} गैर-नागरिक/रास्ता रिकॉर्ड्स स्वतः हटा दिए गए)`
  };
}

if (require.main === module) {
  importAllExcelFiles().then(() => {
    process.exit(0);
  }).catch(err => {
    console.error('Fatal import error:', err);
    process.exit(1);
  });
}

module.exports = { 
  importAllExcelFiles, 
  parseAndImportUploadedFile, 
  isPublicOrNonCitizenRecord 
};

