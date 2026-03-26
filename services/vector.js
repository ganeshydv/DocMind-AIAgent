const axios = require("axios");

const BASE_URL = "http://localhost:6333";

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
  try {
    await axios.get(`${BASE_URL}/collections/${collection}`);
  } catch (err) {
    if (err.response && err.response.status === 404) {
      await axios.put(`${BASE_URL}/collections/${collection}`, {
        vectors: { size: 384, distance: "Cosine" },
      });
      // Create payload index on docId for fast filtered searches
      await axios.put(
        `${BASE_URL}/collections/${collection}/index`,
        { field_name: "docId", field_schema: "keyword" }
      );
    } else {
      throw err;
    }
  }
}

async function insertVectors(userId, points) {
  const collection = getCollectionName(userId);
  await ensureCollection(userId);
  await axios.put(`${BASE_URL}/collections/${collection}/points`, {
    points,
  });
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

  try {
    const res = await axios.post(
      `${BASE_URL}/collections/${collection}/points/query`,
      body
    );
    return res.data.result.points || res.data.result;
  } catch (err) {
    console.error("Qdrant search error:", err.response?.data || err.message);
    throw err;
  }
}

/**
 * Delete all vectors belonging to a specific document.
 */
async function deleteDocument(userId, docId) {
  const collection = getCollectionName(userId);
  await axios.post(`${BASE_URL}/collections/${collection}/points/delete`, {
    filter: {
      must: [{ key: "docId", match: { value: docId } }],
    },
  });
}

/**
 * List all unique documents in a user's collection.
 * Scrolls through points and extracts unique docId + fileName pairs.
 */
async function listDocuments(userId) {
  const collection = getCollectionName(userId);
  try {
    const res = await axios.post(
      `${BASE_URL}/collections/${collection}/points/scroll`,
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
}

module.exports = {
  ensureCollection,
  insertVectors,
  search,
  deleteDocument,
  listDocuments,
};