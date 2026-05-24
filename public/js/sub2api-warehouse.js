/**
 * sub2api 401 自动修复前端。
 */

let _sub2apiWarehouseRows = [];
let _sub2apiAutoTimer = null;
let _sub2apiBusy = false;
const SUB2API_WAREHOUSE_SETTINGS_KEY = 'sub2apiWarehouseSettings';
const SUB2API_WAREHOUSE_LOGGABLE_LOGIN_STATUSES = new Set([
  'login_start',
  'identifier',
  'send_code',
  'waiting_code',
  'verify_code',
  'session',
]);

function getSub2apiWarehousePayload() {
  return {
    baseUrl: document.getElementById('sub2apiBaseUrl').value.trim(),
    email: document.getElementById('sub2apiEmail').value.trim(),
    password: document.getElementById('sub2apiPassword').value,
    groupNames: document.getElementById('sub2apiGroupNames').value.trim() || 'codex',
    proxy: document.getElementById('sub2apiProxy').value.trim(),
    maxItems: parseInt(document.getElementById('sub2apiMaxItems').value, 10) || 20,
  };
}

function loadSub2apiWarehouseSettings() {
  let settings = {};
  try {
    settings = JSON.parse(localStorage.getItem(SUB2API_WAREHOUSE_SETTINGS_KEY) || '{}');
  } catch {
    settings = {};
  }

  if (settings.baseUrl) document.getElementById('sub2apiBaseUrl').value = settings.baseUrl;
  if (settings.email) document.getElementById('sub2apiEmail').value = settings.email;
  if (settings.groupNames) document.getElementById('sub2apiGroupNames').value = settings.groupNames;
  if (settings.proxy) document.getElementById('sub2apiProxy').value = settings.proxy;
  if (settings.maxItems) document.getElementById('sub2apiMaxItems').value = settings.maxItems;
  if (settings.autoInterval) document.getElementById('sub2apiAutoInterval').value = settings.autoInterval;
  document.getElementById('sub2apiAutoToggle').checked = Boolean(settings.autoEnabled);
}

function saveSub2apiWarehouseSettings() {
  const settings = {
    baseUrl: document.getElementById('sub2apiBaseUrl')?.value.trim() || '',
    email: document.getElementById('sub2apiEmail')?.value.trim() || '',
    groupNames: document.getElementById('sub2apiGroupNames')?.value.trim() || 'codex',
    proxy: document.getElementById('sub2apiProxy')?.value.trim() || '',
    maxItems: document.getElementById('sub2apiMaxItems')?.value || '20',
    autoEnabled: Boolean(document.getElementById('sub2apiAutoToggle')?.checked),
    autoInterval: document.getElementById('sub2apiAutoInterval')?.value || '5',
  };
  localStorage.setItem(SUB2API_WAREHOUSE_SETTINGS_KEY, JSON.stringify(settings));
}

function validateSub2apiWarehousePayload(payload) {
  if (!payload.baseUrl) {
    showToast('请填写 sub2api 地址', 'warning');
    return false;
  }
  if (!payload.email) {
    showToast('请填写 sub2api 登录邮箱', 'warning');
    return false;
  }
  if (!payload.password) {
    showToast('请填写 sub2api 登录密码', 'warning');
    return false;
  }
  return true;
}

function getSub2apiAutoIntervalMs() {
  const minutes = parseInt(document.getElementById('sub2apiAutoInterval')?.value, 10) || 5;
  return Math.max(1, Math.min(1440, minutes)) * 60 * 1000;
}

function isSub2apiAutoEnabled() {
  return Boolean(document.getElementById('sub2apiAutoToggle')?.checked);
}

function setSub2apiConnectionState(state, text) {
  const pill = document.getElementById('sub2apiConnectionStatus');
  const label = document.getElementById('sub2apiConnectionText');
  if (!pill || !label) return;
  pill.className = `warehouse-status-pill ${state || 'idle'}`;
  label.textContent = text || '未连接';
}

