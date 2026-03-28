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
- [Text Cleaning Before Embedding](#text-cleaning-before-embedding)
- [Chunk Size vs Embedding Dimensions — A Common Misconception](#chunk-size-vs-embedding-dimensions--a-common-misconception)
- [How Chunk Size Shapes Response Accuracy](#how-chunk-size-shapes-response-accuracy)

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

---

## Text Cleaning Before Embedding

Raw text from PDFs, DOCX, and other formats often contains noise that degrades embedding quality. The embedding model wastes attention on meaningless tokens instead of the actual content.

### Why Clean?

| Noise Type | Example | Problem |
|-----------|---------|---------|
| Extra whitespace | `"Hello     world"` | Wastes tokens on spaces |
| Repeated newlines | `"\n\n\n\n\n"` | Empty tokens dilute the embedding |
| Control characters | `\x00`, `\x0B` | Invisible garbage the model can't interpret |
| PDF artifacts | Page numbers, headers/footers repeated on every page | Pollutes every chunk with the same irrelevant info |
| Unicode replacement chars | `\ufffd` | Failed encoding conversions |

### Recommended Preprocessing

```javascript
function cleanText(text) {
  return text
    .replace(/\r\n/g, '\n')                           // normalize line endings
    .replace(/\n{3,}/g, '\n\n')                        // collapse 3+ newlines → 2
    .replace(/[ \t]{2,}/g, ' ')                        // collapse multiple spaces/tabs
    .replace(/[^\S\n]+/g, ' ')                         // normalize whitespace (keep newlines)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')    // remove control chars
    .trim();
}
```

**Important:** Do NOT remove all spaces or strip punctuation — the model needs natural language structure (sentence boundaries, commas, periods) to understand meaning correctly.

### Before vs After Cleaning

```
BEFORE (raw PDF extract):
"   \n\n\n\nPage 3\n\n   The patient was    prescribed   metformin\x00 500mg\n\n\n\n\n"

AFTER (cleaned):
"Page 3\n\nThe patient was prescribed metformin 500mg"
```

The cleaned version produces a significantly better embedding because every token carries actual meaning.

---

## Chunk Size vs Embedding Dimensions — A Common Misconception

These two concepts are **completely independent**:

| Concept | What It Is | Value in Our App |
|---------|-----------|-----------------|
| **Chunk size** (500 chars) | How much **text input** you feed into the model | Variable — you choose it |
| **Embedding dimensions** (384) | The **vector output** size — fixed by model architecture | Fixed — set by the model |

### How the Model Works Internally

The embedding model is a neural network that takes text of **any length** and **always** outputs a **384-dimensional vector**:

```
Input: "Hello world" (11 chars, ~3 tokens)
  ↓ tokenize
  [CLS] Hello world [SEP]          → 4 tokens
  ↓ 6 transformer layers
  4 token vectors, each 384-dim    → shape: [4, 384]
  ↓ mean pooling (average across tokens)
  1 vector, 384-dim                → shape: [384]
  ↓ normalize
  Output: [0.023, -0.156, ..., 0.089]   (always 384 numbers)

Input: "The patient was prescribed metformin..." (500 chars, ~100 tokens)
  ↓ tokenize
  100 tokens                       → 100 tokens
  ↓ 6 transformer layers
  100 token vectors, each 384-dim  → shape: [100, 384]
  ↓ mean pooling
  1 vector, 384-dim                → shape: [384]
  ↓ normalize
  Output: [0.112, -0.034, ..., 0.201]   (always 384 numbers)
```

The 384 dimensions of the vector collection in Qdrant must match the model's output — but they have **nothing to do with** how much text you feed in.

### Token Limit Matters, Not Char Count

`all-MiniLM-L6-v2` has a **max token limit of 256 tokens** (~1000–1200 characters). Text beyond this is **silently truncated** — the model simply ignores the rest.

```
"A 2000-character paragraph..."
  ↓ tokenize → 400 tokens
  ↓ TRUNCATED to 256 tokens (~first 1200 chars)
  ↓ rest is silently lost
```

Our 500-char chunks produce ~80–120 tokens — safely within the 256-token limit.

---

## How Chunk Size Shapes Response Accuracy

Chunk size directly impacts **retrieval precision**, **context quality**, and ultimately **LLM answer accuracy**.

### Scenario: Medical Document

```
Full text: "The patient was diagnosed with type 2 diabetes in 2021.
Prescribed metformin 500mg twice daily. Blood glucose improved from
180 to 120 mg/dL over 3 months. Patient also has allergies to
penicillin. Family history includes heart disease. Regular exercise
program recommended — 30 min walking daily."
```

### Too Small (100 chars)

```
Chunk 1: "The patient was diagnosed with type 2 diabetes in 2021. Prescribed metformin 500mg twi"
Chunk 2: "ce daily. Blood glucose improved from 180 to 120 mg/dL over 3 months. Patient also ha"
Chunk 3: "s allergies to penicillin. Family history includes heart disease. Regular exercise pro"
```

- **Embedding**: Very specific, narrow meaning per chunk
- **Search**: High precision — finds exact keyword matches
- **Problem**: Sentence split mid-word ("twi" / "ce daily"), context lost
- **LLM gets**: Fragmented snippets, can't form coherent answers
- **Result**: Accurate retrieval but **poor, incomplete answers**

### Too Large (2000 chars)

```
Chunk 1: [entire document as one chunk]
```

- **Embedding**: Diluted — diabetes, allergies, family history, exercise all compressed into 384 dims
- **Search**: Matches broadly but **less precisely** — the metformin signal is drowned by allergy/exercise info
- **LLM gets**: Lots of context but much of it irrelevant to the question
- **Result**: **Noisy retrieval**, LLM may hallucinate from unrelated content in the chunk

### Sweet Spot (500 chars — our setting)

```
Chunk 1: "The patient was diagnosed with type 2 diabetes in 2021. Prescribed metformin 500mg
          twice daily. Blood glucose improved from 180 to 120 mg/dL over 3 months."
Chunk 2: "Patient also has allergies to penicillin. Family history includes heart disease.
          Regular exercise program recommended — 30 min walking daily."
```

- **Embedding**: Each chunk captures a **coherent semantic unit** (treatment vs. history)
- **Search**: Precise enough to match "what medication?" → Chunk 1, broad enough to include dosage + results
- **LLM gets**: Focused, relevant passages
- **Result**: **Best balance** of precision and context

### How 384 Dimensions Encode 500 Characters

When the model compresses 500 chars into 384 numbers, it distributes meaning across all dimensions. Conceptually:

```
500-char chunk about diabetes medication
  ↓ tokenize → ~100 tokens
  ↓ 6 transformer layers (attention mechanism)
  ↓ mean pool all token vectors → 384 dims
  ↓
384-dim vector — meaning distributed across ALL dimensions:
  • Some dimensions activate for "medical" domain
  • Some dimensions activate for "medication/treatment" topic
  • Some dimensions encode "diabetes" specifics
  • Some dimensions capture "dosage + outcome" relationships
  • Remaining dimensions encode nuance, tone, context
```

> **Note:** Dimensions aren't actually this cleanly separated — meaning is distributed across all 384 dims. But the visualization helps understand how a fixed-size vector can capture variable-length text.

### The Overlap Factor

Our 100-char overlap (20% of chunk size) ensures key sentences spanning chunk boundaries appear in both chunks:

```
Chunk 1: "...diagnosed with type 2 diabetes. Prescribed metformin 500mg"  ← overlap zone →
Chunk 2: "Prescribed metformin 500mg twice daily. Blood glucose improved..."
```

Without overlap, the connection between "diabetes diagnosis" and "metformin prescription" could be lost if the boundary falls between them.

### Chunk Size Decision Matrix

| Chunk Size | Tokens (~) | Precision | Context | Best For |
|-----------|-----------|-----------|---------|----------|
| 100–200 chars | 20–50 | ★★★★★ | ★☆☆☆☆ | FAQ, definitions, short facts |
| 300–500 chars | 60–120 | ★★★★☆ | ★★★☆☆ | **General purpose RAG (our choice)** |
| 500–800 chars | 100–200 | ★★★☆☆ | ★★★★☆ | Narrative text, legal docs |
| 1000+ chars | 200+ | ★★☆☆☆ | ★★★★★ | Long-form analysis (⚠️ may hit token limit) |

### Our Current Settings

```javascript
// services/chunk.js
function chunkText(text, size = 500, overlap = 100) { ... }
```

| Setting | Value | Why |
|---------|-------|-----|
| Size | 500 chars | Within 256-token limit, captures coherent ideas |
| Overlap | 100 chars (20%) | Prevents boundary information loss |
| Model max tokens | 256 | 500 chars ≈ 100 tokens — safely within limit |
| Output dims | 384 | Fixed by all-MiniLM-L6-v2 architecture |
