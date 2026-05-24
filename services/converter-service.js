/**
 * Session 格式转换服务
 * 将 ChatGPT session JSON 转换为 CPA / sub2api 格式
 * 移植自 GPTSession2CPAandSub2API 项目
 */

/**
 * 解码 JWT payload（不验签，仅解析）
 */
function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') return null;

  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;

    let payload = parts[1];
    // base64url → base64
    payload = payload.replace(/-/g, '+').replace(/_/g, '/');
    // 补齐 padding
    while (payload.length % 4 !== 0) {
      payload += '=';
    }

    const decoded = Buffer.from(payload, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function decodeJwtHeader(token) {
  if (!token || typeof token !== 'string') return null;

  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;

    let header = parts[0];
    header = header.replace(/-/g, '+').replace(/_/g, '/');
    while (header.length % 4 !== 0) {
      header += '=';
    }

    const decoded = Buffer.from(header, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function isSyntheticCodexIdToken(token) {
  const header = decodeJwtHeader(token);
  return Boolean(header && header.alg === 'none' && header.cpa_synthetic === true);
}

function normalizeSyntheticCodexIdToken(token) {
  if (!token || typeof token !== 'string') return '';
  const parts = token.split('.');
  if (parts.length !== 3 || !isSyntheticCodexIdToken(token)) return token;
  return `${parts[0]}.${parts[1]}.`;
}

/**
 * 从 session JSON 中提取关键信息
 */
function extractSessionInfo(session) {
  const info = {
    email: '',
    accessToken: '',
    sessionToken: '',
    idToken: '',
    accountId: '',
    userId: '',
    planType: '',
    isPlus: false,
    expiresAt: '',
    expiresAtUnix: 0,
  };

  if (!session) return info;

  // 直接字段
  info.accessToken = session.accessToken || session.access_token || '';
  info.sessionToken = session.sessionToken || session.session_token || '';
  info.idToken = session.idToken || session.id_token || '';
  info.email = session.user?.email || session.email || '';

  if (session.account) {
    info.accountId = session.account.id || session.account.account_id || '';
    info.planType = session.account.planType || session.account.plan_type || '';
  }

  // 账号信息
  if (session.accounts) {
    const acc = Object.values(session.accounts)[0] || session.accounts?.default;
    if (acc) {
      if (!info.accountId) info.accountId = acc.account?.account_id || acc.account?.id || '';
      if (!info.planType) info.planType = acc.account?.plan_type || acc.account?.planType || acc.planType || '';
    }
  }

  // 过期时间
  info.expiresAt = session.expires || '';

  // 从 JWT 中补充信息
  const claims = decodeJwtPayload(info.accessToken);
  if (claims) {
    const auth = claims['https://api.openai.com/auth'] || {};
    const profile = claims['https://api.openai.com/profile'] || {};

    if (!info.email) info.email = claims.email || profile.email || auth.email || '';
    if (!info.accountId) info.accountId = auth.chatgpt_account_id || auth.account_id || '';
    if (!info.userId) info.userId = auth.chatgpt_user_id || auth.user_id || claims.sub || '';
    if (!info.planType) info.planType = auth.chatgpt_plan_type || auth.plan_type || '';

    if (claims.exp) {
      info.expiresAtUnix = claims.exp;
      if (!info.expiresAt) {
        info.expiresAt = new Date(claims.exp * 1000).toISOString();
      }
    }
  }

  info.isPlus = /plus|team|enterprise/i.test(info.planType);

  return info;
}

function unixToIsoSeconds(unix) {
  if (!unix) return '';
  return new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function getExpiresIn(expiresAtUnix, nowUnix) {
  if (!expiresAtUnix) return 0;
  return Math.max(0, expiresAtUnix - nowUnix);
}

function getEmailKey(email) {
  return String(email || 'account')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'account';
}

function buildSyntheticCodexIdToken(email, accountId, planType, userId, expires) {
  if (!accountId) return '';
  const now = Math.trunc(Date.now() / 1000);
  const exp = Number(expires) || Math.trunc(Date.parse(expires || '') / 1000) || now + 90 * 24 * 60 * 60;
  const authInfo = { chatgpt_account_id: accountId };
  if (planType) authInfo.chatgpt_plan_type = planType;
  if (userId) {
    authInfo.chatgpt_user_id = userId;
    authInfo.user_id = userId;
  }
  const payload = {
    iat: now,
    exp,
    'https://api.openai.com/auth': authInfo,
  };
  if (email) payload.email = email;
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', cpa_synthetic: true })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

/**
 * 解析输入的 session 文本
 * 支持单个 JSON 对象或数组
 */
function parseSessionInput(text) {
  if (!text || typeof text !== 'string') return [];

  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);

    if (Array.isArray(parsed)) {
      return parsed.map(s => extractSessionInfo(s));
    }

    return [extractSessionInfo(parsed)];
  } catch {
    // 尝试逐行解析（每行一个 JSON）
    const sessions = [];
    const lines = trimmed.split('\n');
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      try {
        const obj = JSON.parse(l);
        sessions.push(extractSessionInfo(obj));
      } catch {
        continue;
      }
    }
    return sessions;
  }
}

/**
 * 转换为 CPA 格式
 * 兼容 Codex CPA auth JSON
 */
function toCPA(sessions) {
  return sessions.map(info => {
    // 构建 id_token（如缺失则生成占位 JWT claims）
    let idToken = normalizeSyntheticCodexIdToken(info.idToken);
    if (!idToken && info.accessToken) {
      idToken = buildSyntheticCodexIdToken(
        info.email,
        info.accountId,
        info.planType,
        info.userId,
        info.expiresAt || info.expiresAtUnix
      );
    }

    const expired = info.expiresAt || unixToIsoSeconds(info.expiresAtUnix);

    return {
      type: 'codex',
      email: info.email,
      account_id: info.accountId,
      chatgpt_account_id: info.accountId,
      plan_type: info.planType,
      chatgpt_plan_type: info.planType,
      id_token: idToken,
      access_token: info.accessToken,
      refresh_token: '',
      session_token: info.sessionToken,
      last_refresh: new Date().toISOString(),
      expired,
      disabled: false,
      id_token_synthetic: isSyntheticCodexIdToken(idToken) || (!info.idToken && Boolean(idToken)),
    };
  });
}

/**
 * 转换为 sub2api 格式
 */
function toSub2API(sessions) {
  const now = new Date();
  const nowUnix = Math.floor(now.getTime() / 1000);
  const exportedAt = now.toISOString();

  return {
    exported_at: exportedAt,
    proxies: [],
    accounts: sessions.map(info => {
      const email = info.email || info.userId || info.accountId || 'account';
      const expiresAtUnix = info.expiresAtUnix || 0;
      const expiresAtIso = unixToIsoSeconds(expiresAtUnix);
      return {
        name: email,
        platform: 'openai',
        type: 'oauth',
        expires_at: expiresAtUnix,
        auto_pause_on_expired: true,
        concurrency: 10,
        priority: 1,
        credentials: {
          access_token: info.accessToken,
          chatgpt_account_id: info.accountId,
          chatgpt_user_id: info.userId,
          email,
          expires_at: expiresAtIso,
          expires_in: getExpiresIn(expiresAtUnix, nowUnix),
          plan_type: info.planType,
        },
        extra: {
          email,
          email_key: getEmailKey(email),
          name: email,
          source: 'chatgpt_web_session',
          last_refresh: exportedAt,
        },
      };
    }),
  };
}

module.exports = {
  decodeJwtPayload,
  extractSessionInfo,
  parseSessionInput,
  toCPA,
  toSub2API,
};
