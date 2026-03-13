#!/usr/bin/env node

const http = require('http');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const readline = require('readline');
const chalk = require('chalk');
const axios = require('axios');
const config = require('./load-config');

const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets.readonly'
];

const TABS_PEEK = 5;
const COMMANDS = ['export', 'publish', 'update-jobs', 'list-tabs', 'auth', 'help'];

// ── Argument parsing ────────────────────────────────────────────────

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { command: null, tab: null, tabName: null, date: null, doc: null, fast: false };

  for (let i = 0; i < a.length; i++) {
    const v = a[i];

    if (!v.startsWith('-') && !o.command && COMMANDS.includes(v)) {
      o.command = v;
      continue;
    }

    switch (v) {
      case '-t': case '--tab':       o.tab = parseInt(a[++i]); break;
      case '-n': case '--tab-name':  o.tabName = a[++i]; break;
      case '-d': case '--date':      o.date = a[++i]; break;
      case '--doc':                  o.doc = a[++i]; break;
      case '-f': case '--fast':      o.fast = true; break;
      case '-h': case '--help':      o.command = o.command || 'help'; break;
    }
  }

  return o;
}

function showHelp() {
  console.log(`
${chalk.bold('Google Docs → Email Export')}

${chalk.bold('USAGE')}
  node cli.js ${chalk.cyan('<command>')} [flags]

${chalk.bold('COMMANDS')}
  ${chalk.cyan('export')}        Export a Google Doc tab to HTML email + Gmail draft
  ${chalk.cyan('publish')}       Publish tracking: add date to gist & refresh service
  ${chalk.cyan('update-jobs')}   Refresh job postings cache from org chart + careers site
  ${chalk.cyan('list-tabs')}     List all tabs in the document
  ${chalk.cyan('auth')}          Re-authenticate with Google (deletes saved token)
  ${chalk.cyan('help')}          Show this help ${chalk.dim('(default)')}

${chalk.bold('FLAGS')}
  -t, --tab <n>           Select tab by number (1-based)
  -n, --tab-name <text>   Select tab by name (substring match)
  -d, --date <YYYY-MM-DD> Override date for tracker URL / Gmail subject
  --doc <id>              Override document ID
  -f, --fast              Skip re-downloading images already in Drive

${chalk.bold('EXAMPLES')}
  node cli.js export                          Interactive export
  node cli.js export -t 1                    Export first tab, today's date
  node cli.js export -t 2 -d 2026-03-01     Export tab 2 with custom date
  node cli.js export -t 1 --fast            Fast re-export (reuse Drive images)
  node cli.js export -n "Iteration 125"      Export tab matching name
  node cli.js publish                        Publish tracking for today
  node cli.js publish -d 2026-03-13          Publish tracking for specific date
  node cli.js update-jobs                     Refresh job postings cache
  node cli.js list-tabs                      List tabs
  node cli.js auth                           Re-authenticate
`);
}

// ── Helpers ─────────────────────────────────────────────────────────

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} '${url}'`);
}

function ask(question, fallback) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, ans => { rl.close(); resolve(ans.trim() || fallback || ''); });
  });
}

function isValidDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

// ── Authentication ──────────────────────────────────────────────────

function readCredentials() {
  const p = config.getCredentialsPath();
  if (!fs.existsSync(p)) {
    console.error(chalk.red('credentials.json not found.'));
    console.error('Place your Google OAuth credentials in config/credentials.json');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(p));
  return raw.installed || raw.web;
}

async function runAuthFlow() {
  const { client_id, client_secret } = readCredentials();

  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const redirectUri = `http://localhost:${port}`;

  const client = new google.auth.OAuth2(client_id, client_secret, redirectUri);
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log(chalk.bold('\n  Authentication required\n'));
  console.log(`  ${chalk.dim(authUrl)}\n`);
  console.log('  Press Space to open browser, or open the url in your browser and authenticate.');
  console.log('  Waiting for authentication...');

  let cleanupStdin = () => {};
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (d) => {
      const ch = d.toString();
      if (ch === '\u0003') process.exit();
      if (ch === ' ') openBrowser(authUrl);
    };
    process.stdin.on('data', onData);
    cleanupStdin = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
  }

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanupStdin(); server.close();
      reject(new Error('Authorization timed out (5 min)'));
    }, 300_000);

    server.on('request', (req, res) => {
      const u = new URL(req.url, redirectUri);
      const err = u.searchParams.get('error');
      const c = u.searchParams.get('code');
      if (err) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Authorization failed</h2><p>You can close this tab.</p>');
        clearTimeout(timer); cleanupStdin(); server.close();
        reject(new Error(`Authorization denied: ${err}`));
      } else if (c) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2 style="color:green">&#10003; Authorized</h2><p>Return to the terminal. You can close this tab.</p>');
        clearTimeout(timer); cleanupStdin(); server.close();
        resolve(c);
      } else {
        res.writeHead(404); res.end();
      }
    });
  });

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const tokenPath = path.join(config.getConfigDirForWriting(), 'token.json');
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  console.log(chalk.green('  ✓ Authenticated!\n'));

  return client;
}

