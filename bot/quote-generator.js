'use strict';

/**
 * quote-generator.js — professional PDF quotes using Puppeteer + HTML.
 * HTML with dir="rtl" renders Hebrew perfectly — no bidi hacks needed.
 * Puppeteer uses its bundled Chromium; on Render set PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false.
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');
const os        = require('os');

const FONTS_DIR = path.join(__dirname, '..', 'data', 'fonts');
const FONT_PATH = path.join(FONTS_DIR, 'Heebo-Regular.ttf');
const FONT_URL  = 'https://fonts.gstatic.com/s/heebo/v21/NGSpv5_NC0k9P_v6ZUCbLRAHxK1EiSycckOnz02SXQ.ttf';

// ── Font download ─────────────────────────────────────────────────────────────

function downloadFont() {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(FONT_PATH)) { resolve(FONT_PATH); return; }
    fs.mkdirSync(FONTS_DIR, { recursive: true });
    console.log('[Quote] Downloading Heebo font...');
    const file = fs.createWriteStream(FONT_PATH);
    const get = (url) => https.get(url, { headers: { 'User-Agent': 'LifePilot-Bot/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(FONT_PATH); });
    }).on('error', (e) => { fs.unlink(FONT_PATH, () => {}); reject(e); });
    get(FONT_URL);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toLocaleDateString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

function quoteNumber() {
  const d = new Date();
  return `DW-${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}-${Math.floor(Math.random()*900)+100}`;
}

function fmtNum(n) {
  return n.toLocaleString('he-IL', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── HTML template ─────────────────────────────────────────────────────────────

function buildHtml(opts, fontBase64) {
  const { clientName, projectDescription, items, currency, notes } = opts;
  const sym      = currency === 'USD' ? '$' : '₪';
  const vatRate  = 0.18;
  const qNum     = quoteNumber();
  const dateStr  = todayStr();
  const subtotal = items.reduce((s, i) => s + (parseFloat(i.price) || 0), 0);
  const vat      = subtotal * vatRate;
  const total    = subtotal + vat;

  const itemRows = items.map((it, i) => {
    const amt = parseFloat(it.price) || 0;
    const bg  = i % 2 === 0 ? '#ffffff' : '#f8faff';
    return `
      <tr style="background:${bg}">
        <td class="desc">${esc(it.description)}</td>
        <td class="price">${sym}${fmtNum(amt)}</td>
      </tr>`;
  }).join('');

  const projectRow = projectDescription
    ? `<div class="client-row"><span class="label">פרויקט:</span> <span>${esc(projectDescription)}</span></div>`
    : '';

  const notesSection = notes
    ? `<div class="notes"><span class="label">הערות:</span> ${esc(notes)}</div>`
    : '';

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="UTF-8">
<style>
  @font-face {
    font-family: 'Heebo';
    src: url('data:font/ttf;base64,${fontBase64}') format('truetype');
    font-weight: normal;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Heebo', Arial, sans-serif;
    direction: rtl;
    color: #111827;
    font-size: 13px;
    background: white;
  }

  /* ── Header ── */
  .header {
    background: linear-gradient(135deg, #1a56db, #1e40af);
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    color: white;
    padding: 24px 36px;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }
  .company-name { font-size: 30px; font-weight: bold; margin-bottom: 5px; letter-spacing: -0.5px; }
  .company-sub  { font-size: 11px; color: #bfdbfe; }
  .header-divider {
    border: none;
    border-top: 1px solid rgba(255,255,255,0.25);
    margin: 0 36px;
  }
  .quote-meta   { text-align: left; font-size: 11px; line-height: 2; color: #dbeafe; }
  .quote-title  { font-size: 17px; font-weight: bold; margin-top: 8px; color: white; }

  /* ── Client box ── */
  .client-box {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-right: 4px solid #1a56db;
    margin: 20px 36px;
    padding: 14px 18px;
    border-radius: 6px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.06);
  }
  .client-row { margin-bottom: 5px; color: #111827; }
  .label { font-weight: 600; color: #374151; margin-left: 8px; }

  /* ── Items table ── */
  .table-wrap { margin: 0 36px; }
  table { width: 100%; border-collapse: collapse; border-radius: 6px; overflow: hidden; }
  thead tr { background: linear-gradient(135deg, #1a56db, #1e40af); color: white; }
  thead th { padding: 11px 14px; text-align: right; font-size: 12px; font-weight: 600; }
  tbody td { padding: 10px 14px; border-bottom: 1px solid #e5e7eb; color: #111827; }
  .desc  { text-align: right; width: 70%; }
  .price { text-align: right; width: 30%; font-weight: 700; }
  tbody tr:last-child td { border-bottom: none; }

  /* ── Totals ── */
  .totals {
    margin: 20px 36px 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
  }
  .total-sub-wrap {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 10px 18px;
    margin-bottom: 10px;
    min-width: 240px;
  }
  .total-row {
    display: flex;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 5px;
    font-size: 13px;
  }
  .total-row:last-child { margin-bottom: 0; }
  .total-row .tl { font-weight: 600; color: #374151; }
  .total-row .tv { font-weight: 700; color: #111827; }
  .total-grand {
    background: linear-gradient(135deg, #059669, #047857);
    box-shadow: 0 4px 8px rgba(5,150,105,0.3);
    color: white;
    padding: 14px 24px;
    border-radius: 8px;
    font-size: 18px;
    font-weight: bold;
    display: flex;
    gap: 16px;
    align-items: center;
  }

  /* ── Notes ── */
  .notes {
    margin: 18px 36px;
    font-size: 12px;
    color: #374151;
    background: #fffbeb;
    border: 1px solid #fde68a;
    border-right: 4px solid #f59e0b;
    border-radius: 6px;
    padding: 10px 14px;
  }

  /* ── Footer ── */
  .footer {
    background: linear-gradient(135deg, #1a56db, #1e40af);
    color: white;
    padding: 11px 36px;
    text-align: center;
    font-size: 10px;
    position: fixed;
    bottom: 0;
    left: 0; right: 0;
  }
</style>
</head>
<body>

<div class="header">
  <div>
    <div class="company-name">Digital Web</div>
    <div class="company-sub">פיתוח אתרים ופתרונות דיגיטליים</div>
  </div>
  <div class="quote-meta">
    <div>מספר הצעה: ${esc(qNum)}</div>
    <div>תאריך: ${esc(dateStr)}</div>
    <div class="quote-title">הצעת מחיר</div>
  </div>
</div>
<hr class="header-divider">

<div class="client-box">
  <div class="client-row"><span class="label">לקוח:</span> <span>${esc(clientName)}</span></div>
  <div class="client-row"><span class="label">תאריך:</span> <span>${esc(dateStr)}</span></div>
  ${projectRow}
</div>

<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th class="desc">תיאור</th>
        <th class="price">מחיר</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
    </tbody>
  </table>
</div>

<div class="totals">
  <div class="total-sub-wrap">
    <div class="total-row">
      <span class="tl">סכום לפני מע"מ:</span>
      <span class="tv">${sym}${fmtNum(subtotal)}</span>
    </div>
    <div class="total-row">
      <span class="tl">מע"מ 18%:</span>
      <span class="tv">${sym}${fmtNum(vat)}</span>
    </div>
  </div>
  <div class="total-grand">
    <span>סה"כ לתשלום:</span>
    <span>${sym}${fmtNum(total)}</span>
  </div>
</div>

${notesSection}

<div class="footer">
  תוקף ההצעה: 30 ימים מתאריך הנפקה &nbsp;|&nbsp; Digital Web &nbsp;|&nbsp; שילה אלקובי
</div>

</body>
</html>`;
}

// ── PDF generation ────────────────────────────────────────────────────────────

/**
 * @param {Object} opts
 * @param {string} opts.clientName
 * @param {string} [opts.projectDescription]
 * @param {Array<{description:string, price:number}>} opts.items
 * @param {string} [opts.currency]   ILS or USD
 * @param {string} [opts.notes]
 * @returns {Promise<string>} absolute path to generated PDF
 */
async function generateQuote(opts) {
  const {
    clientName       = '',
    projectDescription = '',
    items            = [],
    currency         = 'ILS',
    notes            = '',
  } = opts;

  await downloadFont();
  const fontBase64 = fs.readFileSync(FONT_PATH).toString('base64');
  const html       = buildHtml({ clientName, projectDescription, items, currency, notes }, fontBase64);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format:          'A4',
      printBackground: true,
      margin:          { top: '0', right: '0', bottom: '40px', left: '0' },
    });

    const outPath = path.join(os.tmpdir(), `quote-${Date.now()}.pdf`);
    fs.writeFileSync(outPath, pdfBuffer);
    return outPath;
  } finally {
    await browser.close();
  }
}

module.exports = { generateQuote };
