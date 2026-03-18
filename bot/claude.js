const Groq = require('groq-sdk');
const { loadSystemPrompt } = require('./system_prompt');

const client = new Groq({ apiKey: process.env.GROQ_API_KEY });
const systemPrompt = loadSystemPrompt();

async function askClaude(messages) {
  const response = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 1024,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
  });

  return response.choices[0]?.message?.content || '(no response)';
}

module.exports = { askClaude };
