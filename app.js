require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const { createEmbedding } = require("./services/embedding");
const {
  search,
  deleteDocument,
  listDocuments,
} = require("./services/vector");
const { generateStream } = require("./services/llm");
const {
  initUpload,
  saveChunk,
  getUploadStatus,
  getProcessingStatus,
  updateProcessingStatus,
} = require("./services/upload");
const redis = require("./services/redis");
const ProcessPool = require("./services/process-pool");

// ─── Process Pool (shared across all uploads) ──────────────────
const pool = new ProcessPool({
  size: parseInt(process.env.WORKER_POOL_SIZE) || undefined, // defaults to CPU cores - 1
  onMessage: async (msg) => {
    switch (msg.type) {
      case "status":
        await updateProcessingStatus(msg.uploadId, msg.status);
        console.log(`[Pool] ${msg.uploadId} → ${msg.status.stage}`);
        break;
      case "setDocId":
        await redis.hset(`upload:${msg.uploadId}`, "docId", msg.docId);
        break;
      case "done":
        console.log(`[Pool] Job done`);
        break;
      case "error":
        console.error(`[Pool] Job error: ${msg.error}`);
        break;
    }
  },
});

const app = express();
app.use(cors());
app.use(express.json());

// ─── Chunked Upload ────────────────────────────────────────────

/**
 * 1. Initialize upload — client tells us userId, fileName, totalChunks.
 *    Returns an uploadId the client uses for all subsequent chunk calls.
 */
app.post("/upload/init", async (req, res) => {
  try {
    const { userId, fileName, fileSize, totalChunks } = req.body;
    if (!userId || !fileName || !totalChunks) {
      return res
        .status(400)
        .json({ error: "userId, fileName, totalChunks required" });
    }
    const uploadId = uuidv4();
    await initUpload(uploadId, { userId, fileName, fileSize, totalChunks });
    res.json({ uploadId });
  } catch (err) {
    console.error("Init upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 2. Upload a single chunk (raw binary body).
 *    When all chunks arrive, background processing starts automatically.
 */
app.post("/upload/chunk/:uploadId/:chunkIndex", async (req, res) => {
  try {
    const { uploadId, chunkIndex } = req.params;
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const data = Buffer.concat(chunks);
      await saveChunk(uploadId, parseInt(chunkIndex), data);

      const status = await getUploadStatus(uploadId);
      if (status.complete) {
        // Dispatch to the process pool — reuses long-lived workers
        // instead of forking a new process per upload.
        pool
          .run({
            type: "start",
            uploadId,
            userId: status.userId,
            fileName: status.fileName,
            totalChunks: status.totalChunks,
          })
          .catch((err) =>
            console.error(`[Pool] Upload ${uploadId} failed:`, err.message),
          );
      }
      res.json({ received: true, chunkIndex: parseInt(chunkIndex) });
    });
  } catch (err) {
    console.error("Chunk upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 3. Resume info — which chunks have we already received?
 *    The frontend calls this to skip already-uploaded chunks.
 */
app.get("/upload/resume/:uploadId", async (req, res) => {
  try {
    const status = await getUploadStatus(req.params.uploadId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 4. SSE endpoint — streams processing progress to the frontend.
 *    Polls Redis every 500ms until complete or error.
 */
app.get("/upload/status/:uploadId", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const interval = setInterval(async () => {
    try {
      const status = await getProcessingStatus(req.params.uploadId);
      res.write(`data: ${JSON.stringify(status)}\n\n`);

      if (status.stage === "complete" || status.stage === "error") {
        clearInterval(interval);
        res.end();
      }
    } catch {
      clearInterval(interval);
      res.end();
    }
  }, 500);

  req.on("close", () => clearInterval(interval));
});


// ─── Document Management ───────────────────────────────────────

/**
 * List all documents uploaded by a user.
 */
app.get("/docs/:userId", async (req, res) => {
  try {
    const docs = await listDocuments(req.params.userId);
    res.json({ docs });
  } catch (err) {
    console.error("List docs error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Delete a specific document's vectors from the user's collection.
 */
app.delete("/docs/:userId/:docId", async (req, res) => {
  try {
    await deleteDocument(req.params.userId, req.params.docId);
    res.json({ deleted: true });
  } catch (err) {
    console.error("Delete doc error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Ollama Models ─────────────────────────────────────────────

/**
 * List locally available Ollama models.
 */
app.get("/models/ollama", async (_req, res) => {
  try {
    const ollamaUrl =
      process.env.OLLAMA_URL || "http://localhost:11434/api/generate";
    const baseUrl = ollamaUrl.replace(/\/api\/generate$/, "");
    const response = await require("axios").get(`${baseUrl}/api/tags`);
    const models = (response.data.models || []).map((m) => ({
      name: m.name,
      size: m.size,
      family: m.details?.family,
      parameterSize: m.details?.parameter_size,
    }));
    res.json({ models });
  } catch (err) {
    console.error("Ollama models error:", err.message);
    res.json({ models: [], error: "Ollama not reachable" });
  }
});

// ─── Ask Question (Streaming SSE) ──────────────────────────────

/**
 * Streams the LLM answer token-by-token via SSE.
 */
app.post("/ask", async (req, res) => {
  const { userId, question, history, provider, model, docId } = req.body;
  if (!userId || !question) {
    return res.status(400).json({ error: "userId and question required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable proxy buffering (nginx, etc.)
  res.flushHeaders(); // send headers immediately — establishes the SSE connection

  const sendStage = (stage) => {
    res.write(`data: ${JSON.stringify({ stage })}\n\n`);
    if (typeof res.flush === "function") res.flush();
  };

  try {
    sendStage("analyzing");
    const queryEmbedding = await createEmbedding(question);

    sendStage("searching");
    const results = await search(userId, queryEmbedding, docId || null);

    sendStage("referencing");
    const context = results.map((r) => r.payload.text).join("\n");

    // Build conversation history string
    let conversationHistory = "";
    if (history && history.length > 0) {
      conversationHistory = history
        .slice(-10)
        .map(
          (msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.text}`,
        )
        .join("\n");
      conversationHistory = `\n\nConversation so far:\n${conversationHistory}`;
    }

    const prompt = `You are a helpful assistant. Answer ONLY from the context provided. If the user's message is conversational (like "ok", "thanks", "tell me more"), respond naturally based on the conversation history.\n\nContext from document:\n${context}${conversationHistory}\n\nUser: ${question}\nAssistant:`;

    const selectedProvider = provider || process.env.LLM_PROVIDER || "ollama";

    sendStage("thinking");

    let firstToken = true;
    for await (const token of generateStream(prompt, {
      provider: selectedProvider,
      model,
      history,
    })) {
      if (firstToken) {
        sendStage("streaming");
        firstToken = false;
      }
      res.write(`data: ${JSON.stringify({ token })}\n\n`);
      if (typeof res.flush === "function") res.flush(); // force TCP push per token
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error("Ask error:", err);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ─── Start server + process pool ───────────────────────────────

pool.start(); // pre-fork worker processes

const server = app.listen(3000, () => console.log("Server running on port 3000"));

// Graceful shutdown — kill pool workers when the server stops
let shuttingDown = false;
async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Shutting down…");
  pool._shutdown = true; // stop respawn immediately (before async shutdown kills workers)
  await pool.shutdown();
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
  // Force exit if server.close() hangs (e.g. open SSE connections)
  setTimeout(() => {
    console.warn("Forcing exit (connections did not close in time)");
    process.exit(1);
  }, 5000);
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
