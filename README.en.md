# ChatGPT Session Forge

A local web app for managing Outlook-based ChatGPT login workflows and exporting usable session credentials.

It can import Outlook accounts, fetch OpenAI verification codes through IMAP or Microsoft Graph, run batch ChatGPT login jobs with configurable concurrency, and export successful sessions as CPA, sub2api, or Cockpit-compatible JSON.

## Features

- Outlook account import in `email----password----clientId----refreshToken` format
- Dual mailbox fetching with IMAP and Microsoft Graph
- External mailbox providers: Cloudflare Temp Email and Cloud Mail
- Batch ChatGPT login with configurable concurrency
- Live login status and log stream through SSE
- Account status tracking, including deactivated account detection
- CPA export as one JSON file per account
- sub2api export in grouped JSON format
- sub2api direct upload for successful ChatGPT sessions
- Cockpit export as a flat Codex token JSON array accepted by `cockpit-tools`
- CPA warehouse: scan CLIProxyAPI 401 credentials, relogin for fresh CPA JSON, and delete deactivated accounts
- sub2api 401 auto repair: scan OpenAI 401 accounts, relogin, re-import refreshed sessions, and delete deactivated accounts
- Session converter for raw `https://chatgpt.com/api/auth/session` JSON
- Optional outbound proxy support through environment variables or Windows proxy auto-detection

## Requirements

- Node.js 18 or newer
- Outlook account OAuth data:
  - email
  - password
  - Microsoft OAuth client ID
  - refresh token
- Optional self-hosted Cloudflare Temp Email / Cloud Mail API
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
2. Click "Batch Import Mailboxes" on the mailbox tab. Outlook is the default format:

   ```text
   user@outlook.com----password----client-id----refresh-token
   ```

   If verification emails are received through a self-hosted Cloudflare Temp Email or Cloud Mail service, select that provider at the top of the import modal and fill in the visible configuration fields. The app appends the provider config during import and stores the settings in the local browser.

   You can also append a provider manually:

   ```text
   user@example.com----password----client-id----refresh-token----cloudflare-temp-mail----baseUrl=https://mail.example.com;adminAuth=your-admin-auth
   user@example.com----password----client-id----refresh-token----cloud-mail----baseUrl=https://mail.example.com;token=your-token
   ```

   `providerConfig` also accepts JSON:

   ```text
   user@example.com----password----client-id----refresh-token----cloud-mail----{"baseUrl":"https://mail.example.com","adminEmail":"admin@example.com","adminPassword":"password"}
   ```

3. Go to the auto-login tab.
4. Select accounts and choose a concurrency value.
5. Start login.
6. After login succeeds, select successful accounts and export:
   - `CPA`: one JSON file per account
   - `sub2api`: grouped JSON with an `accounts` array
   - `Cockpit`: one JSON array file importable by [jlcodes99/cockpit-tools](https://github.com/jlcodes99/cockpit-tools)
   - Upload selected sessions directly to a running sub2api or CPA instance

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

## sub2api Direct Upload

The auto-login tab can upload successful ChatGPT sessions directly to a running sub2api instance. Select successful accounts, click the upload button, then provide:

- sub2api base URL
- sub2api login email and password
- target OpenAI group name, default `codex`
- optional proxy name / ID
- optional account priority

The upload uses sub2api's codex-session import endpoint:

```text
POST /api/v1/admin/accounts/import/codex-session
```

The payload sets `update_existing: true`, so existing records are updated according to sub2api's import behavior.

## Cockpit Export

Cockpit export uses the flat Codex token JSON array supported by the current `cockpit-tools` importer:

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

`cockpit-tools` reads `id_token`, `access_token`, and `account_id`. When `refresh_token` is empty, it can fall back to `session_token`.

## CPA Warehouse

The CPA warehouse tab talks directly to the CLIProxyAPI management API. Flow:

```text
scan CPA auth-files
→ find 401 credentials
→ relogin the matching local account
→ success: generate and upload fresh CPA JSON
→ deactivated account: delete the old CPA credential
```

Required inputs:

- CPA base URL, for example `http://localhost:8317`
- management key, sent as `Authorization: Bearer <key>`

Only credentials whose `status/status_message` contains `401` or `unauthorized` are processed automatically. Other failures are skipped or reported to avoid accidental deletion.

## sub2api 401 Auto Repair

The CPA warehouse tab also includes a sub2api 401 repair panel. Flow:

```text
scan sub2api OpenAI accounts
→ find 401 / unauthorized / token invalidated accounts
→ relogin the matching local account
→ success: re-import the refreshed session through codex-session import
→ deactivated account: delete the old sub2api account
```

Required inputs:

- sub2api base URL
- sub2api login email and password
- target OpenAI group name, default `codex`
- optional default proxy name / ID
- per-run processing limit

Alias matching supports common `+tag` aliases, Gmail dot / `+tag` aliases, and 2925 prefix aliases. When multiple aliases share one mailbox, verification-code extraction prefers the target recipient address to avoid using another alias's code.

The auto-repair toggle only applies to the current page session. It is not restored after refresh, and the sub2api password is not saved.

## External Mail Providers

External mail providers only affect verification-code fetching. ChatGPT login, CPA/sub2api/Cockpit export, and CPA warehouse behavior remain the same.

The import modal includes visual configuration panels:

- Cloudflare Temp Email: `TEMP API`, `ADMIN AUTH`, `CUSTOM AUTH`, lookup mode, receiving mailbox, random subdomain, and domain refresh
- Cloud Mail: API address, admin email, admin password, and domain

Supported providers:

- `cloudflare-temp-mail`: compatible with Cloudflare Temp Email management APIs, reads `/admin/mails`, supports `adminAuth` / `customAuth`
- `cloud-mail`: compatible with Cloud Mail public APIs, reads `/api/public/emailList`, supports `token` or `adminEmail` + `adminPassword`

The provider compatibility layer references the Cloudflare Temp Email / Cloud Mail API patterns from [FoundZiGu/GuJumpgate](https://github.com/FoundZiGu/GuJumpgate). This project only adds verification-mail compatibility, not GuJumpgate's repository automation.

## Acknowledgements

- Thanks to [FoundZiGu/GuJumpgate](https://github.com/FoundZiGu/GuJumpgate) for the Cloudflare Temp Email and Cloud Mail API ideas.
- Thanks to [DanOps-1/Gpt-Agreement-Payment](https://github.com/DanOps-1/Gpt-Agreement-Payment) for the ChatGPT protocol-login flow reference.

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
- exported CPA/sub2api/Cockpit credential files

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
