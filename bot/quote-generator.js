'use strict';

/**
 * quote-generator.js — professional PDF quotes using pdfmake.
 * pdfmake has native RTL support → no Hebrew spacing issues.
 * No Chromium required — works on Render free tier.
 */

const PdfPrinter = require('pdfmake/src/printer');
const fs         = require('fs');
const path       = require('path');
const https      = require('https');
const os         = require('os');

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

// ── Colors ────────────────────────────────────────────────────────────────────

const BLUE   = '#1a56db';
const GREEN  = '#059669';
const LGRAY  = '#f3f4f6';
const DGRAY  = '#6b7280';
const DARK   = '#111827';
const BORDER = '#d1d5db';
const WHITE  = 'white';

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

  await downloadFont();

  const fonts = {
    Heebo: { normal: FONT_PATH, bold: FONT_PATH, italics: FONT_PATH, bolditalics: FONT_PATH },
  };
  const printer = new PdfPrinter(fonts);

  const sym      = currency === 'USD' ? '$' : '₪';
  const vatRate  = 0.18;
  const qNum     = quoteNumber();
  const dateStr  = todayStr();
  const subtotal = items.reduce((s, i) => s + (parseFloat(i.price) || 0), 0);
  const vat      = subtotal * vatRate;
  const total    = subtotal + vat;

  // ── Client info rows (LTR columns, RTL text inside) ──────────────────────
  // Without rtl:true, columns are left→right. We put labels on right, values on left
  // so the visual reads naturally for Hebrew: [value] [label]
  const clientRows = [
    [
      { text: dateStr,    alignment: 'right', bold: true, color: DARK },
      { text: 'תאריך:',  alignment: 'right', color: DGRAY },
      { text: clientName, alignment: 'right', bold: true, color: DARK },
      { text: 'לקוח:',   alignment: 'right', color: DGRAY },
    ],
  ];
  if (projectDescription) {
    clientRows.push([
      { text: projectDescription, alignment: 'right', bold: true, color: DARK, colSpan: 3 },
      {},
      {},
      { text: 'פרויקט:', alignment: 'right', color: DGRAY },
    ]);
  }

  // ── Items table body ──────────────────────────────────────────────────────
  const tableBody = [
    // Header row
    [
      { text: 'תיאור',  alignment: 'right', color: WHITE, bold: true, margin: [8, 6, 8, 6] },
      { text: 'מחיר',   alignment: 'right', color: WHITE, bold: true, margin: [8, 6, 8, 6] },
    ],
  ];
  items.forEach((it, i) => {
    const amt = parseFloat(it.price) || 0;
    const bg  = i % 2 === 0 ? WHITE : LGRAY;
    tableBody.push([
      { text: it.description || '', alignment: 'right', color: DARK, fillColor: bg, margin: [8, 5, 8, 5] },
      { text: `${sym}${fmtNum(amt)}`,  alignment: 'right', color: DARK, fillColor: bg, margin: [8, 5, 8, 5] },
    ]);
  });

  // ── Document definition ───────────────────────────────────────────────────
  const docDef = {
    pageSize:    'A4',
    pageMargins: [40, 40, 40, 60],
    defaultStyle: {
      font:      'Heebo',
      fontSize:  11,
      color:     DARK,
      // No rtl:true — it causes character reordering/joining bugs in pdfmake.
      // Use alignment:'right' per element instead.
    },

    content: [
      // ── HEADER ──────────────────────────────────────────────────────────
      {
        table: {
          widths: ['*', '*'],
          body: [[
            {
              stack: [
                { text: 'Digital Web', fontSize: 22, bold: true, color: WHITE },
                { text: 'פיתוח אתרים ופתרונות דיגיטליים', fontSize: 10, color: '#c7d7f8', margin: [0, 4, 0, 0] },
              ],
              alignment: 'left',
              margin: [12, 14, 12, 14],
            },
            {
              stack: [
                { text: `מספר הצעה: ${qNum}`, alignment: 'right', color: WHITE, fontSize: 10 },
                { text: `תאריך: ${dateStr}`,   alignment: 'right', color: WHITE, fontSize: 10, margin: [0, 4, 0, 0] },
                { text: 'הצעת מחיר',           alignment: 'right', color: WHITE, bold: true, fontSize: 13, margin: [0, 6, 0, 0] },
              ],
              alignment: 'right',
              margin: [12, 10, 12, 10],
            },
          ]],
        },
        layout: {
          fillColor: () => BLUE,
          hLineWidth: () => 0,
          vLineWidth: () => 0,
          paddingLeft: () => 0,
          paddingRight: () => 0,
          paddingTop: () => 0,
          paddingBottom: () => 0,
        },
        margin: [0, 0, 0, 16],
      },

      // ── CLIENT INFO BOX ──────────────────────────────────────────────────
      {
        table: {
          widths: ['*', 60, '*', 60],
          body: clientRows,
        },
        layout: {
          fillColor:   () => LGRAY,
          hLineColor:  () => BORDER,
          vLineColor:  () => BORDER,
          hLineWidth:  (i, node) => (i === 0 || i === node.table.body.length) ? 1 : 0,
          vLineWidth:  (i, node) => (i === 0 || i === node.table.widths.length) ? 1 : 0,
          paddingLeft:   () => 10,
          paddingRight:  () => 10,
          paddingTop:    () => 8,
          paddingBottom: () => 8,
        },
        margin: [0, 0, 0, 16],
      },

      // ── ITEMS TABLE ───────────────────────────────────────────────────────
      {
        table: {
          widths: ['*', 110],
          headerRows: 1,
          body: tableBody,
        },
        layout: {
          fillColor: (rowIndex) => rowIndex === 0 ? BLUE : null,
          hLineColor: () => BORDER,
          vLineColor: () => BORDER,
          hLineWidth:  () => 0.5,
          vLineWidth:  () => 0.5,
          paddingLeft:   () => 0,
          paddingRight:  () => 0,
          paddingTop:    () => 0,
          paddingBottom: () => 0,
        },
        margin: [0, 0, 0, 16],
      },

      // ── TOTALS ────────────────────────────────────────────────────────────
      {
        table: {
          widths: ['*', 'auto'],
          body: [
            [
              { text: '',                                                  border: [false,false,false,false] },
              { text: `סכום לפני מע"מ: ${sym}${fmtNum(subtotal)}`,        alignment: 'right', border: [false,false,false,false], margin: [0, 2] },
            ],
            [
              { text: '',                                                  border: [false,false,false,false] },
              { text: `מע"מ 18%: ${sym}${fmtNum(vat)}`,                  alignment: 'right', border: [false,false,false,false], margin: [0, 2] },
            ],
            [
              { text: '', border: [false,false,false,false] },
              {
                text:        `סה"כ לתשלום: ${sym}${fmtNum(total)}`,
                alignment:   'center',
                bold:        true,
                fontSize:    13,
                color:       WHITE,
                fillColor:   GREEN,
                border:      [false,false,false,false],
                margin:      [16, 8, 16, 8],
              },
            ],
          ],
        },
        layout: 'noBorders',
        margin: [0, 0, 0, notes ? 16 : 0],
      },

      // ── NOTES ─────────────────────────────────────────────────────────────
      ...(notes ? [
        {
          canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: BORDER }],
          margin: [0, 0, 0, 8],
        },
        {
          columns: [
            { text: notes,      alignment: 'right', color: DARK, width: '*' },
            { text: 'הערות:',  alignment: 'right', color: DGRAY, width: 50 },
          ],
        },
      ] : []),
    ],

    // ── FOOTER ──────────────────────────────────────────────────────────────
    footer: (currentPage, pageCount) => ({
      stack: [
        { canvas: [{ type: 'line', x1: 40, y1: 0, x2: 555, y2: 0, lineWidth: 0.5, lineColor: BORDER }] },
        {
          text: 'תוקף ההצעה: 30 ימים מתאריך הנפקה  |  Digital Web  |  שילה אלקובי',
          alignment: 'center',
          color: DGRAY,
          fontSize: 9,
          margin: [40, 6, 40, 0],
        },
      ],
    }),

    styles: {},
  };

  // ── Write PDF ─────────────────────────────────────────────────────────────
  const outPath = path.join(os.tmpdir(), `quote-${Date.now()}.pdf`);
  const pdfDoc  = printer.createPdfKitDocument(docDef);
  const stream  = fs.createWriteStream(outPath);
  pdfDoc.pipe(stream);
  pdfDoc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(outPath));
    stream.on('error', reject);
  });
}

module.exports = { generateQuote };
