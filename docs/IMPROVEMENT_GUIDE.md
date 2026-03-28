# AiHelper — Improvement Guide

A practical guide to improving response quality, search accuracy, performance, and scalability of the RAG pipeline.

---

## Table of Contents

- [1. Chunking Strategy](#1-chunking-strategy)
- [2. Embedding Model Upgrade](#2-embedding-model-upgrade)
- [3. Vector Search Tuning](#3-vector-search-tuning)
- [4. LLM Prompt Engineering](#4-llm-prompt-engineering)
- [5. LLM Provider & Model Selection](#5-llm-provider--model-selection)
- [6. Re-Ranking Search Results](#6-re-ranking-search-results)
- [7. Metadata & Filtering](#7-metadata--filtering)
- [8. Multi-Document Context](#8-multi-document-context)
- [9. Chat Memory & History](#9-chat-memory--history)
- [10. Performance & Scalability](#10-performance--scalability)
- [11. Security Improvements](#11-security-improvements)
- [12. Node.js Concurrency & Streaming Deep Dive](#12-nodejs-concurrency--streaming-deep-dive)
- [Priority Roadmap](#priority-roadmap)

---

## 1. Chunking Strategy

**Current:** Fixed 500-character window with 100-char overlap.

**Problem:** Cuts mid-sentence, mid-paragraph — the LLM gets incomplete context.

### Improvements

| Strategy | Description | Difficulty |
|---|---|---|
| **Sentence-aware splitting** | Split on sentence boundaries (`. `, `? `, `! `) instead of fixed chars | Easy |
| **Paragraph-aware splitting** | Split on `\n\n` (paragraph breaks), fall back to sentence | Easy |
| **Recursive splitting** | Try paragraph → sentence → word → char boundaries in order | Medium |
| **Semantic chunking** | Use embeddings to detect topic shifts and split there | Hard |

### Recommended: Sentence-Aware Chunking

```javascript
function chunkText(text, maxSize = 500, overlap = 100) {
  // Split into sentences
  const sentences = text.match(/[^.!?\n]+[.!?\n]+/g) || [text];
  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    if (current.length + sentence.length > maxSize && current.length > 0) {
      chunks.push(current.trim());
      // Keep last `overlap` chars for context continuity
      current = current.slice(-overlap) + sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
```

**Impact:** High — better chunks → better search results → better LLM answers.

---

## 2. Embedding Model Upgrade

**Current:** `Xenova/all-MiniLM-L6-v2` → 384 dimensions, runs locally.

### Options

| Model | Dims | Quality | Speed | Cost | Runtime |
|---|---|---|---|---|---|
| `all-MiniLM-L6-v2` (current) | 384 | Good | Fast | Free | Local |
| `all-mpnet-base-v2` | 768 | Better | ~2x slower | Free | Local |
| `bge-base-en-v1.5` | 768 | Very good | ~2x slower | Free | Local |
| OpenAI `text-embedding-3-small` | 1536 | Excellent | API latency | ~$0.02/1M tokens | API |
| OpenAI `text-embedding-3-large` | 3072 | Best | API latency | ~$0.13/1M tokens | API |

### How to Upgrade (Example: `all-mpnet-base-v2`)

1. **Change embedding model** in `services/embedding.js`:
   ```javascript
   embedder = await pipeline("feature-extraction", "Xenova/all-mpnet-base-v2");
   ```

2. **Change vector size** in `services/vector.js`:
   ```javascript
   vectors: { size: 768, distance: "Cosine" }
   ```

3. **Delete old Qdrant collections** — old 384-dim vectors are incompatible.

4. **Re-upload all documents** — they need to be re-embedded with the new model.

**Impact:** Medium — noticeable improvement for nuanced or technical queries.

---

## 3. Vector Search Tuning

**Current:** Returns top 3 results.

### Improvements

| Change | How | Impact |
|---|---|---|
| **Increase top-K** | Change `limit: 3` → `limit: 5` in `vector.js` | More context for LLM, but may add noise |
| **Score threshold** | Add `score_threshold: 0.5` to filter low-quality matches | Prevents irrelevant context from reaching the LLM |
| **HNSW tuning** | Set `hnsw_config: { m: 32, ef_construct: 200 }` on collection | Better recall at scale (1M+ vectors) |

### Recommended: Add Score Filtering

```javascript
const res = await axios.post(
  `${BASE_URL}/collections/${collection}/points/query`,
  {
    query: vector,
    limit: 5,
    with_payload: true,
    score_threshold: 0.4, // ignore results below this similarity
  }
);
```

**Impact:** Medium — prevents "hallucination from irrelevant context" problem.

---

## 4. LLM Prompt Engineering

**Current prompt:**
```
You are a helpful assistant. Answer ONLY from the context provided...
```

### Improvements

| Technique | Description |
|---|---|
| **Structured prompt** | Clearly separate system instructions, context, history, and question |
| **Citation instructions** | Ask LLM to quote which part of the context it used |
| **Confidence signaling** | Tell LLM to say "I don't have enough information" when context is insufficient |
| **Format instructions** | Request bullet points, tables, or specific formats |

### Recommended Prompt Template

```javascript
const prompt = `<system>
You are a precise document assistant. Follow these rules:
1. Answer ONLY using the provided context. Never use outside knowledge.
2. If the context doesn't contain enough information, say "The uploaded document doesn't cover this topic."
3. When quoting the document, use exact phrases.
4. Keep answers concise and well-structured.
5. For conversational messages (like "thanks", "ok"), respond naturally.
</system>

<context>
${context}
</context>

<conversation_history>
${conversationHistory}
</conversation_history>

<question>
${question}
</question>

Answer:`;
```

**Impact:** High — directly controls answer quality, reduces hallucination.

---

## 5. LLM Provider & Model Selection

**Current:** Ollama `llama3.2:3b` (local) or LLM Gateway `auto` (cloud).

### Local Model Upgrades (Ollama)

| Model | Size | Quality | RAM Needed |
|---|---|---|---|
| `llama3.2:3b` (current) | 3B | Basic | ~4 GB |
| `llama3.2:8b` | 8B | Good | ~8 GB |
| `mistral:7b` | 7B | Good | ~8 GB |
| `llama3.1:70b` | 70B | Excellent | ~48 GB |
| `deepseek-r1:7b` | 7B | Good (reasoning) | ~8 GB |

### Cloud Options

| Provider | Model | Quality | Cost |
|---|---|---|---|
| LLM Gateway (current) | `auto` | Varies | Free tier |
| OpenAI | `gpt-4o-mini` | Very good | ~$0.15/1M tokens |
| OpenAI | `gpt-4o` | Excellent | ~$2.50/1M tokens |
| Anthropic | `claude-3.5-sonnet` | Excellent | ~$3/1M tokens |
| Google | `gemini-2.0-flash` | Very good | Free tier available |

**Impact:** High — bigger/better models give significantly better answers.

---

## 6. Re-Ranking Search Results

**Current:** Qdrant returns top-K by cosine similarity → sent directly to LLM.

**Problem:** Embedding similarity ≠ answer relevance. The best vector match might not be the most useful chunk for answering the specific question.

### Solution: Cross-Encoder Re-Ranking

```
Question → Qdrant top 10 → Re-ranker scores each (question, chunk) pair → Top 3 → LLM
```

```javascript
// Example with a cross-encoder (would need a re-ranking model)
const reranker = await pipeline("text-classification", "Xenova/ms-marco-MiniLM-L-6-v2");

async function rerankResults(question, results) {
  const scored = await Promise.all(
    results.map(async (r) => {
      const score = await reranker(`${question} [SEP] ${r.payload.text}`);
      return { ...r, rerank_score: score[0].score };
    })
  );
  return scored.sort((a, b) => b.rerank_score - a.rerank_score).slice(0, 3);
}
```

**Impact:** High — significantly better context selection, especially with larger documents.

---

## 7. Metadata & Filtering

**Current:** Vectors store only `{ text: chunk }` as payload.

### Add Metadata to Chunks

```javascript
const points = batch.map((chunk, j) => ({
  id: uuidv4(),
  vector: embeddings[j],
  payload: {
    text: chunk,
    fileName: "resume.pdf",        // which file this came from
    pageNumber: 3,                  // page/section number
    chunkIndex: i + j,             // position in document
    uploadedAt: Date.now(),        // timestamp
  },
}));
```

### Benefits

- **Filter by file:** "Search only in resume.pdf" — useful when user uploads multiple docs
- **Source citations:** "This answer came from page 3 of resume.pdf"
- **Time-based queries:** "What did I upload last week?"

**Impact:** Medium — enables multi-doc scenarios and better citations.

---

## 8. Multi-Document Context

**Current:** All chunks from all uploads go into the same collection per user.

### Improvements

| Approach | Description |
|---|---|
| **File-level filtering** | Store `fileName` in payload, filter during search |
| **Collection per document** | Separate Qdrant collection for each uploaded file |
| **Hybrid search** | Combine vector search + keyword search (BM25) for better recall |

### Recommended: Payload Filtering

```javascript
async function search(userId, vector, filterFileName = null) {
  const body = {
    query: vector,
    limit: 5,
    with_payload: true,
  };

  if (filterFileName) {
    body.filter = {
      must: [{ key: "fileName", match: { value: filterFileName } }],
    };
  }

  const res = await axios.post(
    `${BASE_URL}/collections/${collection}/points/query`,
    body
  );
  return res.data.result.points || res.data.result;
}
```

**Impact:** Medium — critical when users upload multiple documents.

---

## 9. Chat Memory & History

**Current:** Last 10 messages sent in the request body, no persistence.

### Improvements

| Feature | Description | Difficulty |
|---|---|---|
| **Persist chat in Redis** | Store chat history per userId, survives page refresh | Easy |
| **Summarize old history** | Use LLM to compress older messages into a summary | Medium |
| **Session management** | Multiple named chat sessions per user | Medium |
| **Memory window** | Token-count-based window instead of message count | Medium |

### Recommended: Redis Chat Persistence

```javascript
// Save message
await redis.rpush(`chat:${userId}`, JSON.stringify({ role, text, timestamp }));

// Load history
const messages = await redis.lrange(`chat:${userId}`, -20, -1);
const history = messages.map(JSON.parse);
```

**Impact:** Medium — much better UX, conversations persist across sessions.

---

## 10. Performance & Scalability

### Current Bottlenecks

| Bottleneck | Issue | Fix |
|---|---|---|
| **Embedding speed** | Sequential batch of 5 | Increase batch size to 10-20 |
| **Model loading** | First request loads the model (~5s) | Warm up on server start |
| **Single process** | Node.js single-threaded | Use worker threads for CPU-intensive embedding |
| **No caching** | Same question re-embeds every time | Cache query embeddings in Redis |

### Recommended: Warm Up & Cache

```javascript
// Warm up embedding model on startup
const { createEmbedding } = require("./services/embedding");
createEmbedding("warmup").then(() => console.log("Embedding model ready"));

// Cache query embeddings (TTL: 1 hour)
async function getCachedEmbedding(text) {
  const key = `emb:${Buffer.from(text).toString("base64").slice(0, 64)}`;
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  const embedding = await createEmbedding(text);
  await redis.setex(key, 3600, JSON.stringify(embedding));
  return embedding;
}
```

**Impact:** Medium — faster responses, especially for repeated queries.

---

## 11. Security Improvements

| Issue | Current State | Fix |
|---|---|---|
| **No authentication** | Anyone with userId can access data | Add JWT auth or API keys |
| **Secret in repo** | `secret.txt` has API key in plaintext | Move to `.env`, add to `.gitignore` |
| **No file validation** | Any file accepted blindly | Validate file type + size server-side |
| **No rate limiting** | Unlimited requests | Add express-rate-limit |
| **CORS wide open** | `cors()` allows all origins | Restrict to frontend origin |

**Impact:** Critical for production deployment.

---

## 12. Node.js Concurrency & Streaming Deep Dive

### "Node.js is single-threaded — does streaming block other users?"

**No.** Node.js is single-threaded but **not single-task**. It uses an event loop with non-blocking I/O. Streaming is pure I/O — it never blocks.

### How SSE Streaming Works Internally

```javascript
for await (const token of generateStream(prompt)) {
  res.write(`data: ${JSON.stringify({ token })}\n\n`);  // ~0.001ms CPU work
  // Then Node YIELDS back to the event loop, waiting for next token from LLM
}
```

Each `await` in the `for await` loop **releases the thread** back to the event loop. While waiting for the next token from Ollama/Gateway (network I/O), Node handles other requests freely.

### Multi-User Timeline Example

```
Time    Event Loop Activity
─────   ──────────────────────────────────────────────────
0ms     User A: /ask received → createEmbedding() [CPU BUSY ~50ms]
50ms    User A: embedding done → Qdrant search [I/O, thread FREE]
51ms    User B: /ask received → createEmbedding() [CPU BUSY ~50ms]
52ms    User A: Qdrant results back → send to LLM [I/O, thread FREE]
55ms    User A: token 1 arrives → res.write() → thread FREE
56ms    User C: /ask received (queued until CPU available)
58ms    User A: token 2 arrives → res.write() → thread FREE
101ms   User B: embedding done → Qdrant search [I/O, thread FREE]
102ms   User C: createEmbedding() [CPU BUSY ~50ms]
103ms   User B: Qdrant results → send to LLM [I/O, thread FREE]
...     All 3 users streaming tokens interleaved — nobody blocked
```

10 users streaming simultaneously? No problem — it's all network I/O interleaved on the event loop.

### What Actually Blocks the Event Loop

| Operation | Type | Blocks? | Duration |
|---|---|---|---|
| `createEmbedding()` | **CPU** (transformer model inference) | **Yes** | ~50-200ms per chunk |
| `res.write()` (SSE streaming) | I/O | No | ~0.001ms |
| Qdrant search (HTTP) | I/O | No | Awaited |
| LLM token streaming (HTTP) | I/O | No | Awaited |
| Redis get/set | I/O | No | Awaited |
| PDF text extraction | **CPU** | **Yes** | Brief |
| `fs.readFileSync()` | **CPU** (sync I/O) | **Yes** | Brief |

**Key insight:** Only `createEmbedding()` is a meaningful bottleneck. Everything else is non-blocking I/O.

### Worker Threads — When and Why

Worker threads move CPU-heavy work off the main thread so it doesn't block other requests.

**Without worker threads (current):**
```
Main Thread: User A embedding [████████] User B embedding [████████] ...
             (User B waits 50-200ms until A's embedding finishes)
```

**With worker threads:**
```
Main Thread:     User A req → dispatch → FREE → User B req → dispatch → FREE → streaming...
Worker Thread 1: [████ User A embedding ████]
Worker Thread 2: [████ User B embedding ████]  (parallel, no blocking)
```

**Does it affect streaming?** No — streaming happens on the main thread (I/O only, `res.write()` takes microseconds). Worker threads handle CPU-heavy embedding off the main thread, making the event loop **more responsive** for streaming.

### Implementation: Embedding Worker

```javascript
// services/embedding-worker.js — runs in a worker thread
const { parentPort } = require("worker_threads");
const { pipeline } = require("@xenova/transformers");

let embedder;

parentPort.on("message", async (text) => {
  if (!embedder) {
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  }
  const output = await embedder(text, { pooling: "mean", normalize: true });
  parentPort.postMessage(Array.from(output.data));
});
```

```javascript
// services/embedding.js — main thread dispatches to worker
const { Worker } = require("worker_threads");
const worker = new Worker("./services/embedding-worker.js");

function createEmbedding(text) {
  return new Promise((resolve) => {
    worker.once("message", resolve);
    worker.postMessage(text);
  });
}
```

### When to Use Worker Threads

| Scenario | Users | Need Workers? |
|---|---|---|
| Single user, small docs | 1 | No |
| Few users, occasional uploads | 2-5 | Optional |
| Many concurrent uploads | 5+ | **Yes** — embedding blocks the loop |
| Many users asking questions | 10+ | **Yes** — query embedding blocks briefly |
| Just streaming LLM responses | Any | No — pure I/O, never blocks |

### Summary

- **Streaming never blocks** — each `await` yields to the event loop
- **10+ users can stream simultaneously** — it's all interleaved I/O
- **`createEmbedding()` is the only real bottleneck** — ~50-200ms of CPU per call
- **Worker threads fix the bottleneck** without affecting streaming
- **No need for clustering** unless you exceed one CPU core's capacity for embeddings

---

## Priority Roadmap

Ordered by **impact-to-effort ratio** (do these first):

| Priority | Improvement | Effort | Impact |
|---|---|---|---|
| 🔴 1 | Better prompt engineering (#4) | 30 min | High |
| 🔴 2 | Sentence-aware chunking (#1) | 1 hour | High |
| 🔴 3 | Security fixes (#11) | 2 hours | Critical |
| 🟡 4 | Score threshold filtering (#3) | 15 min | Medium |
| 🟡 5 | Metadata in payloads (#7) | 1 hour | Medium |
| 🟡 6 | Chat persistence (#9) | 1 hour | Medium |
| 🟡 7 | Embedding cache & warmup (#10) | 1 hour | Medium |
| 🟢 8 | Upgrade LLM model (#5) | 30 min | High (if hardware allows) |
| 🟢 9 | Upgrade embedding model (#2) | 1 hour | Medium |
| 🟢 10 | Re-ranking (#6) | 3 hours | High |
| 🟢 11 | Multi-document filtering (#8) | 2 hours | Medium |

---

*Start with items 1-3 for the biggest quality jump with minimal effort.*
