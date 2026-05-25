const { ImapFlow } = require('imapflow');
const config = require('../config');

const IMAP_TOKEN_SCOPES = [
  'https://outlook.office.com/.default offline_access',
  'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
  'https://outlook.office365.com/.default offline_access',
  'https://outlook.office365.com/IMAP.AccessAsUser.All offline_access',
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'openid offline_access https://outlook.office.com/IMAP.AccessAsUser.All',
];
const ACCESS_TOKEN_SKEW_MS = 60 * 1000;
const IMAP_IDLE_CLOSE_MS = 30 * 1000;
const accessTokenCache = new Map();
const imapClientPool = new Map();

async function refreshAccessToken(clientId, refreshToken) {
  const token = await refreshAccessTokenForScope(clientId, refreshToken, IMAP_TOKEN_SCOPES[0]);
  return token.accessToken;
}

async function* getAccessTokenCandidates(clientId, refreshToken) {
  const errors = [];
  let yielded = false;

  for (const scope of IMAP_TOKEN_SCOPES) {
    try {
      const token = await refreshAccessTokenForScope(clientId, refreshToken, scope);
      yielded = true;
      yield token;
    } catch (err) {
      errors.push(`${scope}: ${err.message}`);
    }
  }

  if (!yielded) {
    throw new Error(`IMAP token refresh failed:\n${errors.join('\n')}`);
  }
}

async function refreshAccessTokenForScope(clientId, refreshToken, scope) {
  const key = tokenCacheKey(clientId, refreshToken, scope);
  const cached = accessTokenCache.get(key);
  if (cached && cached.expiresAt - Date.now() > ACCESS_TOKEN_SKEW_MS) {
    return cached;
  }

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
    throw new Error(data.error_description || data.error || `HTTP ${response.status}`);
  }

  const token = {
    accessToken: data.access_token,
    scope,
    cacheKey: key,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000,
  };
  accessTokenCache.set(key, token);
  return token;
}

async function fetchEmails(account, options = {}) {
  const { email, clientId, refreshToken } = account;
  const {
    keyword = '',
    sender = '',
    limit = 10,
    recentOnly = false,
    fullBody = false,
    stopOnCode = false,
  } = options;
  const accessErrors = [];

  for await (const token of getAccessTokenCandidates(clientId, refreshToken)) {
    try {
      return await fetchEmailsWithToken(email, token, {
        keyword,
        sender,
        limit,
        recentOnly,
        fullBody,
        stopOnCode,
      });
    } catch (err) {
      accessErrors.push(`${token.scope}: ${err.message}`);
      if (!isImapTokenAccessError(err)) throw err;
      if (token.cacheKey) accessTokenCache.delete(token.cacheKey);
    }
  }

  throw new Error(`IMAP access failed for all token scopes:\n${accessErrors.join('\n')}`);
}

async function fetchEmailsWithToken(email, token, options = {}) {
  const {
    keyword = '',
    sender = '',
    limit = 10,
    recentOnly = false,
    fullBody = false,
    stopOnCode = false,
  } = options;
  let clientRef = null;

  try {
    clientRef = await getImapClient(email, token);
    const client = clientRef.client;
    const mailbox = await client.getMailboxLock('INBOX', { readOnly: true });

    try {
      const searchCriteria = recentOnly ? { all: true } : buildSearchCriteria(keyword, sender);
      let uids;
      try {
        uids = await client.search(searchCriteria, { uid: true });
      } catch {
        uids = await client.search({ all: true }, { uid: true });
      }

      if (!uids || uids.length === 0) {
        return { success: true, emails: [], count: 0, protocol: 'imap' };
      }

      uids.sort((a, b) => b - a);
      const targetUids = uids.slice(0, limit);
      const uidRange = targetUids.join(',');
      const shouldFetchSource = recentOnly || fullBody || stopOnCode;
      const sourceMaxLength = stopOnCode ? 128 * 1024 : shouldFetchSource ? 256 * 1024 : 64 * 1024;
      const fetchSets = stopOnCode ? targetUids.map(uid => String(uid)) : [uidRange];
      const fetchQuery = {
        uid: true,
        envelope: true,
      };
      if (shouldFetchSource) fetchQuery.source = { maxLength: sourceMaxLength };
      const messages = [];

      for (const fetchSet of fetchSets) {
        for await (const msg of client.fetch(fetchSet, fetchQuery, { uid: true })) {
          const parsed = parseRawMessage(msg.source);
          const message = {
            uid: msg.uid,
            messageId: msg.envelope?.messageId || `imap-${msg.uid}`,
            subject: msg.envelope?.subject || parsed.subject || '',
            from: msg.envelope?.from?.[0]?.address || parsed.from || '',
            fromName: msg.envelope?.from?.[0]?.name || parsed.fromName || '',
            date: msg.envelope?.date?.toISOString() || parsed.date || new Date().toISOString(),
            receivedDateTime: msg.envelope?.date?.toISOString() || parsed.date || '',
            bodyText: parsed.bodyText,
            bodyPreview: parsed.bodyPreview,
            bodyHtml: parsed.bodyHtml,
            protocol: 'imap',
          };
          messages.push(message);
          if (stopOnCode && hasVerificationCode(message)) {
            return buildFetchResult(messages, token);
          }
        }
      }

      messages.sort((a, b) => new Date(b.date) - new Date(a.date));
      return buildFetchResult(messages, token);
    } finally {
      mailbox.release();
    }
  } catch (err) {
    if (clientRef) closeImapClient(clientRef.key);
    throw err;
  } finally {
    if (clientRef) releaseImapClient(clientRef.key);
  }
}

