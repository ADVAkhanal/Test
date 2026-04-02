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

// ── PostgreSQL ──────────────────────────────────────────────────────────────
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
    console.log('✅ Database tables ready');
  } finally {
    client.release();
  }
}

// ── Multer ──────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.originalname.match(/\.(xlsx|xls)$/i)) cb(null, true);
    else cb(new Error('Only Excel files allowed'), false);
  }
});

// ── Parse helpers ────────────────────────────────────────────────────────────
const MONTHS_HORIZON = [
  'Apr 26','May 26','Jun 26','Jul 26','Aug 26','Sep 26',
  'Oct 26','Nov 26','Dec 26','Jan 27','Feb 27','Mar 27'
];

function parseCap(wb, months) {
  const sn = wb.SheetNames.find(s => s.toLowerCase().includes('raw')) || wb.SheetNames[0];
  const data = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: '' });
  if (!data.length) throw new Error('Empty capacity sheet');
  return data.filter(r => r['Work Center']).map(r => {
    const wc = String(r['Work Center']).trim();
    const caps = {};
    months.forEach(m => {
      const col = `Effective Capacity-${m}`;
      caps[m] = parseFloat(r[col]) || 0;
    });
    return { wc, type: String(r['Type'] || '').trim(), axis: String(r['Axis'] || '').trim(), caps };
  });
}

function parseLoad(wb, months) {
  const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', cellDates: true });
  if (!data.length) throw new Error('Empty load sheet');

  const pMap = {};
  months.forEach(m => {
    const pts = m.split(' ');
    const yr = 2000 + parseInt(pts[1]);
    const mn = new Date(Date.parse(pts[0] + ' 1 2000')).getMonth() + 1;
    pMap[m] = `${yr}-${String(mn).padStart(2, '0')}`;
  });

  const loadAgg = {};
  const wos = [];

  data.forEach(r => {
    const st = String(r['Status'] || '').trim();
    if (!['Active', 'Expected'].includes(st)) return;
    const wc = String(r['Work Center'] || '').trim();
    const raw = r['WO Must Leave By'];
    if (!wc || !raw) return;

    let dt;
    if (raw instanceof Date) dt = raw;
    else if (typeof raw === 'number') { const d = XLSX.SSF.parse_date_code(raw); dt = new Date(d.y, d.m - 1, d.d); }
    else dt = new Date(raw);
    if (!dt || isNaN(dt)) return;

    const period = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    const lbl = Object.keys(pMap).find(k => pMap[k] === period);
    if (!lbl) return;

    const setup = parseFloat(r['Set-up Time (Hrs)']) || 0;
    const tgt = parseFloat(r['Hours:Current Target']) || 0;
    const tot = setup + tgt;

    if (!loadAgg[wc]) loadAgg[wc] = {};
    loadAgg[wc][lbl] = (loadAgg[wc][lbl] || 0) + tot;

    const due = r['Cust. Due'];
    let dueStr = '';
    if (due instanceof Date) dueStr = due.toISOString().slice(0, 10);
    else if (typeof due === 'number') {
      const d2 = XLSX.SSF.parse_date_code(due);
      dueStr = d2 ? `${d2.y}-${String(d2.m).padStart(2, '0')}-${String(d2.d).padStart(2, '0')}` : '';
    } else dueStr = String(due || '').slice(0, 10);

    wos.push({
      wo: String(r['Work Order #'] || ''),
      part: String(r['Part #'] || '').slice(0, 70),
      wc, customer: String(r['Customer'] || ''),
      qty: String(r['QtyOrdered'] || ''),
      must_leave: dt.toISOString().slice(0, 10),
      cust_due: dueStr || null,
      status: st,
      setup: Math.round(setup * 100) / 100,
      target: Math.round(tgt * 100) / 100,
      total: Math.round(tot * 100) / 100,
    });
  });

  return { loadAgg, wos };
}

// ── ROUTES ───────────────────────────────────────────────────────────────────

