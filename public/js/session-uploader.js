/**
 * 已登录 Session 在线上传到 sub2api / CPA。
 */

const SESSION_UPLOAD_SETTINGS_KEY = 'sessionUploadSettings';

function getSessionUploadTarget() {
  return document.querySelector('input[name="sessionUploadTarget"]:checked')?.value || 'sub2api';
}

function openSessionUploadModal() {
  const ids = getSelectedLoginAccountIds();
  if (ids.length === 0) {
    showToast('请先选择要上传的账号', 'warning');
    return;
  }
  loadSessionUploadSettings();
  document.getElementById('sessionUploadResult').hidden = true;
  document.getElementById('sessionUploadResult').innerHTML = '';
  document.getElementById('sessionUploadCount').textContent = `已选中 ${ids.length} 个账号`;
  document.getElementById('sessionUploadModal').classList.add('active');
}

function closeSessionUploadModal() {
  document.getElementById('sessionUploadModal')?.classList.remove('active');
}

function loadSessionUploadSettings() {
  let settings = {};
  try {
    settings = JSON.parse(localStorage.getItem(SESSION_UPLOAD_SETTINGS_KEY) || '{}');
  } catch {
    settings = {};
  }

  if (settings.target) {
    const targetInput = document.querySelector(`input[name="sessionUploadTarget"][value="${settings.target}"]`);
    if (targetInput) targetInput.checked = true;
  }
  if (settings.sub2apiBaseUrl) document.getElementById('uploadSub2apiBaseUrl').value = settings.sub2apiBaseUrl;
  if (settings.sub2apiEmail) document.getElementById('uploadSub2apiEmail').value = settings.sub2apiEmail;
  if (settings.sub2apiGroupNames) document.getElementById('uploadSub2apiGroupNames').value = settings.sub2apiGroupNames;
  if (settings.sub2apiProxy) document.getElementById('uploadSub2apiProxy').value = settings.sub2apiProxy;
  if (settings.sub2apiPriority) document.getElementById('uploadSub2apiPriority').value = settings.sub2apiPriority;
  if (settings.cpaBaseUrl) document.getElementById('uploadCpaBaseUrl').value = settings.cpaBaseUrl;
  syncSessionUploadTarget();
}

function saveSessionUploadSettings() {
  const settings = {
    target: getSessionUploadTarget(),
    sub2apiBaseUrl: document.getElementById('uploadSub2apiBaseUrl')?.value.trim() || '',
    sub2apiEmail: document.getElementById('uploadSub2apiEmail')?.value.trim() || '',
    sub2apiGroupNames: document.getElementById('uploadSub2apiGroupNames')?.value.trim() || 'codex',
    sub2apiProxy: document.getElementById('uploadSub2apiProxy')?.value.trim() || '',
    sub2apiPriority: document.getElementById('uploadSub2apiPriority')?.value || '1',
    cpaBaseUrl: document.getElementById('uploadCpaBaseUrl')?.value.trim() || 'http://localhost:8317',
  };
  localStorage.setItem(SESSION_UPLOAD_SETTINGS_KEY, JSON.stringify(settings));
}

function syncSessionUploadTarget() {
  const target = getSessionUploadTarget();
  document.getElementById('sub2apiUploadPanel').hidden = target !== 'sub2api';
  document.getElementById('cpaUploadPanel').hidden = target !== 'cpa';
  saveSessionUploadSettings();
}

function getSessionUploadPayload() {
  const target = getSessionUploadTarget();
  const accountIds = getSelectedLoginAccountIds();

  if (target === 'cpa') {
    return {
      target,
      endpoint: '/api/upload/cpa',
      body: {
        accountIds,
        baseUrl: document.getElementById('uploadCpaBaseUrl').value.trim(),
        managementKey: document.getElementById('uploadCpaManagementKey').value.trim(),
      },
    };
  }

  return {
    target,
    endpoint: '/api/upload/sub2api',
    body: {
      accountIds,
      baseUrl: document.getElementById('uploadSub2apiBaseUrl').value.trim(),
      email: document.getElementById('uploadSub2apiEmail').value.trim(),
      password: document.getElementById('uploadSub2apiPassword').value,
      groupNames: document.getElementById('uploadSub2apiGroupNames').value.trim() || 'codex',
      proxy: document.getElementById('uploadSub2apiProxy').value.trim(),
      priority: document.getElementById('uploadSub2apiPriority').value || '1',
    },
  };
}

