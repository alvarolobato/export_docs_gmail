#!/usr/bin/env node

const http = require('http');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const readline = require('readline');
const chalk = require('chalk');
const config = require('./load-config');

const SCOPES = [
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/drive.file'
];

const TABS_PEEK = 5;

// ── Argument parsing ────────────────────────────────────────────────

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { tab: null, tabName: null, date: null, doc: null, listTabs: false, help: false };
  for (let i = 0; i < a.length; i++) {
    switch (a[i]) {
      case '-t': case '--tab':       o.tab = parseInt(a[++i]); break;
      case '-n': case '--tab-name':  o.tabName = a[++i]; break;
      case '-d': case '--date':      o.date = a[++i]; break;
      case '--doc':                  o.doc = a[++i]; break;
      case '-l': case '--list-tabs': o.listTabs = true; break;
      case '-h': case '--help':      o.help = true; break;
    }
  }
  return o;
}

function showHelp() {
  console.log(`
${chalk.bold('Google Docs → Email Export')}

Usage: node cli.js [options]

Options:
  -t, --tab <n>           Select tab by number (1-based)
  -n, --tab-name <text>   Select tab by name (substring match)
  -d, --date <YYYY-MM-DD> Override date for tracker URL / Gmail subject
  --doc <id>              Override document ID
  -l, --list-tabs         List all tabs and exit
  -h, --help              Show this help

Examples:
  node cli.js                            Interactive mode
  node cli.js -l                         List tabs
  node cli.js -t 1                       Export first tab, today's date
  node cli.js -t 2 -d 2026-03-01        Export tab 2 with custom date
  node cli.js -n "Iteration 122"         Export tab matching name
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

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  if (opts.help) { showHelp(); return; }

  const docId = opts.doc || config.documentId;
  if (!docId) {
    console.error(chalk.red('No document ID. Set it in config/config.json or pass --doc <id>.'));
    process.exit(1);
  }

  const auth = await ensureAuth();

  console.log('Fetching tabs...');
  const tabs = await fetchTabs(auth, docId);

  if (opts.listTabs) {
    console.log(`\n${tabs.length} tabs:\n`);
    printTabs(tabs);
    console.log('');
    return;
  }

  console.log(`\n${tabs.length} tabs:\n`);
  const tab = await selectTab(tabs, opts);
  console.log(chalk.green(`\n  ✓ ${tab.title}\n`));

  const dateStr = await promptDate(opts.date);
  console.log(chalk.green(`  ✓ ${dateStr}\n`));

  const { exportDoc } = require('./export');
  await exportDoc({ docId, tabId: tab.id, dateOverride: dateStr, auth });
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error(chalk.red(`\nError: ${err.message}`));
  process.exit(1);
});
