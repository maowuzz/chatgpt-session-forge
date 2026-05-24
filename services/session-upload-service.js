/**
 * 在线上传已登录 ChatGPT session 到 sub2api / CLIProxyAPI。
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const converter = require('./converter-service');

const DATA_FILE = path.resolve(__dirname, '..', config.dataFile);
const DEFAULT_SUB2API_GROUP_NAME = 'codex';
const DEFAULT_SUB2API_PRIORITY = 1;
const DEFAULT_CPA_BASE_URL = 'http://localhost:8317';

function readAccounts() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8') || '[]');
  } catch {
    return [];
  }
}

function normalizeString(value = '') {
  return String(value || '').trim();
}

function normalizeOrigin(rawUrl, label) {
  const raw = normalizeString(rawUrl);
  if (!raw) throw new Error(`请填写 ${label} 地址`);
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    return new URL(withProtocol).origin;
  } catch {
    throw new Error(`${label} 地址格式无效`);
  }
}

function normalizeManagementBaseUrl(baseUrl = DEFAULT_CPA_BASE_URL) {
  const origin = normalizeOrigin(baseUrl || DEFAULT_CPA_BASE_URL, 'CPA').replace(/\/+$/, '');
  return origin.endsWith('/v0/management') ? origin : `${origin}/v0/management`;
}

function getErrorMessage(payload, responseStatus = 500, pathLabel = '请求') {
  const candidates = [
    payload?.message,
    payload?.detail,
    payload?.error,
    payload?.reason,
  ];
  const message = candidates.map(normalizeString).find(Boolean);
  return message || `${pathLabel} 失败（HTTP ${responseStatus}）`;
}

async function requestJson(origin, pathname, options = {}) {
  const timeoutMs = Math.max(1000, Math.floor(Number(options.timeoutMs) || 30000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const token = normalizeString(options.token);
    const response = await fetch(`${origin}${pathname}`, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'code')) {
      if (Number(payload.code) === 0) return payload.data;
      throw new Error(getErrorMessage(payload, response.status, pathname));
    }

    if (!response.ok) {
      throw new Error(getErrorMessage(payload, response.status, pathname));
    }

    return payload;
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`${pathname} 请求超时`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function getSelectedSuccessfulAccounts(accountIds = []) {
  const ids = Array.isArray(accountIds) && accountIds.length > 0 ? new Set(accountIds) : null;
  return readAccounts()
    .filter(account => (!ids || ids.has(account.id)) && account.status === 'success' && account.session);
}

function normalizeGroupNames(value) {
  const source = Array.isArray(value)
    ? value
    : normalizeString(value || DEFAULT_SUB2API_GROUP_NAME).split(/[\r\n,，;；]+/);
  const seen = new Set();
  const names = [];

  for (const item of source) {
    const name = normalizeString(item);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return names.length ? names : [DEFAULT_SUB2API_GROUP_NAME];
}

function resolvePriority(value) {
  const raw = normalizeString(value);
  if (!raw) return DEFAULT_SUB2API_PRIORITY;
  const priority = Number(raw);
  if (!Number.isSafeInteger(priority) || priority < 1) {
    throw new Error('sub2api 账号优先级必须是大于等于 1 的整数');
  }
  return priority;
}

async function loginSub2Api(options = {}) {
  const origin = normalizeOrigin(options.baseUrl, 'sub2api');
  const email = normalizeString(options.email);
  const password = String(options.password || '');

  if (!email) throw new Error('请填写 sub2api 登录邮箱');
  if (!password) throw new Error('请填写 sub2api 登录密码');

  const data = await requestJson(origin, '/api/v1/auth/login', {
    method: 'POST',
    timeoutMs: options.timeoutMs,
    body: { email, password },
  });
  const token = normalizeString(data?.access_token || data?.accessToken || data?.token);
  if (!token) throw new Error('sub2api 登录返回缺少 access_token');

  return { origin, token };
}

async function getSub2ApiGroups(origin, token, groupNames, options = {}) {
  const targets = normalizeGroupNames(groupNames);
  const groups = await requestJson(origin, '/api/v1/admin/groups/all', {
    method: 'GET',
    token,
    timeoutMs: options.timeoutMs,
  });

  const matched = [];
  const missing = [];
  for (const targetName of targets) {
    const normalized = targetName.toLowerCase();
    const group = (Array.isArray(groups) ? groups : []).find(item => {
      const itemName = normalizeString(item?.name).toLowerCase();
      return itemName === normalized && (!item.platform || item.platform === 'openai');
    });

    if (group) matched.push(group);
    else missing.push(targetName);
  }

  if (missing.length) {
    throw new Error(`sub2api 中未找到 openai 分组：${missing.join('、')}`);
  }

  return matched;
}

function normalizeProxyId(value) {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isActiveProxy(proxy = {}) {
  const status = normalizeString(proxy.status).toLowerCase();
  return !status || status === 'active';
}

function buildProxySearchText(proxy = {}) {
  return [
    proxy.id,
    proxy.name,
    proxy.protocol,
    proxy.host,
    proxy.port,
  ]
    .filter(value => value !== undefined && value !== null && value !== '')
    .map(value => normalizeString(value).toLowerCase())
    .filter(Boolean)
    .join(' ');
}

async function resolveSub2ApiProxy(origin, token, preference = '', options = {}) {
  const rawPreference = normalizeString(preference);
  if (!rawPreference) return null;

  const proxies = await requestJson(origin, '/api/v1/admin/proxies/all?with_count=true', {
    method: 'GET',
    token,
    timeoutMs: options.timeoutMs,
  });
  if (!Array.isArray(proxies)) throw new Error('sub2api 代理列表返回格式异常');

  const activeProxies = proxies.filter(isActiveProxy).filter(proxy => normalizeProxyId(proxy.id));
  const preferenceLower = rawPreference.toLowerCase();
  const preferredId = normalizeProxyId(rawPreference);

  if (preferredId) {
    const matched = activeProxies.find(proxy => normalizeProxyId(proxy.id) === preferredId);
    if (matched) return matched;
    throw new Error(`sub2api 默认代理 ID “${rawPreference}”不存在或未启用`);
  }

  const exactMatches = activeProxies.filter(proxy => normalizeString(proxy.name).toLowerCase() === preferenceLower);
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) throw new Error(`sub2api 默认代理“${rawPreference}”匹配到多个代理，请改填代理 ID`);

  const fuzzyMatches = activeProxies.filter(proxy => buildProxySearchText(proxy).includes(preferenceLower));
  if (fuzzyMatches.length === 1) return fuzzyMatches[0];
  if (fuzzyMatches.length > 1) throw new Error(`sub2api 默认代理“${rawPreference}”匹配到多个代理，请改填代理 ID`);

  throw new Error(`sub2api 默认代理“${rawPreference}”不存在或未启用`);
}

function resolveSessionName(account, session, info) {
  return normalizeString(info.email || session?.user?.email || session?.email || account.email || 'ChatGPT Account');
}

function resolveExpiresAtSeconds(session, info) {
  if (info.expiresAtUnix) return info.expiresAtUnix;
  const raw = session?.expires || session?.expiresAt || session?.expires_at;
  const parsed = Date.parse(String(raw || ''));
  return Number.isFinite(parsed) ? Math.trunc(parsed / 1000) : undefined;
}

function buildSub2ApiImportPayload(account, options = {}) {
  const session = account.session;
  const info = converter.extractSessionInfo(session);
  const expiresAt = resolveExpiresAtSeconds(session, info);
  const payload = {
    content: JSON.stringify(session),
    group_ids: options.groupIds || [],
    name: resolveSessionName(account, session, info),
    priority: resolvePriority(options.priority),
    auto_pause_on_expired: true,
    update_existing: true,
  };

  if (expiresAt) payload.expires_at = expiresAt;
  if (options.proxyId) payload.proxy_id = options.proxyId;

  return { payload, info };
}

function normalizeImportResult(result) {
  return {
    total: Math.max(0, Number(result?.total) || 0),
    created: Math.max(0, Number(result?.created) || 0),
    updated: Math.max(0, Number(result?.updated) || 0),
    skipped: Math.max(0, Number(result?.skipped) || 0),
    failed: Math.max(0, Number(result?.failed) || 0),
    warnings: Array.isArray(result?.warnings) ? result.warnings : [],
    errors: Array.isArray(result?.errors) ? result.errors : [],
  };
}

function firstImportMessage(result) {
  const buckets = [result.errors, result.warnings];
  for (const bucket of buckets) {
    const item = bucket?.find(entry => normalizeString(entry?.message || entry));
    if (item) return normalizeString(item.message || item);
  }
  return '';
}

async function uploadToSub2Api(options = {}) {
  const accounts = getSelectedSuccessfulAccounts(options.accountIds);
  if (accounts.length === 0) throw new Error('没有可上传的登录成功账号');

  const { origin, token } = await loginSub2Api(options);
  const groups = await getSub2ApiGroups(origin, token, options.groupNames || options.groupName, options);
  const groupIds = groups.map(group => Number(group?.id)).filter(id => Number.isFinite(id) && id > 0);
  if (!groupIds.length) throw new Error('sub2api 返回的目标分组 ID 无效');

  const proxy = await resolveSub2ApiProxy(origin, token, options.proxy || options.proxyName || options.proxyId, options);
  const proxyId = normalizeProxyId(proxy?.id);
  const results = [];
  const summary = {
    total: accounts.length,
    uploaded: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  };

  for (const account of accounts) {
    try {
      const { payload, info } = buildSub2ApiImportPayload(account, {
        groupIds,
        proxyId,
        priority: options.priority,
      });
      const rawResult = await requestJson(origin, '/api/v1/admin/accounts/import/codex-session', {
        method: 'POST',
        token,
        timeoutMs: options.importTimeoutMs || options.timeoutMs || 120000,
        body: payload,
      });
      const importResult = normalizeImportResult(rawResult);
      const ok = importResult.failed === 0 && (importResult.created > 0 || importResult.updated > 0);
      if (!ok) throw new Error(firstImportMessage(importResult) || 'sub2api 未创建或更新账号');

      summary.uploaded++;
      summary.created += importResult.created;
      summary.updated += importResult.updated;
      summary.skipped += importResult.skipped;
      results.push({
        id: account.id,
        email: info.email || account.email,
        target: 'sub2api',
        ok: true,
        action: importResult.created > 0 ? 'created' : 'updated',
        message: `新建 ${importResult.created}，更新 ${importResult.updated}`,
      });
    } catch (err) {
      summary.failed++;
      results.push({
        id: account.id,
        email: account.email,
        target: 'sub2api',
        ok: false,
        action: 'failed',
        message: err.message,
      });
    }
  }

  return { summary, results };
}

function sanitizeFilename(value) {
  return normalizeString(value)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'account';
}

function cpaJsonFilename(authJson, index = 0) {
  const email = sanitizeFilename(authJson?.email || authJson?.user_id || `account-${index + 1}`);
  const planType = sanitizeFilename(authJson?.plan_type || authJson?.chatgpt_plan_type || '');
  const accountId = sanitizeFilename(authJson?.account_id || authJson?.chatgpt_account_id || '');
  if (email && planType) return `codex-${email}-${planType}.json`;
  if (email) return `codex-${email}.json`;
  if (accountId) return `codex-${accountId}.json`;
  return `codex-account-${index + 1}.json`;
}

async function requestCpaManagement(baseUrl, pathname, options = {}) {
  const managementKey = normalizeString(options.managementKey);
  if (!managementKey) throw new Error('请填写 CPA 管理密钥');
  return requestJson(baseUrl, pathname, {
    ...options,
    headers: {
      Authorization: `Bearer ${managementKey}`,
      'X-Management-Key': managementKey,
      ...(options.headers || {}),
    },
  });
}

async function uploadToCpa(options = {}) {
  const accounts = getSelectedSuccessfulAccounts(options.accountIds);
  if (accounts.length === 0) throw new Error('没有可上传的登录成功账号');

  const baseUrl = normalizeManagementBaseUrl(options.baseUrl || DEFAULT_CPA_BASE_URL);
  const results = [];
  const summary = {
    total: accounts.length,
    uploaded: 0,
    failed: 0,
  };

  for (const [index, account] of accounts.entries()) {
    try {
      const info = converter.extractSessionInfo(account.session);
      const authJson = converter.toCPA([info])[0];
      const fileName = cpaJsonFilename(authJson, index);
      await requestCpaManagement(baseUrl, `/auth-files?name=${encodeURIComponent(fileName)}`, {
        method: 'POST',
        managementKey: options.managementKey,
        timeoutMs: options.importTimeoutMs || options.timeoutMs || 60000,
        body: authJson,
      });

      summary.uploaded++;
      results.push({
        id: account.id,
        email: authJson.email || account.email,
        target: 'cpa',
        ok: true,
        action: 'uploaded',
        name: fileName,
        message: '已上传 CPA auth-file',
      });
    } catch (err) {
      summary.failed++;
      results.push({
        id: account.id,
        email: account.email,
        target: 'cpa',
        ok: false,
        action: 'failed',
        message: err.message,
      });
    }
  }

  return { summary, results };
}

module.exports = {
  buildSub2ApiImportPayload,
  getSub2ApiGroups,
  loginSub2Api,
  normalizeGroupNames,
  normalizeImportResult,
  normalizeOrigin,
  normalizeProxyId,
  normalizeString,
  requestJson,
  resolveSub2ApiProxy,
  uploadToCpa,
  uploadToSub2Api,
};
