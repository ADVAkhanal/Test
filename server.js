require('dotenv').config();
const express = require('express');
const path    = require('path');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fpy_entries (
      id          BIGSERIAL PRIMARY KEY,
      wo          TEXT NOT NULL,
      date        TEXT,
      part_number TEXT,
      customer    TEXT,
      wc          TEXT,
      run_num     TEXT,
      op_num      TEXT,
      inspection_method TEXT,
      setup_tech  TEXT,
      status      TEXT,
      result      TEXT,
      defect_code TEXT,
      timestamp   TEXT,
      edited_at   TEXT
    );
  `);
  console.log('✅ fpy_entries table ready');
}

function rowToEntry(r) {
  return {
    id:               Number(r.id),
    wo:               r.wo,
    date:             r.date,
    partNumber:       r.part_number,
    customer:         r.customer,
    wc:               r.wc,
    runNum:           r.run_num,
    opNum:            r.op_num,
    inspectionMethod: r.inspection_method,
    setupTech:        r.setup_tech,
    status:           r.status,
    result:           r.result,
    defectCode:       r.defect_code,
    timestamp:        r.timestamp,
    editedAt:         r.edited_at,
  };
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/entries', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM fpy_entries ORDER BY id DESC');
    res.json(rows.map(rowToEntry));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/entries', async (req, res) => {
  const b = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO fpy_entries
         (wo, date, part_number, customer, wc, run_num, op_num,
          inspection_method, setup_tech, status, result, defect_code, timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [b.wo, b.date, b.partNumber, b.customer, b.wc, b.runNum, b.opNum,
       b.inspectionMethod, b.setupTech, b.status, b.result, b.defectCode, b.timestamp]
    );
    res.json(rowToEntry(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/entries/:id', async (req, res) => {
  const b  = req.body;
  const id = Number(req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE fpy_entries SET
         wo=$1, date=$2, part_number=$3, customer=$4, wc=$5,
         run_num=$6, op_num=$7, inspection_method=$8, setup_tech=$9,
         status=$10, result=$11, defect_code=$12, edited_at=$13
       WHERE id=$14 RETURNING *`,
      [b.wo, b.date, b.partNumber, b.customer, b.wc, b.runNum, b.opNum,
       b.inspectionMethod, b.setupTech, b.status, b.result, b.defectCode,
       b.editedAt, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rowToEntry(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/entries/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rowCount } = await pool.query('DELETE FROM fpy_entries WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/entries', async (req, res) => {
  try {
    await pool.query('TRUNCATE fpy_entries RESTART IDENTITY');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  try {
    await initDB();
    app.listen(PORT, () => console.log(`🚀 FPY Tracker running on port ${PORT}`));
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}
start();
