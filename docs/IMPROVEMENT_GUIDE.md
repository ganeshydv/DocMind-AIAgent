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
- [13. Process Pool Architecture (Implemented)](#13-process-pool-architecture-implemented)
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
| **Single process** | Node.js single-threaded | ✅ **Done** — Process pool for CPU-intensive embedding (see [§13](#13-process-pool-architecture-implemented)) |
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

### Worker Threads vs. Child Processes — When and Why

CPU-heavy work (ONNX model inference, PDF parsing) blocks the Node.js event loop. There are two ways to offload it:

| Approach | Isolation | Overhead | Crash Safety |
|---|---|---|---|
| `worker_threads` | Shared memory (lightweight) | Low (~5MB per thread) | ❌ Native bindings can crash the main process |
| `child_process.fork()` | Full process isolation | High (~50-100MB per process) | ✅ Child crash doesn't affect the main process |

**Why we use `fork()` instead of `worker_threads`:**
`@xenova/transformers` uses native ONNX bindings. When a worker thread using these bindings exits, it can crash the entire main process. `fork()` gives full process isolation — a child crash is harmless.

**Without process pool (old):**
```
Upload 1 → fork() → new process (model load ~5s, 100MB, exit)
Upload 2 → fork() → new process (model load ~5s, 100MB, exit)
Upload 3 → fork() → new process (model load ~5s, 100MB, exit)
                     3 processes × 100MB = 300MB, model loaded 3 times
```

**With process pool (current — implemented):**
```
Server start → pool.start() → pre-fork 3 workers (model loads once each)
Upload 1 → pool.run() → Worker A (already warm, model cached) ✅
Upload 2 → pool.run() → Worker B (already warm) ✅
Upload 3 → pool.run() → Worker C (already warm) ✅
Upload 4 → pool.run() → queued → dispatched when A/B/C finishes
```

See [§13](#13-process-pool-architecture-implemented) for the full implementation details.

### Summary

- **Streaming never blocks** — each `await` yields to the event loop
- **10+ users can stream simultaneously** — it's all interleaved I/O
- **`createEmbedding()` is the only real bottleneck** — ~50-200ms of CPU per call
- **Process pool fixes the bottleneck** — fixed memory, reused workers, no model reload
- **No need for clustering** unless you exceed one CPU core's capacity for embeddings

---

## 13. Process Pool Architecture (Implemented)

> **Status: ✅ Implemented** in `services/process-pool.js`, `services/process-worker.js`, `app.js`

### Problem: Fork-per-Upload

The original design called `fork()` for every upload. Each forked process:
- Created its own Redis connection (wasteful multiplied connections)
- Loaded the ~30MB ONNX embedding model from scratch (~1-5s init)
- Allocated a full V8 heap (~50-100MB)
- Exited after one job (all that setup thrown away)

10 concurrent uploads → 10 processes → 1GB+ RAM, 10 Redis connections, 10 model loads.

### Solution: Fixed-Size Process Pool

```
┌─────────────────────────────────────────────────────────────┐
│  Main Process (app.js)                                      │
│                                                             │
│  Express server ◄──── HTTP requests                         │
│       │                                                     │
│       ▼                                                     │
│  ProcessPool ─── onMessage callback ──► Redis (1 connection)│
│   │   │   │                                                 │
│   IPC IPC IPC   (Node IPC channel, no network)              │
│   │   │   │                                                 │
├───┼───┼───┼─────────────────────────────────────────────────┤
│   ▼   ▼   ▼                                                 │
│  Worker Worker Worker   (pre-forked, long-lived)            │
│  PID 1 PID 2  PID 3                                        │
│                                                             │
│  Each worker:                                               │
│  • ONNX model loaded once, reused across all jobs           │
│  • ZERO Redis connections                                   │
│  • Communicates via IPC only                                │
│  • Stays alive between jobs                                 │
│  • Auto-respawned if it crashes                             │
└─────────────────────────────────────────────────────────────┘
```

### Key Files

| File | Role |
|---|---|
| `services/process-pool.js` | Pool manager — pre-forks workers, dispatches jobs, manages queue, auto-respawns crashed workers |
| `services/process-worker.js` | Long-lived worker — handles document processing (extract → chunk → embed → insert), stays alive between jobs |
| `app.js` | Creates pool at startup, routes IPC messages to Redis, dispatches uploads via `pool.run()` |

### IPC Message Protocol

All Redis operations are handled by the **main process only**. Workers have zero Redis connections.

| Direction | Message | Purpose |
|---|---|---|
| Main → Worker | `{ type: 'start', uploadId, userId, fileName, totalChunks }` | Start processing a document |
| Worker → Main | `{ type: 'status', uploadId, status: { stage, progress, total } }` | Update processing progress in Redis |
| Worker → Main | `{ type: 'setDocId', uploadId, docId }` | Store document ID in Redis |
| Worker → Main | `{ type: 'done' }` | Job complete — return worker to idle pool |
| Worker → Main | `{ type: 'error', error }` | Job failed — return worker to idle pool |

### Configuration

| Env Variable | Default | Description |
|---|---|---|
| `WORKER_POOL_SIZE` | `os.cpus().length - 1` (min 1) | Number of pre-forked worker processes |

### Resource Comparison

| Metric | Fork-per-Upload (old) | Process Pool (current) |
|---|---|---|
| Processes for 10 uploads | 10 | Fixed (e.g. 3) |
| Redis connections | 10 extra | 0 extra (main only) |
| ONNX model loads | 10 times | 3 times (once per worker) |
| Peak memory (10 uploads) | ~1GB+ | ~300MB (fixed) |
| Excess upload handling | OOM risk | Queued, bounded |
| Worker crash impact | Lost, no recovery | Auto-respawned |

### Lifecycle

1. **Server start** → `pool.start()` pre-forks N workers
2. **Upload complete** → `pool.run(job)` dispatches to an idle worker (or queues if all busy)
3. **Worker finishes** → returned to idle set, next queued job dispatched immediately
4. **Worker crashes** → auto-respawned, pending job promise rejected
5. **Server shutdown** → `pool.shutdown()` sends SIGTERM to all workers

### Gotcha: Graceful Shutdown Hanging

**Problem encountered:** After pressing Ctrl+C, the server printed `Shutting down…` and `[Pool] All workers terminated` repeatedly but never actually exited. The process was stuck.

**Root causes:**

1. **No re-entry guard** — `SIGINT` fires on every Ctrl+C press, so the shutdown handler ran multiple times in parallel.
2. **`server.close()` doesn't force-exit** — it only stops accepting new connections. Existing connections (SSE streams, keep-alive) keep the event loop alive indefinitely.
3. **Child process references** — even after `pool.shutdown()`, lingering process references can prevent Node.js from exiting.

**Fix applied in `app.js`:**

```javascript
let shuttingDown = false;
async function gracefulShutdown() {
  if (shuttingDown) return;        // 1. Run only once
  shuttingDown = true;
  console.log("Shutting down…");
  await pool.shutdown();
  server.close(() => {
    console.log("Server closed");
    process.exit(0);               // 2. Explicitly exit when all connections drain
  });
  setTimeout(() => {
    console.warn("Forcing exit (connections did not close in time)");
    process.exit(1);               // 3. Force exit after 5s if connections hang
  }, 5000);
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
```

**Key takeaway:** Always call `process.exit()` in Node.js shutdown handlers — `server.close()` alone is not enough when you have SSE streams, keep-alive connections, or child process references.

### Gotcha: Worker Respawn Loop on Windows (Ctrl+C)

**Problem encountered:** On startup the pool spawned 15 workers (on a 16-core machine). When pressing Ctrl+C, the terminal flooded with repeating `[Pool] All workers terminated` / `Shutting down…` messages and never exited.

**Root cause — Windows SIGINT process group behavior:**

On Windows, Ctrl+C sends `SIGINT` to the **entire process group** (parent + all children) simultaneously. This means:

```
Ctrl+C pressed
  → OS sends SIGINT to parent AND 15 children at the same time
  → Children die immediately (exit handlers fire)
  → Parent's SIGINT handler hasn't run yet → _shutdown is still false
  → exit handlers see _shutdown === false → respawn new workers!
  → New workers immediately receive the pending SIGINT → die → respawn
  → Infinite crash-respawn loop
  → Parent's SIGINT handler finally runs → calls pool.shutdown()
  → But by now there are dozens of workers cycling through spawn/die
```

**Three fixes applied:**

1. **Pool size capped at 4** — 15 workers was excessive. Document processing is mostly I/O (Qdrant HTTP, file reads), not CPU-bound enough to justify 15 processes. Each worker loads the ONNX model (~50-100MB), so 15 workers wasted ~1.5GB RAM.

   ```javascript
   // process-pool.js — constructor
   this.size = Math.max(1, Math.min(size || Math.min(os.cpus().length - 1, 4), 4));
   ```

2. **Skip respawn when child was killed by a signal** — If the child exited due to a signal (`SIGINT`, `SIGTERM`), it wasn't a crash — don't respawn. Only respawn on unexpected exits (non-zero code, no signal).

   ```javascript
   // process-pool.js — on('exit') handler
   child.on("exit", (code, signal) => {
     // ...
     if (!this._shutdown && !signal) {  // ← skip if killed by signal
       this._spawnWorker();
     }
   });
   ```

3. **Set `_shutdown = true` synchronously before async shutdown** — Ensures any in-flight exit handlers see the flag immediately, even if they fire before `pool.shutdown()` resolves.

   ```javascript
   // app.js — gracefulShutdown()
   pool._shutdown = true;   // stop respawn immediately (synchronous)
   await pool.shutdown();   // then kill workers (async)
   ```

**Key takeaway:** On Windows, `SIGINT` is broadcast to the entire process group. Always guard child process respawn logic against signal-based exits, and set shutdown flags synchronously before any async cleanup.

**Impact:** High — bounded memory, no model reload overhead, no connection sprawl, crash resilience.

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
