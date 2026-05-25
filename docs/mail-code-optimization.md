# 邮箱验证码接收优化说明

## 背景

部分 Outlook 邮箱明明收到了 OpenAI / ChatGPT 验证码邮件，但本地项目自动登录时仍然取不到码。旧逻辑主要依赖 `keyword: OpenAI` 搜索，并且只取很短的正文预览。这个方式对简单邮件有效，但遇到新邮件索引延迟、HTML-only 邮件、multipart MIME 邮件、不同 token scope 的 Outlook 账号时会不稳定。

## 优化内容

### 1. 登录取码改为拉取最近邮件

两个登录入口都改为从协议侧拉取最近 25 封邮件，再在本地提取验证码：

- `routes/chatgpt.js`
- `services/cpa-warehouse-service.js`

Graph 和 IMAP 会同时启动。只要任意一个协议返回的邮件里能提取到 6 位验证码，取码流程就立刻返回，不再等待另一个协议结束或失败。这一点和对标站点的双协议快速取件思路一致。

只有当两个协议都没有返回可用邮件时，才会记录汇总错误。

### 2. 不再更新或轮换 refresh token

已移除独立的 `services/outlook-token-service.js`。

Graph 和 IMAP 的 access token 换取逻辑分别保留在各自服务中：

- `services/graph-service.js`
- `services/imap-service.js`

两个服务都只使用账号里原始的长期 refresh token 去换短期 access token。即使微软接口返回新的 `refresh_token`，项目也不会接收、返回、保存或替换它。

access token 候选会按需请求，短期 access token 会缓存在内存里，接近过期前才重新换取。这样既不改变原始 refresh token，又能减少重复向微软请求 token 的耗时。

### 3. Graph 取码不再使用 `$search`

`services/graph-service.js` 增加了 `recentOnly` 模式。

当 `recentOnly` 为 true 时：

- 保留 `receivedDateTime desc` 倒序排序。
- 不使用 `$search`。
- 拉取最近邮件，由本地逻辑提取验证码。
- Graph 返回 401/403 时自动尝试下一个 access token 候选。

原因是 Graph 的 `$search` 可能有索引延迟，新验证码刚到时未必能搜到，但最近邮件列表通常能更快看到。

### 4. IMAP 兼容性和速度优化

`services/imap-service.js` 现在会读取原始邮件 source，并解析足够的 MIME 结构来提取：

- `text/plain`
- `text/html`
- quoted-printable 正文
- base64 正文
- 常见 MIME 编码标题

同时修复了 UID 拉取问题。IMAP `SEARCH` 返回的是 UID，但 imapflow 默认会把 fetch 范围当成普通序号；现在 fetch 时明确传入 `{ uid: true }`。否则某些 Outlook 账号会报 `The specified message set is invalid`，表面看起来就是泛化的 `Command failed`。

登录取码场景下，IMAP 现在启用早停策略：从最新 UID 开始逐封读取，只要解析到 OpenAI / ChatGPT 邮件里的 6 位验证码，就立即返回，不再下载并解析所有最近邮件。

IMAP 连接也会在内存中短暂保活。ChatGPT 轮询验证码时，如果第一轮检查邮件还没到，下一轮可以复用已认证的 IMAP 连接，避免重复支付 TLS / OAuth 登录握手耗时。

本地实测：

- Sylvie 账号冷启动 IMAP 取码：约 4.6-4.8 秒。
- 复用保活连接后的 IMAP 取码：约 0.5-0.7 秒。
- Graph 可用的账号仍通过 Graph 返回：约 0.8-1.1 秒。

### 5. 验证码提取扫描更多字段

`services/chatgpt-service.js` 现在会从以下字段组合验证码文本：

- subject
- body text
- body preview
- HTML body
- `text` / `html` 兼容字段

同时把更多 OpenAI 发件人和主题特征视为高优先级，减少漏提取。

## 预期效果

现在登录取码在这些场景下会更稳定：

- Graph 能列出最近邮件，但 `$search` 暂时搜不到。
- IMAP 能看到邮件信封，但 body part `1` 里没有验证码。
- OpenAI 验证码邮件是 HTML-only 或 multipart 格式。
- 一个协议失败，但另一个协议仍能读取邮箱。
- 某些账号 Graph 很快，某些账号需要 IMAP 兜底。
- 长期 refresh token 在反复取码过程中保持不变。

