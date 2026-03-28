# 🤖 AiHelper — Document Q&A with RAG

A full-stack **Retrieval-Augmented Generation (RAG)** application. Upload any document (PDF, DOCX, Excel, TXT, etc.), and ask natural-language questions — get AI-powered answers grounded in your document content, streamed in real-time.

![Node.js](https://img.shields.io/badge/Node.js-Express-green)
![React](https://img.shields.io/badge/React-19-blue)
![Qdrant](https://img.shields.io/badge/Qdrant-Vector%20DB-red)
![Redis](https://img.shields.io/badge/Redis-7-orange)

---

## ✨ Features

- **Multi-format document support** — PDF, DOCX, Excel (.xlsx/.xls), TXT, Markdown, CSV, JSON, HTML, XML
- **Resumable chunked uploads** — 1 MB chunks with resume support for interrupted uploads
- **Per-user data isolation** — each user gets a separate Qdrant vector collection
- **Per-document filtering** — search across all docs or target a specific one
- **Real-time streaming** — both upload progress and LLM responses stream via SSE
- **Dual LLM providers** — local Ollama or cloud LLM Gateway, switchable from the UI
- **Document management** — list, select, and delete uploaded documents
- **Dark-mode UI** — clean React interface with chat history

---

## 🏗️ Architecture

```
┌──────────────┐       HTTP/SSE     ┌──────────────┐
│  React SPA   │ ◄────────────────► │  Express API  │
│  (Vite)      │                    │  (port 3000)  │
│  port 5173   │                    └──────┬────────┘
└──────────────┘                           │
                            ┌──────────────┼──────────────┐
                            ▼              ▼              ▼
                      ┌──────────┐  ┌──────────┐  ┌──────────────┐
                      │  Redis   │  │  Qdrant  │  │ LLM Provider │
                      │  :6379   │  │  :6333   │  │ Ollama / GW  │
                      └──────────┘  └──────────┘  └──────────────┘
```

### Data Flow

**Upload:**
```
Document → Chunked Upload → Extract Text → Split into 500-char chunks
  → Embed (384-dim, all-MiniLM-L6-v2) → Store in Qdrant
```

**Ask:**
```
Question → Embed → Qdrant cosine search (top 5) → Build prompt with context
  → LLM generates answer → Stream tokens to browser
```

---

## 📋 Prerequisites

- **Node.js** v18+
- **Docker & Docker Compose** (for Qdrant and Redis)
- **Ollama** (optional, for local LLM) — [Install Ollama](https://ollama.ai)

---

## 🚀 Setup

### 1. Clone the repo

```bash
git clone https://github.com/<your-username>/AiHelper.git
cd AiHelper
```

### 2. Start infrastructure (Qdrant + Redis)

```bash
docker compose up -d
```

This starts:
- **Qdrant** vector database on port `6333`
- **Redis** on port `6379`

### 3. Configure environment

Create a `.env` file in the root:

```env
# LLM Provider: "ollama" or "gateway"
LLM_PROVIDER=gateway

# Ollama (local) — only needed if using Ollama
OLLAMA_URL=http://localhost:11434/api/generate
OLLAMA_MODEL=llama3.2:3b

# LLM Gateway (cloud — free tier)
LLM_GATEWAY_URL=https://api.llmgateway.io/v1/chat/completions
LLM_GATEWAY_KEY=your_gateway_api_key_here
LLM_GATEWAY_MODEL=auto

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
```

### 4. Install backend dependencies

```bash
npm install
```

### 5. Install frontend dependencies

```bash
cd frontend
npm install
cd ..
```

### 6. (Optional) Pull Ollama model

Only needed if you want to use the local LLM:

```bash
ollama pull llama3.2:3b
```

### 7. Start the app

**Backend** (from project root):
```bash
node app.js
```
→ Server running on `http://localhost:3000`

**Frontend** (in a separate terminal):
```bash
cd frontend
npm run dev
```
→ UI available at `http://localhost:5173`

---

## 📖 Usage

1. **Enter a User ID** — each user gets an isolated knowledge base
2. **Upload a document** — drag/drop or select any supported file type
3. **Wait for processing** — watch real-time progress (extracting → chunking → embedding)
4. **Ask questions** — type a question and get streamed AI answers based on your document
5. **Switch LLM provider** — toggle between 🖥️ Ollama (local) and ☁️ Gateway (cloud) in the header
6. **Filter by document** — use the dropdown to search within a specific doc or across all

---

## 📁 Project Structure

```
├── app.js                  # Express API — routes & processing pipeline
├── docker-compose.yml      # Qdrant + Redis containers
├── package.json            # Backend dependencies
├── .env                    # Environment config
├── services/
│   ├── pdf.js              # Universal text extractor (PDF, DOCX, Excel, TXT...)
│   ├── chunk.js            # Text chunker (500-char, 100-char overlap)
│   ├── embedding.js        # Local embeddings (all-MiniLM-L6-v2, 384-dim)
│   ├── vector.js           # Qdrant client (collections, insert, search, delete)
│   ├── llm.js              # Dual LLM streaming (Ollama + Gateway)
│   ├── upload.js           # Chunked upload manager (Redis-backed)
│   └── redis.js            # Redis connection singleton
├── frontend/
│   ├── src/
│   │   ├── App.jsx         # Main React component (upload, chat, doc management)
│   │   ├── App.css         # Dark-mode styles
│   │   └── main.jsx        # React entry point
│   ├── index.html
│   ├── vite.config.js
│   └── package.json
├── uploads/                # Temporary upload storage (auto-cleaned)
├── qdrant_storage/         # Qdrant persistent data (Docker volume)
└── docs/
    ├── RAG_DEEP_DIVE.md    # Technical deep-dive on embeddings & vector search
    └── IMPROVEMENT_GUIDE.md # Roadmap for improving response quality
```

---

## 🔌 API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/upload/init` | POST | Initialize chunked upload session |
| `/upload/chunk/:uploadId/:chunkIndex` | POST | Upload a single binary chunk |
| `/upload/resume/:uploadId` | GET | Get upload resume info |
| `/upload/status/:uploadId` | GET (SSE) | Stream processing progress |
| `/docs/:userId` | GET | List user's uploaded documents |
| `/docs/:userId/:docId` | DELETE | Delete a document's vectors |
| `/ask` | POST (SSE) | Ask a question, stream LLM response |

---

## ⚙️ Tech Stack

| Component | Technology | Purpose |
|---|---|---|
| **Backend** | Express.js (Node.js) | REST API + SSE streaming |
| **Frontend** | React 19 + Vite 6 | SPA with real-time updates |
| **Vector DB** | Qdrant | Store & search document embeddings |
| **Cache/State** | Redis 7 | Upload tracking & processing status |
| **Embeddings** | `all-MiniLM-L6-v2` (384-dim) | Local text → vector conversion |
| **LLM (local)** | Ollama (`llama3.2:3b`) | Offline answer generation |
| **LLM (cloud)** | LLM Gateway | Free cloud LLM inference |
| **PDF parsing** | pdf-parse | Extract text from PDFs |
| **DOCX parsing** | mammoth | Extract text from Word docs |
| **Excel parsing** | SheetJS (xlsx) | Extract text from spreadsheets |

---

## 🛠️ Supported File Types

| Format | Extension | Extraction Method |
|---|---|---|
| PDF | `.pdf` | pdf-parse |
| Word | `.docx` | mammoth |
| Excel | `.xlsx`, `.xls` | SheetJS |
| Plain Text | `.txt`, `.log` | UTF-8 read |
| Markdown | `.md` | UTF-8 read |
| CSV | `.csv` | UTF-8 read |
| JSON | `.json` | Parse + pretty-print |
| HTML | `.html`, `.htm` | UTF-8 read |
| XML | `.xml` | UTF-8 read |

---

## 📝 License

ISC


3. if want to scale this app for more user what is best appraoch give analysis in details for 10k users then 100k user then 1M users then 100M users then 1B users DAU like this create one md file also mention how this can slow down our system what approach should be used at different levels from users to server to giving response  all include system design think like a architect experienced and give detaild analysis for this