/**
 * Child Process — Document Processing Pipeline
 *
 * Runs in a separate OS process so native bindings (@xenova/transformers ONNX)
 * cannot crash the main Express server when this process exits.
 *
 * Communication:
 *   Main  → Child:  process.argv[2] = uploadId, process.argv[3] = userId
 *   Child → Main:   process.send({ stage, progress, total, error })
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const redis = require("./redis");
const { updateProcessingStatus, assembleFile } = require("./upload");
const { extractText } = require("./pdf");
const { cleanText, chunkText } = require("./chunk");
const { ensureCollection, insertVectors } = require("./vector");
const { createEmbedding } = require("./embedding");

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
    const uploadData = await redis.hgetall(`upload:${uploadId}`);
    const fileName = uploadData.fileName || uploadId;
    // Use uploadId as the docId — unique per upload
    const docId = uploadId;

    // Store docId in Redis so frontend can reference it later
    await redis.hset(`upload:${uploadId}`, "docId", docId);

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



// ─── Entry point ───────────────────────────────────────────────
const [uploadId, userId] = process.argv.slice(2);

processUpload(uploadId, userId)
  .then(async () => {
    if (process.send) process.send({ stage: "complete" });
    await redis.quit();
  })
  .catch(async (err) => {
    if (process.send) process.send({ stage: "error", error: err.message });
    await redis.quit();
  });