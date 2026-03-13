#!/usr/bin/env node

const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const config = require('./load-config');

const REQ_PATTERN = /R-?(\d{4,5})/g;
const CACHE_FILENAME = 'jobs_cache.json';

// ── Cache ────────────────────────────────────────────────────────────

function getCachePath() {
  return path.join(config.getConfigDirForWriting(), CACHE_FILENAME);
}

function loadCache() {
  const p = getCachePath();
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* ignore */ }
  }
  return {};
}

function saveCache(cache) {
  fs.writeFileSync(getCachePath(), JSON.stringify(cache, null, 2));
}

// ── Spreadsheet: extract R-numbers ──────────────────────────────────

async function extractReqNumbers(auth) {
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = config.orgChartSpreadsheetId;

  if (!spreadsheetId) {
    throw new Error('No orgChartSpreadsheetId configured.');
  }

  console.log('  Fetching org chart spreadsheet...');
  let meta;
  try {
    meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('has not been used') || msg.includes('disabled')) {
      const enableUrl = msg.match(/https:\/\/console\.developers\.google\.com\S+/)?.[0] || '';
      console.error(chalk.red('\n  Google Sheets API is not enabled for this project.'));
      console.error(`  Enable it at: ${chalk.bold(enableUrl)}`);
      console.error('  Then re-run this command.\n');
      process.exit(1);
    }
    if (msg.includes('insufficient') || msg.includes('Insufficient') || msg.includes('invalid_scope')) {
      console.error(chalk.red('\n  OAuth scopes changed. Re-authenticate with:'));
      console.error(`  ${chalk.bold('node cli.js auth')}\n`);
      process.exit(1);
    }
    throw err;
  }

  const firstSheet = meta.data.sheets[0].properties.title;
  console.log(`  Reading sheet "${firstSheet}"...`);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${firstSheet}'`,
    valueRenderOption: 'FORMATTED_VALUE',
  });

  const allText = (res.data.values || []).flat().join(' ');
  const found = new Set();
  let m;
  const re = new RegExp(REQ_PATTERN.source, 'g');
  while ((m = re.exec(allText)) !== null) {
    found.add(`R${m[1]}`);
  }

  return [...found].sort();
}

// ── Careers API: look up job by R-number ────────────────────────────

async function getSessionCookies() {
  const res = await axios.get(`${config.careersBaseUrl}/jobs/department/engineering`, {
    maxRedirects: 5,
    validateStatus: () => true,
  });
  const setCookies = res.headers['set-cookie'] || [];
  const cookieHeader = setCookies.map(c => c.split(';')[0]).join('; ');
  const xsrfMatch = setCookies.find(c => c.startsWith('XSRF-TOKEN='));
  let xsrfToken = '';
  if (xsrfMatch) {
    xsrfToken = decodeURIComponent(xsrfMatch.split(';')[0].replace('XSRF-TOKEN=', ''));
  }
  return { cookieHeader, xsrfToken };
}

function extractRoleDescription(content) {
  if (!content) return '';
  const match = content.match(/What is [Tt]he [Rr]ole[:\s]*\n([\s\S]*?)(?=\n(?:What You Will|What you will|Applications without))/);
  if (match) return match[1].trim();
  const fallback = content.match(/What is [Tt]he [Rr]ole[:\s]*\n([\s\S]*?)(?=\n\n)/);
  return fallback ? fallback[1].trim() : '';
}

async function lookupJobByCode(jobCode, session) {
  const body = {
    query: '',
    precision: 2,
    page: { size: 5, current: 1 },
    filters: { all: [{ all: [{ job_code: jobCode }] }] },
    result_fields: {
      title: { raw: {} },
      url: { raw: {} },
      job_code: { raw: {} },
      category: { raw: {} },
      content: { raw: {} },
    },
  };

  const res = await axios.post(`${config.careersBaseUrl}/api/appSearch`, body, {
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Cookie: session.cookieHeader,
      'X-XSRF-TOKEN': session.xsrfToken,
    },
  });

  const results = res.data.results || [];
  if (results.length === 0) return null;

  const r = results[0];
  const urlPath = r.url?.raw || '';
  const fullContent = r.content?.raw || '';
  return {
    title: r.title?.raw || '',
    category: r.category?.raw || '',
    jobCode: r.job_code?.raw || jobCode,
    url: urlPath.startsWith('http') ? urlPath : `${config.careersBaseUrl}/jobs/${urlPath}`,
    description: extractRoleDescription(fullContent),
    fetchedAt: new Date().toISOString(),
  };
}

// ── Summarize job descriptions via `agent` CLI ──────────────────────

