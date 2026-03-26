'use strict';

/**
 * Skills Registry
 *
 * Merges the existing built-in tools from agent.js with dynamically loaded
 * skills. Exposes three functions for agent.js integration:
 *
 *   initRegistry(toolDeclarations, executeToolFn)
 *     — call once after agent.js builds TOOL_DECLARATIONS and executeTool
 *
 *   getAllToolDeclarations()
 *     — returns full OpenAI-format tool list (built-ins + skill tools)
 *     — replace every use of the TOOLS constant in callLLM calls
 *
 *   executeAnyTool(toolName, args, ctx)
 *     — dispatches to a skill if it owns the tool, otherwise to built-in
 *     — replace every call to executeTool() in the ReAct loop
 *
 * Built-in tools always win — skills with conflicting names are silently
 * dropped at init time.
 */

const { loadSkills, getSkillToolDeclarations, findSkillForTool } = require('./skills-loader');

// ── Registry state ─────────────────────────────────────────────────────────────
let _initialized    = false;
let _builtInDecls   = [];          // raw TOOL_DECLARATIONS from agent.js
let _builtInNames   = new Set();   // fast lookup for built-in tool names
let _builtInExec    = null;        // executeTool function from agent.js
let _skills         = [];          // loaded skill modules
let _skillToolsMap  = new Map();   // toolName → skill module
let _skillOpenAI    = [];          // OpenAI-format declarations for skill tools

/**
 * Initialize the registry with the agent's built-in tools and executor.
 * Must be called after both TOOL_DECLARATIONS and executeTool are defined.
 *
 * @param {Array}    toolDeclarations - the TOOL_DECLARATIONS array from agent.js
 * @param {Function} executeToolFn   - the executeTool(name, args, ctx) function
 */
function initRegistry(toolDeclarations, executeToolFn) {
  _builtInDecls  = toolDeclarations;
  _builtInExec   = executeToolFn;
  _builtInNames  = new Set(toolDeclarations.map((t) => t.name));

  // Load skills and filter out any that conflict with built-ins
  _skills = loadSkills();
  _skillToolsMap = new Map();
  const filteredSkillDecls = [];

  for (const skill of _skills) {
    for (const t of skill.tools) {
      if (_builtInNames.has(t.name)) {
        console.warn(`[Skills] Tool "${t.name}" from skill "${skill.name}" conflicts with built-in — skipped`);
        continue;
      }
      if (_skillToolsMap.has(t.name)) {
        console.warn(`[Skills] Tool "${t.name}" already registered by another skill — skipped`);
        continue;
      }
      _skillToolsMap.set(t.name, skill);
      filteredSkillDecls.push(t);
    }
  }

  // Pre-build the OpenAI format for skill tools
  _skillOpenAI = filteredSkillDecls.map((t) => ({
    type: 'function',
    function: {
      name:       t.name,
      description: t.description,
      parameters:  t.parameters || { type: 'object', properties: {}, required: [] },
    },
  }));

  _initialized = true;
  console.log(
    `[Skills] Registry ready: ${_builtInNames.size} built-in tools + ` +
    `${_skillToolsMap.size} skill tools (${_skills.length} skill(s))`
  );
}

/**
 * Returns all tool declarations in OpenAI format: built-ins first, then skills.
 * Safe to call before initRegistry — returns empty array for skill portion.
 *
 * @returns {Array}
 */
function getAllToolDeclarations() {
  const builtInOpenAI = _builtInDecls.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  return [...builtInOpenAI, ..._skillOpenAI];
}

/**
 * Execute any tool — skill tools handled here, everything else forwarded
 * to the built-in executor.
 *
 * @param {string}   toolName
 * @param {Object}   args
 * @param {Object}   ctx - { bot, chatId }
 * @returns {Promise<string>}
 */
async function executeAnyTool(toolName, args, ctx) {
  // Check skill tools first
  const skill = _skillToolsMap.get(toolName);
  if (skill) {
    try {
      const result = await skill.execute(toolName, args, ctx);
      console.log(`[Skills] "${toolName}" executed by skill "${skill.name}"`);
      return String(result ?? '');
    } catch (err) {
      console.error(`[Skills] Error in "${toolName}" (skill "${skill.name}"):`, err.message);
      return `Error in skill "${skill.name}": ${err.message}`;
    }
  }

  // Fall back to built-in executor
  if (_builtInExec) return _builtInExec(toolName, args, ctx);
  return `Unknown tool: ${toolName}`;
}

// ── Additional utilities (unchanged from previous version) ────────────────────

function reloadSkills() {
  if (_builtInExec) {
    initRegistry(_builtInDecls, _builtInExec);
  } else {
    console.warn('[Skills] reloadSkills called before initRegistry');
  }
}

function getRegistryStatus() {
  return {
    initialized: _initialized,
    builtInCount: _builtInNames.size,
    skillCount:  _skills.length,
    skills: _skills.map((s) => ({
      name:      s.name,
      tools:     s.tools.map((t) => t.name),
      toolCount: s.tools.length,
    })),
  };
}

module.exports = {
  initRegistry,
  getAllToolDeclarations,
  executeAnyTool,
  // Legacy / utility exports kept for completeness
  reloadSkills,
  getRegistryStatus,
};
