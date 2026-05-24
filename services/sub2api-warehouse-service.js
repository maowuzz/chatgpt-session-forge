/**
 * sub2api 401 仓管服务。
 * 扫描 sub2api OpenAI 账号状态，发现 401 / unauthorized 后重登本地匹配账号并覆盖导入。
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const chatgptService = require('./chatgpt-service');
const imapService = require('./imap-service');
const graphService = require('./graph-service');
const externalMailService = require('./external-mail-service');
const upload = require('./session-upload-service');

const DATA_FILE = path.resolve(__dirname, '..', config.dataFile);
const ACCOUNT_LIST_ENDPOINTS = [
  '/api/v1/admin/accounts/all',
  '/api/v1/admin/accounts?with_count=true',
  '/api/v1/admin/accounts',
];

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
    return { message: '账号已停用', type: 'account_deactivated' };
  }
  return { message, type: null };
}

async function fetchVerificationCode(account) {
  const options = { keyword: 'OpenAI', sender: '', limit: 5 };
  const mailboxAccount = buildMailboxAccount(account);
  const provider = externalMailService.getAccountMailProvider(mailboxAccount);
  if (provider !== 'outlook') {
    const result = await externalMailService.fetchEmails(mailboxAccount, options).catch(err => {
      console.error(`[sub2api 仓管外部邮箱取码失败] ${mailboxAccount.email} (${provider}):`, err.message);
      return { success: false, emails: [] };
    });
    return result.emails || [];
  }

  const results = await Promise.all([
    imapService.fetchEmails(mailboxAccount, options).catch(err => {
      console.error(`[sub2api 仓管 IMAP 取码失败] ${mailboxAccount.email}:`, err.message);
      return { success: false, emails: [] };
    }),
    graphService.fetchEmails(mailboxAccount, options).catch(err => {
      console.error(`[sub2api 仓管 Graph 取码失败] ${mailboxAccount.email}:`, err.message);
      return { success: false, emails: [] };
    }),
  ]);
  return results.flatMap(result => result.emails || []);
}

function buildMailboxAccount(account = {}) {
  const mailEmail = upload.normalizeString(account.mailEmail || account.email).toLowerCase();
  if (!mailEmail || mailEmail === upload.normalizeString(account.email).toLowerCase()) return account;
  return { ...account, email: mailEmail };
}

function isOpenAiAccount(account = {}) {
  const text = [
    account.platform,
    account.provider,
    account.type,
    account.account_type,
    account.model_provider,
    account.credentials?.platform,
    account.credentials?.type,
  ].filter(Boolean).join(' ').toLowerCase();
  return !text || text.includes('openai') || text.includes('codex') || Boolean(account.credentials?.access_token);
}

function is401Account(account = {}) {
  const text = collectDiagnosticText(account).toLowerCase();
  return (
    /\b401\b/.test(text) ||
    text.includes('unauthorized') ||
    text.includes('token revoked') ||
    text.includes('token_revoked') ||
    text.includes('token invalidated') ||
    text.includes('token_invalidated') ||
    text.includes('authentication token has been invalidated')
  );
}

function inferEmail(account = {}) {
  const candidates = [
    account.email,
    account.name,
    account.label,
    account.credentials?.email,
    account.extra?.email,
    account.user?.email,
    account.profile?.email,
  ];
  for (const value of candidates) {
    const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (match) return match[0].toLowerCase();
  }
  return '';
}

function accountStatusMessage(account = {}) {
  const direct = upload.normalizeString(
    account.status_message ||
    account.statusMessage ||
    account.error ||
    account.message ||
    account.last_error ||
    account.lastError ||
    account.unavailable_reason ||
    account.unavailableReason ||
    account.status ||
    ''
  );
  if (direct) return compactStatusMessage(direct);
  return compactStatusMessage(collectDiagnosticText(account));
}

function compactStatusMessage(text) {
  return upload.normalizeString(text)
    .replace(/\s+/g, ' ')
    .slice(0, 260);
}

function collectDiagnosticText(value, depth = 0, seen = new Set()) {
  if (value === undefined || value === null || depth > 5) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value !== 'object') return '';
  if (seen.has(value)) return '';
  seen.add(value);

  const parts = [];
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretDiagnosticKey(key)) continue;
    if (isDiagnosticKey(key)) parts.push(key);
    if (isDiagnosticKey(key) || isDiagnosticContainer(entry)) {
      parts.push(collectDiagnosticText(entry, depth + 1, seen));
    }
  }

  return parts.filter(Boolean).join(' ');
}

function isDiagnosticKey(key = '') {
  return /status|error|message|reason|detail|code|invalid|unauthor|revoked|failed|failure/i.test(key);
}

function isDiagnosticContainer(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.length <= 20;
  return Object.keys(value).some(isDiagnosticKey);
}

function isSecretDiagnosticKey(key = '') {
  return /access.?token|refresh.?token|id.?token|session.?token|password|secret|authorization/i.test(key);
}

function getAccountLoginEmail(account) {
  return upload.normalizeString(account?.loginEmail || account?.chatgptEmail || account?.email).toLowerCase();
}

function findLocalAccountByEmail(accounts, email) {
  const target = upload.normalizeString(email).toLowerCase();
  if (!target) return null;
  return accounts.find(account => getAccountLoginEmail(account) === target)
    || accounts.find(account => upload.normalizeString(account.email).toLowerCase() === target)
    || accounts.find(account => accountMatchesAliasEmail(account, target))
    || null;
}

function buildOtpLoginAccount(localAccount, loginEmail) {
  const normalizedLoginEmail = upload.normalizeString(loginEmail || localAccount.email).toLowerCase();
  const normalizedMailEmail = upload.normalizeString(localAccount.email).toLowerCase();
  return {
    ...localAccount,
    email: normalizedLoginEmail,
    password: '',
    mailEmail: normalizedMailEmail,
    requireTargetEmailMatch: Boolean(normalizedLoginEmail && normalizedMailEmail && normalizedLoginEmail !== normalizedMailEmail),
  };
}

function accountMatchesAliasEmail(account, candidateEmail) {
  const candidate = parseEmailParts(candidateEmail);
  if (!candidate) return false;

  for (const localEmail of getLocalAccountEmails(account)) {
    const base = parseEmailParts(localEmail);
    if (!base) continue;
    if (base.full === candidate.full) return true;
    if (matchesPlusAlias(base, candidate)) return true;
    if (matchesGmailAlias(base, candidate)) return true;
    if (matchesMail2925Alias(base, candidate)) return true;
  }

  return false;
}

function getLocalAccountEmails(account = {}) {
  const values = [
    account.email,
    account.loginEmail,
    account.chatgptEmail,
    account.registrationEmail,
    account.baseEmail,
    account.gmailBaseEmail,
    account.mail2925BaseEmail,
    account.originalEmail,
  ];
  return Array.from(new Set(values.map(value => upload.normalizeString(value).toLowerCase()).filter(Boolean)));
}

function parseEmailParts(value = '') {
  const email = upload.normalizeString(value).toLowerCase();
  const match = email.match(/^([^@\s]+)@([^@\s]+\.[^@\s]+)$/);
  if (!match) return null;
  return {
    full: email,
    localPart: match[1],
    domain: match[2],
  };
}

function matchesPlusAlias(base, candidate) {
  if (base.domain !== candidate.domain) return false;
  if (!candidate.localPart.includes('+')) return false;
  return candidate.localPart.split('+')[0] === base.localPart;
}

function matchesGmailAlias(base, candidate) {
  if (!isGmailDomain(base.domain) || !isGmailDomain(candidate.domain)) return false;
  const baseLocal = normalizeGmailLocalPart(base.localPart);
  const candidateLocal = normalizeGmailLocalPart(candidate.localPart.split('+')[0]);
  return Boolean(baseLocal && baseLocal === candidateLocal);
}

function normalizeGmailLocalPart(value = '') {
  return upload.normalizeString(value).toLowerCase().replace(/\./g, '');
}

function isGmailDomain(domain = '') {
  return /^(gmail|googlemail)\.com$/i.test(upload.normalizeString(domain));
}

function matchesMail2925Alias(base, candidate) {
  if (base.domain !== '2925.com' || candidate.domain !== '2925.com') return false;
  return candidate.localPart === base.localPart || candidate.localPart.startsWith(base.localPart);
}

function extractAccountsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.accounts)) return payload.accounts;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.accounts)) return payload.data.accounts;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  return [];
}

class Sub2ApiManagementClient {
  constructor(options = {}) {
    this.options = options;
    this.origin = '';
    this.token = '';
  }

  async init() {
    const session = await upload.loginSub2Api(this.options);
    this.origin = session.origin;
    this.token = session.token;
    return this;
  }

  async request(pathname, options = {}) {
    return upload.requestJson(this.origin, pathname, {
      ...options,
      token: this.token,
      timeoutMs: options.timeoutMs || this.options.timeoutMs,
    });
  }

  async listAccounts() {
    const errors = [];
    for (const endpoint of ACCOUNT_LIST_ENDPOINTS) {
      try {
        const payload = await this.request(endpoint, { method: 'GET' });
        const accounts = extractAccountsFromPayload(payload);
        if (accounts.length || payload !== null) {
          return { endpoint, accounts };
        }
      } catch (err) {
        errors.push(`${endpoint}: ${err.message}`);
      }
    }
    throw new Error(`无法读取 sub2api 账号列表：${errors.join('；')}`);
  }

  async importSession(account, options = {}) {
    const groups = await upload.getSub2ApiGroups(
      this.origin,
      this.token,
      this.options.groupNames || this.options.groupName,
      this.options
    );
    const groupIds = groups.map(group => Number(group?.id)).filter(id => Number.isFinite(id) && id > 0);
    if (!groupIds.length) throw new Error('sub2api 返回的目标分组 ID 无效');

    const proxy = await upload.resolveSub2ApiProxy(
      this.origin,
      this.token,
      this.options.proxy || this.options.proxyName || this.options.proxyId,
      this.options
    );
    const proxyId = upload.normalizeProxyId(proxy?.id);
    const { payload } = upload.buildSub2ApiImportPayload(account, {
      groupIds,
      proxyId,
      priority: this.options.priority,
    });
    if (options.name) payload.name = options.name;

    const rawResult = await this.request('/api/v1/admin/accounts/import/codex-session', {
      method: 'POST',
      timeoutMs: this.options.importTimeoutMs || this.options.timeoutMs || 120000,
      body: payload,
    });
    return upload.normalizeImportResult(rawResult);
  }
}

function mapCandidate(account) {
  return {
    id: account.id,
    name: account.name || account.label || account.email || '',
    email: inferEmail(account),
    status: account.status || '',
    status_message: accountStatusMessage(account),
    disabled: Boolean(account.disabled),
    unavailable: Boolean(account.unavailable),
    platform: account.platform || account.provider || '',
  };
}

async function scan401Accounts(options = {}) {
  const client = await new Sub2ApiManagementClient(options).init();
  const { endpoint, accounts } = await client.listAccounts();
  const openaiAccounts = accounts.filter(isOpenAiAccount);
  const candidates = openaiAccounts.filter(is401Account).map(mapCandidate);

  return {
    endpoint,
    total: openaiAccounts.length,
    candidates,
  };
}

async function repair401Accounts(options = {}, onEvent = () => {}) {
  const client = await new Sub2ApiManagementClient(options).init();
  const { endpoint, accounts } = await client.listAccounts();
  const openaiAccounts = accounts.filter(isOpenAiAccount);
  const candidates = openaiAccounts.filter(is401Account);
  const limit = Math.max(1, Math.min(50, parseInt(options.maxItems, 10) || candidates.length || 1));
  const selected = candidates.slice(0, limit);
  const summary = {
    total: openaiAccounts.length,
    candidates: candidates.length,
    processed: 0,
    uploaded: 0,
    skipped: 0,
    failed: 0,
  };
  const results = [];

  onEvent({ type: 'sub2api_warehouse_start', total: selected.length, scanned: openaiAccounts.length, endpoint });

  for (const remoteAccount of selected) {
    const result = await repairOne401Account(client, remoteAccount, onEvent);
    results.push(result);
    summary.processed++;
    if (result.action === 'uploaded') summary.uploaded++;
    else if (result.action === 'skipped') summary.skipped++;
    else summary.failed++;
    onEvent({ type: 'sub2api_warehouse_item', result: sanitizeResultForEvent(result), summary });
  }

  onEvent({ type: 'sub2api_warehouse_complete', summary });
  return { endpoint, summary, results };
}

async function repairOne401Account(client, remoteAccount, onEvent) {
  const email = inferEmail(remoteAccount);
  const name = remoteAccount.name || remoteAccount.label || email || String(remoteAccount.id || '');
  const statusMessage = accountStatusMessage(remoteAccount);

  if (!email) {
    return {
      id: remoteAccount.id,
      name,
      email: '',
      action: 'skipped',
      ok: false,
      message: '无法从 sub2api 账号识别邮箱，已跳过',
      status_message: statusMessage,
    };
  }

  const localAccount = findLocalAccountByEmail(readAccounts(), email);
  if (!localAccount) {
    return {
      id: remoteAccount.id,
      name,
      email,
      action: 'skipped',
      ok: false,
      message: '本地没有匹配的登录账号',
      status_message: statusMessage,
    };
  }

  onEvent({
    type: 'sub2api_warehouse_status',
    email,
    name,
    status: 'login_start',
    detail: 'sub2api 401 账号开始重新登录',
  });

  let session;
  const loginAccount = buildOtpLoginAccount(localAccount, email);
  try {
    updateAccount(localAccount.id, { status: 'logging_in', error: null, errorType: null });
    session = await chatgptService.login(loginAccount, fetchVerificationCode, (status, detail) => {
      onEvent({ type: 'sub2api_warehouse_status', email, name, status, detail });
    });
  } catch (err) {
    const loginError = normalizeLoginError(err.message);
    updateAccount(localAccount.id, {
      status: 'failed',
      error: loginError.message,
      errorType: loginError.type,
    });
    return {
      id: remoteAccount.id,
      name,
      email,
      action: 'login_failed',
      ok: false,
      message: `重新登录失败：${loginError.message}`,
      status_message: statusMessage,
    };
  }

  updateAccount(localAccount.id, {
    status: 'success',
    session,
    error: null,
    errorType: null,
  });

  try {
    const importResult = await client.importSession(
      { ...localAccount, email: loginAccount.email, session },
      { name: email || name }
    );
    const ok = importResult.failed === 0 && (importResult.created > 0 || importResult.updated > 0);
    if (!ok) throw new Error('sub2api 未创建或更新账号');
    return {
      id: remoteAccount.id,
      name,
      email,
      action: 'uploaded',
      ok: true,
      message: `重登成功，已更新 sub2api（新建 ${importResult.created}，更新 ${importResult.updated}）`,
      status_message: statusMessage,
    };
  } catch (err) {
    return {
      id: remoteAccount.id,
      name,
      email,
      action: 'upload_failed',
      ok: false,
      message: `重登成功，但更新 sub2api 失败：${err.message}`,
      status_message: statusMessage,
    };
  }
}

function sanitizeResultForEvent(result) {
  return {
    id: result.id,
    name: result.name,
    email: result.email,
    action: result.action,
    ok: result.ok,
    message: result.message,
  };
}

module.exports = {
  Sub2ApiManagementClient,
  accountMatchesAliasEmail,
  is401Account,
  isOpenAiAccount,
  scan401Accounts,
  repair401Accounts,
};
