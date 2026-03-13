const fs = require('fs');
const path = require('path');
const os = require('os');

const projectConfigDir = path.join(process.cwd(), 'config');
const homeConfigDir = path.join(os.homedir(), '.config', 'export_docs_gmail');
const searchDirs = [projectConfigDir, homeConfigDir];

/** Resolve path to a file: try project config/, then ~/.config/export_docs_gmail/. */
function resolvePath(filename) {
  for (const dir of searchDirs) {
    const p = path.join(dir, filename);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Directory to use when writing (e.g. token). Prefer project config/; else use home and ensure it exists. */
function getConfigDirForWriting() {
  if (fs.existsSync(projectConfigDir)) return projectConfigDir;
  if (!fs.existsSync(homeConfigDir)) {
    fs.mkdirSync(homeConfigDir, { recursive: true });
  }
  return homeConfigDir;
}

/** Path to credentials.json (read-only). */
function getCredentialsPath() {
  return resolvePath('credentials.json') || path.join(getConfigDirForWriting(), 'credentials.json');
}

/** Path to token.json. */
function getTokenPath() {
  return resolvePath('token.json') || path.join(getConfigDirForWriting(), 'token.json');
}

// --- App config (config.json) ---

const DEFAULTS = {
  documentId: '',
  defaultTabId: 't.sy56fi2lyr6j',
  driveParentFolderId: '',
  driveImageUrlTemplate: 'https://lh3.googleusercontent.com/d/{FILE_ID}',
  trackerBaseUrl: 'https://email-pulse.app.elstc.co/track?email_id=',
  gmailSubjectPrefix: '[tri-weekly] Observability Update',
  emailHeaderLabel: '',
  emailHeaderTitle: '',
  outputDir: 'emails'
};

const ENV_MAP = {
  DOCUMENT_ID: 'documentId',
  DEFAULT_TAB_ID: 'defaultTabId',
  DRIVE_PARENT_FOLDER_ID: 'driveParentFolderId',
  TRACKER_BASE_URL: 'trackerBaseUrl',
  GMAIL_SUBJECT_PREFIX: 'gmailSubjectPrefix',
  EMAIL_HEADER_LABEL: 'emailHeaderLabel',
  EMAIL_HEADER_TITLE: 'emailHeaderTitle',
  OUTPUT_DIR: 'outputDir'
};

function loadAppConfig() {
  let fileConfig = {};
  const configPath = resolvePath('config.json');
  if (configPath) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.warn('load-config: invalid config.json, using defaults/env only:', e.message);
    }
  }

  const envOverrides = {};
  for (const [envKey, configKey] of Object.entries(ENV_MAP)) {
    if (process.env[envKey] !== undefined && process.env[envKey] !== '') {
      envOverrides[configKey] = process.env[envKey];
    }
  }

  return { ...DEFAULTS, ...fileConfig, ...envOverrides };
}

const config = loadAppConfig();

function getDriveImageUrl(fileId) {
  return config.driveImageUrlTemplate.replace('{FILE_ID}', fileId);
}

module.exports = {
  ...config,
  getDriveImageUrl,
  getCredentialsPath,
  getTokenPath,
  getConfigDirForWriting,
  resolvePath
};
