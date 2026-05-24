/**
 * ChatGPT 自动登录模块
 * 管理账号登录状态，SSE 事件处理
 */

let _loginAccounts = [];

// ==================== 渲染登录表格 ====================
async function renderLoginTable() {
  try {
    const res = await fetch('/api/accounts');
    const data = await res.json();
    _loginAccounts = data.accounts || [];
  } catch { _loginAccounts = []; }

  const tbody = document.getElementById('loginTableBody');

  if (_loginAccounts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6">
      <div class="empty-state" style="padding:60px 20px">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
        <p>在"邮箱取件"页导入账号后回来登录</p>
        <p class="text-muted">支持批量并发自动登录 ChatGPT</p>
      </div>
    </td></tr>`;
    updateLoginStats();
    return;
  }

  let html = '';
  _loginAccounts.forEach(acc => {
    const loginError = getLoginErrorInfo(acc);
    const statusClass = acc.status === 'success' ? 'status-success'
      : acc.status === 'failed' ? 'status-failed'
      : acc.status === 'logging_in' ? 'status-logging'
      : 'status-idle';

    const statusText = acc.status === 'success' ? '成功'
      : acc.status === 'failed' ? '失败'
      : acc.status === 'logging_in' ? '登录中'
      : '待登录';

    const spinner = acc.status === 'logging_in' ? '<span class="spinner-small"></span>' : '';

    html += `<tr data-account-id="${acc.id}">
      <td><input type="checkbox" class="account-checkbox login-check" data-id="${acc.id}"/></td>
      <td><span class="status-cell ${statusClass}">${spinner} ${statusText}</span></td>
      <td class="cell-email" title="${escapeAttr(acc.email)}">${escapeHtml(acc.email)}</td>
      <td>${acc.password ? '••••' : '-'}</td>
      <td class="cell-error ${loginError.type ? `error-${loginError.type}` : ''}" title="${escapeAttr(loginError.title)}">${escapeHtml(loginError.label)}</td>
      <td>
        <button class="btn btn-ghost btn-small" onclick="loginSingle('${acc.id}')" ${acc.status === 'logging_in' ? 'disabled' : ''}>
          ${acc.status === 'logging_in' ? '⏳' : '▶'}
        </button>
      </td>
    </tr>`;
  });

  tbody.innerHTML = html;
  updateLoginStats();
  bindLoginCheckboxes();
}

// ==================== 统计更新 ====================
function updateLoginStats() {
  const total = _loginAccounts.length;
  const idle = _loginAccounts.filter(a => !a.status || a.status === 'idle').length;
  const logging = _loginAccounts.filter(a => a.status === 'logging_in').length;
  const success = _loginAccounts.filter(a => a.status === 'success').length;
  const failed = _loginAccounts.filter(a => a.status === 'failed').length;

  document.getElementById('statTotal').textContent = total;
  document.getElementById('statIdle').textContent = idle;
  document.getElementById('statLogging').textContent = logging;
  document.getElementById('statSuccess').textContent = success;
  document.getElementById('statFailed').textContent = failed;

  // 更新按钮状态
  const hasSelected = document.querySelectorAll('.login-check:checked').length > 0;
  const selectedSuccess = Array.from(document.querySelectorAll('.login-check:checked'))
    .some(cb => _loginAccounts.find(a => a.id === cb.dataset.id)?.status === 'success');
  document.getElementById('btnLoginSelected').disabled = !hasSelected;
  document.getElementById('btnDeleteLoginSelected').disabled = !hasSelected;
  document.getElementById('btnRetryFailed').disabled = failed === 0;
  document.getElementById('btnExportSessions').disabled = success === 0;
  const uploadBtn = document.getElementById('btnOpenSessionUpload');
  if (uploadBtn) uploadBtn.disabled = !selectedSuccess;

  const selectSuccessBtn = document.getElementById('btnSelectSuccess');
  if (selectSuccessBtn) {
    selectSuccessBtn.disabled = success === 0;
    selectSuccessBtn.textContent = success > 0
      ? `选中成功账号 (${success})`
      : '选中成功账号';
  }

  const deactivatedCount = _loginAccounts.filter(isAccountDeactivated).length;
  const selectDeactivatedBtn = document.getElementById('btnSelectDeactivated');
  if (selectDeactivatedBtn) {
    selectDeactivatedBtn.disabled = deactivatedCount === 0;
    selectDeactivatedBtn.textContent = deactivatedCount > 0
      ? `选中已停用 (${deactivatedCount})`
      : '选中已停用';
  }
}

function bindLoginCheckboxes() {
  const selectAll = document.getElementById('loginSelectAll');
  selectAll?.addEventListener('change', (e) => {
    document.querySelectorAll('.login-check').forEach(cb => cb.checked = e.target.checked);
    updateLoginStats();
  });

  document.querySelectorAll('.login-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const all = document.querySelectorAll('.login-check');
      const checked = document.querySelectorAll('.login-check:checked');
      if (selectAll) {
        selectAll.checked = all.length > 0 && all.length === checked.length;
        selectAll.indeterminate = checked.length > 0 && checked.length < all.length;
      }
      updateLoginStats();
    });
  });
}

function isAccountDeactivated(account) {
  return getLoginErrorInfo(account).type === 'account-deactivated';
}

function getLoginErrorInfo(accountOrError) {
  const rawError = typeof accountOrError === 'string'
    ? accountOrError
    : accountOrError?.error;
  const errorType = typeof accountOrError === 'object'
    ? accountOrError?.errorType
    : '';
  const message = String(rawError || '');
  const lower = message.toLowerCase();

  if (
    errorType === 'account_deactivated' ||
    lower.includes('account_deactivated') ||
    lower.includes('deleted or deactivated') ||
    lower.includes('账号已停用')
  ) {
    return {
      type: 'account-deactivated',
      label: '账号已停用',
      title: '账号已被删除或停用，无法继续登录',
    };
  }

  return {
    type: '',
    label: message || '-',
    title: message || '',
  };
}

function updateLoginSelectAllState() {
  const selectAll = document.getElementById('loginSelectAll');
  if (!selectAll) return;
  const all = document.querySelectorAll('.login-check');
  const checked = document.querySelectorAll('.login-check:checked');
  selectAll.checked = all.length > 0 && all.length === checked.length;
  selectAll.indeterminate = checked.length > 0 && checked.length < all.length;
}

function selectLoginAccountsByFilter(predicate, successMessage, emptyMessage) {
  let count = 0;
  document.querySelectorAll('.login-check').forEach(cb => {
    const account = _loginAccounts.find(a => a.id === cb.dataset.id);
    const checked = !!account && predicate(account);
    cb.checked = checked;
    if (checked) count++;
  });
  updateLoginSelectAllState();
  updateLoginStats();
  showToast(count > 0 ? successMessage(count) : emptyMessage, count > 0 ? 'info' : 'warning');
}

function selectSuccessAccounts() {
  selectLoginAccountsByFilter(
    account => account.status === 'success',
    count => `已选中 ${count} 个登录成功账号`,
    '没有登录成功账号'
  );
}

function selectDeactivatedAccounts() {
  selectLoginAccountsByFilter(
    isAccountDeactivated,
    count => `已选中 ${count} 个已停用账号`,
    '没有已停用账号'
  );
}

// ==================== 登录操作 ====================
async function startLogin() {
  const ids = [];
  document.querySelectorAll('.login-check:checked').forEach(cb => ids.push(cb.dataset.id));

  if (ids.length === 0) {
    showToast('请先选择要登录的账号', 'warning');
    return;
  }

  const concurrency = parseInt(document.getElementById('concurrencyInput').value) || 8;

  // 显示进度条
  document.getElementById('loginProgress').style.display = 'block';
  document.getElementById('loginTotal2').textContent = ids.length;
  document.getElementById('loginCompleted').textContent = '0';
  document.getElementById('loginSucceeded').textContent = '0';
  document.getElementById('loginProgressFill').style.width = '0%';

  try {
    const res = await fetch('/api/chatgpt/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountIds: ids, concurrency }),
    });
    const data = await res.json();
    showToast(data.message || '登录任务已启动', 'info');
    addLog(`启动登录任务: ${ids.length} 个账号，并发 ${concurrency}`, 'info');
  } catch (err) {
    showToast('启动登录失败: ' + err.message, 'error');
  }
}

async function loginSingle(id) {
  document.getElementById('loginProgress').style.display = 'block';
  document.getElementById('loginTotal2').textContent = '1';
  document.getElementById('loginCompleted').textContent = '0';
  document.getElementById('loginSucceeded').textContent = '0';
  document.getElementById('loginProgressFill').style.width = '0%';

  try {
    await fetch(`/api/chatgpt/login/${id}`, { method: 'POST' });
    addLog('启动单个账号登录', 'info');
  } catch (err) {
    showToast('登录失败: ' + err.message, 'error');
  }
}

async function retryFailed() {
  try {
    const res = await fetch('/api/chatgpt/retry-failed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();

    if (data.accountIds && data.accountIds.length > 0) {
      // 触发登录
      const concurrency = parseInt(document.getElementById('concurrencyInput').value) || 8;
      await fetch('/api/chatgpt/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountIds: data.accountIds, concurrency }),
      });

      document.getElementById('loginProgress').style.display = 'block';
      document.getElementById('loginTotal2').textContent = data.count;
      showToast(`重试 ${data.count} 个失败账号`, 'info');
      addLog(`重试 ${data.count} 个失败账号`, 'info');
    } else {
      showToast('没有需要重试的账号', 'info');
    }
  } catch (err) {
    showToast('重试失败: ' + err.message, 'error');
  }
}

// ==================== SSE 事件处理 ====================
function onLoginEvent(data) {
  const row = document.querySelector(`tr[data-account-id="${data.accountId}"]`);
  if (!row) return;

  const statusCell = row.querySelector('.status-cell');

  switch (data.type) {
    case 'login_start':
      statusCell.className = 'status-cell status-logging';
      statusCell.innerHTML = '<span class="spinner-small"></span> 登录中';
      break;
    case 'login_status':
      statusCell.innerHTML = `<span class="spinner-small"></span> ${escapeHtml(data.detail || '处理中')}`;
      break;
    case 'login_success':
      statusCell.className = 'status-cell status-success';
      statusCell.textContent = '成功';
      row.querySelector('.cell-error').textContent = '-';
      row.querySelector('.cell-error').title = '';
      row.querySelector('.cell-error').className = 'cell-error';
      break;
    case 'login_failed':
      const loginError = getLoginErrorInfo({ error: data.error, errorType: data.errorType });
      statusCell.className = 'status-cell status-failed';
      statusCell.textContent = '失败';
      row.querySelector('.cell-error').textContent = loginError.label || '未知错误';
      row.querySelector('.cell-error').title = loginError.title || data.error || '';
      row.querySelector('.cell-error').className = `cell-error ${loginError.type ? `error-${loginError.type}` : ''}`;
      break;
  }

  // 延迟刷新数据
  clearTimeout(window._loginRefreshTimer);
  window._loginRefreshTimer = setTimeout(() => renderLoginTable(), 1000);
}

function onLoginProgress(data) {
  const { completed, total, succeeded } = data;
  document.getElementById('loginCompleted').textContent = completed;
  document.getElementById('loginSucceeded').textContent = succeeded;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  document.getElementById('loginProgressFill').style.width = `${pct}%`;
}

function onLoginComplete(data) {
  document.getElementById('loginProgressFill').style.width = '100%';
  setTimeout(() => renderLoginTable(), 1500);
}

// ==================== 导出 Sessions ====================
async function exportSessions() {
  const format = document.getElementById('exportFormat').value;
  const ids = getSelectedLoginAccountIds();
  if (ids.length === 0) {
    showToast('请先选择要导出的账号', 'warning');
    return;
  }

  try {
    const res = await fetch('/api/convert/from-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format, accountIds: ids }),
    });
    const data = await res.json();

    if (data.success) {
      if (format === 'cpa') {
        const download = downloadCpaJsonFiles(data.data, 'sessions-cpa');
        showToast(download.zipped ? `已下载 ${download.count} 个 CPA JSON 文件` : '已下载 CPA JSON 文件', 'success');
      } else {
        const json = JSON.stringify(data.data, null, 2);
        downloadTextFile(`sessions-${format}-${new Date().toISOString().slice(0, 10)}.json`, json);
        const label = format === 'cockpit' ? 'Cockpit' : format.toUpperCase();
        copyText(json, `已导出 ${data.count} 个 ${label} 账号`);
      }
      addLog(`导出 ${data.count} 个 ${format === 'cockpit' ? 'Cockpit' : format.toUpperCase()} 账号`, 'success');
    } else {
      showToast(data.error || '导出失败', 'warning');
    }
  } catch (err) {
    showToast('导出失败: ' + err.message, 'error');
  }
}

function getSelectedLoginAccountIds() {
  const ids = [];
  document.querySelectorAll('.login-check:checked').forEach(cb => ids.push(cb.dataset.id));
  return ids;
}

// ==================== 事件绑定 ====================
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnLoginSelected').addEventListener('click', startLogin);
  document.getElementById('btnRetryFailed').addEventListener('click', retryFailed);
  document.getElementById('btnSelectSuccess').addEventListener('click', selectSuccessAccounts);
  document.getElementById('btnSelectDeactivated').addEventListener('click', selectDeactivatedAccounts);
  document.getElementById('btnExportSessions').addEventListener('click', exportSessions);

  document.getElementById('btnDeleteLoginSelected').addEventListener('click', async () => {
    const ids = [];
    document.querySelectorAll('.login-check:checked').forEach(cb => ids.push(cb.dataset.id));
    if (ids.length === 0) return;
    if (!confirm(`确定删除选中的 ${ids.length} 个账号？`)) return;

    await fetch('/api/accounts/delete-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    renderLoginTable();
    renderAccountList();
    showToast(`已删除 ${ids.length} 个账号`, 'success');
  });
});
