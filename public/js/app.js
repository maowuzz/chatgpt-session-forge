/**
 * 主应用逻辑
 * Tab 切换、Toast 通知、全局工具函数、SSE 连接
 */

// ==================== Tab 切换 ====================
document.addEventListener('DOMContentLoaded', () => {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;

      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      document.getElementById(`tab-${target}`).classList.add('active');

      // 切换到登录 tab 时刷新表格
      if (target === 'login' && typeof renderLoginTable === 'function') {
        renderLoginTable();
      }
    });
  });

  // ESC 关闭弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
    }
  });

  // 清空日志
  document.getElementById('btnClearLogs')?.addEventListener('click', () => {
    document.getElementById('logList').innerHTML = '';
    addLog('自动登录日志已清空', 'info');
  });

  document.getElementById('btnClearWarehouseLogs')?.addEventListener('click', () => {
    document.getElementById('warehouseLogList').innerHTML = '';
    addWarehouseLog('CPA 仓管日志已清空', 'info');
  });

  // 启动 SSE 连接
  setupSSE();
  setupEventReplayPoll();

  addLog('系统初始化完成', 'success');
});

// ==================== SSE 连接 ====================
let _eventSource = null;
const _handledEventKeys = new Set();
let _eventReplayTimer = null;
const LOG_MAX_ENTRIES = 300;
const _loginStatusLogSeen = new Set();
const LOGGABLE_LOGIN_STATUSES = new Set([
  'identifier',
  'password',
  'waiting_code',
  'verify_code',
  'session',
]);

function setupSSE() {
  if (_eventSource) {
    _eventSource.close();
  }

  _eventSource = new EventSource('/api/events');

  _eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      markEventHandled(data);
      handleSSEEvent(data);
    } catch {}
  };

  _eventSource.onerror = () => {
    console.warn('[SSE] 连接断开，5秒后重连...');
    setTimeout(setupSSE, 5000);
  };
}

function setupEventReplayPoll() {
  if (_eventReplayTimer) clearInterval(_eventReplayTimer);
  _eventReplayTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/events/status', { cache: 'no-store' });
      const data = await res.json();
      const events = data.recentEvents || [];
      for (const event of events) {
        const key = eventKey(event);
        if (_handledEventKeys.has(key)) continue;
        _handledEventKeys.add(key);
        handleSSEEvent(event);
      }
    } catch {
      // SSE remains the primary path; polling is only a quiet fallback.
    }
  }, 2000);
}

function markEventHandled(data) {
  _handledEventKeys.add(eventKey(data));
}

function eventKey(data) {
  if (data.eventId) return String(data.eventId);
  return [
    data.time || '',
    data.type || '',
    data.accountId || '',
    data.status || '',
    data.detail || data.error || '',
  ].join('|');
}

function handleSSEEvent(data) {
  switch (data.type) {
    case 'connected':
      console.log('[SSE] 连接已建立');
      break;
    case 'login_start':
      addLog(`${formatLoginEmail(data.email)} 开始登录${data.workerId ? ` #${data.workerId}` : ''}`, 'info');
      if (typeof onLoginEvent === 'function') onLoginEvent(data);
      break;
    case 'login_status':
      if (shouldLogLoginStatus(data)) {
        addLog(`${formatLoginEmail(data.email)} ${formatLoginStatus(data.status, data.detail)}`, loginStatusLogType(data.status));
      }
      if (typeof onLoginEvent === 'function') onLoginEvent(data);
      break;
    case 'login_success':
      addLog(`${formatLoginEmail(data.email)} 登录成功`, 'success');
      if (typeof onLoginEvent === 'function') onLoginEvent(data);
      break;
    case 'login_failed':
      addLog(`${formatLoginEmail(data.email)} 登录失败: ${data.error}`, 'error');
      if (typeof onLoginEvent === 'function') onLoginEvent(data);
      break;
    case 'login_progress':
      if (typeof onLoginProgress === 'function') onLoginProgress(data);
      break;
    case 'login_complete':
      addLog(`登录任务完成: 成功 ${data.succeeded} / 失败 ${data.failed}`, data.failed > 0 ? 'warning' : 'success');
      if (typeof onLoginComplete === 'function') onLoginComplete(data);
      break;
    case 'warehouse_start':
    case 'warehouse_status':
    case 'warehouse_item':
    case 'warehouse_complete':
      if (typeof onWarehouseEvent === 'function') onWarehouseEvent(data);
      break;
    case 'sub2api_warehouse_start':
    case 'sub2api_warehouse_status':
    case 'sub2api_warehouse_item':
    case 'sub2api_warehouse_complete':
      if (typeof onSub2apiWarehouseEvent === 'function') onSub2apiWarehouseEvent(data);
      break;
  }
}

function formatLoginEmail(email) {
  return email || '账号';
}

function shouldLogLoginStatus(data) {
  if (!data || !LOGGABLE_LOGIN_STATUSES.has(data.status)) return false;
  const key = `${data.accountId || data.email || 'account'}:${data.status}`;
  if (_loginStatusLogSeen.has(key)) return false;
  _loginStatusLogSeen.add(key);
  return true;
}

function formatLoginStatus(status, detail) {
  const cleanDetail = String(detail || '').replace(/\b\d{6}\b/g, '******');
  if (cleanDetail) return cleanDetail;
  const labels = {
    csrf: '获取 CSRF Token',
    signin: '发起登录请求',
    authorize: '跟随授权链路',
    sentinel: '生成 Sentinel Token',
    identifier: '提交邮箱',
    password: '提交密码',
    waiting_code: '等待验证码邮件',
    checking_code: '检查验证码邮件',
    send_code: '重新触发验证码',
    verify_code: '提交验证码',
    callback: '跟随回调链路',
    session: '获取 Session',
    success: '登录成功',
    failed: '登录失败',
  };
  return labels[status] || status || '处理中';
}

function loginStatusLogType(status) {
  if (status === 'failed') return 'error';
  if (status === 'success') return 'success';
  if (status === 'waiting_code') return 'warning';
  return 'info';
}

// ==================== Toast 通知 ====================
function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  toast.innerHTML = `<span>${icons[type] || ''}</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  toast.addEventListener('click', () => {
    toast.classList.add('toast-exit');
    setTimeout(() => toast.remove(), 300);
  });

  setTimeout(() => {
    toast.classList.add('toast-exit');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ==================== 日志 ====================
function addLog(message, type = 'info', target = 'login') {
  const logList = document.getElementById(target === 'warehouse' ? 'warehouseLogList' : 'logList');
  if (!logList) return;

  const now = new Date();
  const time = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-type ${type}">${type.toUpperCase()}</span>
    <span class="log-message">${escapeHtml(message)}</span>
  `;

  logList.prepend(entry);
  while (logList.children.length > LOG_MAX_ENTRIES) {
    logList.lastElementChild?.remove();
  }
}

