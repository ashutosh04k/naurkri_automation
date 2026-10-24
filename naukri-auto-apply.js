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

const log = (msg) => {
  const line = `[${new Date().toLocaleString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
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
    .sort((a, b) => (b.postedOn || '').localeCompare(a.postedOn || ''));

  // CSV (BOM added so Excel shows special characters correctly)
  const headers = ['Title', 'Company', 'Location', 'Experience', 'Posted On', 'Found On', 'Company Apply Link', 'Naukri Link'];
  const keys    = ['title', 'company', 'location', 'experience', 'postedOn', 'foundOn', 'externalUrl', 'naukriUrl'];
  const csv = [headers, ...rows.map((r) => keys.map((k) => r[k]))]
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
</style></head><body>
<h1>Jobs that apply on company site</h1>
<p class="meta">${rows.length} jobs · last updated ${esc(new Date().toLocaleString())}</p>
<table>
<tr><th>#</th><th>Title</th><th>Company</th><th>Location</th><th>Experience</th><th>Posted</th><th>Apply</th><th>Naukri</th></tr>
${rows.map((r, i) => `<tr>
  <td>${i + 1}</td><td>${esc(r.title)}</td><td>${esc(r.company)}</td>
  <td>${esc(r.location)}</td><td>${esc(r.experience)}</td><td>${esc(r.postedOn)}</td>
  <td>${link(r.externalUrl, 'Company site')}</td><td>${link(r.naukriUrl, 'Listing')}</td>
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
      title:      text(['h1[class*="jd-header-title"]', 'h1']),
      company:    text(['[class*="jd-header-comp-name"] a', '[class*="jd-header-comp-name"]']),
      location:   text(['[class*="jhc__location"]', '[class*="location"] a']),
      experience: text(['[class*="jhc__exp"]']),
    };
  });
}

// ── Click "Apply on company site" and capture where it goes ──────────────────
async function getExternalUrl(page, btn) {
  // If it's a plain link, read the href without clicking
  const href = await btn.getAttribute('href').catch(() => null);
  if (href && !href.startsWith('javascript')) return new URL(href, page.url()).href;

  const before = page.url();
  try {
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 10000 }),
      btn.click(),
    ]);
    await popup.waitForURL((u) => u.href !== 'about:blank', { timeout: 10000 }).catch(() => {});
    await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await sleep(2000); // let redirect chains settle
    const url = popup.url();
    await popup.close().catch(() => {});
    return url === 'about:blank' ? '' : url;
  } catch {
    // No new tab: it may have navigated in the same tab
    await sleep(2000);
    const now = page.url();
    if (now !== before && !now.includes('naukri.com')) {
      await page.goBack().catch(() => {});
      return now;
    }
    return '';
  }
}

// ── Extract posting date from a Naukri job URL ───────────────────────────────
// Naukri embeds posting date as DDMMYY right before the 6-digit job ID at the end
// e.g. job-listings-react-developer-infosys-140926012345 → 14 Sep 2026
function getJobDate(url) {
  const match = url.match(/(\d{6})\d{6}$/);
  if (!match) return new Date(0);
  const s = match[1];
  return new Date(2000 + parseInt(s.slice(4, 6)), parseInt(s.slice(2, 4)) - 1, parseInt(s.slice(0, 2)));
}

function isRecentJob(url, daysBack = 7) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  cutoff.setHours(0, 0, 0, 0);
  return getJobDate(url) >= cutoff;
}

// ── Collect job URLs from a search result page ────────────────────────────────
async function collectJobLinks(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2500);

  const links = await page.$$eval(
    [
      'a.title',
      '.jobtuple-wrapper a[class*="title"]',
      '.cust-job-tuple a[class*="title"]',
      'article.jobTuple a.title',
      '.srp-jobtuple-wrapper a[title]',
    ].join(', '),
    (els) => [...new Set(els.map((el) => el.href).filter(Boolean))]
  );

  // Only keep actual job listings posted in the last 7 days, newest first
  return links
    .filter((u) => u.includes('naukri.com/job-listings-'))
    .filter((u) => isRecentJob(u, 7))
    .sort((a, b) => getJobDate(b) - getJobDate(a));
}

