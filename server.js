const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const fs      = require('fs');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const DATA_FILE     = path.join(__dirname, 'data.json');
const CAPACITY_FILE = path.join(__dirname, 'capacity_data.json');
const PORT          = process.env.PORT || 3000;

// ── Load / save helpers ───────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) { console.error('Error loading data:', e.message); }
  return [];
}

function saveData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
  catch(e) { console.error('Error saving data:', e.message); }
}

function loadCapacity() {
  try {
    if (fs.existsSync(CAPACITY_FILE)) return JSON.parse(fs.readFileSync(CAPACITY_FILE, 'utf8'));
  } catch(e) { console.error('Error loading capacity data:', e.message); }
  return null; // null = no saved data yet, dashboard uses its built-in defaults
}

function saveCapacity(data) {
  try { fs.writeFileSync(CAPACITY_FILE, JSON.stringify(data, null, 2)); }
  catch(e) { console.error('Error saving capacity data:', e.message); }
}

let db = loadData();

// ── Broadcast to all connected clients ───────────────────────────
function broadcast(msg) {
  const payload = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

// ── Middleware ────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' })); // capacity data can be large

// ── HTTP: serve the dashboard ─────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// ── Capacity data API (persistent across refreshes) ───────────────
// GET: returns saved capacity data, or null if none uploaded yet
app.get('/api/capacity', (req, res) => {
  const data = loadCapacity();
  res.json(data); // null tells the dashboard to use its hardcoded defaults
});

// POST: saves new capacity data sent from the dashboard after upload
app.post('/api/capacity', (req, res) => {
  const { avail, loaded } = req.body;
  if (!avail || !loaded) return res.status(400).json({ error: 'Missing avail or loaded fields' });
  saveCapacity({ avail, loaded });
  console.log(`[${ts()}] Capacity data saved — ${Object.keys(avail).length} WCs (avail), ${Object.keys(loaded).length} WCs (loaded)`);
  // Broadcast to all other connected clients so their dashboards also update live
  broadcast({ type: 'capacity_update', avail, loaded });
  res.json({ ok: true });
});

// DELETE: clears saved capacity data and reverts to built-in defaults
app.delete('/api/capacity', (req, res) => {
  try {
    if (fs.existsSync(CAPACITY_FILE)) fs.unlinkSync(CAPACITY_FILE);
    broadcast({ type: 'capacity_reset' });
    console.log(`[${ts()}] Capacity data reset to defaults`);
  } catch(e) { /* ignore */ }
  res.json({ ok: true });
});

// REST endpoint for NPI work order data (existing)
app.get('/api/data', (req, res) => res.json(db));

// ── WebSocket: handle NPI work order mutations ────────────────────
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[${ts()}] Client connected: ${ip} | Total: ${wss.clients.size}`);

  // Send current WO data to newly connected client
  ws.send(JSON.stringify({ type: 'init', data: db }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'add': {
        const entry = { ...msg.entry, id: msg.entry.id || uid() };
        db.unshift(entry);
        saveData(db);
        broadcast({ type: 'add', entry });
        console.log(`[${ts()}] ADD — WO: ${entry.wo} | Run: ${entry.run}`);
        break;
      }

      case 'update': {
        const idx = db.findIndex(r => r.id === msg.entry.id);
        if (idx !== -1) {
          db[idx] = msg.entry;
          saveData(db);
          broadcast({ type: 'update', entry: msg.entry });
          console.log(`[${ts()}] UPDATE — WO: ${msg.entry.wo} | Run: ${msg.entry.run}`);
        }
        break;
      }

      case 'delete': {
        const before = db.length;
        db = db.filter(r => r.id !== msg.id);
        if (db.length < before) {
          saveData(db);
          broadcast({ type: 'delete', id: msg.id });
          console.log(`[${ts()}] DELETE — id: ${msg.id}`);
        }
        break;
      }

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  });

  ws.on('close', () => {
    console.log(`[${ts()}] Client disconnected | Remaining: ${wss.clients.size}`);
  });

  ws.on('error', (err) => console.error('WS error:', err.message));
});

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function ts()  { return new Date().toLocaleTimeString(); }

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   ADVANCED MACHINING CAPACITY DASHBOARD      ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Local:    http://localhost:${PORT}              ║`);
  console.log(`║  Network:  http://<YOUR-IP>:${PORT}              ║`);
  console.log('║  Data:     capacity_data.json (persisted)    ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});
