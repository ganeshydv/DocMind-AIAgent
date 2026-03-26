const axios = require("axios");

// ─── Ollama (local) ─────────────────────────────────────────────

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/api/generate";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:3b";

async function* ollamaStream(prompt) {
  const res = await axios.post(
    OLLAMA_URL,
    { model: OLLAMA_MODEL, prompt, stream: true },
    { responseType: "stream" }
  );

  let buffer = "";
  for await (const chunk of res.data) {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.response) yield parsed.response;
        if (parsed.done) return;
      } catch {
        // incomplete JSON, skip
      }
    }
  }
}

// ─── LLM Gateway (cloud) ───────────────────────────────────────

const GATEWAY_URL = process.env.LLM_GATEWAY_URL || "https://api.llmgateway.io/v1/chat/completions";
const GATEWAY_KEY = process.env.LLM_GATEWAY_KEY || "";
const GATEWAY_MODEL = process.env.LLM_GATEWAY_MODEL || "auto";

async function* gatewayStream(prompt, history) {
  // Build messages array from conversation history
  const messages = [];
  if (history && history.length > 0) {
    for (const msg of history) {
      messages.push({
        role: msg.role === "user" ? "user" : "assistant",
        content: msg.text,
      });
    }
  }
  // Add the current prompt (which includes context + question)
  messages.push({ role: "user", content: prompt });

  const res = await axios.post(
    GATEWAY_URL,
    {
      model: GATEWAY_MODEL,
      free_models_only: true,
      messages,
      stream: true,
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GATEWAY_KEY}`,
      },
      responseType: "stream",
    }
  );

  let buffer = "";
  for await (const chunk of res.data) {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const payload = trimmed.slice(6);
      if (payload === "[DONE]") return;

      try {
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // incomplete JSON, skip
      }
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Stream tokens from the selected provider.
 * @param {string} prompt - Full prompt with context
 * @param {object} options
 * @param {string} options.provider - "ollama" or "gateway"
 * @param {Array}  options.history  - Chat history for gateway
 */
async function* generateStream(prompt, { provider = "ollama", history = [] } = {}) {
  if (provider === "gateway" && GATEWAY_KEY) {
    yield* gatewayStream(prompt, history);
  } else {
    yield* ollamaStream(prompt);
  }
}

module.exports = { generateStream };