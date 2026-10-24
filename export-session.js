/**
 * Export clean, decrypted Naukri session cookies into a portable JSON/base64 format.
 * Works seamlessly across macOS, Linux, Docker, and Render without Keychain encryption issues.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const PROFILE_DIR = path.join(__dirname, '.naukri-chrome-profile');
const OUTPUT_TXT = path.join(__dirname, 'session-env.txt');
const OUTPUT_JSON = path.join(__dirname, 'storage-state.json');

(async () => {
  console.log('Reading session cookies from Chrome profile...');

  let ctx = null;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chrome',
      headless: false,
      args: ['--window-position=-32000,-32000', '--disable-blink-features=AutomationControlled'],
    });

    const cookies = await ctx.cookies();
    const naukriCookies = cookies.filter((c) => c.domain.includes('naukri.com'));

    if (naukriCookies.length === 0) {
      console.error('\n❌ No Naukri cookies found in .naukri-chrome-profile.');
      console.error('Please run "npm run login" first to sign into Naukri.\n');
      process.exit(1);
    }

    const payload = {
      timestamp: new Date().toISOString(),
      cookies: naukriCookies,
    };

    const jsonStr = JSON.stringify(payload, null, 2);
    const base64Str = Buffer.from(JSON.stringify(payload)).toString('base64');

    fs.writeFileSync(OUTPUT_JSON, jsonStr);
    fs.writeFileSync(OUTPUT_TXT, base64Str);

    console.log('\n============================================================');
    console.log('✅ Session cookies exported successfully!');
    console.log(`🍪 Found ${naukriCookies.length} Naukri authentication cookies.`);
    console.log(`📁 1. Plain JSON:  ${OUTPUT_JSON} (${Math.round(jsonStr.length / 1024)} KB)`);
    console.log(`📁 2. Base64 Text: ${OUTPUT_TXT} (${Math.round(base64Str.length / 1024)} KB)`);
    console.log('\n👉 Setup on Render:');
    console.log('   Go to your Service -> Environment -> Secret Files -> "session-env.txt"');
    console.log('   Paste the new content of session-env.txt and click Save Changes.');
    console.log('============================================================\n');
  } catch (err) {
    console.error('Export failed:', err.message);
    process.exit(1);
  } finally {
    if (ctx) await ctx.close();
  }
})();
