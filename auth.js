const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { getCredentialsPath, getConfigDirForWriting } = require('./load-config');

// OAuth scopes needed
const SCOPES = [
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/drive.file'
];

async function authenticate() {
  console.log('🔐 Google OAuth Authentication\n');
  
  // Read credentials
  const credentialsPath = getCredentialsPath();
  const credentials = JSON.parse(fs.readFileSync(credentialsPath));
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  
  // Create OAuth2 client
  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );
  
  // Generate auth URL
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  
  console.log('\n🌐 Authorize this app by visiting:\n');
  console.log(authUrl);
  console.log('\n📝 After approving, your browser will try to load http://localhost and show an error — that is expected.');
  console.log('   Copy the full URL from the address bar and paste it below.\n');
  
  // Get code from user
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  let code = await new Promise((resolve) => {
    rl.question('Code: ', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
  
  // Extract code if user pasted full URL
  if (code.includes('code=')) {
    const match = code.match(/code=([^&]+)/);
    if (match) code = match[1];
  }
  
  // Exchange code for tokens
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  
  // Save token to config dir (project config/ or ~/.config/export_docs_gmail)
  const tokenPath = path.join(getConfigDirForWriting(), 'token.json');
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  
  console.log('\n✅ Authentication successful!');
  console.log('📁 Token saved to', tokenPath);
  console.log('\nYou can now run: node export.js');
}

authenticate().catch(err => {
  console.error('\n❌ Authentication error:', err.message);
  process.exit(1);
});
