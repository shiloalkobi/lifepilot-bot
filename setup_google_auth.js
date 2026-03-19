'use strict';

// Run this ONCE to authenticate with Google
// Usage: node setup_google_auth.js

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CREDENTIALS_PATH = path.join(__dirname, 'google_credentials.json');
const TOKEN_PATH = path.join(__dirname, 'google_token.json');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.readonly',
];

const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
const { client_secret, client_id, redirect_uris } = credentials.installed;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });

console.log('\n🔗 פתח את הקישור הזה בדפדפן:\n');
console.log(authUrl);
console.log('\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('📋 הדבק כאן את הקוד שקיבלת: ', async (code) => {
  rl.close();
  const { tokens } = await oAuth2Client.getToken(code.trim());
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
  console.log('\n✅ אימות הצליח! google_token.json נשמר.');
  console.log('עכשיו תוכל להריץ את הבוט כרגיל.\n');
});
