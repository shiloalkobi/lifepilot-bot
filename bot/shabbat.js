'use strict';

const https = require('https');

// Rishon LeZion coordinates
const LAT = 31.9730;
const LNG = 34.7925;

async function getShabbatTimes() {
  return new Promise((resolve, reject) => {
    const url = `https://www.hebcal.com/shabbat?cfg=json&latitude=${LAT}&longitude=${LNG}&tzid=Asia/Jerusalem&m=50`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const items = json.items || [];
          const candles  = items.find(i => i.category === 'candles');
          const havdalah = items.find(i => i.category === 'havdalah');
          const parasha  = items.find(i => i.category === 'parashat');
          resolve({
            candleTime:   candles  ? new Date(candles.date)   : null,
            havdalahTime: havdalah ? new Date(havdalah.date)  : null,
            parashaName:  parasha  ? parasha.title            : null,
            parashaHeb:   parasha  ? (parasha.titleMorfix || parasha.title) : null,
          });
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function isShabbat() {
  const now  = new Date();
  const day  = now.toLocaleDateString('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'long' });
  const hour = parseInt(now.toLocaleTimeString('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false }));
  // Friday after ~17:00 or all day Saturday until ~21:00
  if (day === 'Friday'   && hour >= 17) return true;
  if (day === 'Saturday' && hour <  21) return true;
  return false;
}

// More precise: check against actual candle/havdalah times
let _shabbatWindow = null; // { start: Date, end: Date }

function setShabbatWindow(start, end) {
  _shabbatWindow = { start, end };
}

function isShabbatPrecise() {
  if (!_shabbatWindow) return isShabbat(); // fallback
  const now = new Date();
  return now >= _shabbatWindow.start && now <= _shabbatWindow.end;
}

module.exports = { getShabbatTimes, isShabbat, isShabbatPrecise, setShabbatWindow };
