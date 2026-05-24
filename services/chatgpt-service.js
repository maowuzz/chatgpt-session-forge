/**
 * ChatGPT 协议登录服务（纯 HTTP 请求，无浏览器）
 * 
 * 参考 DanOps-1/Gpt-Agreement-Payment 的 protocol.py 实现
 * 
 * 完整链路:
 *   1. GET  chatgpt.com/api/auth/csrf                     → csrfToken
 *   2. POST chatgpt.com/api/auth/signin/openai            → auth.openai authorize URL
 *   3. GET  auth.openai.com/api/accounts/authorize?...    → 跟重定向到 log-in
 *   4. POST auth.openai.com/api/accounts/authorize/continue → 提交邮箱
 *   5. (分支A) POST auth.openai.com/api/accounts/password/verify → 密码登录
 *   5. (分支B) 等邮箱 OTP → POST email-otp/validate        → 验证码登录
 *   6. 跟随重定向链 → chatgpt.com/api/auth/callback/login-web
 *   7. GET  chatgpt.com/api/auth/session                  → session JSON
 */

const config = require('../config');
const sentinelService = require('./openai-sentinel-service');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

class CookieJar {
  constructor() {
    this._cookies = new Map();
  }

  /** 解析 Set-Cookie 头并存入 jar */
  parseSetCookie(headers, domain) {
    const setCookies = headers.getSetCookie?.() || this._splitSetCookie(headers.get('set-cookie'));
    for (const raw of setCookies) {
      try {
        const parts = raw.split(';');
        const [nameVal] = parts;
        const eqIdx = nameVal.indexOf('=');
        if (eqIdx < 0) continue;
        const name = nameVal.substring(0, eqIdx).trim();
        const value = nameVal.substring(eqIdx + 1).trim();
        if (!name) continue;

        // 解析 domain
        let cookieDomain = domain;
        for (const part of parts.slice(1)) {
          const eqIdx = part.indexOf('=');
          const k = (eqIdx >= 0 ? part.substring(0, eqIdx) : part).trim().toLowerCase();
          const v = eqIdx >= 0 ? part.substring(eqIdx + 1).trim() : '';
          if (k === 'domain' && v) cookieDomain = v.startsWith('.') ? v.substring(1) : v;
        }
        this._cookies.set(`${cookieDomain}::${name}`, { name, value, domain: cookieDomain });
      } catch { /* ignore */ }
    }
  }

  _splitSetCookie(raw) {
    if (!raw) return [];
    return String(raw).split(/,(?=[^;,]+=)/g);
  }

  /** 获取指定域的 Cookie 头 */
  getCookieHeader(url) {
    const { hostname } = new URL(url);
    const pairs = [];
    for (const [, c] of this._cookies) {
      if (hostname === c.domain || hostname.endsWith('.' + c.domain)) {
        pairs.push(`${c.name}=${c.value}`);
      }
    }
    return pairs.join('; ');
  }

  /** 获取指定 cookie 值 */
  get(name, domain) {
    for (const [, c] of this._cookies) {
      if (c.name === name && (!domain || c.domain.includes(domain))) {
        return c.value;
      }
    }
    return '';
  }
}

function normalizeOpenAiPassword(value) {
  const password = String(value ?? '').trim();
  if (!password) return '';
  if (/^(x|xx|xxx|-|--|---|null|none|no|false|placeholder|占位|无|没有|空)$/i.test(password)) {
    return '';
  }
  return password;
}

class ChatGPTProtocolLogin {
  constructor() {
    this.running = 0;
    this.maxConcurrency = config.concurrency;
    this.queue = [];
  }

  async acquire() {
    while (this.running >= this.maxConcurrency) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.running++;
  }

  release() {
    this.running--;
    if (this.queue.length > 0) this.queue.shift()();
  }

  setConcurrency(n) {
    this.maxConcurrency = Math.max(1, Math.min(20, n));
  }