// ── Handle the apply modal / form that appears after clicking Apply ───────────
async function fillApplyModal(page) {
  await sleep(3000);

  // Notice period
  const noticeSel = [
    'select[id*="otice"]', 'select[name*="otice"]',
    'input[placeholder*="otice"]',
  ];
  for (const sel of noticeSel) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      const tag = await el.evaluate((n) => n.tagName.toLowerCase());
      if (tag === 'select') {
        await el.selectOption({ label: /immediate|0/i }).catch(() =>
          el.selectOption({ index: 0 })
        );
      } else {
        await el.fill('0');
      }
      break;
    }
  }

  // Current CTC (blank in .env means skip)
  if (CV.currentCTC) {
    const el = page.locator('input[placeholder*="urrent"]').first();
    if (await el.isVisible().catch(() => false)) await el.fill(CV.currentCTC);
  }

  // Expected CTC
  if (CV.expectedCTC) {
    const el = page.locator('input[placeholder*="xpected"]').first();
    if (await el.isVisible().catch(() => false)) await el.fill(CV.expectedCTC);
  }

  // Try all common Naukri submit button variations
  const submitSelectors = [
    'button:has-text("Apply")',
    'button:has-text("Submit")',
    'button:has-text("APPLY")',
    'button:has-text("Submit Application")',
    'button:has-text("Apply Now")',
    'button:has-text("Confirm")',
    'button:has-text("Send Application")',
    'button[type="submit"]',
    '.apply-button',
    '#apply-button',
    'button.waves-effect',
  ];

  for (const sel of submitSelectors) {
    const btn = page.locator(sel).last();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await sleep(2000);
      return true;
    }
  }

  // Screenshot for debugging when all selectors fail
  await page.screenshot({ path: path.join(__dirname, `modal-failed-${Date.now()}.png`) }).catch(() => {});
  return false;
}

// ── Try to apply to a single job ──────────────────────────────────────────────
async function applyToJob(page, jobUrl, applied, external) {
  if (applied.has(jobUrl) || external[jobUrl]) return 'skipped';
  if (isBlockedByUrl(jobUrl)) return 'blocked-company';

  try {
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1000);

    // Blocklist check using the company name on the page
    const info = await getJobInfo(page);
    if (isBlockedCompany(info.company)) return `blocked-company (${info.company})`;

    // Company-site jobs: record details + redirect link instead of skipping
    const extBtn = page.locator(
      '#company-site-button, button:has-text("company site"), a:has-text("company site")'
    ).first();
    if (await extBtn.isVisible().catch(() => false)) {
      const externalUrl = await getExternalUrl(page, extBtn);
      external[jobUrl] = {
        ...info,
        externalUrl,
        naukriUrl: jobUrl,
        postedOn: getJobDate(jobUrl).toISOString().slice(0, 10),
        foundOn:  new Date().toISOString().slice(0, 10),
      };
      return 'external';
    }

    // Detect the apply button
    const btn = page.locator(
      'button.apply-button, #apply-button, button:has-text("Apply"), a:has-text("Apply")'
    ).first();

    if (!(await btn.isVisible().catch(() => false))) return 'no-button';

    const txt = (await btn.textContent().catch(() => '')).toLowerCase();
    if (txt.includes('applied'))      { applied.add(jobUrl); return 'already-applied'; }
    if (txt.includes('company site')) return 'external';
    if (txt.includes('external'))     return 'external';

    if (DRY_RUN) return 'dry-run';

    await btn.click();
    await sleep(3000);

    // Check if Naukri redirected to a success page (no modal needed)
    const successText = await page.locator('text=Applied to, text=Application submitted, text=Successfully applied').first().isVisible().catch(() => false);
    if (successText) { applied.add(jobUrl); return 'applied'; }

    const ok = await fillApplyModal(page);
    if (ok) { applied.add(jobUrl); return 'applied'; }

    // Check success page one more time after modal interaction
    const successAfter = await page.locator('text=Applied to').first().isVisible().catch(() => false);
    if (successAfter) { applied.add(jobUrl); return 'applied'; }

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

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 850 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--window-position=-32000,-32000',
    ],
  });

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
