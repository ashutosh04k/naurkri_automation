/**
 * Export Naukri Chrome session into a compact base64 string
 * for deploying to cloud environments like Render.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROFILE_DIR = path.join(__dirname, '.naukri-chrome-profile');
const OUTPUT_TXT = path.join(__dirname, 'session-env.txt');
const ARCHIVE_FILE = path.join(__dirname, 'naukri-session.tar.gz');

if (!fs.existsSync(PROFILE_DIR)) {
  console.error('Error: .naukri-chrome-profile directory does not exist.');
  console.error('Please run "npm run login" first to sign in locally.');
  process.exit(1);
}

console.log('Packaging session files from .naukri-chrome-profile...');

try {
  // Package essential auth files: Cookies, Local State, Local Storage, Network Persistent State
  const defaultDir = path.join(PROFILE_DIR, 'Default');
  const includePaths = [];

  if (fs.existsSync(path.join(PROFILE_DIR, 'Local State'))) {
    includePaths.push('Local State');
  }
  if (fs.existsSync(path.join(defaultDir, 'Cookies'))) {
    includePaths.push('Default/Cookies');
  }
  if (fs.existsSync(path.join(defaultDir, 'Network Persistent State'))) {
    includePaths.push('Default/Network Persistent State');
  }
  if (fs.existsSync(path.join(defaultDir, 'Local Storage'))) {
    includePaths.push('Default/Local Storage');
  }
  if (fs.existsSync(path.join(defaultDir, 'Session Storage'))) {
    includePaths.push('Default/Session Storage');
  }

  // Create tar.gz with properly quoted file paths
  const quotedPaths = includePaths.map(p => `"${p}"`).join(' ');
  const cmd = `tar -czf "${ARCHIVE_FILE}" -C "${PROFILE_DIR}" ${quotedPaths}`;
  execSync(cmd);

  const archiveBuffer = fs.readFileSync(ARCHIVE_FILE);
  const base64Str = archiveBuffer.toString('base64');

  fs.writeFileSync(OUTPUT_TXT, base64Str);
  fs.unlinkSync(ARCHIVE_FILE);

  console.log('\n============================================================');
  console.log('✅ Session exported successfully!');
  console.log(`📁 Saved base64 string to: ${OUTPUT_TXT} (${Math.round(base64Str.length / 1024)} KB)`);
  console.log('\n👉 On Render:');
  console.log('   Add an Environment Variable named: NAUKRI_SESSION_BASE64');
  console.log('   Value: Paste the contents of session-env.txt');
  console.log('============================================================\n');
} catch (err) {
  console.error('Failed to export session:', err.message);
  process.exit(1);
}
