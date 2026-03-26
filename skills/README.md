# LifePilot Skills

Each skill is a self-contained directory that adds new tools to the agent
**without touching** `bot/agent.js` or any other core file.

---

## Directory structure

```
skills/
  README.md              ← you are here
  hello-world/           ← example skill
    SKILL.md             ← human description (not read by code)
    index.js             ← the skill implementation
  my-new-skill/
    SKILL.md
    index.js
```

---

## How the loader works

`bot/skills-loader.js` scans `skills/` at startup:

1. Finds every subdirectory
2. Requires `<dir>/index.js`
3. Validates it exports `{ name, description, tools, execute }`
4. Registers its tools — built-in tools always win on name conflicts

`bot/skills-registry.js` provides the unified interface used by the agent:

| Function | Purpose |
|----------|---------|
| `getSkillDeclarations(builtInNames)` | Returns skill tool declarations, filtered for conflicts |
| `isSkillTool(toolName)` | Checks if a name belongs to a skill |
| `executeSkillTool(toolName, args, ctx)` | Runs the skill handler |
| `reloadSkills()` | Hot-reloads all skills without restarting |
| `getRegistryStatus()` | Returns loaded skill count and tool list |

---

## Creating a new skill

### 1. Create the directory

```bash
mkdir skills/my-skill
```

### 2. Create `skills/my-skill/index.js`

```js
'use strict';

const name        = 'my-skill';
const description = 'One-line description of what this skill does.';

const tools = [
  {
    name:        'my_tool',          // snake_case, must be unique across ALL tools
    description: 'What this tool does — this is shown to the LLM, be precise.',
    parameters: {
      type:       'object',
      properties: {
        input: {
          type:        'string',
          description: 'The input to process',
        },
        // add more parameters as needed
      },
      required: ['input'],            // list required parameter names
    },
  },
  // Add more tools in the same array if this skill needs them
];

async function execute(toolName, args, ctx) {
  // ctx = { bot, chatId }
  if (toolName === 'my_tool') {
    // Do your work here
    return `Result: ${args.input}`;
  }
  return `Unknown tool "${toolName}" in skill "${name}"`;
}

module.exports = { name, description, tools, execute };
```

### 3. Create `skills/my-skill/SKILL.md`

Document what the skill does, what tools it exposes, and example usage.
This file is for humans — it is not parsed by the loader.

### 4. That's it

The loader picks it up automatically on next server start (or after `reloadSkills()`).

---

## Rules

| Rule | Reason |
|------|--------|
| Tool names must be unique and snake_case | LLM uses them as function names |
| Built-in tools (from agent.js) always win | Skills can't override core functionality |
| `execute()` must return a string | Gets passed back to the LLM as the tool result |
| Never `require('../bot/agent')` from a skill | Avoid circular dependencies |
| Keep each skill focused on one domain | Easier to debug, enable/disable |

---

## Disabling a skill

Rename the directory to `_my-skill` (prefix with `_`).
The loader only reads directories — non-directories are ignored.
Or just delete the directory.

---

## Integration checklist (when wiring into agent.js)

- [ ] Import `skills-registry.js`
- [ ] Append `getSkillDeclarations(builtInNames)` to `TOOLS` array
- [ ] In `executeTool`: check `isSkillTool(name)` before the `default` case
- [ ] Call `executeSkillTool(name, args, ctx)` for skill tools
