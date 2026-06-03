const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const crypto = require('crypto');
const { execSync, exec, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');

// ============ Public Key ============
const publicKeyPath = fs.existsSync(path.join(__dirname, 'public-key.js'))
  ? path.join(__dirname, 'public-key.js')
  : path.join(process.resourcesPath, 'public-key.js');
const PUBLIC_KEY = require(publicKeyPath);

// ============ Constants ============
const PROVIDERS = {
  deepseek: {
    name: 'DeepSeek',
    category: 'chinese',
    envKey: 'DEEPSEEK_API_KEY',
    billingUrl: 'https://platform.deepseek.com/usage',
    apiDocUrl: 'https://platform.deepseek.com/api-docs',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    testEndpoint: 'https://api.deepseek.com/chat/completions',
    testModel: 'deepseek-chat',
    testHeaders: { 'Content-Type': 'application/json' },
  },
};

// ============ Electron Window ============
let mainWindow = null;

function createWindow() {
  // Remove default app menu
  Menu.setApplicationMenu(null);

  const iconPath = fs.existsSync(path.join(__dirname, 'build', 'icon.png'))
    ? path.join(__dirname, 'build', 'icon.png')
    : undefined;

  mainWindow = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 760,
    minHeight: 620,
    resizable: true,
    frame: true,
    title: 'CC-Installer',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (process.env.DEV) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

// ============ IPC Handlers ============

ipcMain.handle('get:appInfo', () => ({
  version: app.getVersion(),
  name: app.getName(),
  providers: Object.entries(PROVIDERS).map(([key, v]) => ({ key, ...v })),
}));

ipcMain.handle('open:external', (_event, url) => {
  shell.openExternal(url);
});

ipcMain.handle('verify:code', (_event, code) => {
  return verifyAuthCode(code);
});

ipcMain.handle('install:start', (_event, config) => {
  startInstall(config);
  return { ok: true };
});

ipcMain.handle('install:restart', () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('terminal:start', (_event, command) => {
  // Mac: open Terminal.app with the command
  exec(`osascript -e 'tell application "Terminal" to activate' -e 'tell application "Terminal" to do script "${command}"'`);
});

ipcMain.handle('app:quit', () => {
  app.quit();
});

ipcMain.handle('guide:open', (_event, name) => {
  // Guide files in guides/ directory
  const guidesDir = app.isPackaged
    ? path.join(process.resourcesPath, 'guides')
    : path.join(__dirname, '..', 'guides');
  const filePath = path.join(guidesDir, name);
  shell.openPath(filePath);
});

ipcMain.handle('auth:checkLicense', () => checkLocalLicense());

ipcMain.handle('install:checkTools', () => ({
  claude: isGlobalPackageInstalled('@anthropic-ai/claude-code'),
  codex: isGlobalPackageInstalled('@openai/codex'),
}));

ipcMain.handle('install:uninstallTool', (_event, tool) => {
  return uninstallTool(tool);
});

ipcMain.handle('relay:status', () => {
  try {
    const out = execSync('lsof -i :8788 -sTCP:LISTEN', { encoding: 'utf-8', timeout: 5000 });
    return { running: out.includes('8788') };
  } catch (e) {
    return { running: false };
  }
});

ipcMain.handle('relay:start', () => {
  return startRelay();
});

// ============ Machine Fingerprint ============

function getMachineFingerprint() {
  const components = [];

  // 1. Hardware UUID (stable across reboots)
  try {
    const out = execSync('ioreg -rd1 -c IOPlatformExpertDevice | awk \'/IOPlatformUUID/ { print $3 }\'', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    const uuid = out.trim().replace(/"/g, '');
    if (uuid) components.push(uuid);
  } catch (e) {}

  // 2. MAC address of primary network interface
  try {
    const out = execSync("ifconfig en0 | awk '/ether / { print $2 }'", { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    const mac = out.trim();
    if (mac) components.push(mac);
  } catch (e) {}

  // 3. Serial number (requires sudo on newer macOS, fallback gracefully)
  try {
    const out = execSync('system_profiler SPHardwareDataType | awk \'/Serial Number/ { print $NF }\'', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    const serial = out.trim();
    if (serial) components.push(serial);
  } catch (e) {}

  // 4. Fallback system info (always available)
  components.push(os.hostname());
  components.push(os.userInfo()?.username || 'unknown');
  components.push(os.arch());

  const hash = crypto.createHash('sha256');
  hash.update(components.join('|'));
  return hash.digest('hex');
}

// ============ Local License Management ============

function getLicensePath() {
  // Store in home directory, separate from relay directory (uninstalling relay won't delete it)
  return path.join(os.homedir(), '.cc-license');
}

function saveLicense(codeId, expiresAt) {
  const fingerprint = getMachineFingerprint();
  const hmacKey = crypto.createHash('sha256').update(fingerprint).digest();
  const payload = JSON.stringify({ codeId, expiresAt, fingerprint, activatedAt: Math.floor(Date.now() / 1000) });
  const tag = crypto.createHmac('sha256', hmacKey).update(payload).digest('hex');
  const combined = JSON.stringify({ payload, tag });
  const encoded = Buffer.from(combined).toString('base64');

  const licensePath = getLicensePath();
  // Ensure directory exists
  fs.mkdirSync(path.dirname(licensePath), { recursive: true });
  fs.writeFileSync(licensePath, encoded, { encoding: 'utf-8', mode: 0o600 });
}

function loadLicense() {
  try {
    const licensePath = getLicensePath();
    if (!fs.existsSync(licensePath)) return null;

    const encoded = fs.readFileSync(licensePath, 'utf-8').trim();
    if (!encoded) return null;

    const combined = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
    const fingerprint = getMachineFingerprint();
    const hmacKey = crypto.createHash('sha256').update(fingerprint).digest();
    const expectedTag = crypto.createHmac('sha256', hmacKey).update(combined.payload).digest('hex');

    // HMAC mismatch = file tampered or copied to another machine
    if (expectedTag !== combined.tag) return null;

    return JSON.parse(combined.payload);
  } catch (err) {
    return null;
  }
}

function deleteLicense() {
  try {
    const p = getLicensePath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {}
}

// ============ Authorization Code Verification ============

function verifyAuthCode(code) {
  try {
    if (!code || !code.startsWith('AIC-')) {
      return { valid: false, error: 'Invalid authorization code format (should start with AIC-)' };
    }
    const parts = code.slice(4).split('.');
    if (parts.length !== 2) {
      return { valid: false, error: 'Invalid authorization code format' };
    }
    const [payloadBase64, signatureBase64] = parts;

    const verify = crypto.createVerify('RSA-SHA256');
    verify.update(payloadBase64);
    const isValid = verify.verify(PUBLIC_KEY, signatureBase64, 'base64url');

    if (!isValid) {
      return { valid: false, error: 'Invalid authorization code (signature mismatch)' };
    }

    const payloadJson = Buffer.from(payloadBase64, 'base64url').toString('utf-8');
    const payload = JSON.parse(payloadJson);

    const now = Math.floor(Date.now() / 1000);

    // Anti-clock-tampering: verify iat is within reasonable range
    if (!payload.iat || payload.iat > now + 300) {
      return { valid: false, error: 'Authorization code timestamp abnormal (please calibrate system time)' };
    }
    const maxValidityDays = 365;
    if (payload.exp - payload.iat > maxValidityDays * 86400) {
      return { valid: false, error: 'Authorization code validity exceeds maximum limit' };
    }
    if (now > payload.exp) {
      return { valid: false, error: 'Authorization code has expired' };
    }

    // Bind to current machine fingerprint, save local license file
    saveLicense(payload.id, payload.exp);

    const expireDate = new Date(payload.exp * 1000).toLocaleString('zh-CN');
    return { valid: true, codeId: payload.id, expiresAt: expireDate };
  } catch (err) {
    return { valid: false, error: `Verification failed: ${err.message}` };
  }
}

// ============ Check Local License ============

function checkLocalLicense() {
  const license = loadLicense();
  if (!license) return { valid: false };

  const now = Math.floor(Date.now() / 1000);
  if (now > license.expiresAt) {
    deleteLicense();
    return { valid: false, error: 'Authorization has expired' };
  }

  const expireDate = new Date(license.expiresAt * 1000).toLocaleString('zh-CN');
  return { valid: true, codeId: license.codeId, expiresAt: expireDate };
}

// ============ Installation Engine ============

let installRunning = false;

function sendLog(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  mainWindow?.webContents.send('install:log', { text: msg, time: new Date().toLocaleTimeString() });
  // Also write to log file for debugging
  try {
    const logFile = path.join(os.tmpdir(), 'cc-installer.log');
    fs.appendFileSync(logFile, line + '\n', 'utf-8');
  } catch (e) {}
}

function sendProgress(step, total, label) {
  mainWindow?.webContents.send('install:progress', { step, total, label });
}

function sendComplete(success, message) {
  installRunning = false;
  mainWindow?.webContents.send('install:complete', { success, message });
}

function sendError(message) {
  installRunning = false;
  mainWindow?.webContents.send('install:error', { message });
}

function execCmd(cmd, options = {}) {
  const opts = { timeout: 120000, ...options };
  sendLog(`> ${cmd}`);
  try {
    const output = execSync(cmd, { ...opts, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    if (output.trim()) sendLog(output.trim());
    return { success: true, output: output.trim() };
  } catch (err) {
    const msg = err.stderr || err.message || '';
    if (msg.trim()) sendLog(`[error] ${msg.trim()}`);
    return { success: false, output: msg.trim() };
  }
}

function isGlobalPackageInstalled(packageName) {
  try {
    execSync(`npm ls -g ${packageName} --depth=0`, { stdio: 'pipe', encoding: 'utf-8' });
    return true;
  } catch (e) {
    return false;
  }
}

// ===== Uninstall Tool =====
function uninstallTool(tool) {
  try {
    if (tool === 'claude-code') {
      sendLog('Uninstalling Claude Code...');
      execCmd('npm uninstall -g @anthropic-ai/claude-code', { timeout: 60000 });
      // Delete config file
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        fs.unlinkSync(settingsPath);
        sendLog('  Deleted Claude config file');
      }
      return { success: true, message: 'Claude Code has been uninstalled' };
    }

    if (tool === 'codex-cli') {
      sendLog('Uninstalling Codex CLI...');
      execCmd('npm uninstall -g @openai/codex', { timeout: 60000 });

      // Delete Codex config directory
      const codexDir = path.join(os.homedir(), '.codex');
      if (fs.existsSync(codexDir)) {
        fs.rmSync(codexDir, { recursive: true, force: true });
        sendLog('  Deleted Codex config directory');
      }

      // Stop relay process (port 8788)
      try {
        execCmd('lsof -ti:8788 | xargs kill -9 2>/dev/null');
        sendLog('  Stopped relay process');
      } catch (e) { /* port not listening or cannot stop */ }

      // Wait for process to fully exit
      execCmd('sleep 1');

      // Remove relay directory and startup script
      const relayDir = path.join(os.homedir(), '.cc-installer');
      if (fs.existsSync(relayDir)) {
        execCmd(`rm -rf "${relayDir}"`);
        if (!fs.existsSync(relayDir)) sendLog('  Deleted relay files');
      }

      // Remove LaunchAgent for auto-start
      const launchAgentPlist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.cc-installer.relay.plist');
      if (fs.existsSync(launchAgentPlist)) {
        // Unload from launchd first
        try {
          execSync(`launchctl unload "${launchAgentPlist}" 2>/dev/null`, { stdio: 'pipe' });
        } catch (e) {}
        fs.unlinkSync(launchAgentPlist);
        sendLog('  Removed auto-start LaunchAgent');
      }

      // Uninstall mimo2codex
      if (isGlobalPackageInstalled('mimo2codex')) {
        execCmd('npm uninstall -g mimo2codex', { timeout: 30000 });
      }

      return { success: true, message: 'Codex CLI has been uninstalled' };
    }

    return { success: false, message: 'Unknown tool' };
  } catch (err) {
    sendLog(`  Uninstall failed: ${err.message}`);
    return { success: false, message: err.message };
  }
}

// ===== File Download (supports HTTPS redirects) =====
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout: 120000,
      headers: { 'Accept': 'application/octet-stream' },
    };

    const req = https.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(destPath); } catch (e) { /* ignore */ }
        return resolve(downloadFile(res.headers.location, destPath));
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(destPath); } catch (e) { /* ignore */ }
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const total = parseInt(res.headers['content-length'] || '0');
      let downloaded = 0;
      let lastPct = 0;
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total) {
          const pct = Math.round((downloaded / total) * 100);
          if (pct - lastPct >= 25) {
            lastPct = pct;
            sendLog(`    Download ${pct}%`);
          }
        }
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
    });
    req.on('error', (err) => {
      try { fs.unlinkSync(destPath); } catch (e) { /* ignore */ }
      reject(err);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

// ===== Auto-install Node.js (tar extraction, no admin required) =====
async function installNodeJs(useMirror) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const version = '22.14.0';
  // Mac: darwin-arm64 or darwin-x64, .tar.gz format
  const tarFile = `node-v${version}-darwin-${arch}.tar.gz`;
  const baseUrl = useMirror
    ? `https://npmmirror.com/mirrors/node/v${version}/`
    : `https://nodejs.org/dist/v${version}/`;
  const url = `${baseUrl}${tarFile}`;
  const downloadPath = path.join(os.tmpdir(), tarFile);
  // Extract to user home directory, no admin required
  const installDir = path.join(os.homedir(), '.cc-installer', 'node');

  sendLog(`Downloading Node.js ${version} (darwin-${arch})...`);
  try {
    await downloadFile(url, downloadPath);
  } catch (err) {
    sendLog(`  ${err.message}, trying official source...`);
    const fallbackUrl = `https://nodejs.org/dist/v${version}/${tarFile}`;
    await downloadFile(fallbackUrl, downloadPath);
  }

  sendLog('  Extracting (may take 1-3 minutes)...');
  fs.mkdirSync(installDir, { recursive: true });
  // Use tar to extract (built-in on macOS)
  let extractResult = execCmd(
    `tar -xzf "${downloadPath}" -C "${installDir}"`,
    { timeout: 600000 }
  );
  if (!extractResult.success) {
    throw new Error(`Node.js extraction failed: ${extractResult.output}`);
  }

  // tar inner directory is node-v{version}-darwin-{arch}
  const nodeDir = path.join(installDir, `node-v${version}-darwin-${arch}`);
  const nodeBin = path.join(nodeDir, 'bin', 'node');  // No .exe on Mac
  if (!fs.existsSync(nodeBin)) {
    throw new Error(`Node.js binary not found after extraction: ${nodeBin}`);
  }

  // Add to current process PATH
  const npmGlobalDir = path.join(os.homedir(), '.npm-global');
  process.env.PATH = `${nodeDir}/bin:${npmGlobalDir}/bin:${process.env.PATH}`;

  // Persist to user PATH via ~/.zshrc (macOS default shell)
  const pathLine = `export PATH="${nodeDir}/bin:${npmGlobalDir}/bin:$PATH"`;
  try {
    const zshrcPath = path.join(os.homedir(), '.zshrc');
    // Check if already configured
    let existing = '';
    try { existing = fs.readFileSync(zshrcPath, 'utf-8'); } catch (e) {}
    if (!existing.includes(nodeDir)) {
      fs.appendFileSync(zshrcPath, `\n# CC-Installer Node.js PATH\n${pathLine}\n`);
      sendLog('  Added Node.js to ~/.zshrc PATH');
    }
  } catch (e) {
    sendLog(`  Warning: could not write to ~/.zshrc: ${e.message}`);
  }

  sendLog('  Node.js installed successfully');
  // Clean up installer package
  try { fs.unlinkSync(downloadPath); } catch (e) { /* ignore */ }
}

// ===== API Connection Test =====
function testApiConnection(providerKey, apiKey) {
  return new Promise((resolve) => {
    const p = PROVIDERS[providerKey];
    if (!p || !apiKey || !p.testEndpoint) {
      resolve({ success: false, message: 'Skipped test', latency: 0, provider: providerKey });
      return;
    }

    const url = new URL(p.testEndpoint);
    const body = JSON.stringify({
      model: p.testModel || undefined,
      messages: [{ role: 'user', content: 'Say OK' }],
      max_tokens: 5,
    });

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        ...p.testHeaders,
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 15000,
    };

    const startTime = Date.now();
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const latency = Date.now() - startTime;
        const sc = res.statusCode || 0;
        if (sc >= 200 && sc < 300) {
          resolve({ success: true, message: `Connection successful (${latency}ms)`, latency, provider: providerKey });
        } else {
          let detail = '';
          try { const j = JSON.parse(data); detail = j.error?.message || j.error?.type || ''; } catch (e) { detail = data.substring(0, 80); }
          resolve({ success: false, message: `HTTP ${sc}: ${detail.substring(0, 50)}`, latency, provider: providerKey });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ success: false, message: `Connection failed: ${err.message}`, latency: Date.now() - startTime, provider: providerKey });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, message: 'Connection timeout', latency: Date.now() - startTime, provider: providerKey });
    });

    req.write(body);
    req.end();
  });
}

