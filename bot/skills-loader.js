'use strict';

/**
 * Skills Loader
 * Scans the skills/ directory for subdirectories, each containing:
 *   SKILL.md  — human-readable description
 *   index.js  — exports { name, description, tools: [...], execute(toolName, args, ctx) }
 *
 * Returns a combined list of loaded skill modules.
 * Safe to call when skills/ doesn't exist or is empty — returns [].
 */

const fs   = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');

/**
 * Load all skills from the skills/ directory.
 * @returns {Array<{ name, description, tools, execute }>}
 */
function loadSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];

  let entries;
  try {
    entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const loaded = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir  = path.join(SKILLS_DIR, entry.name);
    const indexPath = path.join(skillDir, 'index.js');

    if (!fs.existsSync(indexPath)) {
      console.warn(`[Skills] Skipping "${entry.name}" — missing index.js`);
      continue;
    }

    try {
      const skill = require(indexPath);

      // Validate required exports
      if (typeof skill.name !== 'string' || !skill.name) {
        console.warn(`[Skills] Skipping "${entry.name}" — index.js must export a "name" string`);
        continue;
      }
      if (!Array.isArray(skill.tools)) {
        console.warn(`[Skills] Skipping "${entry.name}" — index.js must export a "tools" array`);
        continue;
      }
      if (typeof skill.execute !== 'function') {
        console.warn(`[Skills] Skipping "${entry.name}" — index.js must export an "execute" function`);
        continue;
      }

      loaded.push(skill);
      console.log(`[Skills] Loaded skill: "${skill.name}" (${skill.tools.length} tool(s))`);
    } catch (err) {
      console.error(`[Skills] Failed to load "${entry.name}": ${err.message}`);
    }
  }

  console.log(`[Skills] ${loaded.length} skill(s) loaded from ${SKILLS_DIR}`);
  return loaded;
}

/**
 * Get the flat list of all tool declarations from loaded skills.
 * @param {Array} skills - result of loadSkills()
 * @returns {Array} OpenAI-format tool declarations
 */
function getSkillToolDeclarations(skills) {
  return skills.flatMap((skill) =>
    skill.tools.map((t) => ({
      type: 'function',
      function: {
        name:        t.name,
        description: t.description,
        parameters:  t.parameters || { type: 'object', properties: {}, required: [] },
      },
    }))
  );
}

/**
 * Given a tool name, find which skill handles it.
 * @param {string} toolName
 * @param {Array} skills
 * @returns {{ skill, toolDef } | null}
 */
function findSkillForTool(toolName, skills) {
  for (const skill of skills) {
    const toolDef = skill.tools.find((t) => t.name === toolName);
    if (toolDef) return { skill, toolDef };
  }
  return null;
}

module.exports = { loadSkills, getSkillToolDeclarations, findSkillForTool };
