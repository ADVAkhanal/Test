require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const XLSX = require('xlsx');
const cors = require('cors');
const compression = require('compression');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS mps_datasets (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL DEFAULT 'MPS Dataset',
        uploaded_by VARCHAR(255),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS mps_months (
        id         SERIAL PRIMARY KEY,
        dataset_id INTEGER REFERENCES mps_datasets(id) ON DELETE CASCADE,
        label      VARCHAR(20) NOT NULL,
        month_idx  SMALLINT NOT NULL,
        UNIQUE(dataset_id, month_idx)
      );
      CREATE TABLE IF NOT EXISTS mps_workcenters (
        id         SERIAL PRIMARY KEY,
        dataset_id INTEGER REFERENCES mps_datasets(id) ON DELETE CASCADE,
        wc         VARCHAR(255) NOT NULL,
        type       VARCHAR(100),
        axis       VARCHAR(100),
        UNIQUE(dataset_id, wc)
      );
      CREATE TABLE IF NOT EXISTS mps_wc_months (
        id         SERIAL PRIMARY KEY,
        wc_id      INTEGER REFERENCES mps_workcenters(id) ON DELETE CASCADE,
        dataset_id INTEGER REFERENCES mps_datasets(id) ON DELETE CASCADE,
        month_idx  SMALLINT NOT NULL,
        cap        NUMERIC(12,2) DEFAULT 0,
        load       NUMERIC(12,2) DEFAULT 0,
        UNIQUE(wc_id, month_idx)
      );
      CREATE TABLE IF NOT EXISTS mps_workorders (
        id         SERIAL PRIMARY KEY,
        dataset_id INTEGER REFERENCES mps_datasets(id) ON DELETE CASCADE,
        wo         VARCHAR(100),
        part       VARCHAR(255),
        wc         VARCHAR(255),
        customer   VARCHAR(255),
        qty        VARCHAR(50),
        must_leave DATE,
        cust_due   DATE,
        status     VARCHAR(50),
        setup      NUMERIC(10,3),
        target     NUMERIC(10,3),
        total      NUMERIC(10,3)
      );
    `);
    console.log('Database tables ready');
  } finally {
    client.release();
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.originalname.match(/\.(xlsx|xls)$/i)) cb(null, true);
    else cb(new Error('Only Excel files allowed'), false);
  }
});

const MON_ORDER = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function detectMonthsFromRow(sampleRow) {
  const ecRe = /^Effective\s+Capacity[-–]\s*([A-Za-z]{3})\s+(\d{2})$/i;
  const found = [];
  Object.keys(sampleRow).forEach(k => {
    const m = k.trim().match(ecRe);
    if (m) {
      const mon = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
      const yr  = parseInt(m[2]);
      found.push({ label: `${mon} ${String(yr).padStart(2,'0')}`, mon, yr });
    }
  });
  if (!found.length) return null;
  found.sort((a, b) => a.yr !== b.yr ? a.yr - b.yr : MON_ORDER.indexOf(a.mon) - MON_ORDER.indexOf(b.mon));
  return found.map(f => f.label);
}

// Safe local-date string from a JS Date — avoids UTC timezone shift bug
// that causes dates to slip back one day when using toISOString()
function localDateStr(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseCap(wb) {
  const sn = wb.SheetNames.find(s => s.toLowerCase().includes('raw')) || wb.SheetNames[0];
  const data = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: '' });
  if (!data.length) throw new Error('Empty capacity sheet');

  const months = detectMonthsFromRow(data[0]);
  if (!months || !months.length) {
    throw new Error('Could not find any "Effective Capacity-Mon YY" columns. Check the file format.');
  }
  console.log(`Capacity: detected ${months.length} months: ${months[0]} to ${months[months.length-1]}`);

  const wcs = data.filter(r => r['Work Center']).map(r => {
    const wc = String(r['Work Center']).trim();
    const caps = {};
    months.forEach(m => {
      const col  = `Effective Capacity-${m}`;
      const col2 = `Effective Capacity\u2013${m}`; // en-dash variant
      const val =
        (r[col]  !== undefined && r[col]  !== '') ? parseFloat(r[col])  || 0 :
        (r[col2] !== undefined && r[col2] !== '') ? parseFloat(r[col2]) || 0 :
        (r[m]    !== undefined && r[m]    !== '') ? parseFloat(r[m])    || 0 : 0;
      caps[m] = val;
    });
    return { wc, type: String(r['Type'] || '').trim(), axis: String(r['Axis'] || '').trim(), caps };
  });

  return { months, wcs };
}

function parseLoad(wb, months) {
  const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', cellDates: true });
  if (!data.length) throw new Error('Empty load sheet');

  // Build period map: "Apr 26" → "2026-04"
  const pMap = {};
  months.forEach(m => {
    const parts = m.split(' ');
    const yr = 2000 + parseInt(parts[1]);
    const mn = MON_ORDER.indexOf(parts[0]) + 1;
    pMap[m] = `${yr}-${String(mn).padStart(2, '0')}`;
  });

  const loadAgg = {};
  const wos     = [];
  let skipped = 0;

  data.forEach(r => {
    const st = String(r['Status'] || '').trim();
    if (!['Active', 'Expected'].includes(st)) return;
    const wc  = String(r['Work Center'] || '').trim();
    const raw = r['WO Must Leave By'];
    if (!wc || !raw) return;

    // Parse date — use localDateStr to avoid UTC timezone shift
    let dt;
    if (raw instanceof Date) {
      dt = raw;
    } else if (typeof raw === 'number') {
      const d = XLSX.SSF.parse_date_code(raw);
      // Build date from parsed components directly — no timezone issues
      dt = new Date(d.y, d.m - 1, d.d);
    } else {
      dt = new Date(raw);
    }
    if (!dt || isNaN(dt.getTime())) return;

    // Use local year/month — NOT UTC — to match the period map
    const year   = dt.getFullYear();
    const month  = dt.getMonth() + 1; // getMonth() is local time
    const period = `${year}-${String(month).padStart(2, '0')}`;

    const lbl = Object.keys(pMap).find(k => pMap[k] === period);
    if (!lbl) { skipped++; return; }

    const setup = parseFloat(r['Set-up Time (Hrs)']) || 0;
    const tgt   = parseFloat(r['Hours:Current Target']) || 0;
    const tot   = setup + tgt;

    if (!loadAgg[wc]) loadAgg[wc] = {};
    loadAgg[wc][lbl] = (loadAgg[wc][lbl] || 0) + tot;

    // Parse cust due date safely
    const due = r['Cust. Due'];
    let dueStr = '';
    if (due instanceof Date) {
      dueStr = localDateStr(due);
    } else if (typeof due === 'number') {
      const d2 = XLSX.SSF.parse_date_code(due);
      dueStr = d2 ? `${d2.y}-${String(d2.m).padStart(2,'0')}-${String(d2.d).padStart(2,'0')}` : '';
    } else {
      dueStr = String(due || '').slice(0, 10);
    }

    wos.push({
      wo:         String(r['Work Order #'] || ''),
      part:       String(r['Part #'] || '').slice(0, 70),
      wc,
      customer:   String(r['Customer'] || ''),
      qty:        String(r['QtyOrdered'] || ''),
      must_leave: localDateStr(dt),   // ← local date, no UTC shift
      cust_due:   dueStr || null,
      status:     st,
      setup:      Math.round(setup * 100) / 100,
      target:     Math.round(tgt   * 100) / 100,
      total:      Math.round(tot   * 100) / 100,
    });
  });

  console.log(`Load: ${wos.length} WOs parsed, ${skipped} outside month range`);
  return { loadAgg, wos };
}

async function fetchDatasetById(id) {
  const ds       = await pool.query('SELECT * FROM mps_datasets WHERE id=$1', [id]);
  const months   = await pool.query('SELECT * FROM mps_months WHERE dataset_id=$1 ORDER BY month_idx', [id]);
  const wcs      = await pool.query('SELECT * FROM mps_workcenters WHERE dataset_id=$1 ORDER BY wc', [id]);
  const wcMonths = await pool.query('SELECT * FROM mps_wc_months WHERE dataset_id=$1', [id]);
  const wos      = await pool.query('SELECT * FROM mps_workorders WHERE dataset_id=$1 ORDER BY must_leave', [id]);

  const monthLabels = months.rows.map(m => m.label);
  const wcMap = {};
  wcs.rows.forEach(w => {
    wcMap[w.id] = {
      wc: w.wc, type: w.type, axis: w.axis,
      months: monthLabels.map(l => ({ label: l, cap: 0, load: 0, util: null }))
    };
  });
  wcMonths.rows.forEach(wm => {
    const wc = wcMap[wm.wc_id];
    if (!wc) return;
    const mi = months.rows.findIndex(m => m.month_idx === wm.month_idx);
    if (mi < 0) return;
    wc.months[mi].cap  = +wm.cap;
    wc.months[mi].load = +wm.load;
    wc.months[mi].util = wm.cap > 0 ? +wm.load / +wm.cap : null;
  });

  return {
    dataset: ds.rows[0],
    months:  monthLabels,
    wcs:     Object.values(wcMap),
    wos:     wos.rows.map(w => ({
      ...w,
      // Return clean YYYY-MM-DD strings — pg DATE columns come back as JS Date objects
      must_leave: w.must_leave instanceof Date ? localDateStr(w.must_leave) : String(w.must_leave || '').slice(0,10),
      cust_due:   w.cust_due   instanceof Date ? localDateStr(w.cust_due)   : String(w.cust_due  || '').slice(0,10),
    })),
  };
}

app.get('/api/datasets', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id,name,uploaded_by,created_at,updated_at FROM mps_datasets ORDER BY updated_at DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/datasets/latest/data', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM mps_datasets ORDER BY updated_at DESC LIMIT 1');
    if (!rows.length) return res.json({ dataset: null, months: [], wcs: [], wos: [] });
    res.json(await fetchDatasetById(rows[0].id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/datasets/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const check = await pool.query('SELECT id FROM mps_datasets WHERE id=$1', [id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(await fetchDatasetById(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/upload/capacity', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const { months, wcs: wcData } = parseCap(wb);

    const name = req.body.name || 'MPS Dataset';
    const dsRes = await client.query(
      'INSERT INTO mps_datasets (name, uploaded_by) VALUES ($1,$2) RETURNING id',
      [name, req.body.uploaded_by || 'anonymous']
    );
    const datasetId = dsRes.rows[0].id;

    for (let i = 0; i < months.length; i++) {
      await client.query(
        'INSERT INTO mps_months (dataset_id, label, month_idx) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [datasetId, months[i], i]
      );
    }
    for (const wc of wcData) {
      const wcRes = await client.query(
        `INSERT INTO mps_workcenters (dataset_id, wc, type, axis)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (dataset_id, wc) DO UPDATE SET type=$3, axis=$4 RETURNING id`,
        [datasetId, wc.wc, wc.type, wc.axis]
      );
      const wcId = wcRes.rows[0].id;
      for (let i = 0; i < months.length; i++) {
        await client.query(
          `INSERT INTO mps_wc_months (wc_id, dataset_id, month_idx, cap, load)
           VALUES ($1,$2,$3,$4,0)
           ON CONFLICT (wc_id, month_idx) DO UPDATE SET cap=$4`,
          [wcId, datasetId, i, wc.caps[months[i]] || 0]
        );
      }
    }
    await client.query('UPDATE mps_datasets SET updated_at=NOW() WHERE id=$1', [datasetId]);
    await client.query('COMMIT');
    res.json({ success: true, dataset_id: datasetId, wcs: wcData.length, months: months.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Capacity upload error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/api/upload/load', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wb        = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const datasetId = parseInt(req.body.dataset_id);
    if (!datasetId) return res.status(400).json({ error: 'dataset_id required' });

    const mRows       = await client.query('SELECT * FROM mps_months WHERE dataset_id=$1 ORDER BY month_idx', [datasetId]);
    const monthLabels = mRows.rows.map(m => m.label);

    const { loadAgg, wos } = parseLoad(wb, monthLabels);

    await client.query('DELETE FROM mps_workorders WHERE dataset_id=$1', [datasetId]);
    for (const wo of wos) {
      await client.query(
        `INSERT INTO mps_workorders
           (dataset_id,wo,part,wc,customer,qty,must_leave,cust_due,status,setup,target,total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [datasetId, wo.wo, wo.part, wo.wc, wo.customer, wo.qty,
         wo.must_leave, wo.cust_due || null, wo.status, wo.setup, wo.target, wo.total]
      );
    }

    const wcsRes = await client.query('SELECT id,wc FROM mps_workcenters WHERE dataset_id=$1', [datasetId]);
    for (const wc of wcsRes.rows) {
      for (let i = 0; i < monthLabels.length; i++) {
        const load = (loadAgg[wc.wc] && loadAgg[wc.wc][monthLabels[i]]) || 0;
        await client.query(
          'UPDATE mps_wc_months SET load=$1 WHERE wc_id=$2 AND month_idx=$3',
          [load, wc.id, i]
        );
      }
    }

    await client.query('UPDATE mps_datasets SET updated_at=NOW() WHERE id=$1', [datasetId]);
    await client.query('COMMIT');
    res.json({ success: true, wos: wos.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Load upload error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.delete('/api/datasets/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM mps_datasets WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

async function start() {
  try {
    await initDB();
    app.listen(PORT, () => console.log(`MPS Dashboard running on port ${PORT}`));
  } catch (err) { console.error('Failed to start:', err); process.exit(1); }
}
start();