## 备注

普通邮箱搜索页面仍然支持关键词和发件人过滤。登录和 CPA 仓管自动取码使用更防御性的“最近邮件 + 双协议并发 + 命中早停”策略，因为这里速度和正确率比精确搜索更重要。

---

# Mail Code Fetch Optimization

## Background

Some Outlook accounts could receive OpenAI verification mail but still fail during automatic ChatGPT login. The old flow searched mailbox providers with `keyword: OpenAI` and fetched only a small body preview. That worked for simple messages, but it was fragile for new OTP mail, multipart MIME messages, and accounts with different Microsoft token scopes.

## What Changed

### 1. Login OTP Fetch Uses Recent Mail

Both login entry points now fetch the latest 25 messages from each protocol instead of relying on provider-side `OpenAI` search.

- `routes/chatgpt.js`
- `services/cpa-warehouse-service.js`

Graph and IMAP are started together. The OTP polling flow returns as soon as either protocol produces mail containing a verification code, matching the fast dual-protocol behavior of the reference site. A consolidated error is logged only when both protocols fail to return usable mail.

### 2. Refresh Tokens Are Not Rotated

Removed the separate `services/outlook-token-service.js` helper.

Graph and IMAP keep protocol-specific access-token refresh logic in:

- `services/graph-service.js`
- `services/imap-service.js`

Both services use the original long-lived refresh token only to request short-lived access tokens. They do not accept, return, persist, or replace refresh tokens returned by Microsoft.

Access-token candidates are requested lazily, and short-lived access tokens are cached in memory until shortly before expiry. This reduces repeated Microsoft token refresh calls while keeping the original refresh token unchanged.

### 3. Graph Avoids `$search` During OTP Polling

`services/graph-service.js` supports `recentOnly`.

When `recentOnly` is true:

- Keeps `receivedDateTime desc` sorting.
- Does not use `$search`.
- Returns recent messages for local OTP extraction.
- Retries the next access-token candidate on Graph 401/403.

This avoids Graph search-index lag when a fresh OTP has just arrived.

### 4. IMAP Fetch Is More Compatible And Faster

`services/imap-service.js` fetches raw message source and parses enough MIME structure to extract:

- `text/plain`
- `text/html`
- quoted-printable bodies
- base64 bodies
- common MIME encoded headers

IMAP now fetches by UID correctly. `SEARCH` returns UIDs, but imapflow treats fetch ranges as sequence numbers unless `{ uid: true }` is passed as fetch options. Without this, some Outlook accounts fail with `The specified message set is invalid`.

For login OTP polling, IMAP uses an early-stop path: it fetches recent UIDs from newest to oldest and returns as soon as an OpenAI/ChatGPT message with a 6-digit code is parsed.

IMAP connections are kept alive briefly in memory after a fetch. This avoids paying the TLS/OAuth login cost on every polling attempt.

Observed local benchmark:

- Cold IMAP OTP fetch: about 4.6-4.8 seconds.
- Warm IMAP OTP fetch using the kept-alive connection: about 0.5-0.7 seconds.
- Graph-success accounts return through Graph in about 0.8-1.1 seconds.

### 5. OTP Extraction Scans More Fields

`services/chatgpt-service.js` builds verification content from:

- subject
- body text
- body preview
- HTML body
- `text` / `html` compatibility fields

It also treats more OpenAI sender and subject markers as high priority.

## Expected Result

The login flow is more reliable when:

- Graph can list recent mail but `$search` cannot find it yet.
- IMAP envelope is visible but body part `1` does not contain the code.
- OpenAI OTP arrives as HTML-only or multipart mail.
- One protocol fails while the other can still read the mailbox.
- Graph is fast for some accounts, while IMAP rescues accounts whose Graph path fails.
- The original long-lived refresh token should remain unchanged across repeated code fetches.

## Notes

The normal mailbox search UI still accepts keyword and sender filters. The more defensive recent-mail, early-stop strategy is used by login and warehouse OTP polling, where correctness and speed matter more than exact search filtering.
