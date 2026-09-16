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
const LOCATIONS        = ['Pune', 'Mumbai', 'Bangalore'];
const EXPERIENCE_YEARS = 3;
const MAX_PER_RUN      = 20; // stop after this many successful applications
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

// ── Extract posting date from a Naukri job URL ───────────────────────────────
// Naukri embeds posting date as DDMMYY right before the 6-digit job ID at the end
// e.g. job-listings-react-developer-infosys-140926012345 → 14 Sep 2026
function getJobDate(url) {
  const match = url.match(/(\d{6})\d{6}$/);
  if (!match) return new Date(0);
  const s = match[1];
  return new Date(2000 + parseInt(s.slice(4, 6)), parseInt(s.slice(2, 4)) - 1, parseInt(s.slice(0, 2)));
}

function isRecentJob(url, daysBack = 3) {
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

  // Only keep actual job listings posted in the last 3 days, newest first
  return links
    .filter((u) => u.includes('naukri.com/job-listings-'))
    .filter((u) => isRecentJob(u, 3))
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
async function applyToJob(page, jobUrl, applied) {
  if (applied.has(jobUrl)) return 'skipped';

  try {
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1000);

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
  const applied = loadApplied();
  let count = 0;

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

        const result = await applyToJob(page, url, applied);

        if (result === 'applied' || result === 'dry-run') {
          count++;
          log(`  ${result === 'dry-run' ? 'DRY-RUN' : 'APPLIED'} [${count}/${MAX_PER_RUN}]: ${url}`);
          saveApplied(applied);
          await sleep(rand(4000, 7000)); // human-like gap between applications
        } else if (result !== 'skipped') {
          log(`  SKIP (${result}): ${url}`);
        }
      }
    }
  }

  log(`=== Done — applied to ${count} jobs this run | total ever: ${applied.size} ===`);
  await ctx.close();
})();
