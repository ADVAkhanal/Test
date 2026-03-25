const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const fs      = require('fs');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const DATA_FILE = path.join(__dirname, 'data.json');
const PORT      = process.env.PORT || 3000;

// ── Load / save data ──────────────────────────────────────────────
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

let db = loadData();

// ── Broadcast to all connected clients ───────────────────────────
function broadcast(msg) {
  const payload = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

// ── HTTP: serve the dashboard ─────────────────────────────────────
app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// REST endpoints (fallback for non-WS clients)
app.get('/api/data', (req, res) => res.json(db));

// ── WebSocket: handle all mutations ──────────────────────────────
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[${new Date().toLocaleTimeString()}] Client connected: ${ip} | Total: ${wss.clients.size}`);

  // Send current data to newly connected client
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
  console.log('║      NPI LIVE DASHBOARD — SERVER RUNNING     ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Local:    http://localhost:${PORT}              ║`);
  console.log(`║  Network:  http://<YOUR-IP>:${PORT}              ║`);
  console.log('║  Run cloudflared for public URL              ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});