  /**
   * 协议登录单个账号
   */
  async login(account, fetchCodeFn, onStatus = () => {}) {
    const jar = new CookieJar();
    const email = account.email;
    const password = normalizeOpenAiPassword(account.password);
    const preferEmailOtp = Boolean(account.preferEmailOtp);
    const loginAccount = { ...account, password, preferEmailOtp };

    try {
      // ====== Step 1: 获取 CSRF Token ======
      onStatus('csrf', '获取 CSRF Token...');
      const csrfToken = await this._getCsrfToken(jar);
      if (!csrfToken) throw new Error('获取 CSRF Token 失败');

      // ====== Step 2: 发起 signin 请求，获取 auth0 授权 URL ======
      onStatus('signin', '发起登录请求...');
      const authUrl = await this._signinOpenAI(jar, csrfToken);
      if (!authUrl) throw new Error('获取 Auth0 授权 URL 失败');

      // ====== Step 3: 访问 auth.openai authorize，跟重定向到 login 页 ======
      onStatus('authorize', '跟随授权链路...');
      const loginState = await this._followAuthorize(jar, authUrl);

      let callbackUrl;

      if (loginState.isModern) {
        // 新版 OpenAI Auth 使用 api/accounts/*，没有旧 /u/login/identifier 页面。
        onStatus('sentinel', '生成 Sentinel Token...');
        loginState.sentinelToken = await this._getSentinelToken(loginState, 'authorize_continue');
        onStatus('identifier', '提交邮箱...');
        const otpIssuedAfter = Date.now() - 10000;
        const firstStep = await this._authorizeContinue(jar, loginState, email);
        callbackUrl = await this._completeModernLogin(
          jar,
          loginState,
          loginAccount,
          firstStep,
          fetchCodeFn,
          onStatus,
          otpIssuedAfter
        );
      } else {
        if (!loginState.state) {
          const hint = loginState.lastUrl ? `，最后停在: ${loginState.lastUrl}` : '';
          throw new Error(`获取 auth0 state 失败${hint}`);
        }

        // ====== 旧版 Step 4: 提交邮箱 ======
        onStatus('identifier', '提交邮箱...');
        const identResult = await this._submitIdentifier(jar, loginState, email);

        // ====== 旧版 Step 5: 密码 or 验证码 ======
        if (identResult.needsPassword && password && !preferEmailOtp) {
          onStatus('password', '提交密码...');
          callbackUrl = await this._submitPassword(jar, loginState, password);
        } else {
          onStatus('waiting_code', '等待验证码邮件...');
          const code = await this._waitForCode(loginAccount, fetchCodeFn, onStatus);
          if (!code) throw new Error('未能获取验证码，请检查邮箱配置');

          onStatus('verify_code', `提交验证码: ${code}`);
          callbackUrl = await this._submitCode(jar, loginState, code);
        }
      }

      // ====== Step 6: 跟随回调链路 ======
      if (callbackUrl) {
        onStatus('callback', '跟随回调链路...');
        await this._followCallback(jar, callbackUrl);
      }

      // ====== Step 7: 获取 Session ======
      onStatus('session', '获取 Session...');
      const session = await this._getSession(jar);

      if (!session || !session.accessToken) {
        throw new Error('获取 Session 失败: accessToken 为空');
      }

      onStatus('success', '登录成功');
      return session;
    } catch (err) {
      onStatus('failed', err.message);
      throw err;
    }
  }

  /** Step 1: CSRF Token */
  async _getCsrfToken(jar) {
    const url = 'https://chatgpt.com/api/auth/csrf';
    const resp = await fetch(url, {
      headers: this._headers(jar, url),
      redirect: 'follow',
    });
    jar.parseSetCookie(resp.headers, 'chatgpt.com');
    const data = await resp.json();
    return data.csrfToken || '';
  }

  /** Step 2: POST signin → 获取 auth.openai URL */
  async _signinOpenAI(jar, csrfToken) {
    const attempts = [
      {
        url: 'https://chatgpt.com/api/auth/signin/openai',
        callbackUrl: 'https://chatgpt.com/',
        referer: 'https://chatgpt.com/auth/login',
      },
      {
        url: 'https://chatgpt.com/api/auth/signin/login-web?callbackUrl=%2F',
        callbackUrl: '/',
        referer: 'https://chatgpt.com/',
      },
    ];

    let lastUrl = '';
    for (const attempt of attempts) {
      const body = new URLSearchParams({
        callbackUrl: attempt.callbackUrl,
        csrfToken,
        json: 'true',
      });

      const resp = await fetch(attempt.url, {
        method: 'POST',
        headers: {
          ...this._headers(jar, attempt.url),
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': 'https://chatgpt.com',
          'Referer': attempt.referer,
        },
        body: body.toString(),
        redirect: 'manual',
      });
      jar.parseSetCookie(resp.headers, 'chatgpt.com');

      let data = {};
      try {
        data = await resp.json();
      } catch {
        data = {};
      }

      lastUrl = data.url || '';
      // login-web 现在常返回 /api/auth/signin?csrf=true，这条链路不会进入 OpenAI Auth。
      if (lastUrl && !lastUrl.includes('/api/auth/signin?csrf=true')) {
        return lastUrl;
      }
    }

    return lastUrl;
  }