async function getImapClient(email, token) {
  const key = imapClientKey(email, token);
  const existing = imapClientPool.get(key);
  if (existing?.client && !existing.client.isClosed && existing.client.usable) {
    if (existing.closeTimer) clearTimeout(existing.closeTimer);
    existing.closeTimer = null;
    return { key, client: existing.client };
  }

  if (existing?.client) closeImapClient(key);

  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: {
      user: email,
      accessToken: token.accessToken,
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
    greetingTimeout: 8000,
    socketTimeout: 12000,
  });
  const entry = { client, closeTimer: null };
  imapClientPool.set(key, entry);
  client.on('error', () => {});
  client.on('close', () => {
    if (imapClientPool.get(key)?.client === client) imapClientPool.delete(key);
  });
  try {
    await client.connect();
  } catch (err) {
    closeImapClient(key);
    throw err;
  }
  return { key, client };
}

function releaseImapClient(key) {
  const entry = imapClientPool.get(key);
  if (!entry?.client || entry.client.isClosed) return;
  if (entry.closeTimer) clearTimeout(entry.closeTimer);
  entry.closeTimer = setTimeout(() => closeImapClient(key), IMAP_IDLE_CLOSE_MS);
}

function closeImapClient(key) {
  const entry = imapClientPool.get(key);
  if (!entry) return;
  if (entry.closeTimer) clearTimeout(entry.closeTimer);
  imapClientPool.delete(key);
  try {
    entry.client.close();
  } catch {
    // ignore close errors
  }
}

function imapClientKey(email, token) {
  return `${String(email || '').toLowerCase()}:${token.scope}:${token.cacheKey || token.accessToken}`;
}

function buildFetchResult(messages, token) {
  messages.forEach(m => delete m.uid);
  return {
    success: true,
    emails: messages,
    count: messages.length,
    protocol: 'imap',
    tokenScope: token.scope,
  };
}

function isImapTokenAccessError(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return (
    message.includes('authenticate') ||
    message.includes('authentication') ||
    message.includes('authfail') ||
    message.includes('invalid credentials')
  );
}

function buildSearchCriteria(keyword, sender) {
  if (keyword && sender) {
    return {
      and: [
        { or: [{ subject: keyword }, { body: keyword }] },
        { from: sender },
      ],
    };
  }
  if (keyword) return { or: [{ subject: keyword }, { body: keyword }] };
  if (sender) return { from: sender };
  return { all: true };
}

function hasVerificationCode(email) {
  const marker = [
    email.from,
    email.fromName,
    email.subject,
    email.bodyPreview,
    email.bodyText,
  ].filter(Boolean).join(' ').toLowerCase();
  if (!/(openai|chatgpt|tm\.openai\.com|mail\.openai\.com|noreply)/i.test(marker)) return false;
  return /\b\d{6}\b/.test(marker);
}

