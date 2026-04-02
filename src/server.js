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

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// ── PostgreSQL ──────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

// ── Init DB ─────────────────────────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS kpi_datasets (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL DEFAULT 'FY Dataset',
        fiscal_year VARCHAR(10)  NOT NULL DEFAULT '2026',
        uploaded_by VARCHAR(255),
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS kpi_months (
        id         SERIAL PRIMARY KEY,
        dataset_id INTEGER REFERENCES kpi_datasets(id) ON DELETE CASCADE,
        month      VARCHAR(10)  NOT NULL,
        month_idx  SMALLINT     NOT NULL,
        target     NUMERIC(15,2),
        backlog    NUMERIC(15,2),
        deficit    NUMERIC(15,2),
        actual     NUMERIC(15,2),
        dir_pay    NUMERIC(15,2),
        ind_pay    NUMERIC(15,2),
        tgt_pay    NUMERIC(15,2),
        tot_pay    NUMERIC(15,2),
        tgt_net    NUMERIC(15,2),
        act_net    NUMERIC(15,2),
        tgt_mat    NUMERIC(15,2),
        mat        NUMERIC(15,2),
        tgt_tool   NUMERIC(15,2),
        tool       NUMERIC(15,2),
        tgt_exp    NUMERIC(15,2),
        exp        NUMERIC(15,2),
        sched_hr   NUMERIC(10,2),
        act_hr     NUMERIC(10,2),
        tgt_gp     NUMERIC(15,2),
        act_gp     NUMERIC(15,2),
        UNIQUE(dataset_id, month_idx)
      );

      CREATE TABLE IF NOT EXISTS kpi_manual_updates (
        id         SERIAL PRIMARY KEY,
        dataset_id INTEGER REFERENCES kpi_datasets(id) ON DELETE CASCADE,
        month_idx  SMALLINT     NOT NULL,
        field_name VARCHAR(50)  NOT NULL,
        old_value  NUMERIC(15,2),
        new_value  NUMERIC(15,2),
        updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_by VARCHAR(255)
      );
    `);
    console.log('✅ Database tables ready');
  } finally {
    client.release();
  }
}

// ── Multer (memory storage) ──────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.originalname.match(/\.(xlsx|xls)$/i)) cb(null, true);
    else cb(new Error('Only Excel files allowed'), false);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function parseExcelToRows(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  const parsed = [];

  rows.forEach((row, i) => {
    const keys = Object.keys(row);
    if (keys.length < 2) return;

    let monthLabel = MONTH_NAMES[i] || ('M' + (i + 1));
    let monthIdx   = i;
    const fv = row[keys[0]];

    if (fv instanceof Date) {
      monthIdx   = fv.getMonth();
      monthLabel = MONTH_NAMES[monthIdx];
    } else if (typeof fv === 'string') {
      if (fv.toUpperCase().includes('TOTAL')) return;
      const mm = MONTH_NAMES.findIndex(m => fv.toUpperCase().includes(m.toUpperCase()));
      if (mm >= 0) { monthIdx = mm; monthLabel = MONTH_NAMES[mm]; }
    }

    const g = (...pats) => {
      for (const p of pats) {
        const k = keys.find(k => k.toLowerCase().includes(p.toLowerCase()));
        if (k !== undefined && row[k] != null) {
          const v = parseFloat(row[k]);
          return isNaN(v) ? null : v;
        }
      }
      return null;
    };

    parsed.push({
      month:     monthLabel,
      month_idx: monthIdx,
      target:    g('sales target','sales needed','target'),
      backlog:   g('backlog','proshop'),
      deficit:   g('deficit'),
      actual:    g('actual sales','actual direct') || g('actual'),
      dir_pay:   g('actual direct payroll','direct payroll'),
      ind_pay:   g('indirect payroll','indirect'),
      tgt_pay:   g('target payroll'),
      tot_pay:   g('total payroll'),
      tgt_net:   g('target net income'),
      act_net:   g('actual net income','net income'),
      tgt_mat:   g('target raw material'),
      mat:       g('raw material','material'),
      tgt_tool:  g('target tooling'),
      tool:      g('actual tooling','tooling'),
      tgt_exp:   g('target expense'),
      exp:       g('actual expense','expense'),
      sched_hr:  g('scheduled machine','sched'),
      act_hr:    g('actual machine','actual hour'),
      tgt_gp:    g('target gross profit'),
      act_gp:    g('actual gross profit','gross profit'),
    });
  });

  return parsed;
}

// ── ROUTES ───────────────────────────────────────────────────────────────────

// GET /api/datasets — list all datasets
app.get('/api/datasets', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, fiscal_year, uploaded_by, created_at, updated_at FROM kpi_datasets ORDER BY updated_at DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/datasets/:id — get dataset + all month rows
app.get('/api/datasets/:id', async (req, res) => {
  try {
    const dsRes = await pool.query('SELECT * FROM kpi_datasets WHERE id=$1', [req.params.id]);
    if (!dsRes.rows.length) return res.status(404).json({ error: 'Not found' });

    const mRes = await pool.query(
      'SELECT * FROM kpi_months WHERE dataset_id=$1 ORDER BY month_idx',
      [req.params.id]
    );
    res.json({ dataset: dsRes.rows[0], months: mRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/datasets/latest — redirect to most recent
app.get('/api/datasets/latest/data', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id FROM kpi_datasets ORDER BY updated_at DESC LIMIT 1'
    );
    if (!rows.length) return res.json({ dataset: null, months: [] });

    const id = rows[0].id;
    const dsRes = await pool.query('SELECT * FROM kpi_datasets WHERE id=$1', [id]);
    const mRes  = await pool.query(
      'SELECT * FROM kpi_months WHERE dataset_id=$1 ORDER BY month_idx', [id]
    );
    res.json({ dataset: dsRes.rows[0], months: mRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upload — upload Excel file
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const parsed = parseExcelToRows(req.file.buffer);
    if (!parsed.length) throw new Error('Could not parse any rows from file');

    const name     = req.body.name || req.file.originalname.replace(/\.[^.]+$/, '');
    const fy       = req.body.fiscal_year || '2026';
    const uploadBy = req.body.uploaded_by || 'anonymous';

    const dsRes = await client.query(
      `INSERT INTO kpi_datasets (name, fiscal_year, uploaded_by)
       VALUES ($1,$2,$3) RETURNING id`,
      [name, fy, uploadBy]
    );
    const datasetId = dsRes.rows[0].id;

    for (const r of parsed) {
      await client.query(
        `INSERT INTO kpi_months
           (dataset_id,month,month_idx,target,backlog,deficit,actual,dir_pay,ind_pay,
            tgt_pay,tot_pay,tgt_net,act_net,tgt_mat,mat,tgt_tool,tool,tgt_exp,exp,
            sched_hr,act_hr,tgt_gp,act_gp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         ON CONFLICT (dataset_id, month_idx) DO UPDATE SET
           target=$4,backlog=$5,deficit=$6,actual=$7,dir_pay=$8,ind_pay=$9,
           tgt_pay=$10,tot_pay=$11,tgt_net=$12,act_net=$13,tgt_mat=$14,mat=$15,
           tgt_tool=$16,tool=$17,tgt_exp=$18,exp=$19,sched_hr=$20,act_hr=$21,
           tgt_gp=$22,act_gp=$23`,
        [datasetId,r.month,r.month_idx,r.target,r.backlog,r.deficit,r.actual,
         r.dir_pay,r.ind_pay,r.tgt_pay,r.tot_pay,r.tgt_net,r.act_net,r.tgt_mat,
         r.mat,r.tgt_tool,r.tool,r.tgt_exp,r.exp,r.sched_hr,r.act_hr,r.tgt_gp,r.act_gp]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, dataset_id: datasetId, rows: parsed.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/datasets/:id/months/:monthIdx — manual cell edit
app.patch('/api/datasets/:id/months/:monthIdx', async (req, res) => {
  const { id, monthIdx } = req.params;
  const updates = req.body; // { field_name: new_value, ... }
  const updatedBy = updates.updated_by || 'anonymous';
  delete updates.updated_by;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const allowed = ['actual','act_net','act_gp','tot_pay','mat','tool','exp',
                     'act_hr','dir_pay','ind_pay','backlog','target'];
    const fields  = Object.keys(updates).filter(k => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ error: 'No valid fields' });

    // fetch old values for audit
    const old = await client.query(
      'SELECT * FROM kpi_months WHERE dataset_id=$1 AND month_idx=$2', [id, monthIdx]
    );

    for (const field of fields) {
      const newVal = updates[field] === '' ? null : parseFloat(updates[field]);
      const oldVal = old.rows[0]?.[field] ?? null;

      await client.query(
        `UPDATE kpi_months SET ${field}=$1 WHERE dataset_id=$2 AND month_idx=$3`,
        [newVal, id, monthIdx]
      );

      await client.query(
        `INSERT INTO kpi_manual_updates (dataset_id,month_idx,field_name,old_value,new_value,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, monthIdx, field, oldVal, newVal, updatedBy]
      );
    }

    // touch updated_at
    await client.query(
      'UPDATE kpi_datasets SET updated_at=NOW() WHERE id=$1', [id]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/datasets/:id
app.delete('/api/datasets/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM kpi_datasets WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Start ────────────────────────────────────────────────────────────────────
async function start() {
  try {
    await initDB();
    app.listen(PORT, () => console.log(`🚀 AMF KPI running on port ${PORT}`));
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

start();
