// ============ State ============
let state = {
  verified: false,
  codeId: null,
  expiresAt: null,
  selectedTools: ['claude-code', 'codex-cli'],
  apiKeys: {},
  customApi: null,
  installActive: false,
};

// ============ App Info ============
let appInfo = null;
window.api.getAppInfo().then(info => {
  appInfo = info;
  // 检测环境决定显示哪个屏
  checkEnvironment();
});

// ============ Screen Navigation ============
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ============ Authorization ============
async function verifyCode() {
  const input = document.getElementById('authCodeInput');
  const errorEl = document.getElementById('authError');
  const successEl = document.getElementById('authSuccess');
  const btn = document.getElementById('btnVerify');

  const code = input.value.trim();
  if (!code) {
    showError('请输入授权码');
    return;
  }

  btn.disabled = true;
  btn.textContent = '验证中...';
  errorEl.style.display = 'none';
  successEl.style.display = 'none';

  try {
    const result = await window.api.verifyCode(code);
    if (result.valid) {
      state.verified = true;
      state.codeId = result.codeId;
      state.expiresAt = result.expiresAt;
      successEl.textContent = '✅ 授权码有效，有效期至 ' + result.expiresAt;
      successEl.style.display = 'block';
      input.style.borderColor = '#22c55e';
      setTimeout(() => showScreen('screen-tool-select'), 800);
    } else {
      showError(result.error);
    }
  } catch (err) {
    showError('验证失败: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '验证授权';
  }
}

function showError(msg) {
  const el = document.getElementById('authError');
  el.textContent = '❌ ' + msg;
  el.style.display = 'block';
  document.getElementById('authSuccess').style.display = 'none';
}

function backToAuth() {
  // 清除授权状态
  state.verified = false;
  state.codeId = null;
  state.expiresAt = null;
  state.selectedTools = ['claude-code', 'codex-cli'];
  state.apiKeys = {};
  state.customApi = null;
  // 重置 UI
  document.getElementById('authCodeInput').value = '';
  document.getElementById('authCodeInput').style.borderColor = '';
  document.getElementById('authError').style.display = 'none';
  document.getElementById('authSuccess').style.display = 'none';
  showScreen('screen-auth');
}

// ============ 环境检测 & 管理面板 ============
async function checkEnvironment() {
  try {
    // 先检查本地授权（无论工具是否已安装，都需先验证授权）
    const license = await window.api.checkLicense();
    if (license && license.valid) {
      state.verified = true;
      state.codeId = license.codeId;
      state.expiresAt = license.expiresAt;
      // 授权有效 → 进入管理面板
      const tools = await window.api.checkTools();
      renderManageScreen(tools.claude, tools.codex);
      showScreen('screen-manage');
      return;
    }
  } catch (e) {
    // license 检查失败，忽略
  }
  // 无有效授权 → 始终显示授权码验证
  showScreen('screen-auth');
}

function renderManageScreen(hasClaude, hasCodex) {
  // Claude Code 状态
  const badgeClaude = document.getElementById('badgeClaude');
  const descClaude = document.getElementById('descClaude');
  badgeClaude.textContent = hasClaude ? '已安装' : '未安装';
  badgeClaude.className = 'status-badge ' + (hasClaude ? 'installed' : 'missing');
  descClaude.textContent = hasClaude
    ? 'Anthropic 官方 AI 编码助手 · 已就绪'
    : 'Anthropic 官方 AI 编码助手 · 尚未安装';
  document.getElementById('btnLaunchClaudeMgmt').classList.toggle('hidden', !hasClaude);
  document.getElementById('btnUninstallClaude').classList.toggle('hidden', !hasClaude);
  document.getElementById('btnInstallClaude').classList.toggle('hidden', hasClaude);

  // Codex CLI 状态
  const badgeCodex = document.getElementById('badgeCodex');
  const descCodex = document.getElementById('descCodex');
  badgeCodex.textContent = hasCodex ? '已安装' : '未安装';
  badgeCodex.className = 'status-badge ' + (hasCodex ? 'installed' : 'missing');
  descCodex.textContent = hasCodex
    ? 'OpenAI 官方 AI 编码助手 · 已就绪'
    : 'OpenAI 官方 AI 编码助手 · 尚未安装';
  document.getElementById('btnLaunchCodexMgmt').classList.toggle('hidden', !hasCodex);
  document.getElementById('btnUninstallCodex').classList.toggle('hidden', !hasCodex);
  document.getElementById('btnInstallCodex').classList.toggle('hidden', hasCodex);

  // 更新顶部说明
  const total = (hasClaude ? 1 : 0) + (hasCodex ? 1 : 0);
  document.getElementById('manageStatusText').textContent =
    total === 2 ? '已安装 Claude Code 和 Codex CLI，选择操作：'
    : total === 1 ? '检测到已安装部分工具，选择操作：'
    : '正在检测已安装的工具...';

  // 检查 relay 状态（如果装了 Codex）
  if (hasCodex) {
    checkRelayStatus();
  }
}

async function checkRelayStatus() {
  const panel = document.getElementById('relayStatusPanel');
  const text = document.getElementById('relayStatusText');
  const btn = document.getElementById('btnStartRelay');
  panel.classList.remove('hidden');
  btn.classList.add('hidden');
  text.textContent = '检查 relay 状态...';
  try {
    const status = await window.api.relayStatus();
    if (status.running) {
      text.textContent = '✅ Relay 运行正常 (127.0.0.1:8788) — Codex 可通过 DeepSeek 访问';
    } else {
      text.textContent = '❌ Relay 未运行，点击「启动 Relay」按钮启动';
      btn.classList.remove('hidden');
    }
  } catch (e) {
    text.textContent = '❌ Relay 状态检测失败';
    btn.classList.remove('hidden');
  }
}

async function startRelay() {
  const btn = document.getElementById('btnStartRelay');
  const text = document.getElementById('relayStatusText');
  btn.disabled = true;
  text.textContent = '正在启动 relay...';
  try {
    const result = await window.api.relayStart();
    if (result.success) {
      text.textContent = '✅ Relay 已启动 (127.0.0.1:8788)';
      btn.classList.add('hidden');
    } else {
      text.textContent = '❌ ' + result.message;
    }
  } catch (err) {
    text.textContent = '❌ 启动失败: ' + err.message;
  }
  btn.disabled = false;
}

async function uninstallTool(tool) {
  const name = tool === 'claude-code' ? 'Claude Code' : 'Codex CLI';
  if (!confirm(`确定要卸载 ${name} 吗？\n\n这将删除 ${name} 及其相关配置文件。`)) return;

  try {
    const result = await window.api.uninstallTool(tool);
    if (result.success) {
      showToast(result.message, 2000);
      // 重新检测环境
      const tools = await window.api.checkTools();
      renderManageScreen(tools.claude, tools.codex);
    } else {
      alert('卸载失败: ' + result.message);
    }
  } catch (err) {
    alert('卸载失败: ' + err.message);
  }
}

function goToInstall(tool) {
  // 预选指定工具，然后跳转到工具选择屏
  state.selectedTools = [tool];
  document.querySelectorAll('.tool-card').forEach(c => {
    c.classList.toggle('selected', state.selectedTools.includes(c.dataset.tool));
  });
  document.getElementById('btnToolNext').disabled = false;
  showScreen('screen-tool-select');
}

// ============ Tool Selection ============
function toggleTool(tool) {
  const idx = state.selectedTools.indexOf(tool);
  if (idx >= 0 && state.selectedTools.length > 1) {
    state.selectedTools.splice(idx, 1);
  } else if (idx < 0) {
    state.selectedTools.push(tool);
  }
  document.querySelectorAll('.tool-card').forEach(c => {
    c.classList.toggle('selected', state.selectedTools.includes(c.dataset.tool));
  });
  document.getElementById('btnToolNext').disabled = state.selectedTools.length === 0;
}

// ============ API Key 收集 ============
// DeepSeek 输入框已在 HTML 中硬编码，这里只负责收集

function collectApiKeys() {
  const inputs = document.querySelectorAll('.api-key-input');
  const keys = {};
  inputs.forEach(input => {
    const val = input.value.trim();
    if (val) {
      keys[input.dataset.provider] = val;
    }
  });
  state.apiKeys = keys;

  // 收集自用中转 API 配置
  const customApiKey = document.getElementById('customApiKey').value.trim();
  if (customApiKey) {
    state.customApi = {
      name: document.getElementById('customApiName').value.trim(),
      endpoint: document.getElementById('customApiEndpoint').value.trim(),
      apiKey: customApiKey,
      model: document.getElementById('customApiModel').value.trim(),
      envKey: document.getElementById('customApiEnvKey').value.trim() || 'CUSTOM_API_KEY',
    };
  } else {
    state.customApi = null;
  }
}

// ============ Install ============
async function startInstall() {
  collectApiKeys();
  if (state.installActive) return;

  // 验证至少配置了一个 API
  const hasDeepSeek = !!(state.apiKeys && state.apiKeys.deepseek);
  const hasCustom = state.customApi !== null;
  const apiError = document.getElementById('apiKeyError');
  if (!hasDeepSeek && !hasCustom) {
    apiError.textContent = '⚠️ 请先配置 API 密钥，可参照上方文档或使用自用中转 API！';
    apiError.style.display = 'block';
    document.getElementById('btnInstallStart').scrollIntoView({ behavior: 'smooth' });
    return;
  } else {
    apiError.style.display = 'none';
  }

  state.installActive = true;

  const useMirror = document.getElementById('chkMirror').checked;

  showScreen('screen-install');
  document.getElementById('installStatus').textContent = '正在准备安装环境...';

  const steps = ['系统检测', '镜像配置', '安装工具', '配置密钥', '测试连接', '完成'];
  const stepContainer = document.getElementById('stepIndicators');
  stepContainer.innerHTML = steps.map((s, i) =>
    '<span class="step-tag" data-step="' + i + '">' + s + '</span>'
  ).join('');

  setProgress(0, steps.length, '');
  document.getElementById('logBody').innerHTML = '';
  document.getElementById('testResultsBody').innerHTML = '';
  document.getElementById('apiTestResults').style.display = 'none';

  const unsubLog = window.api.onInstallLog((data) => { appendLog(data.text); });
  const unsubProg = window.api.onInstallProgress((data) => {
    setProgress(data.step, data.total, data.label);
    updateStepIndicator(data.step - 1, data.step === data.total ? 'done' : 'active');
  });
  const unsubTest = window.api.onInstallApiTestResult((data) => {
    showApiTestResult(data);
  });
  const unsubDone = window.api.onInstallComplete((data) => {
    state.installActive = false;
    document.getElementById('installStatus').textContent = '✅ ' + data.message;
    // Show "下一步" button instead of auto-navigating
    document.getElementById('btnInstallNext').classList.remove('hidden');
    document.getElementById('btnRetry').classList.remove('hidden');
    if (data.success) {
      // Show launch buttons for installed tools
      const tools = data.installedTools || [];
      if (tools.includes('claude-code')) document.getElementById('btnLaunchClaude').style.display = 'inline-flex';
      if (tools.includes('codex-cli')) document.getElementById('btnLaunchCodex').style.display = 'inline-flex';
      // Show toast for default API provider
      if (data.defaultProvider) {
        showToast('默认使用 ' + data.defaultProvider + ' API', 1500);
      }
    }
    setProgress(steps.length, steps.length, data.success ? '完成' : '失败');
    updateStepIndicator(steps.length - 1, data.success ? 'done' : 'error');
    unsubLog(); unsubProg(); unsubTest(); unsubDone();
  });
  const unsubErr = window.api.onInstallError((data) => {
    state.installActive = false;
    document.getElementById('installStatus').textContent = '❌ ' + data.message;
    document.getElementById('btnRetry').classList.remove('hidden');
    appendLog('❌ ' + data.message, 'error');
    updateStepIndicator(-1, 'error');
    unsubLog(); unsubProg(); unsubTest(); unsubDone();
  });

  window.api.startInstall({
    selectedTools: state.selectedTools,
    apiKeys: state.apiKeys,
    customApi: state.customApi,
    useMirror: useMirror,
    testApis: true,
  });

  document.querySelector('.progress-bar').classList.add('installing');
}

function showApiTestResult(data) {
  const panel = document.getElementById('apiTestResults');
  const body = document.getElementById('testResultsBody');
  panel.style.display = 'block';
  const row = document.createElement('div');
  row.className = 'test-row ' + (data.success ? 'test-pass' : 'test-fail');
  row.innerHTML =
    '<span class="test-icon">' + (data.success ? '✅' : '❌') + '</span>' +
    '<span class="test-provider">' + (data.provider || '') + '</span>' +
    '<span class="test-message">' + (data.message || '') + '</span>' +
    (data.latency ? '<span class="test-latency">' + data.latency + 'ms</span>' : '');
  body.appendChild(row);
}

function setProgress(step, total, label) {
  const pct = total > 0 ? Math.round((step / total) * 100) : 0;
  document.getElementById('progressFill').style.width = Math.min(pct, 100) + '%';
  document.getElementById('progressStep').textContent = step;
  document.getElementById('progressTotal').textContent = total;
  document.getElementById('progressLabel').textContent = label ? '- ' + label : '';
}

function updateStepIndicator(index, type) {
  document.querySelectorAll('.step-tag').forEach(el => {
    const i = parseInt(el.dataset.step);
    if (i < index) {
      el.className = 'step-tag done';
      el.innerHTML = '✓ ' + el.textContent.trim();
    } else if (i === index) {
      el.className = 'step-tag ' + type;
      if (type === 'active') el.innerHTML = '● ' + el.textContent.trim();
      else if (type === 'done') el.innerHTML = '✓ ' + el.textContent.trim();
      else if (type === 'error') el.innerHTML = '✕ ' + el.textContent.trim();
    }
  });
}

// ============ Log Console ============
function appendLog(text, type) {
  const body = document.getElementById('logBody');
  const line = document.createElement('div');
  line.className = 'log-line ' + (type || 'info');
  line.textContent = text;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}

function clearLog() {
  document.getElementById('logBody').innerHTML = '';
}

// ============ Actions ============
function restartInstall() {
  state.installActive = false;
  state.selectedTools = ['claude-code', 'codex-cli'];
  state.apiKeys = {};
  state.customApi = null;
  document.querySelectorAll('.tool-card').forEach(c => c.classList.add('selected'));
  document.getElementById('btnRetry').classList.add('hidden');
  document.getElementById('btnInstallNext').classList.add('hidden');
  document.getElementById('logBody').innerHTML = '';
  document.getElementById('testResultsBody').innerHTML = '';
  document.getElementById('apiTestResults').style.display = 'none';
  setProgress(0, 0, '');
  document.querySelector('.progress-bar').classList.remove('installing');
  document.getElementById('stepIndicators').innerHTML = '';
  // Reset API key inputs
  document.querySelectorAll('.api-key-input').forEach(i => i.value = '');
  // Reset custom API inputs
  ['customApiName', 'customApiEndpoint', 'customApiKey', 'customApiModel', 'customApiEnvKey'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = id === 'customApiEnvKey' ? 'CUSTOM_API_KEY' : '';
  });
  showScreen('screen-tool-select');
}

async function launchTool(tool) {
  if (tool === 'claude') {
    window.api.startTerminal('claude');
    return;
  }
  if (tool === 'codex') {
    // 启动 Codex 前确保 relay 在运行
    try {
      const status = await window.api.relayStatus();
      if (!status.running) {
        await window.api.relayStart();
      }
    } catch (e) { /* ignore */ }
    window.api.startTerminal('codex');
  }
}

function openGuide(tool) {
  const guideMap = {
    'claude-code': 'Claude Code 核心用法.doc',
    'codex-cli': 'Codex CLI 核心用法.doc',
    'deepseek-api': 'DeepSeek API 配置指南.doc',
  };
  const name = guideMap[tool];
  if (name) {
    window.api.openGuide(name);
  }
}

async function goToManage() {
  try {
    const tools = await window.api.checkTools();
    renderManageScreen(tools.claude, tools.codex);
    showScreen('screen-manage');
  } catch (e) {
    showScreen('screen-manage');
  }
}

function closeApp() {
  window.api.quitApp();
}

// ============ Toast Notification ============
function showToast(message, duration) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}

// ============ Enter key support ============
document.getElementById('authCodeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') verifyCode();
});