function validateSessionUploadPayload(payload) {
  if (!payload.body.accountIds.length) {
    showToast('请先选择要上传的账号', 'warning');
    return false;
  }

  if (payload.target === 'cpa') {
    if (!payload.body.baseUrl) {
      showToast('请填写 CPA 地址', 'warning');
      return false;
    }
    if (!payload.body.managementKey) {
      showToast('请填写 CPA 管理密钥', 'warning');
      return false;
    }
    return true;
  }

  if (!payload.body.baseUrl) {
    showToast('请填写 sub2api 地址', 'warning');
    return false;
  }
  if (!payload.body.email) {
    showToast('请填写 sub2api 登录邮箱', 'warning');
    return false;
  }
  if (!payload.body.password) {
    showToast('请填写 sub2api 登录密码', 'warning');
    return false;
  }
  return true;
}

async function uploadSelectedSessions() {
  saveSessionUploadSettings();
  const payload = getSessionUploadPayload();
  if (!validateSessionUploadPayload(payload)) return;

  const btn = document.getElementById('btnConfirmSessionUpload');
  const resultPanel = document.getElementById('sessionUploadResult');
  setButtonLoading(btn, true);
  resultPanel.hidden = false;
  resultPanel.innerHTML = '<div class="upload-result-empty">正在上传...</div>';

  try {
    const res = await fetch(payload.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload.body),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || '上传失败');

    renderSessionUploadResult(data);
    const summary = data.summary || {};
    const targetLabel = payload.target === 'cpa' ? 'CPA' : 'sub2api';
    const failed = summary.failed || 0;
    showToast(`${targetLabel} 上传完成: 成功 ${summary.uploaded || 0}，失败 ${failed}`, failed ? 'warning' : 'success');
    addLog(`${targetLabel} 上传完成: 成功 ${summary.uploaded || 0}，失败 ${failed}`, failed ? 'warning' : 'success');
  } catch (err) {
    resultPanel.innerHTML = `<div class="upload-result-error">${escapeHtml(err.message)}</div>`;
    showToast('上传失败: ' + err.message, 'error');
    addLog('Session 上传失败: ' + err.message, 'error');
  } finally {
    setButtonLoading(btn, false);
  }
}

function renderSessionUploadResult(data) {
  const rows = data.results || [];
  const summary = data.summary || {};
  const targetLabel = data.target === 'cpa' ? 'CPA' : 'sub2api';
  const resultPanel = document.getElementById('sessionUploadResult');

  resultPanel.innerHTML = `
    <div class="upload-result-summary">
      <strong>${targetLabel} 上传结果</strong>
      <span>成功 ${summary.uploaded || 0}</span>
      <span>失败 ${summary.failed || 0}</span>
      ${summary.created !== undefined ? `<span>新建 ${summary.created || 0}</span>` : ''}
      ${summary.updated !== undefined ? `<span>更新 ${summary.updated || 0}</span>` : ''}
    </div>
    <div class="upload-result-list">
      ${rows.map(row => `
        <div class="upload-result-row ${row.ok ? 'ok' : 'bad'}">
          <span class="upload-result-email" title="${escapeAttr(row.email || '')}">${escapeHtml(row.email || '-')}</span>
          <span class="upload-result-action">${escapeHtml(formatSessionUploadAction(row.action))}</span>
          <span class="upload-result-message" title="${escapeAttr(row.message || '')}">${escapeHtml(row.message || '')}</span>
        </div>
      `).join('') || '<div class="upload-result-empty">没有返回明细</div>'}
    </div>
  `;
}

function formatSessionUploadAction(action) {
  const labels = {
    created: '新建',
    updated: '更新',
    uploaded: '上传',
    failed: '失败',
  };
  return labels[action] || action || '-';
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnOpenSessionUpload')?.addEventListener('click', openSessionUploadModal);
  document.getElementById('btnCloseSessionUpload')?.addEventListener('click', closeSessionUploadModal);
  document.getElementById('btnCancelSessionUpload')?.addEventListener('click', closeSessionUploadModal);
  document.getElementById('btnConfirmSessionUpload')?.addEventListener('click', uploadSelectedSessions);
  document.querySelectorAll('input[name="sessionUploadTarget"]').forEach(input => {
    input.addEventListener('change', syncSessionUploadTarget);
  });

  [
    'uploadSub2apiBaseUrl',
    'uploadSub2apiEmail',
    'uploadSub2apiGroupNames',
    'uploadSub2apiProxy',
    'uploadSub2apiPriority',
    'uploadCpaBaseUrl',
  ].forEach(id => {
    document.getElementById(id)?.addEventListener('input', saveSessionUploadSettings);
  });
});