function parseRawMessage(source) {
  if (!source) {
    return { subject: '', from: '', fromName: '', date: '', bodyText: '', bodyPreview: '', bodyHtml: '' };
  }

  const raw = Buffer.isBuffer(source) ? source.toString('utf8') : String(source);
  const { headers, body } = splitHeaders(raw);
  const contentType = getHeader(headers, 'content-type');
  const parts = parseMimeParts(body, contentType);

  let bodyText = '';
  let bodyHtml = '';
  for (const part of parts) {
    const type = getHeader(part.headers, 'content-type').toLowerCase();
    const disposition = getHeader(part.headers, 'content-disposition').toLowerCase();
    if (disposition.includes('attachment')) continue;

    const decoded = decodeBody(part.body, getHeader(part.headers, 'content-transfer-encoding'));
    if (type.includes('text/plain') && !bodyText) bodyText = decoded;
    if (type.includes('text/html') && !bodyHtml) bodyHtml = decoded;
  }

  if (!bodyText && !bodyHtml) {
    bodyText = decodeBody(body, getHeader(headers, 'content-transfer-encoding'));
  }
  if (!bodyText && bodyHtml) bodyText = stripHtml(bodyHtml);
  if (bodyText && /<\/?[a-z][\s\S]*>/i.test(bodyText)) {
    if (!bodyHtml) bodyHtml = bodyText;
    bodyText = stripHtml(bodyText);
  }

  bodyText = normalizeWhitespace(bodyText);
  return {
    subject: decodeMimeWords(getHeader(headers, 'subject')),
    from: parseAddress(getHeader(headers, 'from')).address,
    fromName: parseAddress(getHeader(headers, 'from')).name,
    date: getHeader(headers, 'date'),
    bodyText,
    bodyPreview: bodyText.slice(0, 300),
    bodyHtml,
  };
}

function parseMimeParts(body, contentType) {
  const boundary = String(contentType || '').match(/boundary="?([^";\r\n]+)"?/i)?.[1];
  if (!boundary) return [{ headers: '', body }];

  const delimiter = `--${boundary}`;
  return body
    .split(delimiter)
    .filter(part => part.trim() && !part.trim().startsWith('--'))
    .map(part => splitHeaders(part.replace(/^\r?\n/, '')));
}

function splitHeaders(raw) {
  const match = String(raw || '').match(/\r?\n\r?\n/);
  if (!match) return { headers: '', body: String(raw || '') };
  const index = match.index;
  return {
    headers: raw.slice(0, index),
    body: raw.slice(index + match[0].length),
  };
}

function getHeader(headers, name) {
  const lines = String(headers || '').split(/\r?\n/);
  const unfolded = [];
  for (const line of lines) {
    if (/^\s/.test(line) && unfolded.length) {
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    } else {
      unfolded.push(line);
    }
  }
  const prefix = `${name.toLowerCase()}:`;
  const found = unfolded.find(line => line.toLowerCase().startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : '';
}

function decodeBody(value, encoding) {
  const text = String(value || '').trim();
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc.includes('base64')) {
      return Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
    }
    if (enc.includes('quoted-printable')) {
      return decodeQuotedPrintable(text);
    }
  } catch {
    return text;
  }
  return text;
}

function decodeQuotedPrintable(value) {
  const binary = String(value || '')
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(binary, 'binary').toString('utf8');
}

function decodeMimeWords(value) {
  return String(value || '').replace(/=\?([^?]+)\?([bq])\?([^?]+)\?=/gi, (_, charset, encoding, encoded) => {
    try {
      if (encoding.toLowerCase() === 'b') {
        return Buffer.from(encoded, 'base64').toString('utf8');
      }
      return decodeQuotedPrintable(encoded.replace(/_/g, ' '));
    } catch {
      return _;
    }
  });
}

function parseAddress(value) {
  const text = decodeMimeWords(value);
  const match = text.match(/^(?:"?([^"]*)"?\s)?<([^>]+)>$/);
  if (match) return { name: match[1] || '', address: match[2].toLowerCase() };
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
  return { name: '', address: email.toLowerCase() };
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function tokenCacheKey(clientId, refreshToken, scope) {
  return `${clientId}:${scope}:${refreshToken}`;
}

module.exports = { fetchEmails, refreshAccessToken };
