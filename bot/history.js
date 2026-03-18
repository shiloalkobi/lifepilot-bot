const MAX_MESSAGES = 20;

// Map of chatId -> messages[]
const conversations = new Map();

function getHistory(chatId) {
  if (!conversations.has(chatId)) {
    conversations.set(chatId, []);
  }
  return conversations.get(chatId);
}

function addMessage(chatId, role, content) {
  const history = getHistory(chatId);
  history.push({ role, content });

  // Keep only last MAX_MESSAGES to save tokens
  if (history.length > MAX_MESSAGES) {
    conversations.set(chatId, history.slice(history.length - MAX_MESSAGES));
  }
}

function resetHistory(chatId) {
  conversations.set(chatId, []);
}

module.exports = { getHistory, addMessage, resetHistory };