  /** Step 3: 跟随 authorize 重定向链 */
  async _followAuthorize(jar, authUrl) {
    const loginState = {
      state: '',
      loginUrl: '',
      authUrl,
      lastUrl: authUrl,
      isModern: false,
    };
    let currentUrl = authUrl;

    for (let i = 0; i < 10; i++) {
      const resp = await fetch(currentUrl, {
        headers: this._headers(jar, currentUrl, { 
          'Accept': 'text/html,application/xhtml+xml',
          'Referer': 'https://chatgpt.com/',
        }),
        redirect: 'manual',
      });
      jar.parseSetCookie(resp.headers, new URL(currentUrl).hostname);
      loginState.lastUrl = currentUrl;

      // 解析 state 参数
      const urlObj = new URL(currentUrl);
      const state = urlObj.searchParams.get('state');
      if (state) loginState.state = state;
      if (
        urlObj.hostname === 'auth.openai.com' &&
        (urlObj.pathname.includes('/api/accounts/authorize') || urlObj.pathname === '/log-in')
      ) {
        loginState.isModern = true;
      }

      if (resp.status >= 300 && resp.status < 400) {
        let location = resp.headers.get('location') || '';
        if (location.startsWith('/')) {
          location = `${urlObj.protocol}//${urlObj.host}${location}`;
        }
        currentUrl = location;
        loginState.lastUrl = location;

        // 检查 location 里的 state
        try {
          const locUrl = new URL(location);
          const locState = locUrl.searchParams.get('state');
          if (locState) loginState.state = locState;
          if (locUrl.hostname === 'auth.openai.com' && locUrl.pathname === '/log-in') {
            loginState.isModern = true;
            loginState.loginUrl = location;
          }
        } catch { /* ignore */ }

        // 如果到了 login/identifier 页面
        if (location.includes('/u/login/identifier') || location.includes('/u/login/password')) {
          loginState.loginUrl = location;
          // 还需要 GET 这个页面以获取 cookie
          const pageResp = await fetch(location, {
            headers: this._headers(jar, location, {
              'Accept': 'text/html,application/xhtml+xml',
            }),
            redirect: 'follow',
          });
          jar.parseSetCookie(pageResp.headers, 'openai.com');
          break;
        }
        if (location.includes('auth.openai.com/log-in')) {
          loginState.loginUrl = location;
          const pageResp = await fetch(location, {
            headers: this._headers(jar, location, {
              'Accept': 'text/html,application/xhtml+xml',
              'Referer': 'https://chatgpt.com/auth/login',
            }),
            redirect: 'follow',
          });
          jar.parseSetCookie(pageResp.headers, 'auth.openai.com');
          break;
        }
        continue;
      }

      // 200 响应，可能就是 login 页面
      if (currentUrl.includes('auth.openai.com') || currentUrl.includes('auth0.openai.com')) {
        loginState.loginUrl = currentUrl;
        const current = new URL(currentUrl);
        if (current.hostname === 'auth.openai.com' && current.pathname === '/log-in') {
          loginState.isModern = true;
        }
      }
      break;
    }

    return loginState;
  }

