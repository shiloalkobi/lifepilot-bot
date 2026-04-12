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

const FONTS_DIR  = path.join(__dirname, '..', 'data', 'fonts');
const FONT_PATH  = path.join(FONTS_DIR, 'Heebo-Regular.ttf');
const FONT_URL   = 'https://fonts.gstatic.com/s/heebo/v21/NGSpv5_NC0k9P_v6ZUCbLRAHxK1EiSycckOnz02SXQ.ttf';

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

// ── Date helper ───────────────────────────────────────────────────────────────

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

  const fontPath = await downloadFont();
  const outPath  = path.join(os.tmpdir(), `quote-${Date.now()}.pdf`);
  const qNum     = quoteNumber();
  const sym      = currency === 'USD' ? '$' : '₪';
  const vatRate  = 0.17;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, rtl: true });
    const out  = fs.createWriteStream(outPath);
    doc.pipe(out);
    out.on('finish', () => resolve(outPath));
    out.on('error', reject);

    doc.registerFont('Heebo', fontPath);
    doc.font('Heebo');

    // ── Header ──────────────────────────────────────────────────────────────
    doc.fontSize(24).fillColor('#2c3e50').text('Digital Web', { align: 'center' });
    doc.fontSize(12).fillColor('#7f8c8d').text('פיתוח אתרים ופתרונות דיגיטליים', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(18).fillColor('#e74c3c').text('הצעת מחיר', { align: 'center' });

    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#bdc3c7').lineWidth(1).stroke();
    doc.moveDown(0.5);

    // ── Quote info ───────────────────────────────────────────────────────────
    doc.fontSize(11).fillColor('#2c3e50');
    doc.text(`מספר הצעה: ${qNum}`, { align: 'right' });
    doc.text(`תאריך: ${todayStr()}`, { align: 'right' });
    doc.text(`לקוח: ${clientName}`, { align: 'right' });
    if (projectDescription) doc.text(`פרויקט: ${projectDescription}`, { align: 'right' });

    doc.moveDown(1);

    // ── Items table ──────────────────────────────────────────────────────────
    const tableTop = doc.y;
    const colDesc  = 50;
    const colPrice = 420;
    const rowH     = 28;

    // Header row
    doc.rect(colDesc, tableTop, 495, rowH).fill('#2c3e50');
    doc.fillColor('white').fontSize(11);
    doc.text('תיאור', colDesc + 10, tableTop + 8, { width: 350, align: 'right' });
    doc.text('מחיר', colPrice, tableTop + 8, { width: 75, align: 'right' });

    // Item rows
    let y = tableTop + rowH;
    let subtotal = 0;
    for (let i = 0; i < items.length; i++) {
      const it  = items[i];
      const bg  = i % 2 === 0 ? '#f8f9fa' : 'white';
      const amt = parseFloat(it.price) || 0;
      subtotal += amt;

      doc.rect(colDesc, y, 495, rowH).fill(bg);
      doc.fillColor('#2c3e50').fontSize(10);
      doc.text(it.description || '', colDesc + 10, y + 8, { width: 350, align: 'right' });
      doc.text(`${sym}${amt.toLocaleString()}`, colPrice, y + 8, { width: 75, align: 'right' });
      y += rowH;
    }

    // Totals
    const vat   = subtotal * vatRate;
    const total = subtotal + vat;

    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#bdc3c7').lineWidth(1).stroke();
    doc.moveDown(0.3);

    doc.fontSize(11).fillColor('#2c3e50');
    doc.text(`סכום לפני מע"מ: ${sym}${subtotal.toLocaleString('he-IL', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`, { align: 'right' });
    doc.text(`מע"מ 17%: ${sym}${vat.toLocaleString('he-IL', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`, { align: 'right' });

    doc.moveDown(0.2);
    doc.fontSize(14).fillColor('#e74c3c');
    doc.text(`סה"כ לתשלום: ${sym}${total.toLocaleString('he-IL', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`, { align: 'right' });

    // ── Notes ────────────────────────────────────────────────────────────────
    if (notes) {
      doc.moveDown(1);
      doc.fontSize(10).fillColor('#7f8c8d');
      doc.text(`הערות: ${notes}`, { align: 'right' });
    }

    // ── Footer ───────────────────────────────────────────────────────────────
    doc.moveDown(2);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#bdc3c7').lineWidth(0.5).stroke();
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor('#95a5a6');
    doc.text('תוקף ההצעה: 30 ימים מתאריך הנפקה', { align: 'center' });
    doc.text('Digital Web | שילה אלקובי', { align: 'center' });

    doc.end();
  });
}

module.exports = { generateQuote };
