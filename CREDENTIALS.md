# Credentials Setup Guide

This project uses Google OAuth 2.0 to access Google Docs, Drive, and Gmail. Credentials and app config live in the **config** folder (or in `~/.config/export_docs_gmail/` as fallback).

| File | Purpose | How you get it |
|------|---------|----------------|
| `credentials.json` | OAuth client (client ID and secret) | Create in Google Cloud Console, then download |
| `token.json` | Access/refresh tokens for your account | Auto-generated on first run of `node cli.js` |
| `config.json` | Document ID, Drive folder, tracker URL, etc. | Copy from `config/config.json.template` and fill in; see [config/README.md](config/README.md) |

**Where files are read from:** The app looks in **`./config/`** first (project root). If a file is not there, it looks in **`~/.config/export_docs_gmail/`**.  
**Where token is written:** If `./config/` exists, token is saved there; otherwise it is saved in `~/.config/export_docs_gmail/` (directory created if needed).

**Never commit real credentials or token files.** The repo includes only templates: `config/credentials.json.template` and `config/config.json.template`.

---

## 1. How to obtain credentials.json

**You get `credentials.json` from Google Cloud Console** — create a Desktop OAuth client and **download** the JSON file. Save it as `config/credentials.json`. The app does not generate this file; it is used during the automatic OAuth flow on first run of `node cli.js`.

A **template** (`config/credentials.json.template`) is in the repo only as a structure reference. The normal flow is to use the file you download from Google (see section 2 below). If you prefer to hand-fill instead of downloading, copy the template to `config/credentials.json` and replace `YOUR_CLIENT_ID`, `your-project-id`, and `YOUR_CLIENT_SECRET` with your OAuth client values.

---

## 2. Create OAuth client and download JSON (Google Cloud Console)

### Create project and enable APIs

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project: **Select a project** → **New project** (e.g. name: "Docs Export Tool").
3. Enable the APIs:
   - Go to **APIs & Services** → **Library**.
   - Enable:
     - **Google Docs API**
     - **Google Drive API**
     - **Gmail API**

### Configure the OAuth consent screen (if asked)

1. Go to **APIs & Services** → **OAuth consent screen**.
2. User type: **External** (or Internal if you use Workspace and only need your org).
3. Fill:
   - App name: e.g. "Docs Export Tool"
   - User support email and Developer contact: your email
4. **Scopes** → Add:
   - `https://www.googleapis.com/auth/documents.readonly`
   - `https://www.googleapis.com/auth/gmail.compose`
   - `https://www.googleapis.com/auth/drive.file`
5. **Test users** (if External): add the Google account you will use to run the tool.

### Create OAuth client and download JSON

1. Go to **APIs & Services** → **Credentials**.
2. **Create credentials** → **OAuth client ID**.
3. Application type: **Desktop app**.
4. Name: e.g. "Docs Export Client" → **Create**.
5. In the list, open the new client and use the **Download JSON** (download icon).
6. Save the file as:
   ```text
   config/credentials.json
   ```
   (Or in `~/.config/export_docs_gmail/credentials.json` if you use the fallback directory.)

The downloaded file will look like the template but with real `client_id`, `client_secret`, and `project_id`. It may use `"installed"` (desktop) or `"web"`; the app supports both.

---

## 3. How to use the credentials

### One-time setup

1. Ensure `config/credentials.json` exists (or in `~/.config/export_docs_gmail/`) from download or from the template with real values.
2. From the project root, run:
   ```bash
   node cli.js
   ```
3. On first run (no `token.json` found), the tool will print a Google sign-in URL and offer to open your browser (press Space). A local web server captures the OAuth callback automatically — no need to copy-paste codes.
4. Sign in with the Google account you added as a test user (if applicable) and grant the requested permissions. The browser will confirm success and you can close the tab.
5. `token.json` is saved in the config location (project `config/` or `~/.config/export_docs_gmail/`).

After that, subsequent runs use the stored token (with automatic refresh).

### Where each file is used

- **cli.js** – Unified entry point. Checks for token, runs OAuth flow if needed, then handles tab selection and export.
- **export.js** – Export engine, called by `cli.js`. Can also be run standalone with `node export.js <docId> <tabId>`.

---

## 4. Security and .gitignore

- **Do not commit** `config/credentials.json`, `config/token.json`, or `config/config.json`.
- The repo ignores only those files inside `config/`; templates and `config/README.md` are tracked.
- If credentials or token were ever committed, rotate them in Google Cloud Console and regenerate `token.json` by running `node cli.js`.

---

## 5. Troubleshooting

| Problem | What to do |
|--------|------------|
| **"Cannot find credentials"** | Ensure `config/credentials.json` (or `~/.config/export_docs_gmail/credentials.json`) exists and is valid JSON. Use the template structure or the file downloaded from Google. |
| **"invalid_grant" or token errors** | Delete `config/token.json` (or `~/.config/export_docs_gmail/token.json`) and run `node cli.js` again. It will re-authenticate automatically. |
| **"Access denied" or missing scope** | In Google Cloud Console, ensure the OAuth consent screen has the three scopes above and your user is added as a test user. Then delete the token file and run `node cli.js` again. |
| **Redirect URI mismatch** | The CLI uses a dynamic `http://localhost:<port>` redirect for the OAuth flow. For desktop app type credentials this works automatically. |

For more on the export flow and config format, see [README.md](README.md), [config/README.md](config/README.md), and [AGENTS.md](AGENTS.md).
