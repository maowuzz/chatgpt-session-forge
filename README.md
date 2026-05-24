# ChatGPT Session Forge

[English](README.en.md)

一个本地运行的 ChatGPT 会话管理工具，用于导入 Outlook 账号、自动获取 OpenAI 邮箱验证码、批量完成 ChatGPT 登录，并导出 CPA / sub2api 可用的凭证 JSON。

这个项目适合需要集中管理多个 ChatGPT Web Session 的本地工作流。所有账号数据、登录结果和导出文件都保存在本机，不需要外部数据库。

## 功能特性

- 支持批量导入 Outlook 账号
- 支持 IMAP 与 Microsoft Graph 双协议取件
- 自动从邮箱中提取 OpenAI 验证码
- 支持批量 ChatGPT 登录，并可设置并发数
- 登录进度、状态和日志实时刷新
- 自动识别账号停用 / 删除类错误
- CPA 导出：一个账号一个 JSON 文件
- sub2api 导出：生成包含 `accounts` 数组的聚合 JSON
- 支持粘贴原始 `https://chatgpt.com/api/auth/session` JSON 并转换
- 支持通过环境变量或 Windows 系统代理配置后端出站代理

## 环境要求

- Node.js 18 或更高版本
- Outlook 账号 OAuth 数据：
  - 邮箱
  - 密码
  - Microsoft OAuth Client ID
  - Refresh Token
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
2. 在“邮箱取件”页导入 Outlook 账号，格式如下：

   ```text
   user@outlook.com----password----client-id----refresh-token
   ```

3. 进入“自动登录”页。
4. 选择需要登录的账号，并设置并发数。
5. 点击登录。
6. 登录成功后，选择成功账号并导出：
   - `CPA`：每个账号导出为一个 JSON 文件
   - `sub2api`：导出为一个聚合 JSON 文件

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
- 导出的 CPA / sub2api 凭证文件

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
