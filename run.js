#!/usr/bin/env node

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const config = require('./load-config');

const DOC_ID = process.argv[2] || config.documentId;

async function main() {
  try {
    console.log('📄 Fetching document tabs...\n');
    
    // Auth
    const credentials = JSON.parse(fs.readFileSync(config.getCredentialsPath()));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    auth.setCredentials(JSON.parse(fs.readFileSync(config.getTokenPath())));
    
    const docs = google.docs({ version: 'v1', auth });
    
    // Get tabs
    const doc = await docs.documents.get({ 
      documentId: DOC_ID,
      includeTabsContent: false,
      fields: 'tabs(tabProperties)'
    });
    
    if (!doc.data.tabs || doc.data.tabs.length === 0) {
      console.log('❌ No tabs found in this document.');
      process.exit(1);
    }
    
    const tabs = doc.data.tabs.map(tab => ({
      title: tab.tabProperties?.title || 'Untitled',
      id: tab.tabProperties?.tabId || 'unknown'
    }));
    
    console.log(`Found ${tabs.length} tabs:\n`);
    tabs.forEach((tab, index) => {
      console.log(`${index + 1}. ${tab.title}`);
    });
    
    // Ask for selection
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    
    const answer = await new Promise((resolve) => {
      rl.question('\n📝 Enter tab number to export: ', (ans) => {
        rl.close();
        resolve(ans);
      });
    });
    
    const tabNum = parseInt(answer);
    
    if (isNaN(tabNum) || tabNum < 1 || tabNum > tabs.length) {
      console.log('❌ Invalid tab number');
      process.exit(1);
    }
    
    const selectedTab = tabs[tabNum - 1];
    console.log(`\n✓ Selected: ${selectedTab.title}\n`);
    console.log('🚀 Starting export...\n');
    
    // Run export
    const { stdout, stderr } = await execPromise(`node export.js ${DOC_ID} ${selectedTab.id}`);
    console.log(stdout);
    if (stderr) console.error(stderr);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();
