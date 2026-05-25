const config = require('../config');

const GRAPH_TOKEN_SCOPES = [
  'https://graph.microsoft.com/.default offline_access',
  'https://graph.microsoft.com/Mail.Read offline_access',
  'https://graph.microsoft.com/Mail.Read',
  'openid offline_access https://graph.microsoft.com/Mail.Read',
];
const ACCESS_TOKEN_SKEW_MS = 60 * 1000;
const accessTokenCache = new Map();

async function refreshAccessToken(clientId, refreshToken) {
  const token = await refreshAccessTokenForScope(clientId, refreshToken, GRAPH_TOKEN_SCOPES[0]);
  return token.accessToken;
}

async function* getAccessTokenCandidates(clientId, refreshToken) {
  const errors = [];
  let yielded = false;

  for (const scope of GRAPH_TOKEN_SCOPES) {
    try {
      const token = await refreshAccessTokenForScope(clientId, refreshToken, scope);
      yielded = true;
      yield token;
    } catch (err) {
      errors.push(`${scope}: ${err.message}`);
    }
  }

  if (!yielded) {
    throw new Error(`Graph token refresh failed:\n${errors.join('\n')}`);
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
  const { keyword = '', sender = '', limit = 10, recentOnly = false } = options;
  const params = new URLSearchParams({
    $top: String(limit),
    $orderby: 'receivedDateTime desc',
    $select: 'id,subject,from,sender,receivedDateTime,bodyPreview,body,internetMessageId',
  });

  // OTP polling should not use Graph $search. New mail can arrive before the
  // search index catches up, so recentOnly fetches recent messages and lets the
  // caller filter locally.
  if (!recentOnly && keyword) {
    params.set('$search', `"${keyword}"`);
    params.delete('$orderby');
  }

  if (!recentOnly && sender && !keyword) {
    params.set('$filter', `from/emailAddress/address eq '${escapeGraphFilterValue(sender)}'`);
  }

  const url = `${config.graph.apiBase}/me/messages?${params.toString()}`;
  const accessErrors = [];

  for await (const token of getAccessTokenCandidates(clientId, refreshToken)) {
    try {
      return await fetchEmailsWithToken(url, token, { keyword, sender, recentOnly });
    } catch (err) {
      accessErrors.push(`${token.scope}: ${err.message}`);
      if (!isGraphTokenAccessError(err)) throw err;
      if (token.cacheKey) accessTokenCache.delete(token.cacheKey);
    }
  }

  throw new Error(`Graph API access failed for all token scopes:\n${accessErrors.join('\n')}`);
}

async function fetchEmailsWithToken(url, token, options) {
  const { keyword, sender, recentOnly } = options;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    const errMsg = errData?.error?.message || `HTTP ${response.status}`;
    const err = new Error(`Graph API error: ${errMsg}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const messages = (data.value || []).map(msg => ({
    messageId: msg.internetMessageId || msg.id,
    subject: msg.subject || '(no subject)',
    from: msg.from?.emailAddress?.address || msg.sender?.emailAddress?.address || '',
    fromName: msg.from?.emailAddress?.name || msg.sender?.emailAddress?.name || '',
    date: msg.receivedDateTime || new Date().toISOString(),
    receivedDateTime: msg.receivedDateTime || '',
    bodyText: stripHtml(msg.body?.content || ''),
    bodyPreview: msg.bodyPreview || '',
    bodyHtml: msg.body?.contentType === 'html' ? msg.body.content : '',
    protocol: 'graph',
  }));

  let filtered = messages;
  if (!recentOnly && keyword && sender) {
    const s = sender.toLowerCase();
    filtered = messages.filter(m =>
      m.from.toLowerCase().includes(s) || m.fromName.toLowerCase().includes(s)
    );
  }

  return {
    success: true,
    emails: filtered,
    count: filtered.length,
    protocol: 'graph',
    tokenScope: token.scope,
  };
}

function isGraphTokenAccessError(err) {
  return err?.status === 401 || err?.status === 403;
}

function escapeGraphFilterValue(value) {
  return String(value || '').replace(/'/g, "''");
}

function tokenCacheKey(clientId, refreshToken, scope) {
  return `${clientId}:${scope}:${refreshToken}`;
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
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { fetchEmails, refreshAccessToken };