function summarizeJobs(jobsToSummarize) {
  const { execFileSync } = require('child_process');

  const jobBlock = jobsToSummarize
    .map(({ code, desc }) => `${code}\t${desc.replace(/[\t\n\r]/g, ' ')}`)
    .join('\n');

  const prompt = `Below is a TSV list of job codes and their descriptions.
For each, write a 2-sentence summary of what the person would actually do day-to-day.
Skip any company descriptions, mission statements, or team overviews.
Go straight to the point of what they would be doing. It's ok to mention the team name.
Output ONLY TSV lines: job_code<TAB>summary
No headers, no markdown, no extra text. One line per job.

${jobBlock}`;

  console.log(`  Calling agent to summarize ${jobsToSummarize.length} job(s)...`);
  const raw = execFileSync('agent', [prompt], {
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  const summaries = {};
  for (const line of raw.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const code = line.slice(0, tab).trim();
    const summary = line.slice(tab + 1).trim();
    if (code && summary) summaries[code] = summary;
  }
  return summaries;
}

// ── Resolve jobs: cache → validate → fetch → summarize ─────────────

async function resolveJobs(reqNumbers) {
  const cache = loadCache();

  // Always re-check previously-not-found entries
  const staleNotFound = reqNumbers.filter(r => cache[r] && cache[r].notFound);
  if (staleNotFound.length > 0) {
    for (const code of staleNotFound) {
      console.log(`  ↻ ${code} — was not found last time, re-checking`);
      delete cache[code];
    }
    saveCache(cache);
  }

  const cached = reqNumbers.filter(r => cache[r] && !cache[r].notFound && cache[r].url);
  if (cached.length > 0) {
    process.stdout.write(`  Validating ${cached.length} cached link(s)… `);
    const checks = await Promise.all(cached.map(async code => {
      try {
        const res = await axios.head(cache[code].url, { timeout: 8000, maxRedirects: 5, validateStatus: () => true });
        return { code, ok: res.status >= 200 && res.status < 400 };
      } catch {
        return { code, ok: false };
      }
    }));
    const stale = checks.filter(c => !c.ok);
    if (stale.length > 0) {
      for (const { code } of stale) {
        console.log(`\n    ↻ ${code} — cached URL returned ${chalk.yellow('dead link')}, re-fetching`);
        delete cache[code];
      }
      saveCache(cache);
    } else {
      console.log(chalk.green('all good'));
    }
  }

  const needed = reqNumbers.filter(r => !cache[r]);
  const fromCache = reqNumbers.length - needed.length;

  if (fromCache > 0) {
    console.log(`  ♻️  ${fromCache} already in cache`);
  }

  if (needed.length > 0) {
    const brandNew = needed.filter(r => !staleNotFound.includes(r));
    if (brandNew.length > 0) {
      for (const code of brandNew) console.log(`  + ${code} — ${chalk.cyan('new req number')}`);
    }
    console.log(`  Looking up ${needed.length} job(s) on careers site...`);
    const session = await getSessionCookies();

    for (const code of needed) {
      process.stdout.write(`    ${code} … `);
      try {
        const job = await lookupJobByCode(code, session);
        if (job) {
          cache[code] = job;
          console.log(chalk.green(`✓ ${job.title}`));
        } else {
          cache[code] = { title: '', url: '', jobCode: code, notFound: true, fetchedAt: new Date().toISOString() };
          console.log(chalk.yellow('not found'));
        }
      } catch (err) {
        console.log(chalk.red(`error: ${err.message}`));
      }
    }
    saveCache(cache);
  }

  const needsSummary = reqNumbers.filter(r => cache[r] && !cache[r].notFound && cache[r].description && !cache[r].summary);
  if (needsSummary.length > 0) {
    console.log('');
    try {
      const toSummarize = needsSummary.map(code => ({ code, desc: cache[code].description }));
      const summaries = summarizeJobs(toSummarize);
      let ok = 0;
      for (const code of needsSummary) {
        if (summaries[code]) {
          cache[code].summary = summaries[code];
          ok++;
        }
      }
      console.log(chalk.green(`  ✓ Got ${ok}/${needsSummary.length} summaries`));
      saveCache(cache);
    } catch (err) {
      console.log(chalk.yellow(`  Summarization skipped (${err.message})`));
    }
  }

  return reqNumbers.map(r => cache[r]).filter(j => j && !j.notFound && j.title);
}

// ── Main entry point ────────────────────────────────────────────────

async function refreshJobs(auth) {
  console.log(chalk.bold('\n  Update Jobs\n'));

  console.log(chalk.bold('  Step 1: Extract req numbers from org chart'));
  const reqNumbers = await extractReqNumbers(auth);
  console.log(`  Found ${chalk.bold(reqNumbers.length)} req numbers: ${reqNumbers.join(', ')}\n`);

  if (reqNumbers.length === 0) {
    console.log(chalk.yellow('  No req numbers found.\n'));
    return [];
  }

  console.log(chalk.bold('  Step 2: Resolve job postings'));
  const jobs = await resolveJobs(reqNumbers);
  const notFoundCount = reqNumbers.length - jobs.length;
  console.log(`  ${chalk.green(jobs.length + ' found')}${notFoundCount > 0 ? ', ' + chalk.yellow(notFoundCount + ' not found') : ''}\n`);

  return jobs;
}

function getValidJobs() {
  const cache = loadCache();
  return Object.values(cache).filter(j => j && !j.notFound && j.title);
}

module.exports = { refreshJobs, loadCache, getValidJobs };
