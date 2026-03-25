'use strict';

const fs   = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, '..', 'data', 'agent-memory.json');

const DEFAULT_MEMORY = {
  preferences: {
    language: 'he',
    responseLength: 'short',
    activeHoursStart: '08:00',
    activeHoursEnd: '22:00',
  },
  patterns: {
    averagePainLevel: null,
    mostProductiveDays: [],
    lastActiveDate: null,
  },
  context: {
    currentProjects: [],
    recentTopics: [],
    lastConversationSummary: null,
  },
  proactiveSent: {},
  learnedFacts: [],
};

function loadMemory(chatId) {
  try {
    const all = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    return all[String(chatId)] || { ...DEFAULT_MEMORY };
  } catch {
    return { ...DEFAULT_MEMORY };
  }
}

function saveMemory(chatId, memory) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); } catch {}
  all[String(chatId)] = { ...memory, lastUpdated: new Date().toISOString() };
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(all, null, 2), 'utf8');
}

function formatMemoryBlock(memory) {
  const lines = [];
  if (memory.patterns?.averagePainLevel)   lines.push(`ממוצע כאב 7 ימים: ${memory.patterns.averagePainLevel}/10`);
  if (memory.patterns?.mostProductiveDays?.length) lines.push(`ימים פרודוקטיביים: ${memory.patterns.mostProductiveDays.join(', ')}`);
  if (memory.context?.lastConversationSummary)     lines.push(`שיחה אחרונה: ${memory.context.lastConversationSummary}`);
  const facts = (memory.learnedFacts || []).filter(f => f.confidence > 0.6).map(f => `• ${f.fact}`).join('\n');
  if (!lines.length && !facts) return '[עדיין לא למדתי דפוסים — שיחות ראשוניות]';
  return (lines.length ? lines.join('\n') : '') + (facts ? '\n' + facts : '');
}

module.exports = { loadMemory, saveMemory, formatMemoryBlock };
