# Naukri Job Automation

Two scripts that keep your Naukri job search running on autopilot:

1. **Profile Refresh** — toggles a `.` on your resume headline every hour so your profile always appears "recently updated" to recruiters.
2. **Auto Apply** — every morning applies to today's freshly posted jobs (less competition) matching your title, location, and experience.

- Logs in automatically with your **Google account** (session saved after first login).
- Runs in an off-screen Chrome window (Naukri blocks headless browsers).
- All personal data lives in `.env` — nothing sensitive is in the code.

---

## Requirements

- macOS / Linux (uses `crontab` for scheduling)
- [Node.js](https://nodejs.org/) 18+
- Google Chrome installed
- A Naukri account that signs in with Google

---

## Setup

**1. Clone and install:**

```bash
git clone https://github.com/PrasadB1234/naukri-auto-refresh.git
cd naukri-auto-refresh
npm install
```

**2. Create your `.env`:**

```bash
cp .env.example .env
```

Open `.env` and fill in your details:

| Variable | What it is |
|---|---|
| `GOOGLE_EMAIL` | Gmail you use to sign into Naukri |
| `GOOGLE_PASSWORD` | Your Gmail password (stays local, never pushed) |
| `NAME`, `PHONE`, `LOCATION` | Your contact details |
| `CURRENT_ROLE`, `SKILLS` | Your profile info for job applications |
| `NOTICE_PERIOD` | e.g. `Immediate` or `30 days` |
| `EXPECTED_CTC` | e.g. `14` (in LPA) |

`.env` is git-ignored, so your credentials never get pushed.

**3. First login (one time only — a Chrome window will open):**

```bash
node naukri-profile-refresh.js login
```

Sign in with Google and approve any 2-step verification. The session is saved to `.naukri-chrome-profile/` and reused by every later run — you never need to log in again.

**4. Test the profile refresh:**

```bash
node naukri-profile-refresh.js
```

Check `naukri-refresh.log`:
```
[14/9/2026, 9:00:01 AM] OK: headline dot added (verified) → "Immediate joiner | Software Engineer | ..."
```

**5. Test the auto-apply (dry run — no actual applications sent):**

```bash
node naukri-auto-apply.js --dry-run
```

You'll see `DRY-RUN [1/20]: https://...` for each job it would apply to. Once it looks right, run for real:

```bash
node naukri-auto-apply.js
```

---

## Schedule both scripts (Mac/Linux crontab)

Run this once to set up automatic scheduling:

```bash
# Profile refresh — every hour
(crontab -l 2>/dev/null; echo "0 * * * * cd /path/to/naukri-auto-refresh && node naukri-profile-refresh.js >> naukri-refresh.log 2>&1") | crontab -

# Auto-apply — every day at 9 AM
(crontab -l; echo "0 9 * * * cd /path/to/naukri-auto-refresh && node naukri-auto-apply.js >> naukri-apply.log 2>&1") | crontab -
```

Verify:
```bash
crontab -l
```

---

## Auto Apply — how it works

- Searches for jobs posted **today only** (fresh listings, fewer applicants).
- Searches across 6 job titles × 3 cities = 18 combinations per run.
- Applies up to **20 jobs per run** with human-like delays between each.
- Skips jobs that require applying on the company's own website (external apply).
- Tracks every application in `applied-jobs.json` — never applies to the same job twice.

**Job titles searched:** React Developer, Frontend Developer, Software Developer, Software Engineer, MERN Stack Developer, Fullstack Developer

**Locations:** Pune, Mumbai, Bangalore

**Check your applications:**
```bash
cat naukri-apply.log | grep APPLIED
```

---

## Deploy to Render (Hourly Auto-Refresh)

Deploy the automation to **Render** so your Naukri profile refreshes automatically every hour on the cloud without needing your computer on.

### 1. Export your local logged-in session
Render runs headlessly in the cloud and cannot show a browser window for Google 2FA. Export your active session:
```bash
npm run export-session
```
This generates a file named `session-env.txt` (git-ignored) containing your encrypted session string.

### 2. Push repository to GitHub
```bash
git add .
git commit -m "feat: add render docker cron deployment"
git push origin main
```

### 3. Create Web Service on Render
1. Go to [dashboard.render.com](https://dashboard.render.com) and click **New +** → **Web Service**.
2. Connect your GitHub repository.
3. Render will auto-detect the **Docker** runtime from `Dockerfile`.
4. Choose the **Free** instance plan.
5. In **Environment Variables**, add:
   - `NAUKRI_SESSION_BASE64`: *(Copy and paste the entire string from `session-env.txt`)*
   - `GOOGLE_EMAIL`: *(Your Google/Naukri email)*
   - `GOOGLE_PASSWORD`: *(Your password - used as fallback)*
   - `REFRESH_INTERVAL_MINS`: `60`
6. Click **Deploy Web Service**.

### 4. Health & Live Monitoring
Once deployed, Render gives you a live URL (`https://your-service.onrender.com`):
- `https://your-service.onrender.com/health` → Shows current status, last refresh timestamp, next scheduled run, and uptime.
- `https://your-service.onrender.com/refresh` → Triggers an instant refresh on demand.
- `https://your-service.onrender.com/logs` → Displays recent refresh logs.

> [!TIP]
> To keep Render's free tier from sleeping, set up a free 15-minute ping on [cron-job.org](https://cron-job.org) or [UptimeRobot](https://uptimerobot.com) targeting `https://your-service.onrender.com/health`.

---

## Web Dashboard (One-Click Control Center)

Launch the real-time web dashboard:

```bash
npm start
# or: node server.js
```

Open **`http://localhost:3000`** in any browser.

### Features
- **⚡ One-Click Master Button**: Executes profile refresh followed immediately by auto-apply.
- **📡 Real-Time Console**: Streams browser terminal stdout/stderr live to your screen via Server-Sent Events (SSE).
- **📊 Extracted Data Sidebar**:
  - **External Jobs Tab**: View company-site jobs, copy direct links, or export to CSV / HTML.
  - **Applied Jobs Tab**: History of jobs applied with title, company, and links.
  - **Profile Details**: Fast snapshot of candidate details and matching parameters.

### Making it Live
- **Local Network**: Accessible on your LAN via `http://<your-ip>:3000`.
- **Public URL (Free & Secure via Cloudflare Tunnel)**:
  ```bash
  npx cloudflared tunnel --url http://localhost:3000
  ```
- **Public URL (via ngrok)**:
  ```bash
  ngrok http 3000
  ```

---

## npm scripts

```bash
npm start          # Launch web dashboard (http://localhost:3000)
npm run login      # First-time Google login (opens visible Chrome)
npm run refresh    # Manual profile refresh
npm run apply      # Run auto-apply now
npm run apply:dry  # Dry run — shows matches without applying
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Google login did not complete` | Run `npm run login` and approve the 2-step verification prompt manually. |
| `save did not stick` | Naukri changed its headline editor — open an issue. |
| No jobs found (`Found 0 listings`) | Normal if no fresh jobs posted today for that search — try again tomorrow. |
| Any other error | Check `naukri-refresh-error-*.png` — screenshots of exactly what the browser saw. |
| Want to start fresh | Delete `.naukri-chrome-profile/` and run `npm run login` again. |

---

## Files

| File | Purpose |
|---|---|
| `naukri-profile-refresh.js` | Hourly profile refresh script |
| `naukri-auto-apply.js` | Daily auto-apply script |
| `config.js` | Loads `.env` (no external dependencies) |
| `.env.example` | Template — copy to `.env` and fill in |
| `naukri-refresh.log` | Profile refresh run history (git-ignored) |
| `naukri-apply.log` | Auto-apply run history (git-ignored) |
| `applied-jobs.json` | Tracks all jobs applied to (git-ignored) |
| `.naukri-chrome-profile/` | Saved Chrome session (git-ignored) |

---

## Disclaimer

Automating your own profile and applications may be against Naukri's Terms of Service. Both scripts operate at a slow, human-like rate and only act on your own account, but use at your own risk.
# naurkri_automation
