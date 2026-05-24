/**
 * Outlook IMAP OAuth2 邮件获取服务
 *
 * 目标是稳定取验证码邮件：
 * 1. OAuth scope 多路兜底，适配不同来源的 refresh token
 * 2. IMAP 只取最近邮件，再在本地做关键词/发件人过滤，避开 Outlook SEARCH 兼容性问题
 * 3. 正文优先取 text/plain / html part，取不到时回退到 message source 片段
 */

const { ImapFlow } = require('imapflow');
const config = require('../config');

const DEFAULT_LIMIT = 10;
const SEARCH_WINDOW_MIN = 20;
const SEARCH_WINDOW_MAX = 80;
const BODY_PREVIEW_BYTES = 16384;

/**
 * 刷新 OAuth2 access token
 */
async function refreshAccessToken(clientId, refreshToken) {
  const scopes = [
    'https://outlook.office365.com/IMAP.AccessAsUser.All offline_access',
    'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
    'https://outlook.office365.com/.default offline_access',
    'https://graph.microsoft.com/.default offline_access',
  ];

  let lastError = null;
  for (const scope of scopes) {
    try {
      return await _requestToken(clientId, refreshToken, scope);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function _requestToken(clientId, refreshToken, scope) {
  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope,
  });

  const response = await fetch(config.graph.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const msg = data.error_description || data.error || `HTTP ${response.status}`;
    throw new Error(`IMAP Token 错误: ${msg}`);
  }

  if (!data.access_token) {
    throw new Error('IMAP Token 错误: 响应缺少 access_token');
  }

  return data.access_token;
}

/**
 * 通过 IMAP 获取邮件
 */
async function fetchEmails(account, options = {}) {
  const { email, clientId, refreshToken } = account;
  const keyword = String(options.keyword || '').trim();
  const sender = String(options.sender || '').trim();
  const limit = normalizeLimit(options.limit);
  const accessToken = await refreshAccessToken(clientId, refreshToken);

  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: {
      user: email,
      accessToken,
      loginMethod: 'AUTH=XOAUTH2',
    },
    clientInfo: {
      name: 'chatgpt-session-forge',
      version: '1.0.0',
      vendor: 'local',
    },
    disableAutoIdle: true,
    disableAutoEnable: true,
    disableCompression: true,
    logger: false,
    connectionTimeout: config.imap.timeout || 30000,
    greetingTimeout: 15000,
    socketTimeout: config.imap.timeout || 30000,
  });

  try {
    await client.connect();
    const mailbox = await client.getMailboxLock('INBOX');

    try {
      const uids = await resolveRecentUids(client, limit, Boolean(keyword || sender));
      if (uids.length === 0) {
        return { success: true, emails: [], count: 0, protocol: 'imap' };
      }

      const messages = await fetchMessageSummaries(client, uids);
      await hydrateMessageBodies(client, messages);

      const filtered = messages
        .filter(message => matchesFilters(message, keyword, sender))
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, limit)
        .map(message => {
          const { uid, bodyPart, ...safeMessage } = message;
          return safeMessage;
        });

      return { success: true, emails: filtered, count: filtered.length, protocol: 'imap' };
    } finally {
      mailbox.release();
    }
  } catch (err) {
    throw new Error(normalizeImapError(err));
  } finally {
    await client.logout().catch(() => {});
  }
}

function normalizeLimit(value) {
  return Math.max(1, Math.min(50, Number(value) || DEFAULT_LIMIT));
}

async function resolveRecentUids(client, limit, hasFilters) {
  const wanted = Math.max(limit, hasFilters ? Math.min(SEARCH_WINDOW_MAX, limit * 4) : limit);
  const exists = Number(client.mailbox?.exists || 0);
  if (exists <= 0) return [];

  const sequenceStart = Math.max(1, exists - Math.max(wanted, SEARCH_WINDOW_MIN) + 1);
  const sequenceRange = `${sequenceStart}:*`;
  const uids = [];

  for await (const msg of client.fetch(sequenceRange, { uid: true, internalDate: true })) {
    if (msg.uid) uids.push(msg.uid);
  }

  return uids.sort((a, b) => b - a).slice(0, Math.max(wanted, limit));
}

async function fetchMessageSummaries(client, uids) {
  const messages = [];
  for await (const msg of client.fetch(uids, {
    uid: true,
    envelope: true,
    bodyStructure: true,
    internalDate: true,
    source: { start: 0, maxLength: 256 },
  }, { uid: true })) {
    messages.push({
      uid: msg.uid,
      messageId: msg.envelope?.messageId || `imap-${msg.uid}`,
      subject: msg.envelope?.subject || '(无主题)',
      from: firstAddress(msg.envelope?.from)?.address || '',
      fromName: firstAddress(msg.envelope?.from)?.name || '',
      to: addressList(msg.envelope?.to),
      cc: addressList(msg.envelope?.cc),
      bcc: addressList(msg.envelope?.bcc),
      recipients: [
        ...addressList(msg.envelope?.to),
        ...addressList(msg.envelope?.cc),
        ...addressList(msg.envelope?.bcc),
      ],
      date: (msg.envelope?.date || msg.internalDate || new Date()).toISOString(),
      bodyText: '',
      bodyPreview: '',
      bodyHtml: '',
      bodyPart: findPreferredBodyPart(msg.bodyStructure),
      protocol: 'imap',
    });
  }

  return messages;
}

