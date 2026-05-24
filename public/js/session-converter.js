/**
 * Session 转换模块
 * 前端版本的 GPTSession2CPAandSub2API 转换器
 */

let _currentFormat = 'cpa';
let _parsedSessions = [];

// ==================== JWT 解码 ====================
function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;

    let payload = parts[1];
    payload = payload.replace(/-/g, '+').replace(/_/g, '/');
    while (payload.length % 4 !== 0) payload += '=';

    const decoded = atob(payload);
    return JSON.parse(decoded);
  } catch { return null; }
}

function decodeJwtHeader(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;

    let header = parts[0];
    header = header.replace(/-/g, '+').replace(/_/g, '/');
    while (header.length % 4 !== 0) header += '=';

    return JSON.parse(atob(header));
  } catch { return null; }
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

// ==================== Session 解析 ====================
function extractSessionInfo(session) {
  const info = {
    email: '', accessToken: '', sessionToken: '', idToken: '',
    accountId: '', userId: '', planType: '', isPlus: false,
    expiresAt: '', expiresAtUnix: 0,
  };

  if (!session) return info;

  info.accessToken = session.accessToken || session.access_token || '';
  info.sessionToken = session.sessionToken || session.session_token || '';
  info.idToken = session.idToken || session.id_token || '';
  info.email = session.user?.email || session.email || '';

  if (session.account) {
    info.accountId = session.account.id || session.account.account_id || '';
    info.planType = session.account.planType || session.account.plan_type || '';
  }

  if (session.accounts) {
    const acc = Object.values(session.accounts)[0];
    if (acc) {
      if (!info.accountId) info.accountId = acc.account?.account_id || acc.account?.id || '';
      if (!info.planType) info.planType = acc.account?.plan_type || acc.account?.planType || acc.planType || '';
    }
  }

  info.expiresAt = session.expires || '';

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
      if (!info.expiresAt) info.expiresAt = new Date(claims.exp * 1000).toISOString();
    }
  }

  info.isPlus = /plus|team|enterprise/i.test(info.planType);
  return info;
}

function parseSessionInput(text) {
  if (!text || typeof text !== 'string') return [];
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.map(extractSessionInfo);
    return [extractSessionInfo(parsed)];
  } catch {
    const sessions = [];
    for (const line of trimmed.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try { sessions.push(extractSessionInfo(JSON.parse(l))); } catch { continue; }
    }
    return sessions;
  }
}

// ==================== 转换函数 ====================
function convertToCPA(sessions) {
  return sessions.map(info => {
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
  return `${base64UrlJson({ alg: 'none', typ: 'JWT', cpa_synthetic: true })}.${base64UrlJson(payload)}.`;
}

function base64UrlJson(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function convertToSub2API(sessions) {
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

// ==================== 渲染输出 ====================
function doConvert() {
  const input = document.getElementById('convertInput').value;

  if (!input.trim()) {
    showToast('请先输入 Session JSON', 'warning');
    return;
  }

  _parsedSessions = parseSessionInput(input);

  if (_parsedSessions.length === 0) {
    showToast('未解析到有效的 Session 数据', 'error');
    return;
  }

  // 统计
  const now = Math.floor(Date.now() / 1000);
  const valid = _parsedSessions.filter(s => s.accessToken);
  const expired = _parsedSessions.filter(s => s.expiresAtUnix && s.expiresAtUnix < now);

  document.getElementById('convertStats').style.display = 'grid';
  document.getElementById('statParsed').textContent = _parsedSessions.length;
  document.getElementById('statValid').textContent = valid.length;
  document.getElementById('statExpired').textContent = expired.length;

  // 转换
  let result;
  if (_currentFormat === 'sub2api') {
    result = convertToSub2API(_parsedSessions);
  } else {
    result = convertToCPA(_parsedSessions);
  }

  document.getElementById('convertOutput').value = JSON.stringify(formatConvertOutput(result), null, 2);
  showToast(`转换完成: ${_parsedSessions.length} 个账号 → ${_currentFormat.toUpperCase()}`, 'success');
  addLog(`Session 转换: ${_parsedSessions.length} 个账号 → ${_currentFormat.toUpperCase()}`, 'success');
}

function formatConvertOutput(result) {
  if (_currentFormat !== 'cpa' || !Array.isArray(result)) return result;
  return result.length === 1
    ? result[0]
    : {
      note: 'CPA 每个账号一个 JSON 文件，请点击下载输出获取 ZIP。',
      count: result.length,
      files: result.map((item, index) => ({
        index: index + 1,
        email: item.email,
        account_id: item.account_id,
        filename: cpaJsonFilename(item, index, result.length),
      })),
    };
}

// ==================== 从登录结果加载 ====================
async function loadFromLoginResults() {
  try {
    const res = await fetch('/api/chatgpt/sessions');
    const data = await res.json();

    if (!data.sessions || data.sessions.length === 0) {
      showToast('没有已登录成功的账号', 'warning');
      return;
    }

    const sessionsJson = JSON.stringify(data.sessions.map(s => s.session), null, 2);
    document.getElementById('convertInput').value = sessionsJson;
    showToast(`已加载 ${data.sessions.length} 个 Session`, 'success');
    addLog(`从登录结果加载 ${data.sessions.length} 个 Session`, 'info');
  } catch (err) {
    showToast('加载失败: ' + err.message, 'error');
  }
}

// ==================== 事件绑定 ====================
document.addEventListener('DOMContentLoaded', () => {
  // 格式选择
  document.querySelectorAll('.format-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _currentFormat = btn.dataset.format;

      // 如果已有解析数据，重新转换
      if (_parsedSessions.length > 0) doConvert();
    });
  });

  // 转换按钮
  document.getElementById('btnConvert').addEventListener('click', doConvert);

  // 从登录结果加载
  document.getElementById('btnLoadSessions').addEventListener('click', loadFromLoginResults);

  // 清空输入
  document.getElementById('btnClearInput').addEventListener('click', () => {
    document.getElementById('convertInput').value = '';
    document.getElementById('convertOutput').value = '';
    document.getElementById('convertStats').style.display = 'none';
    _parsedSessions = [];
  });

  // 复制输出
  document.getElementById('btnCopyOutput').addEventListener('click', () => {
    const output = document.getElementById('convertOutput').value;
    copyText(output, '已复制转换结果');
  });

  // 下载输出
  document.getElementById('btnDownloadOutput').addEventListener('click', () => {
    const output = document.getElementById('convertOutput').value;
    if (!output) { showToast('没有可下载的内容', 'warning'); return; }
    if (_currentFormat === 'cpa') {
      if (_parsedSessions.length === 0) { showToast('请先转换 CPA 数据', 'warning'); return; }
      const data = convertToCPA(_parsedSessions);
      const download = downloadCpaJsonFiles(data, 'sessions-cpa');
      showToast(download.zipped ? `已下载 ${download.count} 个 CPA JSON 文件` : '已下载 CPA JSON 文件', 'success');
      return;
    }
    const filename = `sessions-${_currentFormat}-${new Date().toISOString().slice(0, 10)}.json`;
    downloadTextFile(filename, output);
    showToast('已下载', 'success');
  });
});
