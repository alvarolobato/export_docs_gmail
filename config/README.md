# Config folder

Credentials and app config live here. **Sensitive files are gitignored.** Tracked files are templates only.

## Where config is loaded from

1. **Project:** `./config/` (this folder, when run from project root)
2. **Fallback:** `~/.config/export_docs_gmail/`

For each file (`credentials.json`, `token.json`, `config.json`), the app looks in the project `config/` first; if the file is not there, it uses the file in `~/.config/export_docs_gmail/`.  
When **writing** (e.g. saving `token.json` after auth), the app uses the project `config/` if that directory exists, otherwise `~/.config/export_docs_gmail/` (creating it if needed).

## Setup

1. **credentials.json** — From **Google Cloud Console**: create a Desktop OAuth client and **download** the JSON. Save it as `config/credentials.json`. (Do not copy from the template; the real file is provided by Google. The template is only for reference.)
2. **config.json** — Copy the template and fill in your values:  
   `cp config/config.json.template config/config.json` then edit document ID, Drive folder ID, etc.
3. **token.json** — Generated automatically when you run `node auth.js` (it uses `credentials.json` to complete OAuth and writes `token.json`).

If you use the fallback directory `~/.config/export_docs_gmail/`: put your downloaded `credentials.json` and optionally `config.json` there, then run `node auth.js`; the token will be written there.

---

## credentials.json format

From Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID (Desktop app).  
Download JSON; it should look like:

```json
{
  "installed": {
    "client_id": "....apps.googleusercontent.com",
    "client_secret": "...",
    "redirect_uris": ["http://localhost"],
    ...
  }
}
```

(Or `"web"` instead of `"installed"` for web client; the loader supports both.)

---

## config.json format

| Key | Description | Example |
|-----|-------------|---------|
| **documentId** | Google Docs document ID from the doc URL | `1y6i0wbfqSCZsoEEcYQ6xJyOJrY2Lll4YZ08fKnX2Ue0` |
| **defaultTabId** | Default tab ID when not passed as CLI arg | `t.sy56fi2lyr6j` |
| **driveParentFolderId** | Drive folder ID for image subfolders | From Drive folder URL |
| **driveImageUrlTemplate** | Image URL template; `{FILE_ID}` is replaced | `https://drive.google.com/uc?export=view&id={FILE_ID}` |
| **trackerBaseUrl** | Tracking pixel base URL; date is appended | `https://email-pulse.app.elstc.co/track?email_id=` |
| **gmailSubjectPrefix** | Gmail draft subject prefix (date appended) | `[tri-weekly] Observability Update` |
| **outputDir** | Local directory for HTML output | `emails` |

Environment variables override: `DOCUMENT_ID`, `DEFAULT_TAB_ID`, `DRIVE_PARENT_FOLDER_ID`, `TRACKER_BASE_URL`, `GMAIL_SUBJECT_PREFIX`, `OUTPUT_DIR`.

---

## Usage in code

The config loader lives at project root: **load-config.js**. It reads from `config/` or `~/.config/export_docs_gmail/`.

```js
const config = require('./load-config');
// App config
config.documentId;
config.getDriveImageUrl(fileId);
// Paths (for credentials/token)
config.getCredentialsPath();
config.getTokenPath();
config.getConfigDirForWriting();
```
