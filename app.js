require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const { extractText } = require("./services/pdf");
const { chunkText, cleanText } = require("./services/chunk");
const { createEmbedding } = require("./services/embedding");
const { ensureCollection, insertVectors, search, deleteDocument, listDocuments } = require("./services/vector");
const { generateStream } = require("./services/llm");
const {
  initUpload,
  saveChunk,
  getUploadStatus,
  assembleFile,
  updateProcessingStatus,
  getProcessingStatus,
} = require("./services/upload");

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
      return res.status(400).json({ error: "userId, fileName, totalChunks required" });
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
        // All chunks received → kick off background processing
        processUpload(uploadId, status.userId).catch(console.error);
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

// ─── Background Document Processing ────────────────────────────

const BATCH_SIZE = 5; // embed this many chunks in parallel

async function processUpload(uploadId, userId) {
  try {
    // Step 1: Reassemble file from chunks
    await updateProcessingStatus(uploadId, { stage: "assembling", progress: 0 });
    const filePath = await assembleFile(uploadId);

    // Step 2: Extract text from document (PDF, DOCX, TXT, etc.)
    await updateProcessingStatus(uploadId, { stage: "extracting", progress: 0 });
    const text = await extractText(filePath);
    const cleanedText = cleanText(text);

    // Step 3: Split into overlapping text chunks
    await updateProcessingStatus(uploadId, { stage: "chunking", progress: 0 });
    const textChunks = chunkText(cleanedText);
    const total = textChunks.length;

    // Step 4: Ensure user's collection exists
    await ensureCollection(userId);

    // Get the original fileName for metadata
    const uploadData = await require("./services/redis").hgetall(`upload:${uploadId}`);
    const fileName = uploadData.fileName || uploadId;
    // Use uploadId as the docId — unique per upload
    const docId = uploadId;

    // Store docId in Redis so frontend can reference it later
    await require("./services/redis").hset(`upload:${uploadId}`, "docId", docId);

    // Step 5: Embed & insert in parallel batches
    for (let i = 0; i < textChunks.length; i += BATCH_SIZE) {
      const batch = textChunks.slice(i, i + BATCH_SIZE);

      // Parallel embedding within the batch
      const embeddings = await Promise.all(batch.map((c) => createEmbedding(c)));

      const points = batch.map((chunk, j) => ({
        id: uuidv4(),
        vector: embeddings[j],
        payload: { text: chunk, docId, fileName },
      }));

      await insertVectors(userId, points);

      await updateProcessingStatus(uploadId, {
        stage: "embedding",
        progress: Math.min(i + BATCH_SIZE, total),
        total,
      });
    }

    await updateProcessingStatus(uploadId, { stage: "complete", progress: total, total });

    // Cleanup the assembled file
    fs.unlinkSync(filePath);
  } catch (err) {
    console.error("Processing error:", err);
    await updateProcessingStatus(uploadId, { stage: "error", error: err.message });
  }
}

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
    const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434/api/generate";
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
        .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.text}`)
        .join("\n");
      conversationHistory = `\n\nConversation so far:\n${conversationHistory}`;
    }

    const prompt = `You are a helpful assistant. Answer ONLY from the context provided. If the user's message is conversational (like "ok", "thanks", "tell me more"), respond naturally based on the conversation history.\n\nContext from document:\n${context}${conversationHistory}\n\nUser: ${question}\nAssistant:`;

    const selectedProvider = provider || process.env.LLM_PROVIDER || "ollama";

    sendStage("thinking");

    let firstToken = true;
    for await (const token of generateStream(prompt, { provider: selectedProvider, model, history })) {
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

app.listen(3000, () => console.log("Server running on port 3000"));
