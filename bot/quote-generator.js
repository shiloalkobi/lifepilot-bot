'use strict';

/**
 * quote-generator.js — generates professional PDF quotes for Digital Web clients.
 * Uses PDFKit. Hebrew font (Heebo) is downloaded on first use and cached in data/fonts/.
 */

const PDFDocument = require('pdfkit');
const fs          = require('fs');
const path        = require('path');
const https       = require('https');
const os          = require('os');

const FONTS_DIR   = path.join(__dirname, '..', 'data', 'fonts');
const FONT_PATH   = path.join(FONTS_DIR, 'Heebo-Regular.ttf');
const FONT_BOLD   = path.join(FONTS_DIR, 'Heebo-Bold.ttf');
const FONT_URL      = 'https://fonts.gstatic.com/s/heebo/v21/NGSpv5_NC0k9P_v6ZUCbLRAHxK1EiSycckOnz02SXQ.ttf';
// Bold variant — same CDN pattern (weight 700)
const FONT_BOLD_URL = 'https://fonts.gstatic.com/s/heebo/v21/NGS6v5_NC0k9P_v6ZUCbLRAHxK1ELyfckOnz02SXQ.ttf';

// ── Colors ────────────────────────────────────────────────────────────────────
const C = {
  primary:   '#1a56db',
  secondary: '#f3f4f6',
  text:      '#111827',
  accent:    '#059669',
  white:     '#ffffff',
  gray:      '#6b7280',
  lightGray: '#e5e7eb',
  border:    '#d1d5db',
};

// ── Font download ─────────────────────────────────────────────────────────────

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) { resolve(dest); return; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const get = (u) => https.get(u, { headers: { 'User-Agent': 'LifePilot-Bot/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
    }).on('error', (e) => { fs.unlink(dest, () => {}); reject(e); });
    get(url);
  });
}

async function downloadFonts() {
  await downloadFile(FONT_URL, FONT_PATH);
  // Bold: try CDN, but validate it's a real TTF (>10KB), else use regular
  try {
    await downloadFile(FONT_BOLD_URL, FONT_BOLD);
    const stat = fs.statSync(FONT_BOLD);
    if (stat.size < 10000) { fs.unlinkSync(FONT_BOLD); } // discard invalid
  } catch { /* use regular for bold */ }
}

// ── Date / number helpers ─────────────────────────────────────────────────────

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

