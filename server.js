require('dotenv').config();
const express  = require('express');
const path     = require('path');
const multer   = require('multer');
const XLSX     = require('xlsx');
const { Pool } = require('pg');

const app    = express();
const PORT   = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── DATABASE ───────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mps_datasets (
      id          BIGSERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      uploaded_by TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mps_capacity (
      id         BIGSERIAL PRIMARY KEY,
      dataset_id BIGINT REFERENCES mps_datasets(id) ON DELETE CASCADE,
      wc         TEXT NOT NULL,
      type       TEXT,
      axis       TEXT,
      month      TEXT NOT NULL,
      cap        NUMERIC DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS mps_workorders (
      id          BIGSERIAL PRIMARY KEY,
      dataset_id  BIGINT REFERENCES mps_datasets(id) ON DELETE CASCADE,
      wo          TEXT,
      part        TEXT,
      wc          TEXT,
      customer    TEXT,
      qty         NUMERIC DEFAULT 0,
      must_leave  TEXT,
      cust_due    TEXT,
      status      TEXT,
      setup       NUMERIC DEFAULT 0,
      target      NUMERIC DEFAULT 0
    );
  `);
  console.log('✅ MPS tables ready');
}

// ── MIDDLEWARE ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── HELPERS ────────────────────────────────────────────────────────────────

// Parse an Excel serial date number or date string → "YYYY-MM-DD"
function parseExcelDate(val) {
  if (!val) return null;
  if (typeof val === 'number') {
    // Excel date serial: days since 1899-12-30
    const d = new Date(Math.round((val - 25569) * 86400 * 1000));
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return null;
    // Try parsing common date formats
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return trimmed; // fallback: return as-is
  }
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  return null;
}

// Parse month label like "Jan 26" → index in months array
// Returns the label exactly as stored so we can match it back
function normalizeMonthLabel(raw) {
  if (!raw) return null;
  // Strip "Effective Capacity-" prefix if present
  const s = String(raw).replace(/^Effective Capacity[-\s]*/i, '').trim();
  // Expect "Mon YY" e.g. "Jan 26"
  const match = s.match(/^([A-Za-z]{3})\s*(\d{2})$/);
  if (!match) return null;
  return `${match[1].charAt(0).toUpperCase()}${match[1].slice(1).toLowerCase()} ${match[2]}`;
}

// Get or find a column by fuzzy name match (case-insensitive, partial)
function findCol(headers, ...candidates) {
  for (const c of candidates) {
    const lc = c.toLowerCase();
    const found = headers.find(h => String(h).toLowerCase().includes(lc));
    if (found !== undefined) return found;
  }
  return null;
}

// ── API: DATASETS ──────────────────────────────────────────────────────────

// GET /api/datasets — list all datasets
app.get('/api/datasets', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, uploaded_by, created_at, updated_at FROM mps_datasets ORDER BY updated_at DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/datasets/latest/data — load the most recent dataset
app.get('/api/datasets/latest/data', async (req, res) => {
  try {
    const { rows: ds } = await pool.query(
      'SELECT * FROM mps_datasets ORDER BY updated_at DESC LIMIT 1'
    );
    if (!ds.length) return res.json({ dataset: null, months: [], wcs: [], wos: [] });
    const dataset = ds[0];
    const data = await loadDatasetData(dataset.id);
    res.json({ dataset, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/datasets/:id — load a specific dataset
app.get('/api/datasets/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rows: ds } = await pool.query('SELECT * FROM mps_datasets WHERE id=$1', [id]);
    if (!ds.length) return res.status(404).json({ error: 'Dataset not found' });
    const data = await loadDatasetData(id);
    res.json({ dataset: ds[0], ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/datasets/:id
app.delete('/api/datasets/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rowCount } = await pool.query('DELETE FROM mps_datasets WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DATASET DATA LOADER ────────────────────────────────────────────────────
async function loadDatasetData(datasetId) {
  // Load all capacity rows for this dataset
  const { rows: capRows } = await pool.query(
    'SELECT wc, type, axis, month, cap FROM mps_capacity WHERE dataset_id=$1 ORDER BY wc, month',
    [datasetId]
  );

  // Build month list (ordered)
  const monthSet = new Set();
  capRows.forEach(r => monthSet.add(r.month));

  // We need months in chronological order (Jan 26, Feb 26 ... Dec 27)
  const MONTH_ORDER = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const months = [...monthSet].sort((a, b) => {
    const [am, ay] = a.split(' ');
    const [bm, by] = b.split(' ');
    if (ay !== by) return parseInt(ay) - parseInt(by);
    return MONTH_ORDER.indexOf(am) - MONTH_ORDER.indexOf(bm);
  });

  // Build WC map: { wc → { wc, type, axis, months: [{label, cap, load, util}] } }
  const wcMap = {};
  capRows.forEach(r => {
    if (!wcMap[r.wc]) {
      wcMap[r.wc] = {
        wc: r.wc,
        type: r.type || '',
        axis: r.axis || '',
        months: months.map(m => ({ label: m, cap: 0, load: 0, util: null }))
      };
    }
    const mi = months.indexOf(r.month);
    if (mi >= 0) {
      wcMap[r.wc].months[mi].cap = parseFloat(r.cap) || 0;
    }
  });

  // Load work orders
  const { rows: woRows } = await pool.query(
    `SELECT wo, part, wc, customer, qty, must_leave, cust_due, status, setup, target
     FROM mps_workorders WHERE dataset_id=$1 ORDER BY must_leave`,
    [datasetId]
  );

  // Distribute WO load hours into WC month slots
  // Match WO must_leave date to month label
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  woRows.forEach(wo => {
    const ml = wo.must_leave || '';
    if (!ml) return;
    const dt = new Date(ml + 'T12:00:00');
    if (isNaN(dt.getTime())) return;
    const yr = String(dt.getFullYear()).slice(2); // "26"
    const mo = MONTH_NAMES[dt.getMonth()];       // "Jan"
    const label = `${mo} ${yr}`;
    const mi = months.indexOf(label);
    if (mi < 0) return;

    const wcKey = wo.wc;
    if (!wcMap[wcKey]) return; // WO references a WC not in capacity file — skip

    const hrs = (parseFloat(wo.setup) || 0) + (parseFloat(wo.target) || 0);
    wcMap[wcKey].months[mi].load += hrs;
  });

  // Calculate utilization
  Object.values(wcMap).forEach(wc => {
    wc.months.forEach(m => {
      m.util = m.cap > 0 ? m.load / m.cap : null;
    });
  });

  // Build WOs array for the frontend
  const wos = woRows.map(w => ({
    wo:         w.wo || '',
    part:       w.part || '',
    wc:         w.wc || '',
    customer:   w.customer || '',
    qty:        parseFloat(w.qty) || 0,
    must_leave: w.must_leave || '',
    cust_due:   w.cust_due || '',
    status:     w.status || '',
    setup:      parseFloat(w.setup) || 0,
    target:     parseFloat(w.target) || 0,
    total:      (parseFloat(w.setup) || 0) + (parseFloat(w.target) || 0),
  }));

  return {
    months,
    wcs: Object.values(wcMap),
    wos,
  };
}

// ── API: UPLOAD CAPACITY FILE ──────────────────────────────────────────────
app.post('/api/upload/capacity', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const name        = req.body.name || `MPS – ${new Date().toLocaleDateString()}`;
  const uploaded_by = req.body.uploaded_by || 'user';

  try {
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });

    // Find "Raw Data" sheet (case-insensitive)
    const sheetName = wb.SheetNames.find(n => n.toLowerCase().replace(/\s/g,'') === 'rawdata')
                   || wb.SheetNames[0];
    const ws   = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });

    if (!rows.length) return res.status(400).json({ error: 'Sheet is empty' });

    const headers = Object.keys(rows[0]);

    // Detect WC / Type / Axis columns
    const wcCol   = findCol(headers, 'work center', 'workcenter', 'wc');
    const typeCol = findCol(headers, 'type', 'machine type');
    const axisCol = findCol(headers, 'axis');

    if (!wcCol) return res.status(400).json({ error: 'Could not find "Work Center" column' });

    // Detect month columns: "Effective Capacity-Jan 26" or "Jan 26" etc.
    const monthCols = headers.filter(h => normalizeMonthLabel(h) !== null);
    if (!monthCols.length) return res.status(400).json({ error: 'No month columns found (expected "Effective Capacity-Jan 26" format)' });

    // Create dataset record
    const { rows: [dataset] } = await pool.query(
      'INSERT INTO mps_datasets (name, uploaded_by) VALUES ($1,$2) RETURNING *',
      [name, uploaded_by]
    );
    const datasetId = dataset.id;

    // Insert capacity rows
    let wcCount = 0;
    for (const row of rows) {
      const wcVal = row[wcCol];
      if (!wcVal || String(wcVal).trim() === '') continue;
      const wc   = String(wcVal).trim();
      const type = typeCol ? (String(row[typeCol] || '').trim()) : '';
      const axis = axisCol ? (String(row[axisCol] || '').trim()) : '';

      for (const col of monthCols) {
        const monthLabel = normalizeMonthLabel(col);
        if (!monthLabel) continue;
        const cap = parseFloat(row[col]) || 0;
        await pool.query(
          'INSERT INTO mps_capacity (dataset_id, wc, type, axis, month, cap) VALUES ($1,$2,$3,$4,$5,$6)',
          [datasetId, wc, type, axis, monthLabel, cap]
        );
      }
      wcCount++;
    }

    // Update dataset timestamp
    await pool.query('UPDATE mps_datasets SET updated_at=NOW() WHERE id=$1', [datasetId]);

    res.json({ ok: true, dataset_id: datasetId, wcs: wcCount, months: monthCols.length });
  } catch (err) {
    console.error('Capacity upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: UPLOAD LOAD HOURS FILE ────────────────────────────────────────────
app.post('/api/upload/load', upload.single('file'), async (req, res) => {
  if (!req.file)          return res.status(400).json({ error: 'No file uploaded' });
  const datasetId = Number(req.body.dataset_id);
  if (!datasetId)         return res.status(400).json({ error: 'dataset_id required' });

  try {
    // Verify dataset exists
    const { rows: ds } = await pool.query('SELECT id FROM mps_datasets WHERE id=$1', [datasetId]);
    if (!ds.length)       return res.status(404).json({ error: 'Dataset not found' });

    const wb   = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });

    // Use first sheet
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
    if (!rows.length) return res.status(400).json({ error: 'File is empty' });

    const headers = Object.keys(rows[0]);

    // Find required columns (flexible matching)
    const woCol      = findCol(headers, 'work order #', 'work order', 'wo #', 'wo#', 'wo');
    const partCol    = findCol(headers, 'part number', 'part no', 'part#', 'part');
    const wcCol      = findCol(headers, 'work center', 'workcenter', 'wc');
    const custCol    = findCol(headers, 'customer', 'cust');
    const qtyCol     = findCol(headers, 'qty', 'quantity');
    const leaveCol   = findCol(headers, 'wo must leave', 'must leave', 'leave by', 'leave');
    const custDueCol = findCol(headers, 'customer due', 'cust due', 'due date', 'cust_due');
    const statusCol  = findCol(headers, 'status');
    const setupCol   = findCol(headers, 'set-up time', 'setup time', 'setup', 'set up');
    const targetCol  = findCol(headers, 'hours:current target', 'current target', 'target hours', 'target');

    if (!woCol)     return res.status(400).json({ error: 'Could not find "Work Order #" column' });
    if (!wcCol)     return res.status(400).json({ error: 'Could not find "Work Center" column' });
    if (!leaveCol)  return res.status(400).json({ error: 'Could not find "WO Must Leave By" column' });

    // Delete existing WOs for this dataset before re-inserting
    await pool.query('DELETE FROM mps_workorders WHERE dataset_id=$1', [datasetId]);

    let woCount = 0;
    for (const row of rows) {
      const woVal = row[woCol];
      if (!woVal || String(woVal).trim() === '') continue;

      const leaveRaw = row[leaveCol];
      const leaveDate = parseExcelDate(leaveRaw);
      if (!leaveDate) continue; // skip rows with no valid date

      const custDueRaw = custDueCol ? row[custDueCol] : null;

      await pool.query(
        `INSERT INTO mps_workorders
           (dataset_id, wo, part, wc, customer, qty, must_leave, cust_due, status, setup, target)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          datasetId,
          String(woVal).trim(),
          partCol    ? String(row[partCol]    || '').trim() : '',
          wcCol      ? String(row[wcCol]      || '').trim() : '',
          custCol    ? String(row[custCol]    || '').trim() : '',
          qtyCol     ? parseFloat(row[qtyCol])    || 0 : 0,
          leaveDate,
          custDueRaw ? parseExcelDate(custDueRaw) : null,
          statusCol  ? String(row[statusCol]  || '').trim() : '',
          setupCol   ? parseFloat(row[setupCol])   || 0 : 0,
          targetCol  ? parseFloat(row[targetCol])  || 0 : 0,
        ]
      );
      woCount++;
    }

    // Update dataset timestamp
    await pool.query('UPDATE mps_datasets SET updated_at=NOW() WHERE id=$1', [datasetId]);

    res.json({ ok: true, wos: woCount });
  } catch (err) {
    console.error('Load upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── HEALTH ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ── CATCH-ALL → SPA ────────────────────────────────────────────────────────
// Must come LAST — after all /api routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ──────────────────────────────────────────────────────────────────
async function start() {
  try {
    await initDB();
    app.listen(PORT, () => console.log(`🚀 MPS Dashboard running on port ${PORT}`));
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}
start();
