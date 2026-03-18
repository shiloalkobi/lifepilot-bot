const fs = require('fs');
const path = require('path');

function loadSystemPrompt() {
  const claudeMdPath = path.join(__dirname, '..', 'CLAUDE.md');
  try {
    return fs.readFileSync(claudeMdPath, 'utf8');
  } catch (err) {
    console.error('Warning: Could not read CLAUDE.md, using default prompt.', err.message);
    return 'You are LifePilot, a personal assistant for Shilo Alkobi. Be direct, practical, and helpful.';
  }
}

module.exports = { loadSystemPrompt };
