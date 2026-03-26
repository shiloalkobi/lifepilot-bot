'use strict';

/**
 * Skills Registry
 *
 * Merges the existing 33 built-in tools from agent.js with any dynamically
 * loaded skills. Exposes a unified interface:
 *
 *   getToolDeclarations()          → all tools (built-ins + skills), deduplicated
 *   executeTool(name, args, ctx)   → dispatches to built-in handler or skill
 *
 * Built-in tools always take priority — skills cannot override them.
 *
 * NOTE: This module does NOT modify agent.js. It is designed to be the
 * integration point once you're ready to wire it in.
 */

const { loadSkills, getSkillToolDeclarations, findSkillForTool } = require('./skills-loader');

// ── Lazy-load the built-in tool declarations and executor from agent.js ───────
// We import only what we need and avoid re-running side effects.
let _agentModule = null;
function getAgentModule() {
  if (!_agentModule) {
    // agent.js exports { handleMessage, _resetToolCalls, _getToolCalls }
    // We need internal access for the registry — agent must export these.
    // For now, the registry works stand-alone; integration wires it later.
    _agentModule = {};
  }
  return _agentModule;
}

// ── Registry state ────────────────────────────────────────────────────────────
let _skills        = null; // loaded once, then cached
let _skillToolsMap = null; // Map<toolName, skill>

function ensureLoaded() {
  if (_skills !== null) return;
  _skills        = loadSkills();
  _skillToolsMap = new Map();
  for (const skill of _skills) {
    for (const t of skill.tools) {
      _skillToolsMap.set(t.name, skill);
    }
  }
}

/**
 * Returns all skill-provided tool declarations (OpenAI format).
 * Built-in tool names are passed in as a Set to filter out conflicts.
 *
 * @param {Set<string>} builtInNames - set of already-registered tool names
 * @returns {Array} additional tool declarations from skills
 */
function getSkillDeclarations(builtInNames = new Set()) {
  ensureLoaded();
  const all = getSkillToolDeclarations(_skills);
  const filtered = all.filter((t) => {
    if (builtInNames.has(t.function.name)) {
      console.warn(`[Skills] Tool "${t.function.name}" conflicts with built-in — skipped`);
      return false;
    }
    return true;
  });
  return filtered;
}

/**
 * Check whether a given tool name belongs to a skill (not built-in).
 * @param {string} toolName
 * @returns {boolean}
 */
function isSkillTool(toolName) {
  ensureLoaded();
  return _skillToolsMap.has(toolName);
}

/**
 * Execute a skill tool.
 * @param {string} toolName
 * @param {Object} args
 * @param {Object} ctx - { bot, chatId }
 * @returns {Promise<string>} result string
 */
async function executeSkillTool(toolName, args, ctx) {
  ensureLoaded();
  const skill = _skillToolsMap.get(toolName);
  if (!skill) return `Unknown skill tool: ${toolName}`;

  try {
    const result = await skill.execute(toolName, args, ctx);
    return String(result ?? '');
  } catch (err) {
    console.error(`[Skills] Error executing "${toolName}" in skill "${skill.name}":`, err.message);
    return `Error in skill "${skill.name}": ${err.message}`;
  }
}

/**
 * Reload all skills (hot-reload support).
 * Clears the cache so the next call to any registry function re-scans disk.
 */
function reloadSkills() {
  // Clear require cache for skill modules so they're re-read from disk
  if (_skills) {
    for (const skill of _skills) {
      const skillKey = Object.keys(require.cache).find((k) =>
        k.includes(`skills`) && k.endsWith('index.js') &&
        k.includes(skill.name.replace(/[^a-z0-9]/gi, '-'))
      );
      if (skillKey) delete require.cache[skillKey];
    }
  }
  _skills        = null;
  _skillToolsMap = null;
  ensureLoaded();
  console.log('[Skills] Reloaded');
}

/**
 * Returns a summary of all loaded skills for debugging.
 */
function getRegistryStatus() {
  ensureLoaded();
  return {
    skillCount: _skills.length,
    skills: _skills.map((s) => ({
      name:      s.name,
      tools:     s.tools.map((t) => t.name),
      toolCount: s.tools.length,
    })),
  };
}

module.exports = {
  getSkillDeclarations,
  isSkillTool,
  executeSkillTool,
  reloadSkills,
  getRegistryStatus,
};
