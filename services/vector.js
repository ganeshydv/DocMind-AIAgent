const axios = require("axios");
const http = require("http");

const BASE_URL = "http://localhost:6333";

// Create a dedicated axios instance with keep-alive to prevent ECONNRESET
// on idle TCP sockets (common with Docker containers on Windows).
const qdrant = axios.create({
  baseURL: BASE_URL,
  httpAgent: new http.Agent({ keepAlive: true, keepAliveMsecs: 30000 }),
  timeout: 30000,
});

/**
 * Retry wrapper for transient network errors (ECONNRESET, ECONNREFUSED, etc.)
 */
async function withRetry(fn, retries = 3, delay = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const isTransient = err.code === "ECONNRESET" || err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT";
      if (isTransient && i < retries - 1) {
        console.warn(`Qdrant connection error (${err.code}), retrying in ${delay}ms... (${i + 1}/${retries})`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

/**
 * Each user gets their own collection: docs_<userId>
 * Each document is tagged with a docId in the payload for filtering.
 * This ensures user isolation + per-document search capability.
 */
function getCollectionName(userId) {
  return `docs_${userId}`;
}

async function ensureCollection(userId) {
  const collection = getCollectionName(userId);
  await withRetry(async () => {
    try {
      await qdrant.get(`/collections/${collection}`);
    } catch (err) {
      if (err.response && err.response.status === 404) {
        await qdrant.put(`/collections/${collection}`, {
          vectors: { size: 384, distance: "Cosine" },
        });
        // Create payload index on docId for fast filtered searches
        await qdrant.put(
          `/collections/${collection}/index`,
          { field_name: "docId", field_schema: "keyword" }
        );
      } else {
        throw err;
      }
    }
  });
}

async function insertVectors(userId, points) {
  const collection = getCollectionName(userId);
  await ensureCollection(userId);
  await withRetry(() =>
    qdrant.put(`/collections/${collection}/points`, { points })
  );
}

/**
 * Search vectors — optionally filter to a specific document.
 * @param {string} userId
 * @param {number[]} vector - 384-dim query embedding
 * @param {string|null} docId - If provided, search only within this document
 */
async function search(userId, vector, docId = null) {
  const collection = getCollectionName(userId);
  const body = {
    query: vector,
    limit: 5,
    with_payload: true,
  };

  if (docId) {
    body.filter = {
      must: [{ key: "docId", match: { value: docId } }],
    };
  }

  return withRetry(async () => {
    try {
      const res = await qdrant.post(
        `/collections/${collection}/points/query`,
        body
      );
      return res.data.result.points || res.data.result;
    } catch (err) {
      console.error("Qdrant search error:", err.response?.data || err.message);
      throw err;
    }
  });
}

/**
 * Delete all vectors belonging to a specific document.
 */
async function deleteDocument(userId, docId) {
  const collection = getCollectionName(userId);
  await withRetry(() =>
    qdrant.post(`/collections/${collection}/points/delete`, {
      filter: {
        must: [{ key: "docId", match: { value: docId } }],
      },
    })
  );
}

/**
 * List all unique documents in a user's collection.
 * Scrolls through points and extracts unique docId + fileName pairs.
 */
async function listDocuments(userId) {
  const collection = getCollectionName(userId);
  return withRetry(async () => {
    try {
      const res = await qdrant.post(
        `/collections/${collection}/points/scroll`,
        {
          limit: 1000,
          with_payload: { include: ["docId", "fileName"] },
        }
      );
      const points = res.data.result.points || [];
      const docsMap = new Map();
      for (const p of points) {
      const { docId, fileName } = p.payload;
      if (docId && !docsMap.has(docId)) {
        docsMap.set(docId, fileName || docId);
      }
    }
    return Array.from(docsMap, ([docId, fileName]) => ({ docId, fileName }));
  } catch (err) {
    if (err.response && err.response.status === 404) return [];
    throw err;
  }
  });
}

module.exports = {
  ensureCollection,
  insertVectors,
  search,
  deleteDocument,
  listDocuments,
};