const redis = require("./redis");
const fs = require("fs");
const path = require("path");

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");

/**
 * Initialize a chunked upload session.
 * Stores metadata in Redis and creates a directory for chunks.
 */
async function initUpload(uploadId, { userId, fileName, fileSize, totalChunks }) {
  await redis.hset(`upload:${uploadId}`, {
    userId,
    fileName,
    fileSize: fileSize || 0,
    totalChunks,
    uploadedChunks: "[]",
    stage: "uploading",
    progress: 0,
    total: 0,
    error: "",
  });
  // 24-hour TTL so stale uploads get cleaned up
  await redis.expire(`upload:${uploadId}`, 86400);

  const dir = path.join(UPLOAD_DIR, uploadId);
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Save a single chunk to disk and record it in Redis.
 */
async function saveChunk(uploadId, chunkIndex, data) {
  const dir = path.join(UPLOAD_DIR, uploadId);
  fs.writeFileSync(path.join(dir, `chunk_${chunkIndex}`), data);

  const uploaded = JSON.parse(
    (await redis.hget(`upload:${uploadId}`, "uploadedChunks")) || "[]"
  );
  if (!uploaded.includes(chunkIndex)) {
    uploaded.push(chunkIndex);
    uploaded.sort((a, b) => a - b);
  }
  await redis.hset(`upload:${uploadId}`, "uploadedChunks", JSON.stringify(uploaded));
}

/**
 * Get current upload status — which chunks are received, is it complete?
 * Used by the frontend to resume interrupted uploads.
 */
async function getUploadStatus(uploadId) {
  const data = await redis.hgetall(`upload:${uploadId}`);
  if (!data || !data.totalChunks) return { exists: false };

  const uploadedChunks = JSON.parse(data.uploadedChunks || "[]");
  const totalChunks = parseInt(data.totalChunks);

  return {
    exists: true,
    userId: data.userId,
    fileName: data.fileName,
    uploadedChunks,
    totalChunks,
    complete: uploadedChunks.length >= totalChunks,
  };
}

/**
 * Reassemble the individual chunk files into one complete file.
 * Preserves original extension so the text extractor can detect format.
 */
async function assembleFile(uploadId) {
  const data = await redis.hgetall(`upload:${uploadId}`);
  const totalChunks = parseInt(data.totalChunks);
  const dir = path.join(UPLOAD_DIR, uploadId);
  const ext = path.extname(data.fileName || ".pdf") || ".pdf";
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

/**
 * Update the processing stage in Redis (assembling → extracting → chunking → embedding → complete).
 * The SSE status endpoint polls this.
 */
async function updateProcessingStatus(uploadId, status) {
  await redis.hset(`upload:${uploadId}`, {
    stage: status.stage,
    progress: status.progress || 0,
    total: status.total || 0,
    error: status.error || "",
  });
}

/**
 * Read the current processing status from Redis.
 */
async function getProcessingStatus(uploadId) {
  const data = await redis.hgetall(`upload:${uploadId}`);
  if (!data || !data.stage) return { stage: "unknown" };

  return {
    stage: data.stage,
    progress: parseInt(data.progress || 0),
    total: parseInt(data.total || 0),
    error: data.error || null,
  };
}

module.exports = {
  initUpload,
  saveChunk,
  getUploadStatus,
  assembleFile,
  updateProcessingStatus,
  getProcessingStatus,
};
