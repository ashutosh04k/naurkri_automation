/**
 * Cloud Cron Worker for Render / Railway / Docker
 * - Automatically executes profile refresh every hour (60 minutes).
 * - Exposes a lightweight HTTP health-check server so Render keeps the service alive.
 * - Zero external dependencies.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { refreshProfile, log } = require('./naukri-profile-refresh');

const PORT = process.env.PORT || 3000;
const REFRESH_INTERVAL_MS = (parseInt(process.env.REFRESH_INTERVAL_MINS, 10) || 60) * 60 * 1000;
const LOG_FILE = path.join(__dirname, 'naukri-refresh.log');

let isRefreshing = false;
let lastResult = {
  timestamp: null,
  status: 'initialized',
  message: 'Worker started, waiting for initial run...',
};
let nextRunTimestamp = Date.now() + 5000; // run 5 seconds after startup

async function executeRefreshJob(triggerSource = 'cron') {
  if (isRefreshing) {
    log(`[${triggerSource}] Refresh already in progress, skipping...`);
    return { status: 'skipped', message: 'Already in progress' };
  }

  isRefreshing = true;
  log(`[${triggerSource}] Starting hourly profile refresh...`);

  try {
    const res = await refreshProfile();
    lastResult = {
      timestamp: new Date().toISOString(),
      status: 'success',
      message: res.message || 'Profile headline updated successfully',
      headline: res.headline || '',
    };
    log(`[${triggerSource}] Finished successfully.`);
  } catch (err) {
    lastResult = {
      timestamp: new Date().toISOString(),
      status: 'error',
      message: err.message,
    };
    log(`[${triggerSource}] Failed: ${err.message}`);
  } finally {
    isRefreshing = false;
    nextRunTimestamp = Date.now() + REFRESH_INTERVAL_MS;
  }
  return lastResult;
}

// ── HTTP Health Check & Control Server ─────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  res.setHeader('Content-Type', 'application/json');

  if (pathname === '/' || pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'ok',
      service: 'Naukri Hourly Profile Refresher',
      isRefreshing,
      lastResult,
      nextScheduledRun: new Date(nextRunTimestamp).toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
    }, null, 2));
    return;
  }

  if (pathname === '/refresh') {
    if (isRefreshing) {
      res.writeHead(409);
      res.end(JSON.stringify({ error: 'Refresh already in progress' }));
      return;
    }
    executeRefreshJob('manual-http');
    res.writeHead(200);
    res.end(JSON.stringify({ message: 'Refresh triggered manually via HTTP' }));
    return;
  }

  if (pathname === '/logs') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (fs.existsSync(LOG_FILE)) {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n');
      res.writeHead(200);
      res.end(lines.slice(-60).join('\n'));
    } else {
      res.writeHead(200);
      res.end('No logs yet.');
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.on('error', (err) => {
  console.error('[HTTP Server Error]:', err.message);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n============================================================`);
  console.log(`🤖 Naukri Hourly Cron Worker is active!`);
  console.log(`👉 Listening on: 0.0.0.0:${PORT}`);
  console.log(`👉 Health check: http://0.0.0.0:${PORT}/health`);
  console.log(`👉 Trigger manual refresh: http://0.0.0.0:${PORT}/refresh`);
  console.log(`👉 Scheduled interval: Every ${Math.round(REFRESH_INTERVAL_MS / 60000)} minutes`);
  console.log(`============================================================\n`);

  // First run 5 seconds after startup
  setTimeout(() => {
    executeRefreshJob('startup');
  }, 5000);

  // Recurring hourly loop
  setInterval(() => {
    executeRefreshJob('cron');
  }, REFRESH_INTERVAL_MS);
});