async function hydrateMessageBodies(client, messages) {
  for (const message of messages) {
    try {
      if (message.bodyPart?.part) {
        const query = {
          uid: true,
          bodyParts: [{ key: message.bodyPart.part, start: 0, maxLength: BODY_PREVIEW_BYTES }],
        };
        const fetched = await client.fetchOne(message.uid, query, { uid: true });
        const part = fetched?.bodyParts?.get(message.bodyPart.part);
        if (part) {
          applyBodyContent(message, part, message.bodyPart);
          continue;
        }
      }

      const fallback = await client.fetchOne(message.uid, {
        uid: true,
        source: { start: 0, maxLength: BODY_PREVIEW_BYTES },
      }, { uid: true });
      if (fallback?.source) applyBodyContent(message, fallback.source, { type: 'text/plain' });
    } catch {
      // 信封信息足够判断是否有邮件；正文读取失败不让整个账号失败。
    }
  }
}

function firstAddress(addresses = []) {
  return Array.isArray(addresses) && addresses.length > 0 ? addresses[0] : null;
}

function addressList(addresses = []) {
  if (!Array.isArray(addresses)) return [];
  return addresses
    .map(address => String(address?.address || '').trim().toLowerCase())
    .filter(Boolean);
}

function findPreferredBodyPart(structure) {
  const parts = [];
  walkBodyStructure(structure, parts);

  return (
    parts.find(part => part.type === 'text/plain' && !isAttachment(part)) ||
    parts.find(part => part.type === 'text/html' && !isAttachment(part)) ||
    parts.find(part => part.type.startsWith('text/') && !isAttachment(part)) ||
    null
  );
}

function walkBodyStructure(node, parts) {
  if (!node) return;
  if (Array.isArray(node.childNodes)) {
    node.childNodes.forEach(child => walkBodyStructure(child, parts));
    return;
  }

  const type = String(node.type || '').toLowerCase();
  if (node.part && type.startsWith('text/')) {
    parts.push({
      part: node.part,
      type,
      encoding: String(node.encoding || '').toLowerCase(),
      charset: String(node.parameters?.charset || '').toLowerCase(),
      disposition: String(node.disposition || '').toLowerCase(),
    });
  }
}

function isAttachment(part) {
  return part.disposition === 'attachment';
}

function applyBodyContent(message, buffer, part = {}) {
  const decoded = decodeBody(buffer, part.encoding);
  const text = part.type === 'text/html' ? stripHtml(decoded) : stripHtml(decoded);

  message.bodyText = text.substring(0, 4000);
  message.bodyPreview = text.substring(0, 240);
  if (part.type === 'text/html') message.bodyHtml = decoded;
}

function decodeBody(buffer, encoding = '') {
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const normalizedEncoding = String(encoding || '').toLowerCase();

  if (normalizedEncoding === 'base64') {
    return raw.toString('utf8').replace(/\s+/g, '').trim()
      ? Buffer.from(raw.toString('utf8').replace(/\s+/g, ''), 'base64').toString('utf8')
      : '';
  }

  if (normalizedEncoding === 'quoted-printable') {
    return decodeQuotedPrintable(raw.toString('utf8'));
  }

  return raw.toString('utf8');
}

function decodeQuotedPrintable(value = '') {
  return String(value || '')
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripHtml(value = '') {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesFilters(message, keyword, sender) {
  const keywordText = String(keyword || '').toLowerCase();
  const senderText = String(sender || '').toLowerCase();

  if (senderText) {
    const from = `${message.from || ''} ${message.fromName || ''}`.toLowerCase();
    if (!from.includes(senderText)) return false;
  }

  if (keywordText) {
    const haystack = [
      message.subject,
      message.from,
      message.fromName,
      message.bodyPreview,
      message.bodyText,
    ].join(' ').toLowerCase();
    if (!haystack.includes(keywordText)) return false;
  }

  return true;
}

function normalizeImapError(err) {
  const message = err?.message || String(err || '未知错误');

  if (/AUTHENTICATE|Authentication|Invalid credentials|NO AUTHENTICATE|LOGIN failed/i.test(message)) {
    return `IMAP 认证失败：${message}`;
  }
  if (/Unsupported authentication mechanism/i.test(message)) {
    return 'IMAP 认证失败：服务器未开放 XOAUTH2/OAUTHBEARER，请确认 Outlook IMAP 已启用且 refresh token 授权包含 IMAP.AccessAsUser.All';
  }
  if (/ETIMEDOUT|ESOCKET|ECONN|Greeting never received|Socket timeout|Timed out/i.test(message)) {
    return `IMAP 连接超时：${message}`;
  }

  return message;
}

module.exports = { fetchEmails, refreshAccessToken };