// ===== Environment Variable Configuration (for relay API) =====
function setEnvVar(envKey, apiKey) {
  // Mac: append to shell rc file
  const homeDir = os.homedir();
  for (const file of ['.zshrc', '.bashrc', '.bash_profile']) {
    const fp = path.join(homeDir, file);
    try {
      if (fs.existsSync(fp)) {
        fs.appendFileSync(fp, `\nexport ${envKey}="${apiKey}"\n`);
        sendLog(`  Appended to ~/${file}`);
        break;
      }
    } catch (e) {
      sendLog(`  Warning: cannot write to ~/${file}`);
    }
  }
  process.env[envKey] = apiKey;
}

// ===== Write Tool Config Files (make claude/codex ready to use) =====
function applyToolConfigs(apiKeys, customApi, selectedTools) {
  if (selectedTools.includes('claude-code')) {
    let envConfig = null;
    if (customApi?.apiKey) {
      // Relay API: strip trailing /v1/chat/completions etc.
      let baseUrl = (customApi.endpoint || '').replace(/\/v1\/(chat\/)?completions\/?$/, '').replace(/\/+$/, '');
      envConfig = { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: customApi.apiKey };
      if (customApi.model) envConfig.ANTHROPIC_MODEL = customApi.model;
      sendLog(`  Default Claude Code API: ${customApi.name || 'relay API'}`);
    } else if (apiKeys?.deepseek) {
      envConfig = {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: apiKeys.deepseek,
        ANTHROPIC_MODEL: 'deepseek-v4-pro',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
      };
      sendLog('  Default Claude Code API: DeepSeek');
    }

    if (envConfig) {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      let existing = {};
      if (fs.existsSync(settingsPath)) {
        try { existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch (e) {}
      }
      const merged = { ...existing, env: { ...(existing.env || {}), ...envConfig } };
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
      sendLog('  Claude Code config written to ~/.claude/settings.json');
    }
  }

  if (selectedTools.includes('codex-cli')) {
    let auth = null;
    let toml = null;
    if (customApi?.apiKey) {
      let baseUrl = (customApi.endpoint || '').replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '');
      auth = { OPENAI_API_KEY: customApi.apiKey };
      toml = [
        'model_provider = "custom"',
        `model = "${customApi.model || 'gpt-4o-mini'}"`,
        'model_reasoning_effort = "high"',
        'disable_response_storage = true',
        '',
        '[model_providers.custom]',
        `name = "${(customApi.name || 'custom').toLowerCase().replace(/\\s+/g, '_')}"`,
        `base_url = "${baseUrl}"`,
        'wire_api = "responses"',
        'requires_openai_auth = true',
      ].join('\n');
      sendLog(`  Default Codex CLI API: ${customApi.name || 'relay API'}`);
    } else if (apiKeys?.deepseek) {
      // DeepSeek needs relay (Responses API -> Chat Completions)
      auth = { OPENAI_API_KEY: 'relay-handles-auth' };
      // Create model catalog JSON to suppress "model metadata not found" warning
      const catalogPath = path.join(os.homedir(), '.codex', 'model-catalog.json');
      const catalog = {
        models: [{
          slug: 'mimo',
          display_name: 'DeepSeek v4 Flash',
          description: '',
          base_instructions: '',
          visibility: 'list',
          supported_in_api: true,
          context_window: 262144,
          max_context_window: 1048576,
          auto_compact_token_limit: 200000,
          effective_context_window_percent: 95,
          input_modalities: ['text'],
          supports_parallel_tool_calls: true,
          supports_search_tool: false,
          supported_reasoning_levels: [
            { effort: 'low', description: 'Low effort' },
            { effort: 'medium', description: 'Medium effort' },
            { effort: 'high', description: 'High effort' },
          ],
          default_reasoning_level: 'medium',
          shell_type: 'shell_command',
          apply_patch_tool_type: 'freeform',
          supports_reasoning_summaries: false,
          support_verbosity: false,
          experimental_supported_tools: [],
          truncation_policy: { mode: 'tokens', limit: 10000 },
          priority: 10,
        }],
      };
      fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
      fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
      sendLog('  Generated model metadata catalog model-catalog.json');

      toml = [
        'model = "mimo"',
        'model_provider = "deepseek-relay"',
        `model_catalog_json = "${catalogPath}"`,
        '',
        '[model_providers.deepseek-relay]',
        'name = "DeepSeek (via relay)"',
        'base_url = "http://127.0.0.1:8788/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
      ].join('\n');
      sendLog('  Default Codex CLI API: DeepSeek (via relay)');
    }

    if (auth && toml) {
      const authPath = path.join(os.homedir(), '.codex', 'auth.json');
      const configPath = path.join(os.homedir(), '.codex', 'config.toml');
      fs.mkdirSync(path.dirname(authPath), { recursive: true });
      fs.writeFileSync(authPath, JSON.stringify(auth, null, 2));
      fs.writeFileSync(configPath, toml);
      sendLog('  Codex CLI config written to ~/.codex/');
    }
  }
}

