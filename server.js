/**
 * Web Dashboard Server for Naukri Automation Hub
 * Zero external dependencies (uses standard Node.js http, fs, path, child_process).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { CV, naukriProfileUrl } = require('./config');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const AUTO_REFRESH_MINS = parseInt(process.env.REFRESH_INTERVAL_MINS, 10) || 60;
const AUTO_REFRESH_MS = AUTO_REFRESH_MINS * 60 * 1000;
let nextCronTimestamp = Date.now() + AUTO_REFRESH_MS;

const APPLIED_FILE = path.join(__dirname, 'applied-jobs.json');
const EXTERNAL_FILE = path.join(__dirname, 'external-jobs.json');
const EXTERNAL_CSV = path.join(__dirname, 'external-jobs.csv');
const REFRESH_LOG = path.join(__dirname, 'naukri-refresh.log');
const APPLY_LOG = path.join(__dirname, 'naukri-apply.log');

// State
let activeTask = null; // { name, process, startTime }
const sseClients = new Set();

function broadcastSSE(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function logToClients(line, source = 'system') {
  broadcastSSE('log', {
    line: line.toString(),
    source,
    time: new Date().toLocaleTimeString(),
  });
}

function parseAppliedUrl(url) {
  // e.g. https://www.naukri.com/job-listings-software-developer-bajaj-finance-limited-pune-3-to-5-years-221026928670
  try {
    const slug = url.split('/job-listings-')[1] || '';
    const clean = slug.replace(/-\d{12}$/, ''); // drop trailing date/id
    const parts = clean.split('-');
    let exp = '';
    const expIdx = parts.findIndex((p, idx) => p === 'years' || (idx > 0 && parts[idx - 1] === 'to'));
    
    return {
      url,
      slug,
      title: parts.slice(0, 3).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
      rawSlug: clean.replace(/-/g, ' ')
    };
  } catch {
    return { url, slug: url, title: url, rawSlug: url };
  }
}

function getStats() {
  let appliedCount = 0;
  let externalCount = 0;
  let lastRefreshText = 'Never';

  try {
    if (fs.existsSync(APPLIED_FILE)) {
      const data = JSON.parse(fs.readFileSync(APPLIED_FILE, 'utf8'));
      appliedCount = Array.isArray(data) ? data.length : 0;
    }
  } catch {}

  try {
    if (fs.existsSync(EXTERNAL_FILE)) {
      const data = JSON.parse(fs.readFileSync(EXTERNAL_FILE, 'utf8'));
      externalCount = Object.keys(data).length;
    }
  } catch {}

  try {
    if (fs.existsSync(REFRESH_LOG)) {
      const lines = fs.readFileSync(REFRESH_LOG, 'utf8').trim().split('\n');
      if (lines.length > 0) {
        lastRefreshText = lines[lines.length - 1];
      }
    }
  } catch {}

  return {
    appliedCount,
    externalCount,
    lastRefreshText,
    isRunning: Boolean(activeTask),
    currentTask: activeTask ? activeTask.name : null,
    taskStartTime: activeTask ? activeTask.startTime : null,
    nextCronTimestamp,
    autoRefreshIntervalMins: AUTO_REFRESH_MINS,
  };
}

function getData() {
  let appliedList = [];
  let externalList = [];

  try {
    if (fs.existsSync(APPLIED_FILE)) {
      const urls = JSON.parse(fs.readFileSync(APPLIED_FILE, 'utf8'));
      appliedList = (Array.isArray(urls) ? urls : []).map(parseAppliedUrl);
    }
  } catch {}

  try {
    if (fs.existsSync(EXTERNAL_FILE)) {
      const extObj = JSON.parse(fs.readFileSync(EXTERNAL_FILE, 'utf8'));
      externalList = Object.values(extObj).sort((a, b) => (b.postedOn || '').localeCompare(a.postedOn || ''));
    }
  } catch {}

  // Safe sanitized CV (no sensitive passwords or private auth keys)
  const safeProfile = {
    name: CV.name || 'Candidate',
    email: CV.email || '',
    phone: CV.phone || '',
    location: CV.location || '',
    currentRole: CV.currentRole || '',
    company: CV.company || '',
    education: CV.education || '',
    yearsOfExperience: CV.yearsOfExperience || '',
    skills: CV.skills || '',
    noticePeriod: CV.noticePeriod || '',
    currentSalary: CV.currentSalary || '',
    expectedSalary: CV.expectedSalary || '',
    links: CV.links || '',
    github: CV.github || '',
    linkedin: CV.linkedin || '',
    naukriProfileUrl,
  };

  return {
    profile: safeProfile,
    stats: getStats(),
    appliedList,
    externalList,
  };
}

function runScript(scriptFile, args, taskName, onFinish) {
  if (activeTask) {
    throw new Error(`Another task is already running: ${activeTask.name}`);
  }

  logToClients(`\n------------------------------------------------------------\n[START] ${taskName}\n------------------------------------------------------------\n`, 'system');

  const child = spawn(process.execPath, [path.join(__dirname, scriptFile), ...args], {
    cwd: __dirname,
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  activeTask = {
    name: taskName,
    process: child,
    startTime: new Date().toISOString(),
  };

  broadcastSSE('status', getStats());

  child.stdout.on('data', (d) => {
    const text = d.toString();
    process.stdout.write(text);
    logToClients(text, 'stdout');
  });

  child.stderr.on('data', (d) => {
    const text = d.toString();
    process.stderr.write(text);
    logToClients(text, 'stderr');
  });

  child.on('close', (code) => {
    const durationSec = Math.round((Date.now() - new Date(activeTask.startTime).getTime()) / 1000);
    logToClients(`\n[FINISH] ${taskName} finished with exit code ${code} (took ${durationSec}s)\n------------------------------------------------------------\n`, 'system');
    activeTask = null;
    broadcastSSE('status', getStats());
    broadcastSSE('data-refresh', getData());
    if (onFinish) onFinish(code);
  });

  child.on('error', (err) => {
    logToClients(`[ERROR] Failed to start process: ${err.message}\n`, 'system');
    activeTask = null;
    broadcastSSE('status', getStats());
    if (onFinish) onFinish(1);
  });
}

function stopCurrentTask() {
  if (!activeTask || !activeTask.process) {
    return { ok: false, message: 'No task currently running.' };
  }
  const taskName = activeTask.name;
  logToClients(`\n[ABORT] Canceling task: ${taskName}...\n`, 'system');
  activeTask.process.kill('SIGINT');
  setTimeout(() => {
    if (activeTask && activeTask.process) {
      activeTask.process.kill('SIGKILL');
    }
  }, 2000);
  return { ok: true, message: `Terminated ${taskName}` };
}

// HTTP Server
const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  // Enable basic CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. SSE Logs Stream
  if (pathname === '/api/logs/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':\n\n'); // SSE comment to keep alive
    sseClients.add(res);

    // Initial status event
    res.write(`event: status\ndata: ${JSON.stringify(getStats())}\n\n`);

    const keepAlive = setInterval(() => {
      res.write(': keep-alive\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
    return;
  }

  // Health check endpoint for Render monitoring
  if ((pathname === '/health' || pathname === '/api/health') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'Naukri Automation Hub Dashboard & Hourly Cron',
      isRunning: Boolean(activeTask),
      currentTask: activeTask ? activeTask.name : null,
      nextScheduledRun: new Date(nextCronTimestamp).toISOString(),
      ...getStats(),
      uptimeSeconds: Math.floor(process.uptime()),
    }, null, 2));
    return;
  }

  // Trigger cron run on demand via simple GET (ideal for external webhook / cron-job.org)
  if ((pathname === '/api/cron/run' || pathname === '/refresh-cron') && req.method === 'GET') {
    if (activeTask) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Task "${activeTask.name}" already in progress` }));
      return;
    }
    nextCronTimestamp = Date.now() + AUTO_REFRESH_MS;
    runScript('naukri-profile-refresh.js', [], 'Hourly Cron Refresh');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Hourly profile refresh triggered successfully.' }));
    return;
  }

  // 2. Status API
  if (pathname === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getStats()));
    return;
  }

  // 3. Full Data API (profile, applied, external)
  if (pathname === '/api/data' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getData()));
    return;
  }

  // 4. Download CSV or view generated external-jobs.html
  if (pathname === '/api/export/csv' && req.method === 'GET') {
    if (fs.existsSync(EXTERNAL_CSV)) {
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="external-jobs.csv"',
      });
      fs.createReadStream(EXTERNAL_CSV).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('CSV file not generated yet.');
    }
    return;
  }

  if (pathname === '/external-jobs.html' && req.method === 'GET') {
    const extHtmlPath = path.join(__dirname, 'external-jobs.html');
    if (fs.existsSync(extHtmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(extHtmlPath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('external-jobs.html not generated yet.');
    }
    return;
  }

  // 5. Actions API
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        if (pathname === '/api/action/stop') {
          const result = stopCurrentTask();
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        if (activeTask) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Task "${activeTask.name}" is already in progress.` }));
          return;
        }

        if (pathname === '/api/action/refresh') {
          runScript('naukri-profile-refresh.js', [], 'Profile Refresh');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: 'Profile Refresh started.' }));
          return;
        }

        if (pathname === '/api/action/apply') {
          runScript('naukri-auto-apply.js', [], 'Auto Apply (Live)');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: 'Auto Apply started.' }));
          return;
        }

        if (pathname === '/api/action/apply-dry') {
          runScript('naukri-auto-apply.js', ['--dry-run'], 'Auto Apply (Dry Run)');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: 'Auto Apply (Dry Run) started.' }));
          return;
        }

        if (pathname === '/api/action/run-all') {
          // Sequentially: 1) Profile Refresh -> 2) Auto Apply
          runScript('naukri-profile-refresh.js', [], 'One-Click Step 1: Profile Refresh', (code) => {
            if (code === 0) {
              logToClients('[ONE-CLICK] Profile refresh succeeded! Proceeding immediately to Step 2: Auto Apply...\n', 'system');
              runScript('naukri-auto-apply.js', [], 'One-Click Step 2: Auto Apply');
            } else {
              logToClients(`[ONE-CLICK] Profile refresh finished with code ${code}. Aborting Auto Apply.\n`, 'system');
            }
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: 'One-Click Automation sequence initiated.' }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Endpoint not found' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 6. Serve static files from public/
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    res.end('Access denied');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(__dirname, 'public', 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      }
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n============================================================`);
  console.log(`🚀 Naukri Automation Hub Dashboard is LIVE!`);
  console.log(`👉 Access URL: http://localhost:${PORT}`);
  console.log(`👉 Network URL: http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  console.log(`============================================================\n`);

  // Hourly Auto-Refresh Cron
  const AUTO_REFRESH_MINS = parseInt(process.env.REFRESH_INTERVAL_MINS, 10) || 60;
  const AUTO_REFRESH_MS = AUTO_REFRESH_MINS * 60 * 1000;

  console.log(`⏱️ Hourly Auto-Refresh Cron active: Runs every ${AUTO_REFRESH_MINS} minutes`);

  // Startup run (8 seconds after server is healthy)
  setTimeout(() => {
    if (!activeTask) {
      console.log('\n[Auto-Cron] Starting initial profile refresh on boot...');
      try {
        runScript('naukri-profile-refresh.js', [], 'Hourly Profile Refresh (Startup)');
      } catch (err) {
        console.error('[Auto-Cron] Startup run failed:', err.message);
      }
    }
  }, 8000);

  // Recurring hourly timer
  setInterval(() => {
    if (!activeTask) {
      console.log('\n[Auto-Cron] Starting scheduled hourly profile refresh...');
      try {
        runScript('naukri-profile-refresh.js', [], 'Hourly Profile Refresh');
      } catch (err) {
        console.error('[Auto-Cron] Scheduled run failed:', err.message);
      }
    } else {
      console.log(`\n[Auto-Cron] Task "${activeTask.name}" currently active, skipping this cycle.`);
    }
  }, AUTO_REFRESH_MS);
});
