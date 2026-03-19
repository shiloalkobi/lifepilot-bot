'use strict';

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const CREDENTIALS_PATH = path.join(__dirname, '..', 'google_credentials.json');
const TOKEN_PATH       = path.join(__dirname, '..', 'google_token.json');

function getAuthClient() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));

  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  const token = process.env.GOOGLE_TOKEN_JSON
    ? JSON.parse(process.env.GOOGLE_TOKEN_JSON)
    : JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));

  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

// ── Calendar ──────────────────────────────────────────────────────────────────
async function getCalendarEvents(days = 1) {
  const auth     = getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const now   = new Date();
  const end   = new Date();
  end.setDate(end.getDate() + days);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 10,
  });

  const events = res.data.items || [];
  if (events.length === 0) return 'אין אירועים בתקופה זו.';

  return events.map((e) => {
    const start = e.start.dateTime
      ? new Date(e.start.dateTime).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', weekday: 'long', day: 'numeric', month: 'numeric' })
      : e.start.date;
    return `📅 ${start} — ${e.summary || 'ללא כותרת'}`;
  }).join('\n');
}

async function createCalendarEvent(summary, startDateTime, endDateTime) {
  const auth     = getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });

  await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary,
      start: { dateTime: startDateTime, timeZone: 'Asia/Jerusalem' },
      end:   { dateTime: endDateTime,   timeZone: 'Asia/Jerusalem' },
    },
  });

  return `✅ אירוע נוצר: "${summary}"`;
}

// ── Gmail ─────────────────────────────────────────────────────────────────────
async function getUnreadEmails(maxResults = 5) {
  const auth  = getAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread is:inbox',
    maxResults,
  });

  const messages = res.data.messages || [];
  if (messages.length === 0) return 'אין מיילים שלא נקראו.';

  const details = await Promise.all(
    messages.map((m) =>
      gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] })
    )
  );

  return details.map((d) => {
    const headers = d.data.payload.headers;
    const from    = headers.find((h) => h.name === 'From')?.value    || 'לא ידוע';
    const subject = headers.find((h) => h.name === 'Subject')?.value || 'ללא נושא';
    return `📧 מ: ${from.replace(/<.*>/, '').trim()}\n   נושא: ${subject}`;
  }).join('\n\n');
}

module.exports = { getCalendarEvents, createCalendarEvent, getUnreadEmails };