async function ensureAuth() {
  const tokenPath = config.getTokenPath();
  if (!fs.existsSync(tokenPath)) return runAuthFlow();

  const creds = readCredentials();
  const client = new google.auth.OAuth2(
    creds.client_id, creds.client_secret, (creds.redirect_uris || [])[0]
  );
  client.setCredentials(JSON.parse(fs.readFileSync(tokenPath)));

  client.on('tokens', newTokens => {
    const cur = JSON.parse(fs.readFileSync(tokenPath));
    fs.writeFileSync(tokenPath, JSON.stringify({ ...cur, ...newTokens }, null, 2));
  });

  console.log(chalk.green('✓ Authenticated\n'));
  return client;
}

// ── Tabs ────────────────────────────────────────────────────────────

async function fetchTabs(auth, docId) {
  const docs = google.docs({ version: 'v1', auth });
  const doc = await docs.documents.get({
    documentId: docId,
    includeTabsContent: false,
    fields: 'tabs(tabProperties)',
  });
  if (!doc.data.tabs?.length) {
    console.error(chalk.red('No tabs found in this document.'));
    process.exit(1);
  }
  return doc.data.tabs.map(t => ({
    title: t.tabProperties?.title || 'Untitled',
    id: t.tabProperties?.tabId,
  }));
}

function printTabs(tabs, limit) {
  const n = limit != null ? limit : tabs.length;
  for (let i = 0; i < n; i++) {
    console.log(`  ${chalk.bold(String(i + 1).padStart(2))}. ${tabs[i].title}`);
  }
  if (n < tabs.length) {
    console.log(`   ${chalk.bold('m')}. Show all ${tabs.length} tabs`);
  }
}

async function selectTab(tabs, opts) {
  if (opts.tab != null) {
    if (isNaN(opts.tab) || opts.tab < 1 || opts.tab > tabs.length) {
      console.error(chalk.red(`Tab ${opts.tab} out of range (1–${tabs.length}).`));
      process.exit(1);
    }
    return tabs[opts.tab - 1];
  }

  if (opts.tabName) {
    const needle = opts.tabName.toLowerCase();
    const match = tabs.find(t => t.title.toLowerCase().includes(needle));
    if (!match) {
      console.error(chalk.red(`No tab matching "${opts.tabName}".`));
      process.exit(1);
    }
    return match;
  }

  let showAll = tabs.length <= TABS_PEEK;
  printTabs(tabs, showAll ? tabs.length : TABS_PEEK);

  while (true) {
    const ans = await ask(`\n  Select tab ${chalk.dim('[1]')}: `, '1');
    if (ans.toLowerCase() === 'm' && !showAll) {
      showAll = true;
      console.log('');
      printTabs(tabs, tabs.length);
      continue;
    }
    const num = parseInt(ans);
    const max = showAll ? tabs.length : TABS_PEEK;
    if (!isNaN(num) && num >= 1 && num <= max) return tabs[num - 1];
    console.log(chalk.yellow(`  Enter 1–${max}${showAll ? '' : ' or m for more'}`));
  }
}

// ── Date ────────────────────────────────────────────────────────────

async function promptDate(cliDate) {
  const today = new Date().toISOString().split('T')[0];

  if (cliDate) {
    if (!isValidDate(cliDate)) {
      console.error(chalk.red(`Invalid date "${cliDate}". Use YYYY-MM-DD format.`));
      process.exit(1);
    }
    return cliDate;
  }

  while (true) {
    const ans = await ask(`  Date ${chalk.dim(`[${today}]`)}: `, today);
    if (isValidDate(ans)) return ans;
    console.log(chalk.yellow('  Use YYYY-MM-DD format.'));
  }
}

// ── Require doc + tab helper ────────────────────────────────────────

async function requireDocAndTab(opts) {
  const docId = opts.doc || config.documentId;
  if (!docId) {
    console.error(chalk.red('No document ID. Set it in config/config.json or pass --doc <id>.'));
    process.exit(1);
  }
  const auth = await ensureAuth();
  console.log('Fetching tabs...');
  const tabs = await fetchTabs(auth, docId);
  console.log(`\n${tabs.length} tabs:\n`);
  const tab = await selectTab(tabs, opts);
  console.log(chalk.green(`\n  ✓ ${tab.title}\n`));
  return { auth, docId, tab };
}

// ── Commands ────────────────────────────────────────────────────────

async function cmdAuth() {
  const tokenPath = config.getTokenPath();
  if (fs.existsSync(tokenPath)) {
    fs.unlinkSync(tokenPath);
    console.log(chalk.green(`  ✓ Deleted ${tokenPath}`));
  }
  console.log('  Re-authenticating with updated scopes...\n');
  await runAuthFlow();
}

