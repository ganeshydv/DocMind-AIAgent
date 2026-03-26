# RAG Pipeline Deep Dive: Embeddings, Chunking & Vector Search

## Table of Contents

- [The Bug We Hit](#the-bug-we-hit)
- [What Are Embeddings?](#what-are-embeddings)
- [Embedding Dimensions Explained](#embedding-dimensions-explained)
- [Mean Pooling — Why It Matters](#mean-pooling--why-it-matters)
- [Text Chunking — The Heart of RAG](#text-chunking--the-heart-of-rag)
  - [Why Chunk At All?](#why-chunk-at-all)
  - [Chunk Size](#chunk-size)
  - [Overlap](#overlap)
  - [Chunking Strategies](#chunking-strategies)
- [Vector Search — How Qdrant Finds Answers](#vector-search--how-qdrant-finds-answers)
- [The Full Picture](#the-full-picture)

---

## The Bug We Hit

```
Qdrant search error: {
  status: { error: 'Vector dimension error: expected dim: 384, got 2304' }
}
```

### What Happened

We created a Qdrant collection expecting **384-dimensional** vectors (because `all-MiniLM-L6-v2` outputs 384 dims). But our `createEmbedding()` was returning **2304** numbers.

**Why 2304?** The model doesn't output a single vector — it outputs one vector **per token** (word piece). For example, the sentence `"Hello world"` might be split into 6 tokens, and each token gets a 384-dim vector:

```
Tokens:  [CLS]  Hello  world  [SEP]  [PAD]  [PAD]
Vectors:  384  + 384  + 384  + 384  + 384  + 384  = 2304 total numbers
```

Without pooling, `output.data` is a flat array of all 2304 values — which is meaningless as a single embedding.

### The Fix

```javascript
// ❌ BEFORE — returns raw tensor (tokens × 384 = 2304 numbers)
const output = await model(text);
return Array.from(output.data);

// ✅ AFTER — mean pools across tokens → single 384-dim vector
const output = await model(text, { pooling: "mean", normalize: true });
return Array.from(output.data);
```

| Option        | What It Does                                                       |
|---------------|--------------------------------------------------------------------|
| `pooling: "mean"` | Averages all token vectors into one vector (384 dims)          |
| `normalize: true` | Scales the vector to unit length (length = 1.0) for cosine similarity |

---

## What Are Embeddings?

An **embedding** is a list of numbers (a vector) that represents the **meaning** of text in a form that computers can compare mathematically.

```
"JavaScript developer"  →  [0.12, -0.45, 0.78, ..., 0.33]   (384 numbers)
"Node.js programmer"    →  [0.11, -0.43, 0.76, ..., 0.31]   (384 numbers)  ← similar!
"Pizza recipe"          →  [-0.56, 0.22, -0.11, ..., 0.89]  (384 numbers)  ← very different
```

Texts with similar **meaning** end up with similar vectors (close together in 384-dimensional space), even if they use completely different words.

### Why Not Just Use Keyword Search?

| Query                | Keyword search finds         | Embedding search finds        |
|----------------------|------------------------------|-------------------------------|
| "JS experience"      | Documents with "JS"          | Documents about JavaScript, Node.js, React |
| "backend developer"  | Documents with "backend"     | Documents about Node.js, APIs, databases   |

Embeddings understand **semantics**, not just exact word matches.

---

## Embedding Dimensions Explained

The **dimension** is how many numbers are in each vector. Think of it as how detailed the model's understanding is.

| Model                       | Dimensions | Quality    | Speed   |
|-----------------------------|-----------|------------|---------|
| `all-MiniLM-L6-v2` (ours)  | 384       | Good       | Fast    |
| `all-mpnet-base-v2`         | 768       | Better     | Slower  |
| OpenAI `text-embedding-3-small` | 1536  | Very good  | API call |
| OpenAI `text-embedding-3-large` | 3072  | Best       | API call |

**Key rule:** The collection dimension in Qdrant **must exactly match** the model's output dimension. If your model outputs 384 dims, the collection must be created with `size: 384`.

```javascript
// This MUST match your embedding model's output dimension
await axios.put(`${BASE_URL}/collections/${collection}`, {
  vectors: { size: 384, distance: "Cosine" },
});
```

---

## Mean Pooling — Why It Matters

### The Problem: Token-Level vs Sentence-Level

Transformer models process text as **tokens** (sub-word pieces), not sentences. The raw output is a matrix:

```
Input:  "I love Node.js"

Tokenization: ["[CLS]", "I", "love", "Node", ".", "js", "[SEP]"]
                 ↓       ↓     ↓      ↓     ↓    ↓      ↓
               [384]   [384] [384]  [384]  [384] [384]  [384]

Raw output shape: 7 tokens × 384 dimensions = 2688 numbers
```

We need **one** 384-dim vector for the entire text. That's where **pooling** comes in.

### Pooling Strategies

| Strategy     | How It Works                              | Quality  |
|-------------|-------------------------------------------|----------|
| **Mean pooling** | Average all token vectors element-wise  | Best for most cases |
| CLS pooling  | Just take the `[CLS]` token's vector      | Simpler but worse |
| Max pooling   | Take the max value per dimension          | Rarely used |

**Mean pooling example** (simplified to 4 dims):

```
Token 1: [0.1, 0.5, 0.3, 0.8]
Token 2: [0.3, 0.7, 0.1, 0.6]
Token 3: [0.2, 0.3, 0.5, 0.4]

Mean:    [0.2, 0.5, 0.3, 0.6]  ← one vector representing the whole text
```

### Normalization

After pooling, we **normalize** the vector (scale it so its length = 1.0). This is important for **cosine similarity** — the distance metric we use in Qdrant.

```
Before normalization: [0.2, 0.5, 0.3, 0.6]  (length = 0.86)
After normalization:  [0.23, 0.58, 0.35, 0.70]  (length = 1.0)
```

Without normalization, longer texts could produce vectors with larger magnitudes, biasing the similarity scores.

---

## Text Chunking — The Heart of RAG

### Why Chunk At All?

Embedding models have a **token limit** (typically 256–512 tokens). If you feed a 10-page PDF as one string:

1. The model **truncates** it — losing most of the content
2. Even if it fit, the embedding would be too **generic** — averaging the meaning of 10 different topics into one vector

Chunking splits the text so each piece is:
- Small enough for the model
- Focused on **one topic/idea** — making search accurate

### Chunk Size

Our code uses `size = 500` (characters):

```javascript
function chunkText(text, size = 500, overlap = 100) { ... }
```

**Trade-offs:**

| Chunk Size | Pros                          | Cons                              |
|-----------|-------------------------------|-----------------------------------|
| Small (200-300) | Very precise search results | May split sentences mid-thought |
| Medium (500-800) | Good balance               | Standard choice                  |
| Large (1000-2000) | Preserves full context    | Dilutes specific info, may exceed model limit |

**Example — small vs large chunks:**

```
Resume text: "Ganesh has 3 years experience in Node.js. He built REST APIs
using Express and NestJS. He also worked with DynamoDB and PostgreSQL.
His latest project involved microservices architecture with Docker and
Kubernetes deployment on AWS."
```

**Small chunks (200 chars):**
```
Chunk 1: "Ganesh has 3 years experience in Node.js. He built REST APIs using Express and NestJS."
Chunk 2: "He also worked with DynamoDB and PostgreSQL. His latest project involved microservices"
Chunk 3: "architecture with Docker and Kubernetes deployment on AWS."
```
→ Question "What databases?" → Chunk 2 is a perfect match ✓

**One big chunk (all 500 chars):**
→ Question "What databases?" → Gets everything including irrelevant stuff about Docker ✗

### Overlap

**Overlap = the number of characters shared between consecutive chunks.**

Our code: `overlap = 100`

```
Text: "AAAA BBBB CCCC DDDD EEEE FFFF"

Without overlap (size=10):
  Chunk 1: "AAAA BBBB "
  Chunk 2: "CCCC DDDD "     ← context is lost between chunks
  Chunk 3: "EEEE FFFF"

With overlap of 5 (size=10):
  Chunk 1: "AAAA BBBB "
  Chunk 2: "BBBB CCCC "     ← shares "BBBB" with chunk 1
  Chunk 3: "CCCC DDDD "     ← shares "CCCC" with chunk 2
  Chunk 4: "DDDD EEEE "
  Chunk 5: "EEEE FFFF"
```

**Why overlap?** Without it, if a sentence spans two chunks, neither chunk has the full sentence and search may miss it.

```
Without overlap — sentence split:
  Chunk 1: "...He has experience in"
  Chunk 2: "Node.js and Express..."
  → Question "What is his experience?" may not match either chunk well

With overlap — sentence preserved:
  Chunk 1: "...He has experience in Node.js"
  Chunk 2: "experience in Node.js and Express..."
  → Chunk 2 has the full thought ✓
```

**Overlap trade-off:**

| Overlap | Pros                    | Cons                         |
|---------|-------------------------|------------------------------|
| 0       | Fewer chunks, less storage | May break sentences         |
| 10-20%  | Good balance             | Standard choice             |
| 50%+    | Very safe, no info loss  | Too many duplicate chunks   |

Our `100 / 500 = 20%` overlap is a solid default.

### Chunking Strategies

Our app uses the simplest approach (**fixed-size character splitting**). Here are all common strategies, from simple to advanced:

#### 1. Fixed-Size (What We Use)

```javascript
// Simple sliding window
for (let i = 0; i < text.length; i += size - overlap) {
  chunks.push(text.slice(i, i + size));
}
```
- **Pros:** Simple, predictable chunk count
- **Cons:** May split mid-word or mid-sentence

#### 2. Sentence-Based

```javascript
// Split on sentence boundaries
const sentences = text.split(/(?<=[.!?])\s+/);
let chunk = "";
for (const sentence of sentences) {
  if ((chunk + sentence).length > maxSize) {
    chunks.push(chunk);
    chunk = "";
  }
  chunk += sentence + " ";
}
```
- **Pros:** Never splits sentences
- **Cons:** Uneven chunk sizes

#### 3. Paragraph / Section-Based

Split on `\n\n` or headings — keeps logical sections together. Best for structured documents like resumes.

#### 4. Recursive (LangChain-style)

Try splitting by `\n\n` first, then `\n`, then `. `, then ` `, then characters. Falls back to smaller separators only when chunks are too large.

#### 5. Semantic Chunking

Use embeddings to detect topic shifts — start a new chunk when the meaning changes significantly. Most accurate but slowest.

**For resumes:** Paragraph-based or recursive chunking is ideal since resumes have clear sections (Skills, Experience, Education).

---

## Vector Search — How Qdrant Finds Answers

### Distance Metrics

When you create a collection, you choose how "similarity" is calculated:

```javascript
vectors: { size: 384, distance: "Cosine" }
```

| Metric      | What It Measures          | Best For                    |
|-------------|---------------------------|-----------------------------|
| **Cosine**  | Angle between vectors     | Text similarity (our choice) |
| Euclid      | Straight-line distance    | When magnitude matters       |
| Dot product | Combined angle + magnitude | Normalized vectors          |

**Cosine similarity:**
```
"Node.js developer" · "JavaScript programmer" = 0.92  (very similar)
"Node.js developer" · "Italian cooking"       = 0.11  (very different)
```

### How Search Works

```
1. Question: "What databases does Ganesh know?"
                    ↓
2. Embed question → [0.12, -0.45, 0.78, ..., 0.33]  (384 dims)
                    ↓
3. Qdrant compares this vector against ALL stored chunk vectors
                    ↓
4. Returns top 3 closest chunks:
   - "He also worked with DynamoDB and PostgreSQL" (score: 0.89)
   - "Database DynamoDB, RDS"                      (score: 0.85)
   - "Built REST APIs with Express"                (score: 0.34)
                    ↓
5. Top chunks become the "context" sent to the LLM
```

### The `limit: 3` Parameter

```javascript
{ query: vector, limit: 3, with_payload: true }
```

| Limit | Pros                     | Cons                           |
|-------|--------------------------|--------------------------------|
| 1-2   | Very focused context     | May miss relevant info         |
| 3-5   | Good balance             | Standard choice                |
| 10+   | Comprehensive            | May include irrelevant chunks, uses more LLM tokens |

---

## The Full Picture

```
                        RAG Pipeline
                        
  ┌─────────────────── UPLOAD FLOW ───────────────────┐
  │                                                    │
  │  PDF → Extract Text → Chunk (500 chars, 100 overlap)
  │                           │                        │
  │                    ┌──────┴──────┐                 │
  │                    │  Chunk 1    │                 │
  │                    │  Chunk 2    │  → Embed each   │
  │                    │  Chunk 3    │    (384 dims)   │
  │                    │  ...        │                 │
  │                    └──────┬──────┘                 │
  │                           │                        │
  │                     Store in Qdrant                │
  │                   (per-user collection)             │
  └────────────────────────────────────────────────────┘

  ┌──────────────────── ASK FLOW ─────────────────────┐
  │                                                    │
  │  Question → Embed (384 dims)                       │
  │               │                                    │
  │         Vector search in                           │
  │         user's collection                          │
  │               │                                    │
  │         Top 3 chunks                               │
  │               │                                    │
  │         Build prompt:                              │
  │         "Answer ONLY from context:                 │
  │          {chunk1} {chunk2} {chunk3}                │
  │          Question: {user's question}"              │
  │               │                                    │
  │          Send to LLM                               │
  │          (stream tokens back)                      │
  │               │                                    │
  │          Streaming answer → User                   │
  └────────────────────────────────────────────────────┘
```

### Key Takeaways

1. **Embedding dimension must match everywhere** — model output, vector DB collection, and search query must all be the same dimension (384 in our case)
2. **Always use mean pooling + normalization** for sentence embeddings
3. **Chunk size is a trade-off** — too small loses context, too large dilutes relevance
4. **Overlap prevents information loss** at chunk boundaries (20% is a good default)
5. **Per-user collections** ensure complete data isolation
6. **Cosine similarity** is the standard choice for text search
