# ChatGPT Session Forge

[English](README.en.md)

一个本地运行的 ChatGPT 会话管理工具，用于导入 Outlook 账号、自动获取 OpenAI 邮箱验证码、批量完成 ChatGPT 登录，并导出 CPA / sub2api / Cockpit 可用的凭证 JSON。

这个项目适合需要集中管理多个 ChatGPT Web Session 的本地工作流。所有账号数据、登录结果和导出文件都保存在本机，不需要外部数据库。

## 功能特性

- 支持批量导入 Outlook 账号
- 支持 IMAP 与 Microsoft Graph 双协议取件
- 支持外部邮箱 Provider：Cloudflare Temp Email / Cloud Mail
- 自动从邮箱中提取 OpenAI 验证码
- 支持批量 ChatGPT 登录，并可设置并发数
- 登录进度、状态和日志实时刷新
- 自动识别账号停用 / 删除类错误
- CPA 导出：一个账号一个 JSON 文件
- sub2api 导出：生成包含 `accounts` 数组的聚合 JSON
- sub2api 上传：将已登录成功的账号直接导入运行中的 sub2api
- Cockpit 导出：生成 `cockpit-tools` 可直接导入的扁平 Codex token JSON 数组
- CPA 仓管：扫描 CLIProxyAPI 401 凭证，自动重登获取新 CPA，封号时删除旧凭证
- sub2api 401 自动修复：扫描 OpenAI 账号 401 状态，自动重登并覆盖导入，封号时删除旧账号
- 支持粘贴原始 `https://chatgpt.com/api/auth/session` JSON 并转换
- 支持通过环境变量或 Windows 系统代理配置后端出站代理

## 环境要求

- Node.js 18 或更高版本
- Outlook 账号 OAuth 数据：
  - 邮箱
  - 密码
  - Microsoft OAuth Client ID
  - Refresh Token
- 可选：自建 Cloudflare Temp Email / Cloud Mail 收件 API
- 可以访问以下服务：
  - `chatgpt.com`
  - `auth.openai.com`
  - `outlook.office365.com`
  - `graph.microsoft.com`

## 安装

```bash
npm install
```

## 启动

```bash
npm start
```

然后打开：

```text
http://localhost:3000
```

默认端口是 `3000`。也可以指定端口：

```bash
PORT=8080 npm start
```

Windows PowerShell：

```powershell
$env:PORT = "8080"
npm start
```

## 代理配置

后端出站请求使用 `undici`，代理配置在 `config.js` 中：

```js
proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || 'auto'
```

默认值 `auto` 会尝试读取 Windows 当前用户代理。也可以手动指定：

```bash
HTTPS_PROXY=http://127.0.0.1:7897 npm start
```

如果不想使用代理，可以在 `config.js` 中设置为 `direct` 或 `none`。

## 使用方法

1. 打开 Web UI。
2. 在“邮箱取件”页点击“批量导入邮箱”。默认使用 Outlook，格式如下：

   ```text
   user@outlook.com----password----client-id----refresh-token
   ```

   如果验证码邮件不是 Outlook 收件，而是自建 Cloudflare Temp Email / Cloud Mail，可以在导入弹窗顶部选择对应邮箱服务并填写配置。导入时会自动把 Provider 配置附加到账号行，配置会保存在本机浏览器里。

   也可以手动追加 provider：

   ```text
   user@example.com----password----client-id----refresh-token----cloudflare-temp-mail----baseUrl=https://mail.example.com;adminAuth=your-admin-auth
   user@example.com----password----client-id----refresh-token----cloud-mail----baseUrl=https://mail.example.com;token=your-token
   ```

   `providerConfig` 也支持 JSON：

   ```text
   user@example.com----password----client-id----refresh-token----cloud-mail----{"baseUrl":"https://mail.example.com","adminEmail":"admin@example.com","adminPassword":"password"}
   ```

