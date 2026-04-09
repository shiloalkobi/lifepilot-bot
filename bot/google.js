'use strict';

const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

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

async function findEventsByQuery(query, days = 30) {
  const auth     = getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const now = new Date();
  const end = new Date();
  end.setDate(end.getDate() + days);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 20,
  });

  // Hebrew-friendly search: match if event summary contains any significant word from query
  const noTitleKeywords = ['ללא כותרת', 'ללא שם', 'no title', 'untitled', 'without title', 'ללא'];
  const isSearchingNoTitle = noTitleKeywords.some((k) => query.toLowerCase().includes(k.toLowerCase()));

  const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1)
    .map((w) => w.replace(/^[הוכבלמש]/, '')); // strip common Hebrew prefixes

  const events = (res.data.items || []).filter((e) => {
    const summary = (e.summary || '').toLowerCase();
    if (isSearchingNoTitle && !e.summary) return true;
    return queryWords.some((w) => summary.includes(w));
  });

  if (events.length === 0) return JSON.stringify({ found: false, message: `לא נמצא אירוע עם השם "${query}"` });

  return JSON.stringify({
    found: true,
    events: events.map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start.dateTime || e.start.date,
      end: e.end.dateTime || e.end.date,
    })),
  });
}

async function updateCalendarEvent(eventId, updates) {
  const auth     = getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const body = {};
  if (updates.summary)       body.summary = updates.summary;
  if (updates.startDateTime) body.start = { dateTime: updates.startDateTime, timeZone: 'Asia/Jerusalem' };
  if (updates.endDateTime)   body.end   = { dateTime: updates.endDateTime,   timeZone: 'Asia/Jerusalem' };

  const res = await calendar.events.patch({
    calendarId: 'primary',
    eventId,
    requestBody: body,
  });

  return `✅ האירוע עודכן: "${res.data.summary}"`;
}

async function deleteCalendarEvent(eventId) {
  const auth     = getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });

  await calendar.events.delete({ calendarId: 'primary', eventId });
  return '✅ האירוע נמחק.';
}

// ── Gmail ─────────────────────────────────────────────────────────────────────

// Default query excludes promotions, social, and spam
const DEFAULT_GMAIL_FILTER = 'is:unread is:inbox -category:promotions -category:social -category:spam';

async function getUnreadEmails(maxResults = 5, query = '') {
  const auth  = getAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const q = query
    ? `is:unread is:inbox -category:promotions -category:social -category:spam ${query}`
    : DEFAULT_GMAIL_FILTER;

  const res = await gmail.users.messages.list({ userId: 'me', q, maxResults });

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
    const date    = headers.find((h) => h.name === 'Date')?.value    || '';
    const id      = d.data.id;
    return `📧 [${id}] מ: ${from.replace(/<.*>/, '').trim()}\n   נושא: ${subject}\n   תאריך: ${date}`;
  }).join('\n\n');
}

async function searchEmails(query, maxResults = 10) {
  const auth  = getAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const q = query || 'newer_than:7d -category:promotions';

  const res = await gmail.users.messages.list({ userId: 'me', q, maxResults });

  const messages = res.data.messages || [];
  if (messages.length === 0) return 'לא נמצאו מיילים לפי החיפוש.';

  const details = await Promise.all(
    messages.map((m) =>
      gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] })
    )
  );

  return details.map((d) => {
    const headers = d.data.payload.headers;
    const from    = headers.find((h) => h.name === 'From')?.value    || 'לא ידוע';
    const subject = headers.find((h) => h.name === 'Subject')?.value || 'ללא נושא';
    const date    = headers.find((h) => h.name === 'Date')?.value    || '';
    const id      = d.data.id;
    return `📧 [${id}] מ: ${from.replace(/<.*>/, '').trim()}\n   נושא: ${subject}\n   תאריך: ${date}`;
  }).join('\n\n');
}

