/**
 * Microsoft Graph API 邮件获取服务
 * 通过 Graph REST API 获取 Outlook 邮件
 */

const config = require('../config');

/**
 * 刷新 OAuth2 access token (Graph API 作用域)
 */
async function refreshAccessToken(clientId, refreshToken) {
  // Graph API 刷新 token 时，支持多种 scope 格式
  // .default 可以获取所有已授权权限
  const scopes = [
    'https://graph.microsoft.com/.default',
    'https://graph.microsoft.com/Mail.Read offline_access',
  ];

  let lastError = null;
  for (const scope of scopes) {
    try {
      return await _requestGraphToken(clientId, refreshToken, scope);
    } catch (err) {
      lastError = err;
      continue;
    }
  }
  throw lastError;
}

async function _requestGraphToken(clientId, refreshToken, scope) {
  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: scope,
  });

  const response = await fetch(config.graph.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    const msg = data.error_description || data.error || 'Token 刷新失败';
    throw new Error(`Graph Token 错误: ${msg}`);
  }

  return data.access_token;
}

/**
 * 通过 Graph API 获取邮件
 * @param {object} account - 账号信息
 * @param {object} options - {keyword, sender, limit}
 * @returns {object} - {success, emails, count, protocol}
 */
async function fetchEmails(account, options = {}) {
  const { email, clientId, refreshToken } = account;
  const { keyword = '', sender = '', limit = 10 } = options;

  // 1. 刷新 access token
  const accessToken = await refreshAccessToken(clientId, refreshToken);

  // 2. 构建查询参数
  const params = new URLSearchParams({
    $top: String(limit),
    $orderby: 'receivedDateTime desc',
    $select: 'id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,bodyPreview,body,internetMessageId',
  });

  // 关键词搜索
  if (keyword) {
    params.set('$search', `"${keyword}"`);
    // Graph API 使用 $search 时不能同时用 $orderby
    params.delete('$orderby');
  }

  // 发件人过滤
  if (sender && !keyword) {
    params.set('$filter', `from/emailAddress/address eq '${sender}'`);
  }

  const url = `${config.graph.apiBase}/me/messages?${params.toString()}`;

  // 3. 发起请求
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    const errMsg = errData?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Graph API 错误: ${errMsg}`);
  }

  const data = await response.json();
  const messages = (data.value || []).map(msg => ({
    messageId: msg.internetMessageId || msg.id,
    subject: msg.subject || '(无主题)',
    from: msg.from?.emailAddress?.address || '',
    fromName: msg.from?.emailAddress?.name || '',
    to: graphRecipientList(msg.toRecipients),
    cc: graphRecipientList(msg.ccRecipients),
    bcc: graphRecipientList(msg.bccRecipients),
    recipients: [
      ...graphRecipientList(msg.toRecipients),
      ...graphRecipientList(msg.ccRecipients),
      ...graphRecipientList(msg.bccRecipients),
    ],
    date: msg.receivedDateTime || new Date().toISOString(),
    bodyText: stripHtml(msg.body?.content || ''),
    bodyPreview: msg.bodyPreview || '',
    bodyHtml: msg.body?.contentType === 'html' ? msg.body.content : '',
    protocol: 'graph',
  }));

  // 如果用了 $search 且有 sender 过滤，客户端再过滤一次
  let filtered = messages;
  if (keyword && sender) {
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
  };
}

function graphRecipientList(recipients = []) {
  if (!Array.isArray(recipients)) return [];
  return recipients
    .map(recipient => String(recipient?.emailAddress?.address || '').trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 简单去除 HTML 标签
 */
function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { fetchEmails, refreshAccessToken };