function addWarehouseLog(message, type = 'info') {
  addLog(message, type, 'warehouse');
}

// ==================== 工具函数 ====================
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function copyText(text, successMessage = '已复制') {
  if (!text) {
    showToast('没有可复制的内容', 'warning');
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage, 'success', 1800);
    return true;
  } catch {
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);
    input.select();
    const ok = document.execCommand('copy');
    input.remove();
    if (ok) { showToast(successMessage, 'success', 1800); return true; }
    showToast('复制失败', 'error');
    return false;
  }
}

function formatDate(dateStr, full = false) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const now = new Date();
    if (full) {
      return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    if (now.toDateString() === d.toDateString()) {
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return dateStr; }
}

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  downloadBlobFile(filename, blob);
}

function downloadBlobFile(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadCpaJsonFiles(accounts, baseFilename = 'sessions-cpa') {
  const list = (Array.isArray(accounts) ? accounts : [accounts]).filter(Boolean);
  const date = new Date().toISOString().slice(0, 10);

  if (list.length === 0) {
    return { count: 0, zipped: false };
  }

  const files = list.map((account, index) => ({
    name: cpaJsonFilename(account, index, list.length),
    content: JSON.stringify(account, null, 2),
  }));

  if (files.length === 1) {
    downloadTextFile(files[0].name, files[0].content);
    return { count: 1, zipped: false };
  }

  const zipName = `${sanitizeFilename(baseFilename)}-${date}.zip`;
  downloadBlobFile(zipName, createZipBlob(files));
  return { count: files.length, zipped: true };
}

function cpaJsonFilename(account, index, total) {
  const email = sanitizeFilename(account?.email || account?.user_id || `account-${index + 1}`);
  const accountId = sanitizeFilename(account?.account_id || account?.chatgpt_account_id || '');
  const shortId = accountId ? accountId.slice(0, 8) : '';
  const id = shortId ? `codex-${email}-${shortId}` : `codex-${email}`;
  const prefix = total > 1 ? `${String(index + 1).padStart(3, '0')}-` : '';
  return `${prefix}${id || `account-${index + 1}`}.json`;
}

function sanitizeFilename(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'account';
}

let _crc32Table = null;

function crc32(bytes) {
  const table = _crc32Table || (_crc32Table = createCrc32Table());
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createCrc32Table() {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
}

function getZipDateTime(date = new Date()) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function createZipBlob(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const centralDirectory = [];
  const { dosTime, dosDate } = getZipDateTime();
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const contentBytes = typeof file.content === 'string' ? encoder.encode(file.content) : file.content;
    const checksum = crc32(contentBytes);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, contentBytes.length, true);
    localView.setUint32(22, contentBytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    chunks.push(localHeader, contentBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, contentBytes.length, true);
    centralView.setUint32(24, contentBytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    centralDirectory.push(centralHeader);

    offset += localHeader.length + contentBytes.length;
  }

  const centralStart = offset;
  const centralSize = centralDirectory.reduce((sum, chunk) => sum + chunk.length, 0);
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralStart, true);
  endView.setUint16(20, 0, true);

  return new Blob([...chunks, ...centralDirectory, endRecord], { type: 'application/zip' });
}

function setStatus(state, text) {
  const badge = document.getElementById('statusBadge');
  if (!badge) return;
  badge.className = `status-badge ${state === 'loading' ? 'loading' : state === 'error' ? 'error' : ''}`;
  badge.querySelector('.status-text').textContent = text;
}

function setButtonLoading(btn, loading) {
  if (loading) {
    btn.dataset.originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-spinner"></span> 处理中...';
  } else {
    btn.disabled = false;
    btn.innerHTML = btn.dataset.originalHtml || '';
  }
}

function showImportSuccessBanner(uniqueCount, duplicateCount) {
  const banner = document.createElement('div');
  banner.className = 'import-success-banner';
  let msg = `🎉 成功导入 <strong>${uniqueCount}</strong> 个邮箱`;
  if (duplicateCount > 0) msg += `，跳过 <strong>${duplicateCount}</strong> 个重复`;
  banner.innerHTML = msg;
  document.body.appendChild(banner);
  requestAnimationFrame(() => banner.classList.add('active'));
  setTimeout(() => {
    banner.classList.add('exit');
    setTimeout(() => banner.remove(), 400);
  }, 2500);
}