  /** 新版 Step 4: 提交邮箱到 authorize/continue */
  async _authorizeContinue(jar, loginState, email) {
    const url = 'https://auth.openai.com/api/accounts/authorize/continue';
    const body = JSON.stringify({
      username: {
        kind: 'email',
        value: email,
      },
    });

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        ...this._headers(jar, url),
        ...this._sentinelHeader(loginState),
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': 'https://auth.openai.com',
        'Referer': loginState.loginUrl || 'https://auth.openai.com/log-in',
      },
      body,
      redirect: 'manual',
    });
    jar.parseSetCookie(resp.headers, 'auth.openai.com');

    const data = await this._readJsonResponse(resp);
    if (resp.status !== 200) {
      throw new Error(`提交邮箱失败: HTTP ${resp.status} - ${this._compactError(data)}`);
    }
    return data;
  }

  async _completeModernLogin(jar, loginState, account, step, fetchCodeFn, onStatus, otpIssuedAfter) {
    let currentStep = step || {};
    let continueUrl = this._normalizeAuthUrl(this._extractContinueUrl(currentStep));
    let pageType = this._extractPageType(currentStep);
    let mode = this._extractEmailVerificationMode(currentStep);
    const needsPassword = pageType === 'login_password' || continueUrl.includes('/log-in/password');
    const preferEmailOtp = Boolean(account.preferEmailOtp);

    if (needsPassword && account.password && !preferEmailOtp) {
      onStatus('password', '提交密码...');
      loginState.sentinelToken = await this._getSentinelToken(loginState, 'username_password_login');
      currentStep = await this._submitModernPassword(jar, loginState, account.password);
      continueUrl = this._normalizeAuthUrl(this._extractContinueUrl(currentStep));
      pageType = this._extractPageType(currentStep);
      mode = this._extractEmailVerificationMode(currentStep) || mode;
    } else if (needsPassword) {
      onStatus('send_code', '请求邮箱验证码...');
      const requestedAt = Date.now() - 10000;
      loginState.sentinelToken = await this._getSentinelToken(loginState, 'email_verification');
      await this._kickoffModernOtp(jar, loginState, mode);
      continueUrl = '';
      pageType = 'email_otp_verification';
      otpIssuedAfter = Math.max(Number(otpIssuedAfter) || 0, requestedAt);
    }

    if (continueUrl && !this._needsModernOtp(pageType, continueUrl)) {
      return continueUrl;
    }

    onStatus('waiting_code', '等待验证码邮件...');
    let code = await this._waitForCode(account, fetchCodeFn, onStatus, otpIssuedAfter);

    if (!code) {
      onStatus('send_code', '尝试重新触发验证码...');
      const resentAt = Date.now() - 10000;
      loginState.sentinelToken = await this._getSentinelToken(loginState, 'email_verification');
      await this._kickoffModernOtp(jar, loginState, mode);
      code = await this._waitForCode(account, fetchCodeFn, onStatus, resentAt);
    }

    if (!code) throw new Error('未能获取验证码，请检查邮箱配置');

    onStatus('verify_code', `提交验证码: ${code}`);
    currentStep = await this._submitModernCode(jar, loginState, code);
    continueUrl = this._normalizeAuthUrl(this._extractContinueUrl(currentStep));

    if (!continueUrl) {
      throw new Error(`验证码已提交，但未获取到继续登录地址: ${this._compactError(currentStep)}`);
    }

    return continueUrl;
  }

  async _submitModernPassword(jar, loginState, password) {
    const url = 'https://auth.openai.com/api/accounts/password/verify';
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        ...this._headers(jar, url),
        ...this._sentinelHeader(loginState),
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': 'https://auth.openai.com',
        'Referer': 'https://auth.openai.com/log-in/password',
      },
      body: JSON.stringify({ password }),
      redirect: 'manual',
    });
    jar.parseSetCookie(resp.headers, 'auth.openai.com');

    const data = await this._readJsonResponse(resp);
    if (resp.status !== 200) {
      throw new Error(`密码登录失败: HTTP ${resp.status} - ${this._compactError(data)}`);
    }
    return data;
  }

  async _submitModernCode(jar, loginState, code) {
    const url = 'https://auth.openai.com/api/accounts/email-otp/validate';
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        ...this._headers(jar, url),
        ...this._sentinelHeader(loginState),
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': 'https://auth.openai.com',
        'Referer': 'https://auth.openai.com/email-verification',
      },
      body: JSON.stringify({ code }),
      redirect: 'manual',
    });
    jar.parseSetCookie(resp.headers, 'auth.openai.com');

    const data = await this._readJsonResponse(resp);
    if (resp.status !== 200) {
      throw new Error(`验证码验证失败: HTTP ${resp.status} - ${this._compactError(data)}`);
    }
    return data;
  }

  async _kickoffModernOtp(jar, loginState, mode = '') {
    const attempts = [
      {
        url: 'https://auth.openai.com/api/accounts/passwordless/send-otp',
        method: 'POST',
        referer: 'https://auth.openai.com/email-verification',
      },
      {
        url: 'https://auth.openai.com/api/accounts/email-otp/resend',
        method: 'POST',
        referer: 'https://auth.openai.com/email-verification',
      },
      {
        url: 'https://auth.openai.com/api/accounts/email-otp/send',
        method: 'GET',
        referer: 'https://auth.openai.com/email-verification',
      },
    ];

    for (const attempt of attempts) {
      try {
        const resp = await fetch(attempt.url, {
          method: attempt.method,
          headers: {
            ...this._headers(jar, attempt.url),
            ...this._sentinelHeader(loginState),
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Origin': 'https://auth.openai.com',
            'Referer': attempt.referer,
          },
          redirect: 'manual',
        });
        jar.parseSetCookie(resp.headers, 'auth.openai.com');
        if (resp.status === 200) return true;
      } catch {
        continue;
      }
    }

    return false;
  }

  /** Step 4: 提交邮箱 identifier */
  async _submitIdentifier(jar, loginState, email) {
    loginState.email = email;
    const url = `https://auth.openai.com/u/login/identifier?state=${loginState.state}`;
    const body = JSON.stringify({
      state: loginState.state,
      username: email,
      js_available: true,
      webauthn_available: true,
      is_brave: false,
      webauthn_platform_available: true,
      action: 'default',
    });

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        ...this._headers(jar, url),
        'Content-Type': 'application/json',
        'Origin': 'https://auth.openai.com',
        'Referer': loginState.loginUrl || `https://auth.openai.com/u/login/identifier?state=${loginState.state}`,
      },
      body,
      redirect: 'follow',
    });
    jar.parseSetCookie(resp.headers, 'openai.com');

    const finalUrl = resp.url;
    let needsPassword = false;
    
    // 检查响应是否跳转到密码页
    if (finalUrl.includes('password')) {
      needsPassword = true;
    } else {
      try {
        const text = await resp.text();
        if (text.includes('password') && !text.includes('email-verification')) {
          needsPassword = true;
        }
      } catch { /* ignore */ }
    }

    return { needsPassword, finalUrl };
  }

  /** Step 5A: 提交密码 */
  async _submitPassword(jar, loginState, password) {
    const url = `https://auth.openai.com/u/login/password?state=${loginState.state}`;
    const body = JSON.stringify({
      state: loginState.state,
      username: loginState.email,
      password,
      action: 'default',
    });

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        ...this._headers(jar, url),
        'Content-Type': 'application/json',
        'Origin': 'https://auth.openai.com',
        'Referer': url,
      },
      body,
      redirect: 'manual',
    });
    jar.parseSetCookie(resp.headers, 'openai.com');

    return this._extractCallbackUrl(resp);
  }

  /** Step 5B: 提交验证码 */
  async _submitCode(jar, loginState, code) {
    // 尝试两种验证码提交端点
    const endpoints = [
      `https://auth.openai.com/u/email-verification?state=${loginState.state}`,
      `https://auth.openai.com/u/login/email-verification?state=${loginState.state}`,
    ];

    for (const url of endpoints) {
      try {
        const body = JSON.stringify({
          state: loginState.state,
          code,
          action: 'default',
        });

        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            ...this._headers(jar, url),
            'Content-Type': 'application/json',
            'Origin': 'https://auth.openai.com',
            'Referer': url,
          },
          body,
          redirect: 'manual',
        });
        jar.parseSetCookie(resp.headers, 'openai.com');

        const callbackUrl = this._extractCallbackUrl(resp);
        if (callbackUrl) return callbackUrl;

        // 如果是 200，可能有 continue_url
        if (resp.status === 200) {
          try {
            const data = await resp.json();
            if (data.continue_url) return data.continue_url;
          } catch { /* ignore */ }
        }
      } catch { continue; }
    }

    return null;
  }

  /** Step 6: 跟随 callback 回到 chatgpt.com */
  async _followCallback(jar, callbackUrl) {
    let currentUrl = callbackUrl;

    for (let i = 0; i < 10; i++) {
      const resp = await fetch(currentUrl, {
        headers: this._headers(jar, currentUrl, {
          'Accept': 'text/html,application/xhtml+xml',
        }),
        redirect: 'manual',
      });
      jar.parseSetCookie(resp.headers, new URL(currentUrl).hostname);

      if (resp.status >= 300 && resp.status < 400) {
        let location = resp.headers.get('location') || '';
        if (location.startsWith('/')) {
          const u = new URL(currentUrl);
          location = `${u.protocol}//${u.host}${location}`;
        }
        currentUrl = location;

        // 到了 chatgpt.com 首页就停
        if (currentUrl.includes('chatgpt.com') && !currentUrl.includes('/api/auth/')) {
          break;
        }
        continue;
      }
      break;
    }
  }

  /** Step 7: 获取 Session */
  async _getSession(jar) {
    const url = 'https://chatgpt.com/api/auth/session';
    const resp = await fetch(url, {
      headers: this._headers(jar, url),
      redirect: 'follow',
    });
    jar.parseSetCookie(resp.headers, 'chatgpt.com');

    const data = await resp.json();
    return data;
  }

  /** 从重定向响应提取 callback URL */
  _extractCallbackUrl(resp) {
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location') || '';
      if (location) return location.startsWith('/') 
        ? `https://auth.openai.com${location}` 
        : location;
    }
    return null;
  }

  _extractContinueUrl(data) {
    if (!data || typeof data !== 'object') return '';
    return data.continue_url ||
      data.continueUrl ||
      data.redirect_url ||
      data.redirectUrl ||
      data.url ||
      data.page?.payload?.continue_url ||
      '';
  }

  _extractPageType(data) {
    return String(data?.page?.type || data?.page_type || '').trim();
  }

  _extractEmailVerificationMode(data) {
    return String(data?.page?.payload?.email_verification_mode || '').trim();
  }

  _needsModernOtp(pageType, continueUrl) {
    const page = String(pageType || '').toLowerCase();
    const url = String(continueUrl || '').toLowerCase();
    return page === 'email_otp_verification' || url.includes('/email-verification') || !continueUrl;
  }

  _normalizeAuthUrl(url, base = 'https://auth.openai.com') {
    if (!url) return '';
    try {
      return new URL(url, base).toString();
    } catch {
      return url;
    }
  }

  async _readJsonResponse(resp) {
    const text = await resp.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text.slice(0, 500) };
    }
  }

  _compactError(data) {
    if (!data) return '空响应';
    if (typeof data === 'string') return data.slice(0, 260);
    const err = data.error;
    if (err) {
      if (typeof err === 'string') return err.slice(0, 260);
      return [
        err.message,
        err.code,
        err.type,
      ].filter(Boolean).join(' / ').slice(0, 260) || JSON.stringify(err).slice(0, 260);
    }
    return JSON.stringify(data).slice(0, 260);
  }

  async _getSentinelToken(loginState, flow) {
    const deviceId = this._extractDeviceId(loginState.authUrl) || loginState.deviceId || '';
    if (deviceId) loginState.deviceId = deviceId;
    return sentinelService.getSentinelToken({ deviceId, flow });
  }

  _extractDeviceId(url) {
    try {
      return new URL(url).searchParams.get('device_id') || '';
    } catch {
      return '';
    }
  }

  _sentinelHeader(loginState) {
    return loginState?.sentinelToken
      ? { 'openai-sentinel-token': loginState.sentinelToken }
      : {};
  }

  /** 构建通用请求头 */
  _headers(jar, url, extra = {}) {
    const headers = {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      ...extra,
    };
    const cookie = jar.getCookieHeader(url);
    if (cookie) headers['Cookie'] = cookie;
    return headers;
  }

  /** 轮询获取验证码 */
  async _waitForCode(account, fetchCodeFn, onStatus, issuedAfter = 0) {
    const maxRetries = config.chatgpt.codeCheckMaxRetries;
    const interval = config.chatgpt.codeCheckInterval;
    const targetEmail = this._normalizeEmail(account?.loginEmail || account?.chatgptEmail || account?.email);
    const requireRecipientMatch = Boolean(account?.requireTargetEmailMatch);

    for (let i = 0; i < maxRetries; i++) {
      onStatus('checking_code', `检查验证码 (${i + 1}/${maxRetries})...`);
      try {
        const emails = await fetchCodeFn(account);
        if (emails && emails.length > 0) {
          const code = this._extractCodeFromEmails(emails, issuedAfter, {
            targetEmail,
            requireRecipientMatch,
          });
          if (code) return code;
        }
      } catch (err) {
        console.error(`[协议登录] 获取验证码出错 (${i + 1}/${maxRetries}):`, err.message);
      }
      await new Promise(r => setTimeout(r, interval));
    }
    return null;
  }

  /** 从邮件中提取 6 位验证码 */
  _extractCodeFromEmails(emails, issuedAfter = 0, options = {}) {
    const cutoff = issuedAfter ? issuedAfter - 60000 : 0;
    const normalizedTargetEmail = this._normalizeEmail(
      typeof options === 'string' ? options : options.targetEmail
    );
    const requireRecipientMatch = typeof options === 'object' && Boolean(options.requireRecipientMatch);
    const candidates = cutoff
      ? emails.filter(email => {
          const ts = new Date(email.date || email.receivedDateTime || 0).getTime();
          return !Number.isFinite(ts) || ts >= cutoff;
        })
      : emails;
    const sorted = [...candidates]
      .filter(email => !normalizedTargetEmail || this._emailMatchesTarget(email, normalizedTargetEmail, requireRecipientMatch))
      .sort((a, b) => new Date(b.date || b.receivedDateTime) - new Date(a.date || a.receivedDateTime));

    // 优先 OpenAI 相关邮件
    for (const email of sorted) {
      const fromStr = `${email.from || ''} ${email.fromName || ''}`.toLowerCase();
      const subjectStr = (email.subject || '').toLowerCase();
      if (
        fromStr.includes('openai') || fromStr.includes('chatgpt') || fromStr.includes('noreply') ||
        subjectStr.includes('verification') || subjectStr.includes('verify') ||
        subjectStr.includes('code') || subjectStr.includes('login') || subjectStr.includes('otp')
      ) {
        const content = `${email.subject || ''} ${email.bodyText || ''} ${email.bodyPreview || ''}`;
        const match = content.match(/\b(\d{6})\b/);
        if (match) return match[1];
      }
    }

    // 回退
    for (const email of sorted) {
      const content = `${email.subject || ''} ${email.bodyText || ''} ${email.bodyPreview || ''}`;
      const match = content.match(/\b(\d{6})\b/);
      if (match) return match[1];
    }
    return null;
  }

  _emailMatchesTarget(email = {}, targetEmail = '', requireRecipientMatch = false) {
    const target = this._normalizeEmail(targetEmail);
    if (!target) return true;
    const recipients = this._extractRecipientEmails(email);
    if (recipients.length === 0) return !requireRecipientMatch;
    return recipients.includes(target);
  }

  _extractRecipientEmails(email = {}) {
    const values = [
      email.recipient,
      email.toEmail,
      email.to_email,
      email.deliveredTo,
      email.delivered_to,
      email.xOriginalTo,
      email.x_original_to,
      ...(Array.isArray(email.recipients) ? email.recipients : []),
      ...(Array.isArray(email.to) ? email.to : [email.to]),
      ...(Array.isArray(email.cc) ? email.cc : [email.cc]),
      ...(Array.isArray(email.bcc) ? email.bcc : [email.bcc]),
    ];
    return Array.from(new Set(values.flatMap(value => this._extractEmailsFromValue(value))));
  }

  _extractEmailsFromValue(value) {
    if (!value) return [];
    if (typeof value === 'object') {
      return this._extractEmailsFromValue(value.address || value.email || value.name || '');
    }
    const matches = String(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
    return matches.map(item => this._normalizeEmail(item)).filter(Boolean);
  }

  _normalizeEmail(value = '') {
    return String(value || '').trim().toLowerCase();
  }

  // 兼容旧接口
  extractCodeFromEmails(emails) {
    return this._extractCodeFromEmails(emails);
  }

  /** 批量登录 */
  async batchLogin(accounts, fetchCodeFn, onProgress = () => {}) {
    const results = [];
    const tasks = accounts.map(account => async () => {
      await this.acquire();
      try {
        onProgress(account.id, 'login_start', '开始登录...');
        const session = await this.login(
          account, fetchCodeFn,
          (status, detail) => onProgress(account.id, status, detail)
        );
        results.push({ id: account.id, email: account.email, success: true, session });
        onProgress(account.id, 'login_success', '登录成功');
      } catch (err) {
        results.push({ id: account.id, email: account.email, success: false, error: err.message });
        onProgress(account.id, 'login_failed', err.message);
      } finally {
        this.release();
      }
    });

    await Promise.all(tasks.map(task => task()));
    return results;
  }
}

module.exports = new ChatGPTProtocolLogin();
