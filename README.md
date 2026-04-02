# AMF KPI Command Center

Manufacturing KPI dashboard for Advanced Machining & Fab with full persistence across all users via PostgreSQL.

## ⚡ Deploy to Railway in 3 Steps

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "AMF KPI Command Center"
git remote add origin https://github.com/YOUR_USERNAME/amf-kpi.git
git push -u origin main
```

### 2. Deploy on Railway
1. Go to [railway.app](https://railway.app) → **New Project**
2. Click **"Deploy from GitHub repo"** → select this repo
3. Railway auto-detects Node.js and deploys

### 3. Add PostgreSQL (one click)
1. In your Railway project dashboard, click **"+ New"**
2. Select **"Database" → "Add PostgreSQL"**
3. Railway automatically injects `DATABASE_URL` into your app
4. The app creates all tables on first boot — **done!**

Your dashboard is live at your Railway URL within ~60 seconds.

---

## Features

- **Persistent storage** — all uploaded Excel data is saved in PostgreSQL, visible to every user who visits the URL
- **Multi-dataset support** — upload multiple fiscal year files, switch between them via dropdown
- **Inline cell editing** — click any Actual Sales, Net Income, GP, Payroll, or Material cell in the table to edit live; changes auto-save to the database with 800ms debounce
- **Audit trail** — every manual edit is logged in `kpi_manual_updates` with old/new values and timestamp
- **Offline fallback** — if no backend is reachable, the app falls back to parsing Excel locally in the browser
- **Drag & drop upload** — drag an `.xlsx` file anywhere on the page to upload

## Local Development

```bash
# 1. Install deps
npm install

# 2. Set up local Postgres and copy env
cp .env.example .env
# Edit .env with your local DATABASE_URL

# 3. Run
npm run dev
```

## Excel Column Mapping

The parser is flexible and looks for these column name patterns (case-insensitive):

| Dashboard Field | Excel Column Names Recognized |
|---|---|
| Sales Target | `sales target`, `sales needed`, `target` |
| Backlog | `backlog`, `proshop` |
| Actual Sales | `actual sales`, `actual direct`, `actual` |
| Net Income | `actual net income`, `net income` |
| Gross Profit | `actual gross profit`, `gross profit` |
| Total Payroll | `total payroll` |
| Raw Material | `raw material`, `material` |
| Tooling | `actual tooling`, `tooling` |
| Machine Hours | `scheduled machine`, `sched` / `actual machine`, `actual hour` |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/datasets` | List all datasets |
| `GET` | `/api/datasets/:id` | Get dataset + all month rows |
| `GET` | `/api/datasets/latest/data` | Get most recently uploaded dataset |
| `POST` | `/api/upload` | Upload Excel file (multipart) |
| `PATCH` | `/api/datasets/:id/months/:monthIdx` | Update individual cell(s) |
| `DELETE` | `/api/datasets/:id` | Delete dataset |
| `GET` | `/health` | Health check |

## Stack

- **Frontend**: Vanilla HTML/CSS/JS + Chart.js + SheetJS
- **Backend**: Node.js + Express
- **Database**: PostgreSQL (via `pg`)
- **Deploy**: Railway (Nixpacks, auto-detected)