// GET /api/datasets
app.get('/api/datasets', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id,name,uploaded_by,created_at,updated_at FROM mps_datasets ORDER BY updated_at DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/datasets/:id
app.get('/api/datasets/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const ds = await pool.query('SELECT * FROM mps_datasets WHERE id=$1', [id]);
    if (!ds.rows.length) return res.status(404).json({ error: 'Not found' });

    const months = await pool.query('SELECT * FROM mps_months WHERE dataset_id=$1 ORDER BY month_idx', [id]);
    const wcs = await pool.query('SELECT * FROM mps_workcenters WHERE dataset_id=$1 ORDER BY wc', [id]);
    const wcMonths = await pool.query('SELECT * FROM mps_wc_months WHERE dataset_id=$1', [id]);
    const wos = await pool.query('SELECT * FROM mps_workorders WHERE dataset_id=$1 ORDER BY must_leave', [id]);

    // Build structured response matching frontend APP shape
    const monthLabels = months.rows.map(m => m.label);
    const wcMap = {};
    wcs.rows.forEach(w => {
      wcMap[w.id] = { wc: w.wc, type: w.type, axis: w.axis, months: monthLabels.map(l => ({ label: l, cap: 0, load: 0, util: null })) };
    });
    wcMonths.rows.forEach(wm => {
      const wc = wcMap[wm.wc_id];
      if (!wc) return;
      const mi = months.rows.findIndex(m => m.month_idx === wm.month_idx);
      if (mi < 0) return;
      wc.months[mi].cap = +wm.cap;
      wc.months[mi].load = +wm.load;
      wc.months[mi].util = wm.cap > 0 ? +wm.load / +wm.cap : null;
    });

    res.json({
      dataset: ds.rows[0],
      months: monthLabels,
      wcs: Object.values(wcMap),
      wos: wos.rows.map(w => ({ ...w, must_leave: w.must_leave?.toISOString?.()?.slice(0,10) || w.must_leave, cust_due: w.cust_due?.toISOString?.()?.slice(0,10) || w.cust_due || '' })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/datasets/latest/data
app.get('/api/datasets/latest/data', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM mps_datasets ORDER BY updated_at DESC LIMIT 1');
    if (!rows.length) return res.json({ dataset: null, months: [], wcs: [], wos: [] });
    req.params = { id: rows[0].id };
    // reuse handler
    const id = rows[0].id;
    const ds = await pool.query('SELECT * FROM mps_datasets WHERE id=$1', [id]);
    const months = await pool.query('SELECT * FROM mps_months WHERE dataset_id=$1 ORDER BY month_idx', [id]);
    const wcs = await pool.query('SELECT * FROM mps_workcenters WHERE dataset_id=$1 ORDER BY wc', [id]);
    const wcMonths = await pool.query('SELECT * FROM mps_wc_months WHERE dataset_id=$1', [id]);
    const wos = await pool.query('SELECT * FROM mps_workorders WHERE dataset_id=$1 ORDER BY must_leave', [id]);

    const monthLabels = months.rows.map(m => m.label);
    const wcMap = {};
    wcs.rows.forEach(w => {
      wcMap[w.id] = { wc: w.wc, type: w.type, axis: w.axis, months: monthLabels.map(l => ({ label: l, cap: 0, load: 0, util: null })) };
    });
    wcMonths.rows.forEach(wm => {
      const wc = wcMap[wm.wc_id];
      if (!wc) return;
      const mi = months.rows.findIndex(m => m.month_idx === wm.month_idx);
      if (mi < 0) return;
      wc.months[mi].cap = +wm.cap;
      wc.months[mi].load = +wm.load;
      wc.months[mi].util = wm.cap > 0 ? +wm.load / +wm.cap : null;
    });

    res.json({
      dataset: ds.rows[0],
      months: monthLabels,
      wcs: Object.values(wcMap),
      wos: wos.rows.map(w => ({ ...w, must_leave: w.must_leave?.toISOString?.()?.slice(0,10) || w.must_leave, cust_due: w.cust_due?.toISOString?.()?.slice(0,10) || w.cust_due || '' })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/upload/capacity
app.post('/api/upload/capacity', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const months = req.body.months ? JSON.parse(req.body.months) : MONTHS_HORIZON;
    const wcData = parseCap(wb, months);
    const name = req.body.name || 'MPS Dataset';

    // Create or get dataset
    let datasetId = req.body.dataset_id ? parseInt(req.body.dataset_id) : null;
    if (!datasetId) {
      const dsRes = await client.query(
        'INSERT INTO mps_datasets (name, uploaded_by) VALUES ($1,$2) RETURNING id',
        [name, req.body.uploaded_by || 'anonymous']
      );
      datasetId = dsRes.rows[0].id;

      // Insert months
      for (let i = 0; i < months.length; i++) {
        await client.query(
          'INSERT INTO mps_months (dataset_id, label, month_idx) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [datasetId, months[i], i]
        );
      }
    }

    // Upsert work centers
    for (const wc of wcData) {
      const wcRes = await client.query(
        `INSERT INTO mps_workcenters (dataset_id, wc, type, axis)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (dataset_id, wc) DO UPDATE SET type=$3, axis=$4
         RETURNING id`,
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
    res.json({ success: true, dataset_id: datasetId, wcs: wcData.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// POST /api/upload/load
app.post('/api/upload/load', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const datasetId = parseInt(req.body.dataset_id);
    if (!datasetId) return res.status(400).json({ error: 'dataset_id required' });

    const months = await client.query('SELECT * FROM mps_months WHERE dataset_id=$1 ORDER BY month_idx', [datasetId]);
    const monthLabels = months.rows.map(m => m.label);

    const { loadAgg, wos } = parseLoad(wb, monthLabels);

    // Delete old WOs for this dataset
    await client.query('DELETE FROM mps_workorders WHERE dataset_id=$1', [datasetId]);

    // Insert new WOs
    for (const wo of wos) {
      await client.query(
        `INSERT INTO mps_workorders (dataset_id,wo,part,wc,customer,qty,must_leave,cust_due,status,setup,target,total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [datasetId, wo.wo, wo.part, wo.wc, wo.customer, wo.qty,
         wo.must_leave, wo.cust_due || null, wo.status, wo.setup, wo.target, wo.total]
      );
    }

    // Update loads on wc_months
    const wcsRes = await client.query('SELECT id,wc FROM mps_workcenters WHERE dataset_id=$1', [datasetId]);
    for (const wc of wcsRes.rows) {
      for (let i = 0; i < monthLabels.length; i++) {
        const load = (loadAgg[wc.wc] && loadAgg[wc.wc][monthLabels[i]]) || 0;
        await client.query(
          `UPDATE mps_wc_months SET load=$1 WHERE wc_id=$2 AND month_idx=$3`,
          [load, wc.id, i]
        );
      }
    }

    // Recalc util
    await client.query(
      `UPDATE mps_wc_months SET load=0 WHERE dataset_id=$1 AND wc_id NOT IN (SELECT id FROM mps_workcenters WHERE dataset_id=$1)`,
      [datasetId]
    );

    await client.query('UPDATE mps_datasets SET updated_at=NOW() WHERE id=$1', [datasetId]);
    await client.query('COMMIT');
    res.json({ success: true, wos: wos.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// DELETE /api/datasets/:id
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
    app.listen(PORT, () => console.log(`🚀 MPS Dashboard running on port ${PORT}`));
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}
start();
