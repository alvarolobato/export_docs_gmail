#!/usr/bin/env node

const { google } = require('googleapis');
const fs = require('fs');
const config = require('./load-config');

const DOC_ID = process.argv[2] || config.documentId;

async function listTabs() {
  try {
    // Auth
    const credentials = JSON.parse(fs.readFileSync(config.getCredentialsPath()));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    auth.setCredentials(JSON.parse(fs.readFileSync(config.getTokenPath())));
    
    const docs = google.docs({ version: 'v1', auth });
    
    console.log('📄 Fetching document tabs...\n');
    
    const doc = await docs.documents.get({ 
      documentId: DOC_ID,
      includeTabsContent: false,
      fields: 'tabs(tabProperties)'
    });
    
    if (!doc.data.tabs || doc.data.tabs.length === 0) {
      console.log('No tabs found in this document.');
      return;
    }
    
    console.log(`Found ${doc.data.tabs.length} tabs:\n`);
    
    doc.data.tabs.forEach((tab, index) => {
      const title = tab.tabProperties?.title || 'Untitled';
      const tabId = tab.tabProperties?.tabId || 'unknown';
      console.log(`${index + 1}. "${title}"`);
      console.log(`   Tab ID: ${tabId}`);
      console.log(`   Export: node export.js ${DOC_ID} ${tabId}\n`);
    });
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

listTabs();