async function scanSub2api401() {
  saveSub2apiWarehouseSettings();
  const payload = getSub2apiWarehousePayload();
  if (!validateSub2apiWarehousePayload(payload)) return;

  const btn = document.getElementById('btnSub2apiScan401');
  setButtonLoading(btn, true);
  setSub2apiConnectionState('running', '连接中');
  try {
    const res = await fetch('/api/warehouse/sub2api/scan-401', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || '扫描失败');

    _sub2apiWarehouseRows = data.candidates || [];
    renderSub2apiWarehouseRows(_sub2apiWarehouseRows);
    updateSub2apiWarehouseStats({
      total: data.total,
      candidates: _sub2apiWarehouseRows.length,
      uploaded: 0,
      failed: 0,
    });
    addWarehouseLog(`sub2api 扫描完成: 共 ${data.total} 个 OpenAI 账号，发现 ${_sub2apiWarehouseRows.length} 个 401`, _sub2apiWarehouseRows.length ? 'warning' : 'success');
    showToast(`sub2api 发现 ${_sub2apiWarehouseRows.length} 个 401 账号`, _sub2apiWarehouseRows.length ? 'warning' : 'success');
    setSub2apiConnectionState('connected', _sub2apiWarehouseRows.length ? `已连接 · ${_sub2apiWarehouseRows.length} 个 401` : '已连接');
  } catch (err) {
    showToast('sub2api 扫描失败: ' + err.message, 'error');
    addWarehouseLog('sub2api 扫描失败: ' + err.message, 'error');
    setSub2apiConnectionState('error', '连接失败');
  } finally {
    setButtonLoading(btn, false);
  }
}

async function repairSub2api401(options = {}) {
  saveSub2apiWarehouseSettings();
  const payload = getSub2apiWarehousePayload();
  if (!validateSub2apiWarehousePayload(payload)) return;
  if (_sub2apiBusy) {
    if (!options.silent) showToast('sub2api 仓管正在处理中', 'warning');
    return;
  }

  const btn = document.getElementById('btnSub2apiRepair401');
  _sub2apiBusy = true;
  if (!options.silent) setButtonLoading(btn, true);
  setSub2apiConnectionState('running', options.auto ? '自动运行中' : '连接中');
  try {
    const res = await fetch('/api/warehouse/sub2api/repair-401', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || '修复失败');

    _sub2apiWarehouseRows = data.results || [];
    renderSub2apiWarehouseRows(_sub2apiWarehouseRows);
    updateSub2apiWarehouseStats(data.summary || {});
    const summary = data.summary || {};
    const failed = summary.failed || 0;
    if (!options.auto || isSub2apiAutoEnabled()) {
      const label = options.auto ? '自动修复已连接' : '已连接';
      setSub2apiConnectionState('connected', failed > 0 ? `${label} · ${failed} 个失败` : label);
    }
    if (!options.silent) showToast('sub2api 401 修复完成', failed ? 'warning' : 'success');
  } catch (err) {
    if (!options.silent) showToast('sub2api 修复失败: ' + err.message, 'error');
    addWarehouseLog('sub2api 修复失败: ' + err.message, 'error');
    setSub2apiConnectionState('error', '连接失败');
  } finally {
    _sub2apiBusy = false;
    if (!options.silent) setButtonLoading(btn, false);
  }
}

function stopSub2apiAutoWarehouse(reason = 'sub2api 自动修复已关闭') {
  if (_sub2apiAutoTimer) {
    clearInterval(_sub2apiAutoTimer);
    _sub2apiAutoTimer = null;
  }
  setSub2apiConnectionState('idle', '未连接');
  addWarehouseLog(reason, 'info');
}

function startSub2apiAutoWarehouse() {
  saveSub2apiWarehouseSettings();
  if (_sub2apiAutoTimer) {
    clearInterval(_sub2apiAutoTimer);
    _sub2apiAutoTimer = null;
  }

  const payload = getSub2apiWarehousePayload();
  if (!validateSub2apiWarehousePayload(payload)) {
    document.getElementById('sub2apiAutoToggle').checked = false;
    saveSub2apiWarehouseSettings();
    setSub2apiConnectionState('idle', '未连接');
    return;
  }

  const intervalMs = getSub2apiAutoIntervalMs();
  const minutes = Math.round(intervalMs / 60000);
  setSub2apiConnectionState('running', '自动运行中');
  addWarehouseLog(`sub2api 自动修复已开启: 每 ${minutes} 分钟扫描并修复 401`, 'success');
  repairSub2api401({ auto: true, silent: true });
  _sub2apiAutoTimer = setInterval(() => {
    repairSub2api401({ auto: true, silent: true });
  }, intervalMs);
}

