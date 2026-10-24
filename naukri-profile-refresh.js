/**
 * Naukri Profile Refresh — toggles a trailing "." on the resume headline
 * so the profile counts as "updated" every run.
 *
 * Hourly:  Windows Task Scheduler runs:  node naukri-profile-refresh.js   (off-screen Chrome)
 * Debug:   node naukri-profile-refresh.js login                           (visible Chrome window)
 *
 * Login is automatic: if the Naukri session is gone, it signs in with the
 * Google account below. State lives in the headline itself:
 * ends with "." → remove it, else add it.
 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { CREDS, naukriProfileUrl } = require('./config'); // credentials + profile URL come from .env, never hard-coded

const PROFILE_URL = naukriProfileUrl;
const LOGIN_URL = `https://www.naukri.com/nlogin/login?URL=${PROFILE_URL}`;

const PROFILE_DIR = path.join(__dirname, '.naukri-chrome-profile');
const LOG_FILE = path.join(__dirname, 'naukri-refresh.log');
const ERROR_SHOT = path.join(__dirname, 'naukri-refresh-error.png');
const LOGIN_MODE = process.argv[2] === 'login';

const formatIST = (d = new Date()) => {
  try {
    return new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
  } catch {
    return new Date(d).toLocaleString();
  }
};

const log = (msg) => {
  const line = `[${formatIST()} IST] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
};

async function injectCookiesIfAvailable(ctx) {
  const secretPaths = [
    '/etc/secrets/session-env.txt',
    '/etc/secrets/storage-state.json',
    path.join(__dirname, 'session-env.txt'),
    path.join(__dirname, 'storage-state.json'),
  ];

  for (const p of secretPaths) {
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf8').trim();
        let parsed = null;
        if (raw.startsWith('{') || raw.startsWith('[')) {
          parsed = JSON.parse(raw);
        } else {
          try {
            const decoded = Buffer.from(raw, 'base64').toString('utf8');
            parsed = JSON.parse(decoded);
          } catch {}
        }

        if (parsed) {
          const cookies = Array.isArray(parsed) ? parsed : (parsed.cookies || []);
          if (cookies.length > 0) {
            await ctx.addCookies(cookies);
            log(`Injected ${cookies.length} session cookies from ${p}`);
            return true;
          }
        }
      } catch (err) {
        log(`Warning reading cookies from ${p}: ${err.message}`);
      }
    }
  }

  const envB64 = process.env.NAUKRI_SESSION_BASE64;
  if (envB64) {
    try {
      const decoded = Buffer.from(envB64.trim(), 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      const cookies = Array.isArray(parsed) ? parsed : (parsed.cookies || []);
      if (cookies.length > 0) {
        await ctx.addCookies(cookies);
        log(`Injected ${cookies.length} session cookies from NAUKRI_SESSION_BASE64 env`);
        return true;
      }
    } catch (err) {
      log(`Warning reading cookies from NAUKRI_SESSION_BASE64: ${err.message}`);
    }
  }
  return false;
}

const onProfile = (url) => url.pathname.startsWith('/mnjuser');

async function googleLogin(ctx, page) {
  log('Session gone — signing in with Google...');
  await page.goto(LOGIN_URL, {
    waitUntil: 'domcontentloaded', timeout: 60000,
  });

  // Naukri's "Sign in with Google" is a plain div.socialbtn.google
  const googleBtn = page.locator('.socialbtn.google, [class*="socialbtn"][class*="google"]').first();
  await googleBtn.waitFor({ timeout: 20000 });
  await googleBtn.click();

  // The Google sign-in may open a popup OR replace the current tab — find it either way
  let g = null;
  for (let i = 0; i < 30 && !g; i++) {
    await page.waitForTimeout(1000);
    g = ctx.pages().find((p) => /accounts\.google\./.test(p.url())) || null;
  }
  if (!g) throw new Error('Google sign-in page never appeared');
  await g.waitForLoadState('domcontentloaded');

  // Account already known to this Chrome profile → click it, else full email+password
  const knownAccount = g.locator(`[data-email="${CREDS.email}"]`).first();
  if (await knownAccount.isVisible().catch(() => false)) {
    await knownAccount.click();
  } else {
    const emailBox = g.locator('input#identifierId, input[type="email"], input[name="identifier"]').first();
    await emailBox.waitFor({ state: 'visible', timeout: 60000 });
    await emailBox.fill(CREDS.email);
    await g.locator('#identifierNext, button:has-text("Next")').first().click();
    const passBox = g.locator('input[type="password"], input[name="Passwd"]').first();
    await passBox.waitFor({ state: 'visible', timeout: 60000 });
    await passBox.fill(CREDS.password);
    await g.locator('#passwordNext, button:has-text("Next")').first().click();
  }

  // Wait until any tab lands back on the logged-in naukri profile
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    // consent screen ("Continue") sometimes follows the password step
    if (!g.isClosed()) {
      await g.locator('button:has-text("Continue")').first().click({ timeout: 500 }).catch(() => {});
    }
    const done = ctx.pages().find((p) => {
      try { return onProfile(new URL(p.url())); } catch { return false; }
    });
    if (done) { log('Google login OK, session saved.'); return done; }
    if (g.isClosed() || /naukri\.com/.test(g.url())) {
      // auth finished but landed elsewhere — go to the profile directly
      await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      if (onProfile(new URL(page.url()))) { log('Google login OK, session saved.'); return page; }
    }
    await page.waitForTimeout(2000);
  }
  throw new Error(
    'Google login did not complete — likely a 2-step verification prompt. ' +
    'Run "node naukri-profile-refresh.js login" and approve it once manually.'
  );
}

async function refreshProfile() {
  log('Starting profile refresh procedure...');

  const launchArgs = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    ...(LOGIN_MODE ? [] : ['--window-position=-32000,-32000']),
  ];

  const launchOptions = {
    headless: process.env.HEADLESS === 'true',
    viewport: { width: 1280, height: 850 },
    args: launchArgs,
  };

  if (process.env.PLAYWRIGHT_CHANNEL) {
    launchOptions.channel = process.env.PLAYWRIGHT_CHANNEL;
  } else if (process.platform === 'darwin' || process.platform === 'win32') {
    launchOptions.channel = 'chrome';
  }

  let ctx = null;

  try {
    log('Launching browser persistent context...');
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);

    await injectCookiesIfAvailable(ctx);

    let page = ctx.pages()[0] || (await ctx.newPage());

    log(`Navigating to profile: ${PROFILE_URL}...`);
    await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (!onProfile(new URL(page.url()))) {
      page = await googleLogin(ctx, page);
    }
    // login may land on /mnjuser/homepage — make sure we're on the profile itself
    if (!/\/mnjuser\/profile/.test(page.url())) {
      await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    // Resume headline widget → pencil icon → textarea → save
    const editIcon = page.locator('#lazyResumeHead span.edit.icon, [data-ga-track*="resumeHeadline"] .edit');
    await editIcon.first().waitFor({ timeout: 30000 });
    await editIcon.first().click();

    const textarea = page.locator('#resumeHeadlineTxt');
    await textarea.waitFor({ timeout: 15000 });
    const current = (await textarea.inputValue()).trimEnd();
    const updated = current.endsWith('.') ? current.slice(0, -1) : current + '.';

    await textarea.fill(updated);
    await page.getByRole('button', { name: /^save$/i }).first().click();
    await textarea.waitFor({ state: 'hidden', timeout: 15000 });

    // modal closing isn't proof the save stuck — reload from the server and re-read
    await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await editIcon.first().waitFor({ timeout: 30000 });
    await editIcon.first().click();
    await textarea.waitFor({ timeout: 15000 });
    const saved = (await textarea.inputValue()).trimEnd();
    if (saved !== updated) {
      throw new Error(`save did not stick — server headline is "${saved.slice(0, 60)}", expected "${updated.slice(0, 60)}"`);
    }

    const actionMsg = `OK: headline ${current.endsWith('.') ? 'dot removed' : 'dot added'} (verified) → "${updated.slice(0, 60)}"`;
    log(actionMsg);
    return { success: true, message: actionMsg, headline: updated };
  } catch (err) {
    if (ctx) {
      const pages = ctx.pages();
      for (let i = 0; i < pages.length; i++) {
        await pages[i].screenshot({ path: ERROR_SHOT.replace('.png', `-${i}.png`) }).catch(() => {});
      }
    }
    log(`ERROR: ${err.message}`);
    throw err;
  } finally {
    if (ctx) {
      await ctx.close().catch(() => {});
    }
  }
}

if (require.main === module) {
  refreshProfile().catch((err) => {
    console.error(`[FATAL ERROR]:`, err.message || err);
    process.exitCode = 1;
  });
}

module.exports = { refreshProfile, injectCookiesIfAvailable, log };