// Extract plain text from email parts recursively
function extractTextFromParts(parts = []) {
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64').toString('utf8');
    }
    if (part.parts) {
      const found = extractTextFromParts(part.parts);
      if (found) return found;
    }
  }
  // Fallback: try text/html
  for (const part of parts) {
    if (part.mimeType === 'text/html' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64').toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  return null;
}

async function getEmailBody(emailId) {
  const auth  = getAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.get({ userId: 'me', id: emailId, format: 'full' });
  const msg = res.data;

  const headers = msg.payload.headers || [];
  const from    = headers.find((h) => h.name === 'From')?.value    || 'לא ידוע';
  const subject = headers.find((h) => h.name === 'Subject')?.value || 'ללא נושא';
  const date    = headers.find((h) => h.name === 'Date')?.value    || '';

  let body = null;
  if (msg.payload.body?.data) {
    body = Buffer.from(msg.payload.body.data, 'base64').toString('utf8');
  } else if (msg.payload.parts) {
    body = extractTextFromParts(msg.payload.parts);
  }

  if (!body) return `📧 מ: ${from}\nנושא: ${subject}\nתאריך: ${date}\n\n(לא ניתן לחלץ תוכן)`;

  // Truncate to 3000 chars to avoid LLM overload
  const truncated = body.length > 3000 ? body.slice(0, 3000) + '\n...[קוצר]' : body;
  return `📧 מ: ${from}\nנושא: ${subject}\nתאריך: ${date}\n\n${truncated}`;
}

// Strict: attachment + invoice subject, OR known billing domain (no newsletters)
const INVOICE_QUERY =
  'newer_than:30d (' +
  '(has:attachment (subject:invoice OR subject:receipt ' +
  'OR subject:חשבונית OR subject:קבלה)) ' +
  'OR from:anthropic.com OR from:wolt.com ' +
  'OR from:render.com OR from:paybox.co.il ' +
  'OR from:max.co.il OR from:icount.co.il' +
  ')';

// Extract amount from email body text using common invoice patterns
function extractAmountFromText(text) {
  if (!text) return null;
  const patterns = [
    // Most specific first — full phrases
    /סה[""״]כ לתשלום[\s\u00a0:]+([0-9,]+\.?[0-9]{0,2})/,
    /סה[""״]כ[\s\u00a0:]+([0-9,]+\.?[0-9]{0,2})/,
    /לתשלום[\s\u00a0:]+([0-9,]+\.?[0-9]{0,2})/,
    /סכום[\s\u00a0:]+([0-9,]+\.?[0-9]{0,2})/,
    /total[\s:]*[₪$€]?\s*([0-9,]+\.?[0-9]{0,2})/i,
    /amount[\s:]*[₪$€]?\s*([0-9,]+\.?[0-9]{0,2})/i,
    // Currency suffix
    /([0-9,]+\.?[0-9]{0,2})\s*ש[""״]ח/,
    /([0-9,]+\.?[0-9]{0,2})\s*שקל/,
    /([0-9,]+\.?[0-9]{0,2})\s*(?:ILS|USD|EUR)/,
    // Currency prefix
    /₪\s*([0-9,]+\.?[0-9]{0,2})/,
    /\$([0-9,]+\.?[0-9]{0,2})/,
    /€([0-9,]+\.?[0-9]{0,2})/,
    // Number followed by currency symbol (Wolt: "45.90 ₪")
    /([0-9,]+\.?[0-9]{0,2})\s*[₪]/,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      const raw = (m[1] || m[2] || '').replace(/,/g, '');
      const num = parseFloat(raw);
      if (!isNaN(num) && num > 0 && num < 100000) return num;
    }
  }
  return null;
}

function extractCurrencyFromText(text) {
  if (!text) return 'ILS';
  if (/USD|\$/.test(text)) return 'USD';
  if (/EUR|€/.test(text)) return 'EUR';
  return 'ILS';
}

async function scanEmailsForInvoices(maxResults = 20) {
  const auth  = getAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.list({ userId: 'me', q: INVOICE_QUERY, maxResults });
  const messages = res.data.messages || [];
  if (messages.length === 0) return [];

  const details = await Promise.all(
    messages.map((m) =>
      gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'] })
    )
  );

  // Fetch body for up to 10 emails to extract amounts (cap to avoid quota drain)
  // Fetch full body for up to 10 emails; find PDF attachment IDs alongside
  const bodyFetches = details.slice(0, 10).map(async (d) => {
    try {
      const full = await gmail.users.messages.get({ userId: 'me', id: d.data.id, format: 'full' });
      let body = null;
      let pdfAttachmentId = null;

      if (full.data.payload?.body?.data) {
        body = Buffer.from(full.data.payload.body.data, 'base64').toString('utf8');
      } else if (full.data.payload?.parts) {
        body = extractTextFromParts(full.data.payload.parts);
        // Find first PDF attachment
        const findPdf = (parts) => {
          for (const p of parts || []) {
            if (p.mimeType === 'application/pdf' && p.body?.attachmentId) return p.body.attachmentId;
            const found = findPdf(p.parts);
            if (found) return found;
          }
          return null;
        };
        pdfAttachmentId = findPdf(full.data.payload.parts);
      }
      return { id: d.data.id, body, pdfAttachmentId };
    } catch {
      return { id: d.data.id, body: null, pdfAttachmentId: null };
    }
  });
  const bodies = await Promise.all(bodyFetches);

  // For emails where body had no amount but has PDF — try PDF extraction
  const bodyMap = {};
  for (const b of bodies) {
    let text = b.body;
    const bodyAmount = extractAmountFromText(`${text || ''}`);
    if (!bodyAmount && b.pdfAttachmentId && pdfParse) {
      try {
        const att = await gmail.users.messages.attachments.get(
          { userId: 'me', messageId: b.id, id: b.pdfAttachmentId }
        );
        const pdfBuffer = Buffer.from(att.data.data, 'base64');
        const parsed    = await pdfParse(pdfBuffer);
        text = (text || '') + '\n' + (parsed.text || '');
      } catch (err) {
        console.warn('[Invoice] PDF parse failed:', err.message);
      }
    }
    bodyMap[b.id] = text;
  }

  return details.map((d) => {
    const headers = d.data.payload.headers;
    const from    = headers.find((h) => h.name === 'From')?.value    || '';
    const subject = headers.find((h) => h.name === 'Subject')?.value || '';
    const date    = headers.find((h) => h.name === 'Date')?.value    || '';
    const vendor  = from.replace(/<[^>]+>/, '').trim() || from.split('@')[0];
    const body    = bodyMap[d.data.id] || null;
    if (/wolt/i.test(vendor) || /wolt/i.test(from)) {
      console.log('[Invoice] Wolt body preview:', (body || '(empty)').slice(0, 300));
    }
    const searchText = `${subject} ${body || ''}`;
    const amount   = extractAmountFromText(searchText);
    const currency = amount ? extractCurrencyFromText(searchText) : 'ILS';
    return { emailId: d.data.id, vendor, subject, date, from, amount, currency };
  });
}

module.exports = {
  getCalendarEvents,
  createCalendarEvent,
  findEventsByQuery,
  updateCalendarEvent,
  deleteCalendarEvent,
  getUnreadEmails,
  searchEmails,
  getEmailBody,
  scanEmailsForInvoices,
};