function handleSub2apiAutoToggle() {
  saveSub2apiWarehouseSettings();
  const enabled = document.getElementById('sub2apiAutoToggle')?.checked;
  if (enabled) startSub2apiAutoWarehouse();
  else stopSub2apiAutoWarehouse();
}

function restartSub2apiAutoWarehouseIfNeeded() {
  saveSub2apiWarehouseSettings();
  const toggle = document.getElementById('sub2apiAutoToggle');
  if (!toggle?.checked) return;
  startSub2apiAutoWarehouse();
}

function renderSub2apiWarehouseRows(rows) {
  const tbody = document.getElementById('sub2apiWarehouseTableBody');
  if (!tbody) return;

  if (!rows || rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state" style="padding:32px 20px"><p>没有需要处理的 sub2api 401 账号</p></div></td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(row => {
    const message = row.message || row.status_message || '-';
    const action = formatSub2apiWarehouseAction(row.action || row.status || '401');
    const okClass = row.ok === true ? 'warehouse-ok' : row.ok === false ? 'warehouse-bad' : '';
    return `<tr>
      <td title="${escapeAttr(row.name || row.id || '')}">${escapeHtml(row.name || row.id || '-')}</td>
      <td title="${escapeAttr(row.email || '')}">${escapeHtml(row.email || '-')}</td>
      <td>${escapeHtml(action)}</td>
      <td class="${okClass}" title="${escapeAttr(message)}">${escapeHtml(message)}</td>
    </tr>`;
  }).join('');
}

function updateSub2apiWarehouseStats(summary = {}) {
  document.getElementById('sub2apiStatTotal').textContent = summary.total ?? 0;
  document.getElementById('sub2apiStat401').textContent = summary.candidates ?? summary.processed ?? 0;
  document.getElementById('sub2apiStatUploaded').textContent = summary.uploaded ?? 0;
  document.getElementById('sub2apiStatFailed').textContent = summary.failed ?? 0;
}

function formatSub2apiWarehouseAction(action) {
  const labels = {
    uploaded: '已更新',
    skipped: '已跳过',
    login_failed: '登录失败',
    upload_failed: '更新失败',
    ready: '正常',
  };
  return labels[action] || action || '-';
}

function onSub2apiWarehouseEvent(data) {
  if (data.type === 'sub2api_warehouse_start') {
    addWarehouseLog(`sub2api 开始处理: ${data.total || 0} 个 401 账号`, 'info');
  } else if (data.type === 'sub2api_warehouse_status') {
    if (!SUB2API_WAREHOUSE_LOGGABLE_LOGIN_STATUSES.has(data.status)) return;
    addWarehouseLog(`${data.email || data.name || 'sub2api 账号'} ${formatLoginStatus(data.status, data.detail)}`, data.status === 'waiting_code' ? 'warning' : 'info');
  } else if (data.type === 'sub2api_warehouse_item') {
    const result = data.result || {};
    addWarehouseLog(`${result.email || result.name || 'sub2api 账号'} ${result.message || result.action}`, result.ok ? 'success' : 'warning');
  } else if (data.type === 'sub2api_warehouse_complete') {
    const s = data.summary || {};
    addWarehouseLog(`sub2api 处理完成: 更新 ${s.uploaded || 0}，失败 ${s.failed || 0}，跳过 ${s.skipped || 0}`, s.failed ? 'warning' : 'success');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadSub2apiWarehouseSettings();
  document.getElementById('btnSub2apiScan401')?.addEventListener('click', scanSub2api401);
  document.getElementById('btnSub2apiRepair401')?.addEventListener('click', () => repairSub2api401());
  document.getElementById('sub2apiAutoToggle')?.addEventListener('change', handleSub2apiAutoToggle);
  document.getElementById('sub2apiAutoInterval')?.addEventListener('change', restartSub2apiAutoWarehouseIfNeeded);
  [
    'sub2apiBaseUrl',
    'sub2apiEmail',
    'sub2apiGroupNames',
    'sub2apiProxy',
    'sub2apiMaxItems',
    'sub2apiAutoInterval',
  ].forEach(id => {
    document.getElementById(id)?.addEventListener('input', saveSub2apiWarehouseSettings);
  });
  document.getElementById('sub2apiPassword')?.addEventListener('change', restartSub2apiAutoWarehouseIfNeeded);
  setSub2apiConnectionState('idle', '未连接');
  if (document.getElementById('sub2apiAutoToggle')?.checked) startSub2apiAutoWarehouse();
});