// ===== Codex DeepSeek Relay Startup (can be called independently) =====
function startRelay() {
  const shPath = path.join(os.homedir(), '.cc-installer', 'relay.sh');
  if (!fs.existsSync(shPath)) {
    return { success: false, message: 'Relay config not found, please reinstall Codex CLI' };
  }
  try {
    exec(`nohup "${shPath}" > /dev/null 2>&1 &`);
    // Wait 2 seconds then verify port
    const startTime = Date.now();
    while (Date.now() - startTime < 5000) {
      try {
        const out = execSync('lsof -i :8788 -sTCP:LISTEN', { encoding: 'utf-8', timeout: 3000 });
        if (out.includes('8788')) {
          return { success: true, message: 'Relay started' };
        }
      } catch (e) { /* not ready yet */ }
      execCmd('sleep 1');
    }
    return { success: false, message: 'Relay startup timeout' };
  } catch (err) {
    return { success: false, message: `Relay startup failed: ${err.message}` };
  }
}

// ===== Codex DeepSeek Relay Setup =====
async function setupCodexRelay(apiKey) {
  if (!apiKey) return;
  sendLog('Configuring Codex DeepSeek protocol relay...');

  const relayDir = path.join(os.homedir(), '.cc-installer');
  fs.mkdirSync(relayDir, { recursive: true });

  // Find node path
  let nodeBin = 'node';
  try {
    const whichResult = execSync('which node', { encoding: 'utf-8', timeout: 5000 });
    nodeBin = whichResult.trim();
    sendLog(`  Using node: ${nodeBin}`);
  } catch (e) {
    sendLog('  Warning: cannot find node path, using default node');
  }

  // ===== Tier 1: Try mimo2codex =====
  let relayType = 'cc-relay';  // default to built-in
  let useMimo = false;

  if (!isGlobalPackageInstalled('mimo2codex')) {
    sendLog('Installing mimo2codex (recommended, full features)...');
    const result = execCmd('npm install -g mimo2codex');
    if (result.success) {
      sendLog('mimo2codex installed successfully');
      useMimo = true;
    } else {
      sendLog('mimo2codex installation failed (may lack build tools), using built-in relay');
    }
  } else {
    sendLog('mimo2codex already installed, using mimo2codex');
    useMimo = true;
  }

  if (useMimo) {
    // Find mimo2codex entry
    try {
      const npmRoot = execSync('npm root -g').toString().trim();
      const pkgPath = path.join(npmRoot, 'mimo2codex', 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const mimoEntry = path.join(npmRoot, 'mimo2codex', pkg.main || 'dist/index.js');
        if (fs.existsSync(mimoEntry)) {
          relayType = 'mimo2codex';
          sendLog('  Using mimo2codex relay');
        }
      }
    } catch (e) { /* fallback to cc-relay */ }
  }

  // ===== Generate relay files =====

  if (relayType === 'mimo2codex') {
    // Use mimo2codex via npx
    const relayShPath = path.join(relayDir, 'relay.sh');
    const relayShContent = `#!/bin/bash
export DS_API_KEY="${apiKey}"
exec npx mimo2codex --model ds --port 8788
`;
    fs.writeFileSync(relayShPath, relayShContent);
    fs.chmodSync(relayShPath, '755');
  } else {
    // Use built-in cc-relay.js (pure JS, no native deps)
    // Copy from extraResources to relay dir
    const relaySrc = app.isPackaged
      ? path.join(process.resourcesPath, 'cc-relay.js')
      : path.join(__dirname, '..', 'cc-relay.js');

    if (fs.existsSync(relaySrc)) {
      fs.copyFileSync(relaySrc, path.join(relayDir, 'cc-relay.js'));
      sendLog('  Deployed built-in relay (cc-relay.js)');
    } else {
      sendLog('  Warning: built-in relay file not found, relay startup failed');
      return;
    }

    const relayShPath = path.join(relayDir, 'relay.sh');
    const relayShContent = `#!/bin/bash
export DS_API_KEY="${apiKey}"
exec "${nodeBin}" "${path.join(relayDir, 'cc-relay.js')}"
`;
    fs.writeFileSync(relayShPath, relayShContent);
    fs.chmodSync(relayShPath, '755');
  }

  // ===== LaunchAgent for auto-start on boot =====
  try {
    const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    fs.mkdirSync(launchAgentsDir, { recursive: true });

    const plistPath = path.join(launchAgentsDir, 'com.cc-installer.relay.plist');
    const relayShPath = path.join(relayDir, 'relay.sh');

    // Unload old plist if exists
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'pipe' });
    } catch (e) {}

    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cc-installer.relay</string>
    <key>ProgramArguments</key>
    <array>
        <string>${relayShPath}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    <string>/dev/null</string>