function fmt(n, sym) {
  return `${sym}${n.toLocaleString('he-IL', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

// ── Layout constants ──────────────────────────────────────────────────────────

const PAGE_W    = 595.28;  // A4 width in points
const MARGIN    = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;

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
    clientName,
    projectDescription = '',
    items = [],
    currency = 'ILS',
    notes = '',
  } = opts;

  await downloadFonts();

  const boldPath = fs.existsSync(FONT_BOLD) ? FONT_BOLD : FONT_PATH;
  const outPath  = path.join(os.tmpdir(), `quote-${Date.now()}.pdf`);
  const qNum     = quoteNumber();
  const sym      = currency === 'USD' ? '$' : '₪';
  const vatRate  = 0.17;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, rtl: true });
    const out  = fs.createWriteStream(outPath);
    doc.pipe(out);
    out.on('finish', () => resolve(outPath));
    out.on('error', reject);

    doc.registerFont('Heebo', FONT_PATH);
    doc.registerFont('Heebo-Bold', boldPath);

    // ── HEADER BAR (full-width blue) ─────────────────────────────────────────
    const headerH = 90;
    doc.rect(0, 0, PAGE_W, headerH).fill(C.primary);

    // Company name (left side, white)
    doc.font('Heebo-Bold').fontSize(26).fillColor(C.white);
    doc.text('Digital Web', MARGIN, 18, { lineGap: 2 });

    doc.font('Heebo').fontSize(11).fillColor('rgba(255,255,255,0.85)');
    doc.text('פיתוח אתרים ופתרונות דיגיטליים', MARGIN, 50, { lineGap: 2 });

    // Quote number + date (right side, white)
    doc.font('Heebo').fontSize(10).fillColor(C.white);
    doc.text(`מספר הצעה: ${qNum}`, MARGIN, 22, { width: CONTENT_W, align: 'right', lineGap: 2 });
    doc.text(`תאריך: ${todayStr()}`, MARGIN, 40, { width: CONTENT_W, align: 'right', lineGap: 2 });

    // "הצעת מחיר" badge on right
    doc.font('Heebo-Bold').fontSize(13).fillColor(C.white);
    doc.text('הצעת מחיר', MARGIN, 60, { width: CONTENT_W, align: 'right', lineGap: 2 });

    // ── BLUE DIVIDER ─────────────────────────────────────────────────────────
    doc.rect(0, headerH, PAGE_W, 3).fill('#1048c0');

    // ── CLIENT INFO BOX ───────────────────────────────────────────────────────
    let y = headerH + 18;
    const boxH = projectDescription ? 72 : 50;
    doc.rect(MARGIN, y, CONTENT_W, boxH).fill(C.secondary).stroke(C.border);

    doc.font('Heebo-Bold').fontSize(11).fillColor(C.text);
    doc.text(`לקוח: `, MARGIN + 12, y + 10, { continued: false, lineGap: 4 });
    doc.font('Heebo').fontSize(11).fillColor(C.text);
    // Use x,y positioning for precise control
    doc.font('Heebo-Bold').fontSize(11).fillColor(C.text)
       .text(`לקוח:`, MARGIN + 12, y + 10, { lineGap: 4 });
    doc.font('Heebo').fontSize(11).fillColor(C.text)
       .text(clientName, MARGIN + 12, y + 10, { width: CONTENT_W - 24, align: 'right', lineGap: 4 });

    doc.font('Heebo-Bold').fontSize(11).fillColor(C.text)
       .text(`תאריך:`, MARGIN + 12, y + 30, { lineGap: 4 });
    doc.font('Heebo').fontSize(11).fillColor(C.text)
       .text(todayStr(), MARGIN + 12, y + 30, { width: CONTENT_W - 24, align: 'right', lineGap: 4 });

    if (projectDescription) {
      doc.font('Heebo-Bold').fontSize(11).fillColor(C.text)
         .text(`פרויקט:`, MARGIN + 12, y + 50, { lineGap: 4 });
      doc.font('Heebo').fontSize(11).fillColor(C.text)
         .text(projectDescription, MARGIN + 12, y + 50, { width: CONTENT_W - 24, align: 'right', lineGap: 4 });
    }

    y += boxH + 20;

    // ── ITEMS TABLE ───────────────────────────────────────────────────────────
    const COL_DESC_X  = MARGIN;
    const COL_DESC_W  = CONTENT_W - 120;
    const COL_PRICE_X = MARGIN + COL_DESC_W;
    const COL_PRICE_W = 120;
    const ROW_H       = 32;

    // Table header
    doc.rect(COL_DESC_X, y, CONTENT_W, ROW_H).fill(C.primary);
    doc.font('Heebo-Bold').fontSize(11).fillColor(C.white);
    doc.text('תיאור', COL_DESC_X + 10, y + 10, { width: COL_DESC_W - 10, align: 'right', lineGap: 4 });
    doc.text('מחיר', COL_PRICE_X, y + 10, { width: COL_PRICE_W - 10, align: 'right', lineGap: 4 });

    y += ROW_H;

    // Item rows
    let subtotal = 0;
    for (let i = 0; i < items.length; i++) {
      const it  = items[i];
      const amt = parseFloat(it.price) || 0;
      subtotal += amt;

      const bg = i % 2 === 0 ? C.white : C.secondary;
      doc.rect(COL_DESC_X, y, CONTENT_W, ROW_H).fill(bg);

      // Bottom border per row
      doc.moveTo(COL_DESC_X, y + ROW_H)
         .lineTo(COL_DESC_X + CONTENT_W, y + ROW_H)
         .strokeColor(C.lightGray).lineWidth(0.5).stroke();

      // Vertical separator
      doc.moveTo(COL_PRICE_X, y)
         .lineTo(COL_PRICE_X, y + ROW_H)
         .strokeColor(C.lightGray).lineWidth(0.5).stroke();

      doc.font('Heebo').fontSize(10).fillColor(C.text);
      doc.text(it.description || '', COL_DESC_X + 10, y + 10,
               { width: COL_DESC_W - 20, align: 'right', lineGap: 4 });
      doc.text(fmt(amt, sym), COL_PRICE_X, y + 10,
               { width: COL_PRICE_W - 10, align: 'right', lineGap: 4 });

      y += ROW_H;
    }

    // Table outer border
    doc.rect(COL_DESC_X, y - (items.length * ROW_H) - ROW_H, CONTENT_W, (items.length + 1) * ROW_H)
       .strokeColor(C.border).lineWidth(1).stroke();

    y += 16;

    // ── TOTALS ────────────────────────────────────────────────────────────────
    const vat   = subtotal * vatRate;
    const total = subtotal + vat;

    const TOTAL_X = COL_PRICE_X - 60;
    const TOTAL_W = COL_PRICE_W + 60;

    doc.font('Heebo').fontSize(11).fillColor(C.text);
    doc.text(`סכום לפני מע"מ:`, TOTAL_X, y, { width: TOTAL_W, align: 'right', lineGap: 4 });
    y += 18;
    doc.text(fmt(subtotal, sym), TOTAL_X, y - 18,
             { width: TOTAL_W - 120, align: 'right', lineGap: 4 });

    doc.text(`מע"מ 17%:`, TOTAL_X, y, { width: TOTAL_W, align: 'right', lineGap: 4 });
    doc.text(fmt(vat, sym), TOTAL_X, y,
             { width: TOTAL_W - 120, align: 'right', lineGap: 4 });
    y += 22;

    // Green total box
    const totalBoxH = 36;
    doc.rect(TOTAL_X - 10, y, TOTAL_W + 10, totalBoxH).fill(C.accent);
    doc.font('Heebo-Bold').fontSize(13).fillColor(C.white);
    doc.text(`סה"כ לתשלום: ${fmt(total, sym)}`, TOTAL_X - 10, y + 10,
             { width: TOTAL_W + 10, align: 'center', lineGap: 4 });

    y += totalBoxH + 20;

    // ── NOTES ─────────────────────────────────────────────────────────────────
    if (notes) {
      doc.rect(MARGIN, y, CONTENT_W, 1).fill(C.lightGray);
      y += 10;
      doc.font('Heebo-Bold').fontSize(10).fillColor(C.gray);
      doc.text('הערות:', MARGIN, y, { lineGap: 4 });
      y += 16;
      doc.font('Heebo').fontSize(10).fillColor(C.text);
      doc.text(notes, MARGIN, y, { width: CONTENT_W, align: 'right', lineGap: 4 });
      y += 30;
    }

    // ── FOOTER ────────────────────────────────────────────────────────────────
    const footerY = 780;
    doc.rect(0, footerY - 5, PAGE_W, 1).fill(C.lightGray);
    doc.rect(0, footerY + 20, PAGE_W, 40).fill(C.secondary);

    doc.font('Heebo').fontSize(9).fillColor(C.gray);
    doc.text('תוקף ההצעה: 30 ימים מתאריך הנפקה  |  Digital Web  |  שילה אלקובי',
             MARGIN, footerY + 28, { width: CONTENT_W, align: 'center', lineGap: 4 });

    doc.end();
  });
}

module.exports = { generateQuote };
