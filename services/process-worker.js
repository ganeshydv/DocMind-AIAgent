/**
 * Child Process — Document Processing Pipeline (Pool Worker)
 *
 * Runs in a separate OS process so native bindings (@xenova/transformers ONNX)
 * cannot crash the main Express server.
 *
 * This worker is LONG-LIVED — managed by ProcessPool. It stays alive after
 * completing a job and waits for the next one. The ONNX model is loaded once
 * and reused across all jobs assigned to this worker.
 *
 * Communication (IPC — no direct Redis connection):
 *   Main  → Child:  { type: 'start', uploadId, userId, fileName, totalChunks }
 *   Child → Main:   { type: 'status', uploadId, status: { stage, progress, total } }
 *                    { type: 'setDocId', uploadId, docId }
 *                    { type: 'done' }   /   { type: 'error', error }
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

// Only import processing modules — NO Redis, NO upload.js
const { extractText } = require("./pdf");
const { cleanText, chunkText } = require("./chunk");
const { ensureCollection, insertVectors } = require("./vector");
const { createEmbedding } = require("./embedding");

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");

// ─── IPC helpers (status updates forwarded to main → Redis) ────

function sendStatus(uploadId, status) {
  if (process.send) process.send({ type: "status", uploadId, status });
}

// ─── Local file assembly (no Redis needed) ─────────────────────

async function assembleFileLocal(uploadId, fileName, totalChunks) {
  const dir = path.join(UPLOAD_DIR, uploadId);
  const ext = path.extname(fileName || ".pdf") || ".pdf";
  const outputPath = path.join(UPLOAD_DIR, `${uploadId}${ext}`);

  const writeStream = fs.createWriteStream(outputPath);
  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = path.join(dir, `chunk_${i}`);
    const chunkData = fs.readFileSync(chunkPath);
    writeStream.write(chunkData);
  }
  writeStream.end();
  await new Promise((resolve) => writeStream.on("finish", resolve));

  // Cleanup individual chunk files
  fs.rmSync(dir, { recursive: true, force: true });
  return outputPath;
}

// ─── Background Document Processing ────────────────────────────

const BATCH_SIZE = 5; // embed this many chunks in parallel

async function processUpload({ uploadId, userId, fileName, totalChunks }) {
  try {
    // Step 1: Reassemble file from chunks
    sendStatus(uploadId, { stage: "assembling", progress: 0 });
    const filePath = await assembleFileLocal(uploadId, fileName, totalChunks);

    // Step 2: Extract text from document (PDF, DOCX, TXT, etc.)
    sendStatus(uploadId, { stage: "extracting", progress: 0 });
    const text = await extractText(filePath);
    const cleanedText = cleanText(text);

    // Step 3: Split into overlapping text chunks
    sendStatus(uploadId, { stage: "chunking", progress: 0 });
    const textChunks = chunkText(cleanedText);
    const total = textChunks.length;

    // Step 4: Ensure user's collection exists
    await ensureCollection(userId);

    // Use uploadId as the docId — unique per upload
    const docId = uploadId;

    // Tell main process to store docId in Redis
    if (process.send) process.send({ type: "setDocId", uploadId, docId });

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

      sendStatus(uploadId, {
        stage: "embedding",
        progress: Math.min(i + BATCH_SIZE, total),
        total,
      });
    }

    sendStatus(uploadId, { stage: "complete", progress: total, total });

    // Cleanup the assembled file
    fs.unlinkSync(filePath);
  } catch (err) {
    console.error("Processing error:", err);
    sendStatus(uploadId, { stage: "error", error: err.message });
  }
}

// ─── Entry point — long-lived worker, handles jobs from ProcessPool ──

process.on("message", (msg) => {
  if (msg.type === "start") {
    processUpload(msg)
      .then(() => {
        // Signal done — ProcessPool will return this worker to the idle set
        if (process.send) process.send({ type: "done" });
        // NOTE: Do NOT process.exit() — stay alive for the next job
      })
      .catch((err) => {
        if (process.send) process.send({ type: "error", error: err.message });
        // Do NOT exit — pool will still consider us available for retry/next job
      });
  }
});

// Graceful shutdown when the pool sends SIGTERM
process.on("SIGTERM", () => {
  console.log(`[Worker PID ${process.pid}] Received SIGTERM, exiting`);
  process.exit(0);
});