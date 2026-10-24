/**
 * Naukri Auto Apply
 * Searches for matching jobs and applies using the saved login session.
 *
 * Run:        node naukri-auto-apply.js
 * Dry run:    node naukri-auto-apply.js --dry-run   (shows matches, skips actual apply)
 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs   = require('fs');
const { CV } = require('./config');

const PROFILE_DIR  = path.join(__dirname, '.naukri-chrome-profile');
const LOG_FILE     = path.join(__dirname, 'naukri-apply.log');
const APPLIED_FILE = path.join(__dirname, 'applied-jobs.json');
const EXTERNAL_FILE = path.join(__dirname, 'external-jobs.json');
const EXTERNAL_CSV  = path.join(__dirname, 'external-jobs.csv');
const EXTERNAL_HTML = path.join(__dirname, 'external-jobs.html');
const DRY_RUN      = process.argv.includes('--dry-run');

// ── Search config ─────────────────────────────────────────────────────────────
const JOB_TITLES = [
  'React Developer',
  'Frontend Developer',
  'Software Developer',
  'Software Engineer',
  'MERN Stack Developer',
  'Fullstack Developer',
];
const LOCATIONS        = ['Pune', 'Mumbai', 'Bangalore','Gurugram','Noida','Delhi','Hyderabad','Ahmedabad','Kolkata','Kochi','Mangalore','Chennai'];
const EXPERIENCE_YEARS = 3;
const MAX_PER_RUN      = 20; // stop after this many successful applications

// Companies to ignore (case-insensitive, partial match: "accenture" also blocks "Accenture Solutions")
const BLOCKED_COMPANIES = [
  'Accenture',
];
// ─────────────────────────────────────────────────────────────────────────────

const formatIST = (d = new Date()) => {
  try {
    return new Date(d).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'short',
      hour12: true,
    }) + ' IST';
  } catch {
    return new Date(d).toLocaleString();
  }
};

const log = (msg) => {
  const line = `[${formatIST()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
};

const loadApplied = () => {
  try { return new Set(JSON.parse(fs.readFileSync(APPLIED_FILE, 'utf8'))); }
  catch { return new Set(); }
};

const saveApplied = (set) =>
  fs.writeFileSync(APPLIED_FILE, JSON.stringify([...set], null, 2));

const searchUrl = (title, location) => {
  const slug = title.toLowerCase().replace(/\s+/g, '-');
  const loc  = location.toLowerCase();
  return `https://www.naukri.com/${slug}-jobs-in-${loc}?experience=${EXPERIENCE_YEARS}`;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ── Company blocklist ─────────────────────────────────────────────────────────
const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const BLOCKED   = BLOCKED_COMPANIES.map(normalize).filter(Boolean);

// Quick check on the URL slug, before opening the page
function isBlockedByUrl(url) {
  const slug = '-' + url.toLowerCase().split('/').pop() + '-';
  return BLOCKED.some((name) => slug.includes('-' + name.replace(/ /g, '-') + '-'));
}

// Check against the company name shown on the job page
function isBlockedCompany(company) {
  const c = ' ' + normalize(company) + ' ';
  return BLOCKED.some((name) => c.includes(' ' + name + ' '));
}

// ── External (company-site) job storage ──────────────────────────────────────
// Keyed by Naukri URL so the same job is never recorded twice across runs
const loadExternal = () => {
  try { return JSON.parse(fs.readFileSync(EXTERNAL_FILE, 'utf8')); }
  catch { return {}; }
};

const csvCell = (v = '') => `"${String(v).replace(/"/g, '""')}"`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function exportExternal(external) {
  fs.writeFileSync(EXTERNAL_FILE, JSON.stringify(external, null, 2));

  const rows = Object.values(external)
    .sort((a, b) => (b.extractedAtTimestamp || 0) - (a.extractedAtTimestamp || 0));

  // CSV with Extracted At timestamp
  const headers = ['Title', 'Company', 'Location', 'Experience', 'Extracted At', 'Company Apply Link', 'Naukri Link'];
  const keys    = ['title', 'company', 'location', 'experience', 'extractedAt', 'externalUrl', 'naukriUrl'];
  const csv = [headers, ...rows.map((r) => keys.map((k) => r[k] || r['postedOn'] || ''))]
    .map((row) => row.map(csvCell).join(','))
    .join('\n');
  fs.writeFileSync(EXTERNAL_CSV, '\uFEFF' + csv);

  // HTML document
  const link = (u, label) => (u ? `<a href="${esc(u)}" target="_blank">${label}</a>` : '<span class="na">not captured</span>');
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Company-site jobs</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 32px; color: #222; }
  h1 { margin-bottom: 4px; } p.meta { color: #666; margin-top: 0; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border-bottom: 1px solid #ddd; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f5f5f5; position: sticky; top: 0; }
  tr:hover td { background: #fafafa; }
  a { color: #1a5fd0; } .na { color: #aaa; }
  .badge { background: #e0e7ff; color: #3730a3; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
</style></head><body>
<h1>Jobs that apply on company site</h1>
<p class="meta">${rows.length} jobs · last updated ${esc(formatIST())}</p>
<table>
<tr><th>#</th><th>Title</th><th>Company</th><th>Location</th><th>Experience</th><th>Extracted At</th><th>Apply Link</th><th>Naukri</th></tr>
${rows.map((r, i) => `<tr>
  <td>${i + 1}</td><td><b>${esc(r.title)}</b></td><td>${esc(r.company)}</td>
  <td>${esc(r.location)}</td><td>${esc(r.experience)}</td><td><span class="badge">${esc(r.extractedAt || r.foundOn || 'Recent')}</span></td>
  <td>${link(r.externalUrl, 'Company site ↗')}</td><td>${link(r.naukriUrl, 'Listing ↗')}</td>
</tr>`).join('\n')}
</table></body></html>`;
  fs.writeFileSync(EXTERNAL_HTML, html);
}

// ── Read job details from a Naukri job page ──────────────────────────────────
async function getJobInfo(page) {
  return page.evaluate(() => {
    const text = (sels) => {
      for (const s of sels) {
        const el = document.querySelector(s);
        const t = el && el.textContent.trim().replace(/\s+/g, ' ');
        if (t) return t;
      }
      return '';
    };
    return {
      title:      text(['h1[class*="jd-header-title"]', 'h1[class*="title"]', 'h1', '.jd-header-title']),
      company:    text(['[class*="jd-header-comp-name"] a', '[class*="jd-header-comp-name"]', '.comp-name a', '.comp-name']),
      location:   text(['[class*="jhc__location"]', '[class*="location"] a', '[class*="loc"]', '.loc-wrapper']),
      experience: text(['[class*="jhc__exp"]', '[class*="exp"]', '.exp-wrapper']),
    };
  });
}

// ── Click "Apply on company site" and capture where it goes ──────────────────
async function getExternalUrl(page, btn) {
  const href = await btn.getAttribute('href').catch(() => null);
  if (href && !href.startsWith('javascript') && !href.includes('naukri.com/apply')) {
    return new URL(href, page.url()).href;
  }

  const before = page.url();
  try {
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 12000 }),
      btn.click(),
    ]);
    await popup.waitForURL((u) => u.href !== 'about:blank', { timeout: 10000 }).catch(() => {});
    await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await sleep(2500); // let redirect chains settle
    const url = popup.url();
    await popup.close().catch(() => {});
    return (url && url !== 'about:blank') ? url : '';
  } catch {
    await sleep(2500);
    const now = page.url();
    if (now !== before && !now.includes('naukri.com')) {
      await page.goBack().catch(() => {});
      return now;
    }
    return '';
  }
}

// ── Extract posting date from a Naukri job URL ───────────────────────────────
function getJobDate(url) {
  const match = url.match(/(\d{6})\d{6}$/);
  if (!match) return new Date(); // If date cannot be parsed, assume recent so it is not dropped
  const s = match[1];
  try {
    const d = new Date(2000 + parseInt(s.slice(4, 6)), parseInt(s.slice(2, 4)) - 1, parseInt(s.slice(0, 2)));
    return isNaN(d.getTime()) ? new Date() : d;
  } catch {
    return new Date();
  }
}

function isRecentJob(url, daysBack = 7) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  cutoff.setHours(0, 0, 0, 0);
  return getJobDate(url) >= cutoff;
}

// ── Collect job URLs from a search result page ────────────────────────────────
async function collectJobLinks(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
  await sleep(2000);

  // Scroll down to load all dynamic cards on the search results page
  await page.evaluate(async () => {
    for (let i = 0; i < 4; i++) {
      window.scrollBy(0, 800);
      await new Promise(r => setTimeout(r, 400));
    }
  }).catch(() => {});

  await sleep(1500);

  const links = await page.$$eval(
    [
      'a.title',
      'a[class*="title"]',
      '.jobtuple-wrapper a[class*="title"]',
      '.cust-job-tuple a[class*="title"]',
      'article.jobTuple a.title',
      '.srp-jobtuple-wrapper a[title]',
      'a[href*="/job-listings-"]',
    ].join(', '),
    (els) => [...new Set(els.map((el) => el.href).filter(Boolean))]
  );

  return links
    .filter((u) => u.includes('naukri.com/job-listings-'))
    .filter((u) => isRecentJob(u, 7))
    .sort((a, b) => getJobDate(b) - getJobDate(a));
}

// ── Handle the apply modal / form that appears after clicking Apply ───────────
async function fillApplyModal(page) {
  await sleep(2500);

  // 1. Notice Period options (chips, radio buttons)
  const noticeOptions = [
    page.locator('button:has-text("Immediate"), [class*="chip"]:has-text("Immediate")').first(),
    page.locator('label:has-text("Immediate"), label:has-text("15 Days"), label:has-text("30 Days")').first(),
    page.locator('input[value*="Immediate"], input[value="0"]').first(),
  ];
  for (const opt of noticeOptions) {
    if (await opt.isVisible().catch(() => false)) {
      await opt.click().catch(() => {});
      break;
    }
  }

  // Notice Period input or select
  const noticeSel = ['select[id*="otice"]', 'select[name*="otice"]', 'input[placeholder*="otice"]'];
  for (const sel of noticeSel) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      const tag = await el.evaluate((n) => n.tagName.toLowerCase()).catch(() => '');
      if (tag === 'select') {
        await el.selectOption({ label: /immediate|0|15|30/i }).catch(() => el.selectOption({ index: 0 }));
      } else {
        await el.fill('15').catch(() => {});
      }
      break;
    }
  }

  // 2. Current CTC & Expected CTC
  if (CV.currentCTC) {
    const el = page.locator('input[placeholder*="urrent"], input[name*="current"]').first();
    if (await el.isVisible().catch(() => false)) await el.fill(CV.currentCTC).catch(() => {});
  }
  if (CV.expectedCTC) {
    const el = page.locator('input[placeholder*="xpected"], input[name*="expected"]').first();
    if (await el.isVisible().catch(() => false)) await el.fill(CV.expectedCTC).catch(() => {});
  }

  // 3. Yes buttons for work auth / relocation
  const yesBtn = page.locator('button:has-text("Yes"), label:has-text("Yes")').first();
  if (await yesBtn.isVisible().catch(() => false)) {
    await yesBtn.click().catch(() => {});
  }

  // 4. Submit buttons
  const submitSelectors = [
    'button:has-text("Apply")',
    'button:has-text("Submit")',
    'button:has-text("APPLY")',
    'button:has-text("Submit Application")',
    'button:has-text("Apply Now")',
    'button:has-text("Confirm")',
    'button:has-text("Send Application")',
    'button:has-text("Save & Apply")',
    'button[type="submit"]',
    '.apply-button',
    '#apply-button',
  ];

  for (const sel of submitSelectors) {
    const btn = page.locator(sel).last();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      await sleep(2500);
      return true;
    }
  }

  return false;
}

// ── Try to apply to a single job ──────────────────────────────────────────────
async function applyToJob(page, jobUrl, applied, external) {
  if (applied.has(jobUrl) || external[jobUrl]) return 'skipped';
  if (isBlockedByUrl(jobUrl)) return 'blocked-company';

  try {
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await sleep(1500);

    // Blocklist check using the company name on the page
    const info = await getJobInfo(page);
    if (isBlockedCompany(info.company)) return `blocked-company (${info.company})`;

    // Check for "Apply on company site" / "company website"
    const companySiteSelectors = [
      '#company-site-button',
      'button:has-text("company site")',
      'button:has-text("company website")',
      'button:has-text("Apply on Website")',
      'button:has-text("Apply on company")',
      'a:has-text("company site")',
      'a:has-text("company website")',
      'a:has-text("Apply on Website")',
      'a:has-text("Apply on company")',
      'button[class*="company-site"]',
      'a[class*="company-site"]',
      'button[id*="company-site"]',
    ];

    let extBtn = null;
    for (const sel of companySiteSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        extBtn = el;
        break;
      }
    }

    if (extBtn) {
      log(`  [Company Site Job Detected]: ${info.title || 'Job'} @ ${info.company || 'Company'}`);
      const externalUrl = await getExternalUrl(page, extBtn);
      const nowIST = formatIST();
      external[jobUrl] = {
        title: info.title || 'Software Developer',
        company: info.company || 'Company',
        location: info.location || 'India',
        experience: info.experience || 'Not Disclosed',
        externalUrl: externalUrl || jobUrl,
        naukriUrl: jobUrl,
        postedOn: getJobDate(jobUrl).toISOString().slice(0, 10),
        extractedAt: nowIST,
        extractedAtTimestamp: Date.now(),
        foundOn: new Date().toISOString().slice(0, 10),
      };
      exportExternal(external);
      return 'external';
    }

    // Detect the standard apply button
    const applySelectors = [
      'button.apply-button',
      '#apply-button',
      'button:has-text("Apply")',
      'a:has-text("Apply")',
      'button[id*="apply"]',
      'a[id*="apply"]',
      '[class*="apply-button"]',
    ];

    let btn = null;
    for (const sel of applySelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        btn = el;
        break;
      }
    }

    if (!btn) return 'no-button';

    const btnText = (await btn.textContent().catch(() => '')).toLowerCase();

    // Check if button text indicates external apply
    if (btnText.includes('company site') || btnText.includes('website') || btnText.includes('external')) {
      log(`  [Company Site Job Detected via button text]: ${info.title} @ ${info.company}`);
      const externalUrl = await getExternalUrl(page, btn);
      const nowIST = formatIST();
      external[jobUrl] = {
        title: info.title || 'Software Developer',
        company: info.company || 'Company',
        location: info.location || 'India',
        experience: info.experience || 'Not Disclosed',
        externalUrl: externalUrl || jobUrl,
        naukriUrl: jobUrl,
        postedOn: getJobDate(jobUrl).toISOString().slice(0, 10),
        extractedAt: nowIST,
        extractedAtTimestamp: Date.now(),
        foundOn: new Date().toISOString().slice(0, 10),
      };
      exportExternal(external);
      return 'external';
    }

    if (btnText.includes('already') || btnText.includes('applied')) {
      applied.add(jobUrl);
      saveApplied(applied);
      return 'already-applied';
    }

    if (DRY_RUN) return 'dry-run';

    log(`  Applying to: ${info.title || 'Job'} @ ${info.company || 'Company'}...`);
    await btn.click();
    await sleep(2500);

    // Check if directly submitted without modal
    const successSels = [
      'text=Applied to',
      'text=Application submitted',
      'text=Successfully applied',
      'text=already applied',
      '[class*="apply-message"]',
      '[class*="success-msg"]',
    ];
    for (const s of successSels) {
      if (await page.locator(s).first().isVisible().catch(() => false)) {
        applied.add(jobUrl);
        saveApplied(applied);
        return 'applied';
      }
    }

    // Modal or questionnaire
    const ok = await fillApplyModal(page);
    if (ok) {
      applied.add(jobUrl);
      saveApplied(applied);
      return 'applied';
    }

    for (const s of successSels) {
      if (await page.locator(s).first().isVisible().catch(() => false)) {
        applied.add(jobUrl);
        saveApplied(applied);
        return 'applied';
      }
    }

    return 'modal-failed';
  } catch (err) {
    return `error: ${err.message.slice(0, 100)}`;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const applied  = loadApplied();
  const external = loadExternal();
  for (const [url, job] of Object.entries(external)) {
    if (isBlockedCompany(job.company)) delete external[url];
  }
  let count = 0;
  let externalCount = 0;

  const { injectCookiesIfAvailable } = require('./naukri-profile-refresh');

  const launchArgs = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-position=-32000,-32000',
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

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);
  await injectCookiesIfAvailable(ctx);

  const page = ctx.pages()[0] || (await ctx.newPage());
  log(`=== Auto-apply started${DRY_RUN ? ' (DRY RUN)' : ''} — max ${MAX_PER_RUN} applications ===`);

  outer:
  for (const title of JOB_TITLES) {
    for (const location of LOCATIONS) {
      if (count >= MAX_PER_RUN) break outer;

      log(`Searching: "${title}" in ${location}`);
      let links;
      try {
        links = await collectJobLinks(page, searchUrl(title, location));
        log(`  Found ${links.length} listings`);
      } catch (err) {
        log(`  Search error: ${err.message.slice(0, 80)}`);
        continue;
      }

      for (const url of links) {
        if (count >= MAX_PER_RUN) break outer;

        const result = await applyToJob(page, url, applied, external);

        if (result === 'applied' || result === 'dry-run') {
          count++;
          log(`  ${result === 'dry-run' ? 'DRY-RUN' : 'APPLIED'} [${count}/${MAX_PER_RUN}]: ${url}`);
          saveApplied(applied);
          await sleep(rand(4000, 7000));
        } else if (result === 'external') {
          externalCount++;
          const j = external[url];
          log(`  SAVED EXTERNAL: ${j.title || '?'} @ ${j.company || '?'} → ${j.externalUrl || '(link not captured)'}`);
          exportExternal(external); // save immediately so a crash doesn't lose it
          await sleep(rand(2000, 4000));
        } else if (result !== 'skipped') {
          log(`  SKIP (${result}): ${url}`);
        }
      }
    }
  }

  exportExternal(external);
  log(`=== Done — applied to ${count} jobs | saved ${externalCount} company-site jobs this run (${Object.keys(external).length} total in external-jobs.html) ===`);
  await ctx.close();
})();
