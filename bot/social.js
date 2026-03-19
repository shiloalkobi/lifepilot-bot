'use strict';

const fs   = require('fs');
const path = require('path');

const DRAFTS_DIR = path.join(__dirname, '..', 'drafts');

function ensureDraftsDir() {
  if (!fs.existsSync(DRAFTS_DIR)) fs.mkdirSync(DRAFTS_DIR, { recursive: true });
}

// Save a social media draft to disk
function saveDraft({ platform, content, hashtags, imagePrompt }) {
  ensureDraftsDir();

  const id        = Date.now().toString();
  const createdAt = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  const draft     = { id, platform, content, hashtags: hashtags || '', imagePrompt: imagePrompt || '', createdAt };

  fs.writeFileSync(path.join(DRAFTS_DIR, `${id}.json`), JSON.stringify(draft, null, 2), 'utf8');
  return `✅ טיוטה נשמרה (ID: ${id}) | ${platform} | ${createdAt}`;
}

// List all saved drafts (summary)
function listDrafts() {
  ensureDraftsDir();

  const files = fs.readdirSync(DRAFTS_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) return 'אין טיוטות שמורות.';

  return files
    .map(f => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, f), 'utf8'));
        const preview = d.content.slice(0, 60).replace(/\n/g, ' ');
        return `• [${d.id}] ${d.platform} | ${d.createdAt}\n  "${preview}${d.content.length > 60 ? '...' : ''}"`;
      } catch { return null; }
    })
    .filter(Boolean)
    .join('\n\n');
}

// Delete a draft by id
function deleteDraft(id) {
  const filePath = path.join(DRAFTS_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return `לא נמצאה טיוטה עם ID: ${id}`;
  fs.unlinkSync(filePath);
  return `🗑️ טיוטה ${id} נמחקה.`;
}

module.exports = { saveDraft, listDrafts, deleteDraft };