3. 进入“自动登录”页。
4. 选择需要登录的账号，并设置并发数。
5. 点击登录。
6. 登录成功后，选择成功账号并导出：
   - `CPA`：每个账号导出为一个 JSON 文件
   - `sub2api`：导出为一个聚合 JSON 文件
   - `Cockpit`：导出为一个 JSON 数组文件，可导入 [jlcodes99/cockpit-tools](https://github.com/jlcodes99/cockpit-tools)
   - `上传选中`：直接上传已登录成功的账号到运行中的 sub2api 或 CPA

## CPA 导出格式

CPA 导出采用“一个账号一个 JSON 文件”的形式。结构示例：

```json
{
  "type": "codex",
  "email": "user@example.com",
  "account_id": "00000000-0000-4000-9000-000000000000",
  "chatgpt_account_id": "00000000-0000-4000-9000-000000000000",
  "plan_type": "free",
  "chatgpt_plan_type": "free",
  "id_token": "header.payload.",
  "access_token": "real-access-token",
  "refresh_token": "",
  "session_token": "real-session-token",
  "last_refresh": "2026-05-24T00:00:00.000Z",
  "expired": "2026-08-22T00:00:00.000Z",
  "disabled": false,
  "id_token_synthetic": true
}
```

该格式由 ChatGPT Web Session 和 access token claims 派生生成。登录成功后程序不会主动退出 ChatGPT，因为退出可能导致 access token 失效。

## sub2api 导出格式

sub2api 导出为聚合结构：

```json
{
  "exported_at": "2026-05-24T00:00:00.000Z",
  "proxies": [],
  "accounts": []
}
```

每个账号会包含 OAuth 凭证、账号 ID、用户 ID、套餐类型、过期时间和额外元数据。

## sub2api 在线上传

“自动登录”页可将已登录成功的 ChatGPT session 直接上传到运行中的 sub2api。选择状态为“成功”的账号后点击“上传选中”，填写：

- sub2api 地址
- sub2api 登录邮箱和密码
- 目标 OpenAI 分组名称，默认 `codex`
- 可选代理名称 / ID
- 可选账号优先级

上传接口使用 sub2api 的 codex-session 导入能力：

```text
POST /api/v1/admin/accounts/import/codex-session
```

上传时会设置 `update_existing: true`，因此同名 / 同账号会按 sub2api 的导入逻辑更新已有记录。

## Cockpit 导出格式

Cockpit 导出采用 `cockpit-tools` 当前导入逻辑支持的扁平 Codex token JSON 数组。结构示例：

```json
[
  {
    "type": "codex",
    "auth_mode": "oauth",
    "email": "user@example.com",
    "name": "user@example.com",
    "account_id": "00000000-0000-4000-9000-000000000000",
    "organization_id": "",
    "user_id": "user-example",
    "plan_type": "free",
    "id_token": "header.payload.",
    "access_token": "real-access-token",
    "refresh_token": "",
    "session_token": "real-session-token",
    "last_refresh": "2026-05-24T00:00:00.000Z",
    "expired": "2026-08-22T00:00:00.000Z",
    "source": "chatgpt_session_forge",
    "id_token_synthetic": true
  }
]
```

`cockpit-tools` 会读取 `id_token`、`access_token`、`account_id`，并在 `refresh_token` 为空时使用 `session_token` 作为回退字段。

## CPA 仓管

“CPA 仓管”页用于直接操作 CLIProxyAPI 的管理 API。处理流程：

```text
扫描 CPA auth-files
→ 发现 401 凭证
→ 用本地同邮箱账号重新登录 ChatGPT
→ 登录成功：生成 CPA JSON 并上传覆盖
→ 登录失败且账号已停用：删除 CPA 中的旧凭证
```

需要填写：

- CPA 地址，例如 `http://localhost:8317`
- 管理密钥，对应 CLIProxyAPI 管理 API 的 `Authorization: Bearer <key>`

本功能只会自动处理 `status/status_message` 中包含 `401` 或 `unauthorized` 的凭证。其他异常会跳过或记录失败，避免误删。

## sub2api 401 自动修复

“CPA 仓管”页也提供 sub2api 401 自动修复。处理流程：

```text
扫描 sub2api OpenAI 账号
→ 发现 401 / unauthorized / token invalidated 账号
→ 用本地匹配账号重新登录 ChatGPT
→ 登录成功：通过 codex-session 导入接口覆盖更新 sub2api
→ 登录失败且账号已停用：删除 sub2api 中的旧账号
```

需要填写：

- sub2api 地址
- sub2api 登录邮箱和密码
- 目标 OpenAI 分组名称，默认 `codex`
- 可选默认代理名称 / ID
- 单次处理上限

本功能支持常见别名匹配，包括普通 `+tag` 别名、Gmail 点号 / `+tag` 别名、2925 邮箱前缀别名。对于同一个主邮箱下的多个别名，取验证码时会优先按目标收件人邮箱匹配，避免不同别名之间误用验证码。

自动修复开关只在当前页面会话中生效。页面刷新后不会自动恢复开启状态，且不会保存 sub2api 登录密码。

## 外部邮箱 Provider

外部邮箱 Provider 只影响“获取验证码邮件”这一步，不会改变 ChatGPT 登录、CPA / sub2api / Cockpit 导出和 CPA 仓管逻辑。

导入弹窗已经内置可视化配置面板：

- Cloudflare Temp Email：支持 `TEMP API`、`ADMIN AUTH`、`CUSTOM AUTH`、查询方式、接收邮箱、随机子域和域名更新
- Cloud Mail：支持 `API 地址`、管理员邮箱、管理员密码和域名

当前支持：

- `cloudflare-temp-mail`：兼容 Cloudflare Temp Email 管理接口，读取 `/admin/mails`，可配置 `adminAuth` / `customAuth`
- `cloud-mail`：兼容 Cloud Mail 公共接口，读取 `/api/public/emailList`，可配置 `token`，或用 `adminEmail` + `adminPassword` 自动获取 token

该兼容层参考了 [FoundZiGu/GuJumpgate](https://github.com/FoundZiGu/GuJumpgate) 中 Cloudflare Temp Email / Cloud Mail 的接口思路；本项目没有合并它的仓管功能，只在取验证码邮件这层增加兼容。

## 致谢

- 感谢 [FoundZiGu/GuJumpgate](https://github.com/FoundZiGu/GuJumpgate) 提供 Cloudflare Temp Email 和 Cloud Mail 的接口思路。
- 感谢 [DanOps-1/Gpt-Agreement-Payment](https://github.com/DanOps-1/Gpt-Agreement-Payment) 提供 ChatGPT 协议登录流程参考。

## 本地数据

运行时账号数据保存在：

```text
data/accounts.json
```

日志保存在：

```text
logs/
```

这两个路径都已加入 `.gitignore`，不会被提交到仓库。

## 安全提醒

本项目会处理高度敏感的数据：

- Outlook 密码
- OAuth refresh token
- ChatGPT access token
- ChatGPT session token
- 导出的 CPA / sub2api / Cockpit 凭证文件

不要提交运行数据、日志、导出的 JSON / ZIP 文件，或任何包含 token 的截图。公开仓库前请务必检查：

```bash
git status --ignored
```

## 脚本

```bash
npm start
```

启动 Express 服务。

```bash
npm run dev
```

使用 Node watch mode 启动开发模式。

## 许可证

当前暂未选择许可证。如果你希望其他人复用或修改该项目，请在公开发布前添加合适的开源许可证。
