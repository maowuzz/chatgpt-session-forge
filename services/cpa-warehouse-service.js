/**
 * CPA 仓管服务
 * 通过 CLIProxyAPI 管理 API 扫描 auth-files，并对 401 凭证执行重登换货。
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const chatgptService = require('./chatgpt-service');
const imapService = require('./imap-service');
const graphService = require('./graph-service');
const externalMailService = require('./external-mail-service');
const converter = require('./converter-service');

const DATA_FILE = path.resolve(__dirname, '..', config.dataFile);
const DEFAULT_CPA_BASE_URL = 'http://localhost:8317';

function readAccounts() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8') || '[]');
  } catch {
    return [];
  }
}

function writeAccounts(accounts) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(accounts, null, 2), 'utf-8');
}

function updateAccount(accountId, updates) {
  const accounts = readAccounts();
  const idx = accounts.findIndex(account => account.id === accountId);
  if (idx < 0) return;
  Object.assign(accounts[idx], updates);
  writeAccounts(accounts);
}

function normalizeLoginError(error) {
  const message = String(error || '未知错误');
  const lower = message.toLowerCase();
  if (
    lower.includes('account_deactivated') ||
    lower.includes('deleted or deactivated') ||
    lower.includes('账号已停用')
  ) {
    return {
      message: '账号已停用',
      type: 'account_deactivated',
    };
  }

  return {
    message,
    type: null,
  };
}

async function fetchVerificationCode(account) {
  const options = {
    recentOnly: true,
    fullBody: true,
    stopOnCode: true,
    sender: '',
    limit: 25,
  };

  const provider = externalMailService.getAccountMailProvider(account);
  if (provider !== 'outlook') {
    const result = await externalMailService.fetchEmails(account, options).catch(err => {
      console.error(`[CPA 仓管外部邮箱取码失败] ${account.email} (${provider}):`, err.message);
      return { success: false, emails: [] };
    });
    return result.emails || [];
  }

  const allEmails = [];
  const errors = [];
  const tasks = [
    startMailFetch('graph', graphService.fetchEmails, account, options),
    startMailFetch('imap', imapService.fetchEmails, account, options),
  ];
  const pending = new Set(tasks);

  while (pending.size > 0) {
    const settled = await Promise.race([...pending].map(task =>
      task.promise.then(value => ({ task, value }))
    ));
    pending.delete(settled.task);

    const codeEmails = collectMailFetchResult(settled.value, allEmails, errors);
    if (codeEmails) return codeEmails;
  }

  if (allEmails.length === 0 && errors.length > 0) {
    console.error(`[CPA warehouse code fetch failed] ${account.email}: ${errors.join(' | ')}`);
  }

  return allEmails;
}

function startMailFetch(protocol, fetcher, account, options) {
  return {
    protocol,
    promise: fetcher(account, options)
      .then(result => ({ success: true, protocol, result }))
      .catch(error => ({ success: false, protocol, error })),
  };
}

function collectMailFetchResult(result, allEmails, errors) {
  if (result.success) {
    const emails = result.result?.emails || [];
    if (emails.length > 0) {
      allEmails.push(...emails);
      if (chatgptService.extractCodeFromEmails(emails)) return emails;
    }
  } else {
    errors.push(`${result.protocol}: ${result.error?.message || String(result.error)}`);
  }
  return null;
}

function normalizeManagementBaseUrl(baseUrl = DEFAULT_CPA_BASE_URL) {
  const raw = String(baseUrl || DEFAULT_CPA_BASE_URL).trim().replace(/\/+$/, '');
  if (!raw) return `${DEFAULT_CPA_BASE_URL}/v0/management`;
  return raw.endsWith('/v0/management') ? raw : `${raw}/v0/management`;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isHttp401AuthFile(file) {
  const text = [
    file?.status,
    file?.status_message,
    file?.error,
    file?.message,
  ].filter(Boolean).join(' ').toLowerCase();

  return /\b401\b/.test(text) || text.includes('unauthorized');
}

function looksLikeCodexFile(file, authJson) {
  const parts = [
    file?.provider,
    file?.type,
    file?.account_type,
    file?.name,
    file?.label,
    authJson?.type,
    authJson?.auth_mode,
  ].filter(Boolean).join(' ').toLowerCase();

  return (
    parts.includes('codex') ||
    parts.includes('openai') ||
    authJson?.access_token ||
    authJson?.accessToken ||
    authJson?.tokens?.access_token ||
    authJson?.tokens?.accessToken
  );
}

function inferEmail(file, authJson) {
  const candidates = [
    authJson?.email,
    authJson?.name,
    authJson?.user?.email,
    authJson?.profile?.email,
    authJson?.credentials?.email,
    authJson?.extra?.email,
    file?.email,
    file?.name,
    file?.id,
  ];

  for (const value of candidates) {
    const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (match) return match[0].toLowerCase();
  }

  return '';
}

function getAccountLoginEmail(account) {
  return String(account?.loginEmail || account?.chatgptEmail || account?.email || '').trim().toLowerCase();
}

function findLocalAccountByEmail(accounts, email) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return null;
  return accounts.find(account => getAccountLoginEmail(account) === target)
    || accounts.find(account => String(account.email || '').trim().toLowerCase() === target)
    || null;
}

function cpaJsonFilename(account, index = 0) {
  const email = sanitizeFilename(account?.email || account?.user_id || `account-${index + 1}`);
  const accountId = sanitizeFilename(account?.account_id || account?.chatgpt_account_id || '');
  const shortId = accountId ? accountId.slice(0, 8) : '';
  return shortId ? `codex-${email}-${shortId}.json` : `codex-${email}.json`;
}

function sanitizeFilename(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'account';
}

class CpaManagementClient {
  constructor({ baseUrl, managementKey }) {
    this.baseUrl = normalizeManagementBaseUrl(baseUrl);
    this.managementKey = String(managementKey || '').trim();
  }

  headers(extra = {}) {
    if (!this.managementKey) {
      throw new Error('缺少 CPA 管理密钥');
    }
    return {
      Authorization: `Bearer ${this.managementKey}`,
      ...extra,
    };
  }

  async request(pathname, options = {}) {
    const url = `${this.baseUrl}${pathname}`;
    const res = await fetch(url, {
      ...options,
      headers: this.headers(options.headers || {}),
    });
    const text = await res.text();
    const data = safeJsonParse(text);

    if (!res.ok) {
      const message = data?.error || data?.message || text || `HTTP ${res.status}`;
      const error = new Error(`CPA 管理 API 请求失败: HTTP ${res.status} - ${message}`);
      error.status = res.status;
      error.body = data || text;
      throw error;
    }

    return data ?? text;
  }

  async listAuthFiles() {
    const data = await this.request('/auth-files');
    return Array.isArray(data?.files) ? data.files : [];
  }

  async downloadAuthFile(name) {
    const encoded = encodeURIComponent(name);
    const data = await this.request(`/auth-files/download?name=${encoded}`);
    return typeof data === 'string' ? safeJsonParse(data) : data;
  }

  async uploadAuthFile(name, authJson) {
    const encoded = encodeURIComponent(name);
    return this.request(`/auth-files?name=${encoded}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authJson),
    });
  }

  async deleteAuthFile(name) {
    const encoded = encodeURIComponent(name);
    return this.request(`/auth-files?name=${encoded}`, { method: 'DELETE' });
  }
}

async function scan401Credentials(options) {
  const client = new CpaManagementClient(options);
  const files = await client.listAuthFiles();
  const candidates = files.filter(isHttp401AuthFile);

  return {
    total: files.length,
    candidates: candidates.map(file => ({
      name: file.name,
      provider: file.provider || '',
      status: file.status || '',
      status_message: file.status_message || '',
      disabled: Boolean(file.disabled),
      unavailable: Boolean(file.unavailable),
      runtime_only: Boolean(file.runtime_only),
      source: file.source || '',
      email: file.email || '',
      success: file.success || 0,
      failed: file.failed || 0,
    })),
  };
}

async function repair401Credentials(options, onEvent = () => {}) {
  const client = new CpaManagementClient(options);
  const files = await client.listAuthFiles();
  const candidates = files.filter(isHttp401AuthFile);
  const limit = Math.max(1, Math.min(50, parseInt(options.maxItems, 10) || candidates.length));
  const selected = candidates.slice(0, limit);
  const results = [];
  const summary = {
    total: files.length,
    candidates: candidates.length,
    processed: 0,
    uploaded: 0,
    deleted: 0,
    skipped: 0,
    failed: 0,
  };

  onEvent({ type: 'warehouse_start', total: selected.length, scanned: files.length });

  for (const file of selected) {
    const result = await repairOne401Credential(client, file, onEvent);
    results.push(result);
    summary.processed++;
    if (result.action === 'uploaded') summary.uploaded++;
    else if (result.action === 'deleted_deactivated') summary.deleted++;
    else if (result.action === 'skipped') summary.skipped++;
    else summary.failed++;
    onEvent({ type: 'warehouse_item', result: sanitizeResultForEvent(result), summary });
  }

  onEvent({ type: 'warehouse_complete', summary });
  return { summary, results };
}

async function repairOne401Credential(client, file, onEvent) {
  let authJson = null;
  let email = String(file.email || '').toLowerCase();

  try {
    if (file.name && !file.runtime_only) {
      authJson = await client.downloadAuthFile(file.name);
      email = inferEmail(file, authJson) || email;
    }
  } catch (err) {
    console.warn(`[CPA 仓管] 下载凭证失败 ${file.name}: ${err.message}`);
  }

  if (!looksLikeCodexFile(file, authJson)) {
    return {
      name: file.name,
      email,
      action: 'skipped',
      ok: false,
      message: '不是 Codex/OpenAI 凭证，已跳过',
      status_message: file.status_message || '',
    };
  }

  if (!email) {
    return {
      name: file.name,
      email: '',
      action: 'skipped',
      ok: false,
      message: '无法从 CPA 凭证识别邮箱，已跳过',
      status_message: file.status_message || '',
    };
  }

  const accounts = readAccounts();
  const account = findLocalAccountByEmail(accounts, email);
  if (!account) {
    return {
      name: file.name,
      email,
      action: 'skipped',
      ok: false,
      message: '本地没有匹配的登录账号',
      status_message: file.status_message || '',
    };
  }

  onEvent({
    type: 'warehouse_status',
    email,
    name: file.name,
    status: 'login_start',
    detail: '401 凭证开始重新登录',
  });

  let session;
  try {
    updateAccount(account.id, { status: 'logging_in', error: null, errorType: null });
    session = await chatgptService.login(
      account,
      fetchVerificationCode,
      (status, detail) => {
        onEvent({
          type: 'warehouse_status',
          email,
          name: file.name,
          status,
          detail,
        });
      }
    );
  } catch (err) {
    const loginError = normalizeLoginError(err.message);
    updateAccount(account.id, {
      status: 'failed',
      error: loginError.message,
      errorType: loginError.type,
    });

    if (loginError.type === 'account_deactivated' && file.name && !file.runtime_only) {
      try {
        await client.deleteAuthFile(file.name);
        return {
          name: file.name,
          email,
          action: 'deleted_deactivated',
          ok: true,
          message: '重新登录失败：账号已停用，已删除 CPA 凭证',
          status_message: file.status_message || '',
        };
      } catch (deleteErr) {
        return {
          name: file.name,
          email,
          action: 'delete_failed',
          ok: false,
          message: `账号已停用，但删除 CPA 凭证失败：${deleteErr.message}`,
          status_message: file.status_message || '',
        };
      }
    }

    return {
      name: file.name,
      email,
      action: 'login_failed',
      ok: false,
      message: `重新登录失败：${loginError.message}`,
      status_message: file.status_message || '',
    };
  }

  updateAccount(account.id, {
    status: 'success',
    session,
    error: null,
    errorType: null,
  });

  const parsed = converter.extractSessionInfo(session);
  const cpa = converter.toCPA([parsed])[0];
  const uploadName = file.name || cpaJsonFilename(cpa);

  try {
    await client.uploadAuthFile(uploadName, cpa);
    return {
      name: uploadName,
      email,
      action: 'uploaded',
      ok: true,
      message: '重登成功，已上传新 CPA 凭证',
      status_message: file.status_message || '',
    };
  } catch (err) {
    return {
      name: uploadName,
      email,
      action: 'upload_failed',
      ok: false,
      message: `重登成功，但上传 CPA 凭证失败：${err.message}`,
      status_message: file.status_message || '',
    };
  }
}

function sanitizeResultForEvent(result) {
  return {
    name: result.name,
    email: result.email,
    action: result.action,
    ok: result.ok,
    message: result.message,
  };
}

module.exports = {
  CpaManagementClient,
  isHttp401AuthFile,
  normalizeManagementBaseUrl,
  scan401Credentials,
  repair401Credentials,
};