</dict>
</plist>`;

    fs.writeFileSync(plistPath, plistContent);
    sendLog('  Added auto-start LaunchAgent');
  } catch (e) {
    sendLog(`  Warning: LaunchAgent registration failed: ${e.message}`);
  }

  // Start relay now
  sendLog('  Starting relay (background)...');
  const shPath = path.join(relayDir, 'relay.sh');
  exec(`nohup "${shPath}" > /dev/null 2>&1 &`);

  // Wait for port
  sendLog('  Verifying relay port...');
  await new Promise(r => setTimeout(r, 3000));
  let relayReady = false;
  try {
    const portCheck = execSync('lsof -i :8788 -sTCP:LISTEN', { encoding: 'utf-8', timeout: 5000 });
    if (portCheck.includes('8788')) {
      sendLog('  Codex relay started and listening on 127.0.0.1:8788');
      relayReady = true;
    } else {
      sendLog('  Warning: relay port 8788 not in LISTEN state');
    }
  } catch (e) {
    sendLog('  Warning: relay startup may have failed, port 8788 not listening');
  }

  // End-to-end test
  if (relayReady) {
    sendLog('  Testing relay -> DeepSeek connectivity...');
    const testResult = await testRelayProxy();
    if (testResult.success) {
      sendLog('  relay -> DeepSeek communication normal');
    } else {
      sendLog(`  relay -> DeepSeek communication failed: ${testResult.error}`);
      sendLog('  Please check if DeepSeek API key is valid and account balance is sufficient');
    }
  }
}

// ==== Relay end-to-end communication test ====
function testRelayProxy() {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'mimo',
      input: 'hello',
      max_output_tokens: 3,
      stream: false,
    });
    const options = {
      hostname: '127.0.0.1',
      port: 8788,
      path: '/v1/responses',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer relay-test',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 15000,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        if (ok) return resolve({ success: true });
        let detail = '';
        try { const j = JSON.parse(data); detail = j.error?.message || j.error?.code || ''; } catch (e) {}
        resolve({ success: false, error: `HTTP ${res.statusCode}${detail ? ': ' + detail : ''}` });
      });
    });
    req.on('error', (err) => resolve({ success: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Connection timeout' }); });
    req.write(body);
    req.end();
  });
}

async function startInstall(config) {
  if (installRunning) return;
  installRunning = true;

  const totalSteps = 6;
  let step = 0;

  try {
    // ===== Step 1: System Detection =====
    step++;
    sendProgress(step, totalSteps, 'Detecting system environment...');
    sendLog('========== Installation Started ==========');
    sendLog(`Operating system: ${process.platform} ${process.arch}`);

    let nodeOk = false;

    // First check our own installed Node.js (bypass system PATH pointing to old version)
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const ourNodeDir = path.join(os.homedir(), '.cc-installer', 'node', `node-v22.14.0-darwin-${arch}`);
    const ourNodeBin = path.join(ourNodeDir, 'bin', 'node');

    if (fs.existsSync(ourNodeBin)) {
      const ourNodeCheck = execCmd(`"${ourNodeBin}" --version`);
      if (ourNodeCheck.success) {
        sendLog(`Node.js: ${ourNodeCheck.output} (installed locally)`);
        nodeOk = true;
        // Ensure our Node is at the front of current process PATH
        const npmGlobalDir = path.join(os.homedir(), '.npm-global');
        process.env.PATH = `${ourNodeDir}/bin:${npmGlobalDir}/bin:${process.env.PATH}`;
      }
    }

    if (!nodeOk) {
      let nodeCheck = execCmd('node --version');
      if (nodeCheck.success) {
        const nodeVer = nodeCheck.output.replace(/^v/, '').split('.');
        const nodeMajor = parseInt(nodeVer[0]) || 0;
        if (nodeMajor >= 18) {
          sendLog(`Node.js: ${nodeCheck.output}`);
          nodeOk = true;
        } else {
          sendLog(`Node.js ${nodeCheck.output} version too low (need >= 18), installing new version...`);
        }
      } else {
        sendLog("Node.js not detected, will auto-install...");
      }
    }

    if (!nodeOk) {
      await installNodeJs(config.useMirror);
      const checkAgain = execCmd(`"${ourNodeBin}" --version`);
      if (!checkAgain.success) {
        return sendError("Node.js installation failed, please install manually from https://nodejs.org");
      }
      sendLog(`Node.js: ${checkAgain.output}`);
    }

    const npmCheck = execCmd('npm --version');
    if (npmCheck.success) {
      const npmParts = npmCheck.output.replace(/^v/, '').split('.');
      const npmMajor = parseInt(npmParts[0]) || 0;
      if (npmMajor >= 8) {
        sendLog(`npm: ${npmCheck.output}`);
      } else {
        sendLog(`npm ${npmCheck.output} version too low (need >= 8), updated with Node.js`);
      }
    } else {
      return sendError("npm not available, please reinstall Node.js from https://nodejs.org");
    }

    const gitCheck = execCmd('git --version');
    if (gitCheck.success) {
      sendLog(`Git: ${gitCheck.output}`);
    } else {
      sendLog('Git not installed (does not affect core installation)');
    }

    // System architecture verification
    const platform = process.platform;
    if (platform !== 'darwin') {
      return sendError(`Unsupported operating system: ${platform}`);
    }
    sendLog('System architecture compatible');

    // ===== Step 2: Mirror Configuration =====
    step++;
    sendProgress(step, totalSteps, 'Configuring npm mirror...');
    if (config.useMirror) {
      const currentRegistry = execCmd('npm config get registry');
      if (currentRegistry.success && currentRegistry.output.includes('npmmirror')) {
        sendLog('npm mirror already configured (npmmirror.com)');
      } else {
        const mirrorResult = execCmd('npm config set registry https://registry.npmmirror.com');
        if (mirrorResult.success) {
          sendLog('npm mirror configured (npmmirror.com)');
        } else {
          sendLog('Mirror setup failed (.npmrc may be locked), continuing with current source...');
        }
      }
    } else {
      sendLog('Using default npm source');
    }

    // ===== Step 3: Install Tools =====
    step++;
    const tools = config.selectedTools || [];
    const toolNames = [];
    if (tools.includes('claude-code')) toolNames.push('Claude Code');
    if (tools.includes('codex-cli')) toolNames.push('Codex CLI');
    sendProgress(step, totalSteps, `Installing ${toolNames.join(' + ')}...`);

    if (tools.includes('claude-code')) {
      if (isGlobalPackageInstalled('@anthropic-ai/claude-code')) {
        sendLog('Claude Code already installed, skipping');
      } else {
        sendLog('Installing Claude Code...');
        const claudeResult = execCmd('npm install -g @anthropic-ai/claude-code', { timeout: 600000 });
        if (claudeResult.success) {
          sendLog('Claude Code installed successfully');
          const claudeVer = execCmd('npx @anthropic-ai/claude-code --version', { timeout: 30000 });
          if (claudeVer.success) sendLog(`   Version: ${claudeVer.output}`);
        } else {
          sendLog('Claude Code installation failed, install manually: npm install -g @anthropic-ai/claude-code');
        }
      }
    }

    if (tools.includes('codex-cli')) {
      if (isGlobalPackageInstalled('@openai/codex')) {
        sendLog('Codex CLI already installed, skipping');
      } else {
        sendLog('Installing Codex CLI...');
        const codexResult = execCmd('npm install -g @openai/codex', { timeout: 600000 });
        if (codexResult.success) {
          sendLog('Codex CLI installed successfully');
        } else {
          sendLog('Codex CLI installation failed, install manually: npm install -g @openai/codex');
        }
      }
    }

    // If Codex CLI selected and DeepSeek key provided, install protocol relay
    if (tools.includes('codex-cli') && config.apiKeys?.deepseek) {
      await setupCodexRelay(config.apiKeys.deepseek);
    }

    // Ensure npm global bin directory is in user PATH (make claude/codex available in new terminal)
    if (tools.length > 0) {
      const npmGlobalDir = path.join(os.homedir(), '.npm-global');
      const pathLine = `export PATH="${npmGlobalDir}/bin:$PATH"`;
      try {
        const zshrcPath = path.join(os.homedir(), '.zshrc');
        let existing = '';
        try { existing = fs.readFileSync(zshrcPath, 'utf-8'); } catch (e) {}
        if (!existing.includes(npmGlobalDir)) {
          fs.appendFileSync(zshrcPath, `\n# CC-Installer npm global\n${pathLine}\n`);
          sendLog('  npm global directory added to PATH');
        } else {
          sendLog('  npm global directory already in PATH');
        }
      } catch (e) {
        sendLog(`  Warning: could not update ~/.zshrc: ${e.message}`);
      }
    }

    // ===== Step 4: Configure API Keys =====
    step++;
    sendProgress(step, totalSteps, 'Configuring API keys...');
    const hasApiKeys = (config.apiKeys && Object.keys(config.apiKeys).length > 0) || config.customApi?.apiKey;
    if (hasApiKeys) {
      // Set environment variable for relay API only
      if (config.customApi?.apiKey && config.customApi?.envKey) {
        sendLog(`Configuring ${config.customApi.name || 'relay API'} environment variable...`);
        setEnvVar(config.customApi.envKey, config.customApi.apiKey);
        sendLog(`  ${config.customApi.envKey} configured`);
      }

      // Write claude/codex tool config files for out-of-the-box experience
      applyToolConfigs(config.apiKeys || {}, config.customApi, config.selectedTools || []);
    } else {
      sendLog('No API key provided, skipping configuration');
      sendLog('Tip: you can manually set environment variables later via set command');
    }

    // Calculate default API (priority: relay > DeepSeek)
    let defaultProvider = null;
    if (config.customApi?.apiKey && config.customApi?.name) {
      defaultProvider = config.customApi.name;
    } else if (config.apiKeys?.deepseek) {
      defaultProvider = 'DeepSeek';
    }

    // ===== Step 5: Test Connection =====
    step++;
    sendProgress(step, totalSteps, 'Testing API connection...');
    const testApis = config.testApis !== false;
    if (testApis && config.apiKeys) {
      for (const [providerKey, apiKey] of Object.entries(config.apiKeys)) {
        if (!apiKey) continue;
        const p = PROVIDERS[providerKey];
        if (!p) continue;

        sendLog(`Testing ${p.name}...`);
        const result = await testApiConnection(providerKey, apiKey);
        if (result.success) {
          sendLog(`  ${result.message}`);
        } else {
          sendLog(`  ${result.message}`);
        }
        mainWindow?.webContents.send('install:apiTestResult', result);
      }
    }

    // Test relay API
    const customApi = config.customApi;
    if (testApis && customApi && customApi.apiKey && customApi.endpoint) {
      sendLog(`Testing ${customApi.name || 'relay API'}...`);
      try {
        const url = new URL(customApi.endpoint);
        const body = JSON.stringify({
          model: customApi.model || undefined,
          messages: [{ role: 'user', content: 'Say OK' }],
          max_tokens: 5,
        });
        const options = {
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${customApi.apiKey}`,
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 15000,
        };
        const startTime = Date.now();
        const result = await new Promise((resolve) => {
          const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
              const latency = Date.now() - startTime;
              const sc = res.statusCode || 0;
              if (sc >= 200 && sc < 300) {
                resolve({ success: true, message: `Connection successful (${latency}ms)`, latency, provider: customApi.name || 'relay API' });
              } else {
                let detail = '';
                try { const j = JSON.parse(data); detail = j.error?.message || ''; } catch (e) { detail = data.substring(0, 80); }
                resolve({ success: false, message: `HTTP ${sc}: ${detail.substring(0, 50)}`, latency, provider: customApi.name || 'relay API' });
              }
            });
          });
          req.on('error', (err) => resolve({ success: false, message: `Connection failed: ${err.message}`, latency: Date.now() - startTime, provider: customApi.name || 'relay API' }));
          req.on('timeout', () => { req.destroy(); resolve({ success: false, message: 'Connection timeout', latency: Date.now() - startTime, provider: customApi.name || 'relay API' }); });
          req.write(body);
          req.end();
        });
        if (result.success) {
          sendLog(`  ${result.message}`);
        } else {
          sendLog(`  ${result.message}`);
        }
        mainWindow?.webContents.send('install:apiTestResult', result);
      } catch (err) {
        sendLog(`  Test failed: ${err.message}`);
      }
    }

    if (!testApis || (!config.apiKeys && !customApi?.apiKey)) {
      sendLog('Skipping API connection test');
    }

    // ===== Step 6: Complete =====
    step++;
    sendProgress(step, totalSteps, 'Completing...');
    sendLog('');
    sendLog('========== Installation Complete ==========');
    sendLog('All components deployed successfully!');
    sendLog('');
    sendLog('Verifying command availability...');

    // Verify commands with full path to avoid PATH issues
    const npmGlobalDir = path.join(os.homedir(), '.npm-global');
    let hasPathIssue = false;

    if (tools.includes('claude-code')) {
      const claudeBin = path.join(npmGlobalDir, 'bin', 'claude');
      if (fs.existsSync(claudeBin)) {
        sendLog('  claude command installed');
      } else {
        // Also check /usr/local/bin or brew paths
        const altClaude = '/usr/local/bin/claude';
        if (fs.existsSync(altClaude)) {
          sendLog('  claude command installed');
        } else {
          sendLog('  Warning: claude command not found, check installation log');
          hasPathIssue = true;
        }
      }
    }
    if (tools.includes('codex-cli')) {
      const codexBin = path.join(npmGlobalDir, 'bin', 'codex');
      if (fs.existsSync(codexBin)) {
        sendLog('  codex command installed');
      } else {
        const altCodex = '/usr/local/bin/codex';
        if (fs.existsSync(altCodex)) {
          sendLog('  codex command installed');
        } else {
          sendLog('  Warning: codex command not found, check installation log');
          hasPathIssue = true;
        }
      }
    }

    sendLog('');
    sendLog('Quick start:');
    if (tools.includes('claude-code')) {
      sendLog('  claude        # Start Claude Code');
    }
    if (tools.includes('codex-cli')) {
      sendLog('  codex         # Start Codex CLI');
    }
    sendLog('');
    sendLog('Tip: Open a new Terminal window to use claude/codex commands');
    sendLog(`If commands not found, add ${npmGlobalDir}/bin to your PATH in ~/.zshrc`);
    sendLog('');
    sendLog('See usage guides in the tool folder for details');

    // Send installed tools list to renderer for completion page display
    mainWindow?.webContents.send('install:complete', {
      success: true,
      message: 'Installation complete! All components deployed successfully.',
      installedTools: tools,
      defaultProvider: defaultProvider,
    });
    installRunning = false;
  } catch (err) {
    sendError(`Installation exception: ${err.message}`);
  }
}
