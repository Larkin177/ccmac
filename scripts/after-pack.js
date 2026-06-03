const { execSync } = require('child_process');
const path = require('path');

// electron-builder afterPack hook: strip quarantine attribute from built .app
// so macOS Gatekeeper won't show "developer not verified" for unsigned apps
module.exports = async function (context) {
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  try {
    // Remove quarantine attribute recursively
    execSync(`xattr -cr "${appPath}"`, { stdio: 'pipe' });
    console.log(`[afterPack] Stripped quarantine from: ${appPath}`);
  } catch (err) {
    console.warn(`[afterPack] Warning: could not strip quarantine: ${err.message}`);
  }
};
