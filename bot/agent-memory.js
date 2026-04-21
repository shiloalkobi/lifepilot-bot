'use strict';

const fs   = require('fs');
const path = require('path');
const { supabase, isEnabled } = require('./supabase');

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

// ── JSON fallback ─────────────────────────────────────────────────────────────
function loadAllFromJson() {
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); } catch { return {}; }
}

function saveAllToJson(all) {
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(all, null, 2), 'utf8');
  } catch (e) {
    console.warn('[memory] JSON save failed:', e.message);
  }
}

function memoryId(chatId) {
  return `mem_${chatId}`;
}

// ── Public API ────────────────────────────────────────────────────────────────
async function loadMemory(chatId) {
  if (isEnabled()) {
    const { data, error } = await supabase
      .from('memory')
      .select('*')
      .eq('id', memoryId(chatId))
      .maybeSingle();
    if (!error && data && data.data) return data.data;
    if (error && error.code !== 'PGRST116') {
      console.warn('[Supabase] loadMemory error:', error.message);
    }
  }
  const all = loadAllFromJson();
  return all[String(chatId)] || { ...DEFAULT_MEMORY };
}

async function saveMemory(chatId, memory) {
  const withTs = { ...memory, lastUpdated: new Date().toISOString() };

  if (isEnabled()) {
    const { error } = await supabase.from('memory').upsert({
      id:         memoryId(chatId),
      chat_id:    Number(chatId) || null,
      data:       withTs,
      created_at: withTs.lastUpdated,
      updated_at: withTs.lastUpdated,
    }, { onConflict: 'id' });
    if (error) console.warn('[Supabase] saveMemory error:', error.message);
  }

  const all = loadAllFromJson();
  all[String(chatId)] = withTs;
  saveAllToJson(all);
}

async function addLearnedFact(chatId, fact) {
  const memory = await loadMemory(chatId);
  if (!Array.isArray(memory.learnedFacts)) memory.learnedFacts = [];
  const duplicate = memory.learnedFacts.some(f =>
    f.fact.toLowerCase().includes(fact.toLowerCase().slice(0, 20))
  );
  if (!duplicate) {
    memory.learnedFacts.push({ fact, confidence: 1.0, addedAt: new Date().toISOString() });
    await saveMemory(chatId, memory);
  }
  return memory.learnedFacts;
}

async function removeLearnedFact(chatId, index) {
  const memory = await loadMemory(chatId);
  if (!Array.isArray(memory.learnedFacts)) return false;
  if (index < 0 || index >= memory.learnedFacts.length) return false;
  memory.learnedFacts.splice(index, 1);
  await saveMemory(chatId, memory);
  return true;
}

async function listLearnedFacts(chatId) {
  const memory = await loadMemory(chatId);
  return memory.learnedFacts || [];
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

module.exports = { loadMemory, saveMemory, formatMemoryBlock, addLearnedFact, removeLearnedFact, listLearnedFacts };
