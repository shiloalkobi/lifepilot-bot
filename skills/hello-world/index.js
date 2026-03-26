'use strict';

/**
 * Hello World Skill — example / smoke-test for the Skills system.
 *
 * Exports the minimum required shape:
 *   name        — unique skill identifier
 *   description — shown in logs
 *   tools       — array of tool declarations (same schema as agent.js TOOL_DECLARATIONS)
 *   execute     — async (toolName, args, ctx) => string
 */

const name        = 'hello-world';
const description = 'Example skill that proves the Skills system is working.';

const tools = [
  {
    name:        'hello_world',
    description: 'Returns a greeting from the Skills system. Used to verify that skill loading works.',
    parameters: {
      type:       'object',
      properties: {
        name: {
          type:        'string',
          description: 'Optional name to include in the greeting',
        },
      },
      required: [],
    },
  },
];

async function execute(toolName, args, ctx) {
  if (toolName === 'hello_world') {
    const who = args.name ? `, ${args.name}` : '';
    return `Hello${who} from the Skills system! 🎉`;
  }
  return `Unknown tool "${toolName}" in skill "${name}"`;
}

module.exports = { name, description, tools, execute };
