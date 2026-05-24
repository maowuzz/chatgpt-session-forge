# ChatGPT Session Forge

A local web app for managing Outlook-based ChatGPT login workflows and exporting usable session credentials.

It can import Outlook accounts, fetch OpenAI verification codes through IMAP or Microsoft Graph, run batch ChatGPT login jobs with configurable concurrency, and export successful sessions as CPA or sub2api-compatible JSON.

## Features

- Outlook account import in `email----password----clientId----refreshToken` format
- Dual mailbox fetching with IMAP and Microsoft Graph
- Batch ChatGPT login with configurable concurrency
- Live login status and log stream through SSE
- Account status tracking, including deactivated account detection
- CPA export as one JSON file per account
- sub2api export in grouped JSON format
- Session converter for raw `https://chatgpt.com/api/auth/session` JSON
- Optional outbound proxy support through environment variables or Windows proxy auto-detection

## Requirements

- Node.js 18 or newer
- Outlook account OAuth data:
  - email
  - password
  - Microsoft OAuth client ID
  - refresh token
- Network access to:
  - `chatgpt.com`
  - `auth.openai.com`
  - `outlook.office365.com`
  - `graph.microsoft.com`

## Install

```bash
npm install
```

## Run

```bash
npm start
```

Then open:

```text
http://localhost:3000
```

The default port is `3000`. You can override it:

```bash
PORT=8080 npm start
```

On Windows PowerShell:

```powershell
$env:PORT = "8080"
npm start
```

## Proxy

The backend uses `undici` for outbound requests. Proxy selection is controlled by `config.js`.

By default, the app tries to read the current Windows user proxy:

```js
proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || 'auto'
```

You can also set it manually:

```bash
HTTPS_PROXY=http://127.0.0.1:7897 npm start
```

Use `direct` or `none` in `config.js` to disable proxy handling.

## Usage

1. Open the web UI.
2. Import Outlook accounts with this format:

   ```text
   user@outlook.com----password----client-id----refresh-token
   ```

3. Go to the auto-login tab.
4. Select accounts and choose a concurrency value.
5. Start login.
6. After login succeeds, select successful accounts and export:
   - `CPA`: one JSON file per account
   - `sub2api`: grouped JSON with an `accounts` array

## CPA Export

CPA export is intentionally written as one account per JSON file. The exported object uses this shape:

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

The app derives this from the ChatGPT web session response and the access token claims. It does not log out after a successful login, because logging out can invalidate the access token.

## sub2api Export

sub2api export creates a grouped file:

```json
{
  "exported_at": "2026-05-24T00:00:00.000Z",
  "proxies": [],
  "accounts": []
}
```

Each account includes OAuth credentials, account ID, user ID, plan type, expiry, and metadata.

## Data Storage

Runtime account data is stored locally in:

```text
data/accounts.json
```

Logs are stored in:

```text
logs/
```

Both paths are ignored by Git.

## Security Notes

This project handles highly sensitive data:

- Outlook passwords
- OAuth refresh tokens
- ChatGPT access tokens
- ChatGPT session tokens
- exported CPA/sub2api credential files

Do not commit runtime data, logs, exported JSON, exported ZIP files, or screenshots that contain tokens. The included `.gitignore` excludes the common sensitive paths, but review `git status` before pushing.

Recommended check before publishing:

```bash
git status --ignored
```

## Scripts

```bash
npm start
```

Starts the Express server.

```bash
npm run dev
```

Starts the server with Node watch mode.

## License

No license has been selected yet. Add one before publishing if you want others to reuse or modify the project.