async function cmdListTabs(opts) {
  const docId = opts.doc || config.documentId;
  if (!docId) {
    console.error(chalk.red('No document ID. Set it in config/config.json or pass --doc <id>.'));
    process.exit(1);
  }
  const auth = await ensureAuth();
  console.log('Fetching tabs...');
  const tabs = await fetchTabs(auth, docId);
  console.log(`\n${tabs.length} tabs:\n`);
  printTabs(tabs);
  console.log('');
}

async function cmdExport(opts) {
  const { auth, docId, tab } = await requireDocAndTab(opts);
  const dateStr = await promptDate(opts.date);
  console.log(chalk.green(`  ✓ ${dateStr}\n`));

  let jobs;
  if (opts.fast) {
    const { getValidJobs } = require('./update-jobs');
    jobs = getValidJobs();
    console.log(chalk.dim(`  ⚡ Fast mode — using ${jobs.length} cached job(s), skipping refresh\n`));
  } else {
    const { refreshJobs } = require('./update-jobs');
    jobs = await refreshJobs(auth);
  }

  const { exportDoc } = require('./export');
  await exportDoc({ docId, tabId: tab.id, dateOverride: dateStr, auth, jobs, fast: opts.fast });
}

function getGhToken() {
  try {
    return execSync('gh auth token', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    console.error(chalk.red('Could not get GitHub token. Make sure `gh` CLI is installed and authenticated.'));
    console.error('Run: gh auth login');
    process.exit(1);
  }
}

async function cmdPublish(opts) {
  const dateStr = await promptDate(opts.date);
  const emailId = dateStr.replace(/-/g, '');
  const gistId = config.gistId;
  const pulseUrl = config.pulseListUrl;

  if (!gistId) {
    console.error(chalk.red('No gistId configured. Set it in config/config.json or env GIST_ID.'));
    process.exit(1);
  }

  console.log(`\n  Publishing email ID: ${chalk.bold(emailId)}\n`);

  const token = getGhToken();
  const ghHeaders = { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' };

  console.log('  Fetching gist...');
  const gistRes = await axios.get(`https://api.github.com/gists/${gistId}`, { headers: ghHeaders });
  const filename = Object.keys(gistRes.data.files)[0];
  const currentContent = JSON.parse(gistRes.data.files[filename].content);

  if (currentContent.enabled_email_ids.includes(emailId)) {
    console.log(chalk.yellow(`  ⚠ ${emailId} already exists in the gist — skipping update`));
  } else {
    currentContent.enabled_email_ids.push(emailId);
    const newContent = JSON.stringify(currentContent, null, 2);

    console.log(`  Adding ${chalk.bold(emailId)} to gist...`);
    await axios.patch(`https://api.github.com/gists/${gistId}`, {
      files: { [filename]: { content: newContent } }
    }, { headers: ghHeaders });
    console.log(chalk.green(`  ✓ Gist updated`));
  }

  const TOTAL_CALLS = 15;
  const VERIFY_LAST = 5;

  console.log(`\n  Refreshing service nodes (${TOTAL_CALLS} calls)...\n  `);
  const results = [];
  for (let i = 0; i < TOTAL_CALLS; i++) {
    try {
      const res = await axios.get(pulseUrl);
      const found = res.data.enabled_email_ids && res.data.enabled_email_ids.includes(emailId);
      results.push(found);
      process.stdout.write(found ? chalk.green('✓') : chalk.dim('·'));
    } catch (err) {
      results.push(false);
      process.stdout.write(chalk.red('✗'));
    }
  }
  console.log('');

  const lastN = results.slice(-VERIFY_LAST);
  const allGood = lastN.every(Boolean);
  console.log('');
  if (allGood) {
    console.log(chalk.green(`  ✓ All last ${VERIFY_LAST} responses contain ${emailId} — tracking is live!`));
  } else {
    const okCount = lastN.filter(Boolean).length;
    console.log(chalk.yellow(`  ⚠ Only ${okCount}/${VERIFY_LAST} of the last responses contain ${emailId}.`));
    console.log(chalk.yellow(`    Nodes may still be propagating. Re-run to verify, or wait and check again.`));
  }
  console.log('');
}

async function cmdUpdateJobs() {
  const auth = await ensureAuth();
  const { refreshJobs } = require('./update-jobs');
  await refreshJobs(auth);
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const command = opts.command || 'help';

  switch (command) {
    case 'help':        showHelp(); break;
    case 'auth':        await cmdAuth(); break;
    case 'list-tabs':   await cmdListTabs(opts); break;
    case 'export':      await cmdExport(opts); break;
    case 'publish':     await cmdPublish(opts); break;
    case 'update-jobs': await cmdUpdateJobs(opts); break;
    default:
      console.error(chalk.red(`Unknown command: ${command}`));
      console.error(`Run ${chalk.bold('node cli.js help')} for usage.`);
      process.exit(1);
  }
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error(chalk.red(`\nError: ${err.message}`));
  process.exit(1);
});
