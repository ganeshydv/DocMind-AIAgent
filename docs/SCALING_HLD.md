# AiHelper — Scaling HLD (High-Level Design)

A tier-by-tier architecture guide for scaling the AiHelper RAG service from its current single-machine setup to 1 billion users.

---

## Table of Contents

- [Current Architecture (Baseline)](#current-architecture-baseline)
- [Tier 0: 10K Users](#tier-0-10k-users)
- [Tier 1: 100K Users](#tier-1-100k-users)
- [Tier 2: 1M Users](#tier-2-1m-users)
- [Tier 3: 10M Users](#tier-3-10m-users)
- [Tier 4: 100M Users](#tier-4-100m-users)
- [Tier 5: 1B Users](#tier-5-1b-users)
- [Cross-Cutting Concerns](#cross-cutting-concerns)
- [Data Flow at Scale](#data-flow-at-scale)
- [Cost Estimation Model](#cost-estimation-model)
- [Migration Strategy (Tier-to-Tier)](#migration-strategy-tier-to-tier)

---

## Current Architecture (Baseline)

```
┌──────────────┐    ┌───────────────┐    ┌──────────────┐
│   Frontend   │───▶│  Express.js   │───▶│   Qdrant     │
│   (React)    │    │  (single)     │    │  (single)    │
└──────────────┘    │               │    └──────────────┘
                    │  ProcessPool  │    ┌──────────────┐
                    │  (N workers)  │───▶│   Redis      │
                    └───────────────┘    │  (single)    │
                           │            └──────────────┘
                           ▼
                    ┌───────────────┐
                    │  Ollama /     │
                    │  LLM Gateway  │
                    └───────────────┘
```

**What we have today:**

| Component | Setup | Limitation |
|---|---|---|
| API Server | Single Express.js process | Single-threaded event loop; ~1K concurrent connections max |
| Embedding | `@xenova/transformers` (ONNX, local CPU) via process pool | CPU-bound; ~50-200ms per chunk |
| Vector DB | Single Qdrant container, local disk | One collection per user (`docs_<userId>`); no replication |
| Cache/State | Single Redis container | No persistence guarantees; no clustering |
| LLM | Local Ollama or cloud LLM Gateway | Ollama: 1 model loaded, single GPU; Gateway: rate limits |
| File Storage | Local filesystem (`./uploads/`) | Lost on container restart; no redundancy |
| Auth | None (userId passed by client) | No security |
| CDN / LB | None | Single point of failure |

**Estimated capacity:** ~50-100 concurrent users, <10K total users with light usage.

---

## Tier 0: 10K Users

**Goal:** Production-ready single-server deployment with reliability basics.

### Architecture

```
                    ┌─────────────┐
                    │   Nginx     │ ← TLS termination, static files, rate limiting
                    │  (reverse   │
                    │   proxy)    │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Express  │ │ Express  │ │ Express  │  ← PM2 cluster mode (N instances)
        │ + Pool   │ │ + Pool   │ │ + Pool   │
        └────┬─────┘ └────┬─────┘ └────┬─────┘
             │             │            │
             ▼             ▼            ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │  Redis   │  │  Qdrant  │  │  MinIO   │ ← Object storage for uploads
        │ (single) │  │ (single) │  │ (single) │
        └──────────┘  └──────────┘  └──────────┘
```

### Key Changes

| Change | Why | How |
|---|---|---|
| **Add Nginx reverse proxy** | TLS, rate limiting, static file serving, connection buffering | Deploy Nginx in front of Express |
| **PM2 cluster mode** | Use all CPU cores for the Express event loop | `pm2 start app.js -i max` |
| **Add authentication** | Users can access/delete each other's data without auth | JWT tokens (e.g. Auth0, Firebase Auth, or self-hosted) |
| **Move uploads to MinIO/S3** | Local filesystem not durable; lost on redeploy | S3-compatible object storage |
| **Redis persistence** | Upload state lost on Redis restart | Enable AOF or RDB snapshots |
| **Structured logging** | Can't debug issues in production with `console.log` | Pino/Winston → JSON logs → file/stdout |
| **Health checks** | Need to know when services are down | `/health` endpoint; Docker `healthcheck` |
| **Rate limiting** | Prevent abuse (upload spam, LLM overuse) | `express-rate-limit` or Nginx `limit_req` |
| **File type/size validation** | No server-side validation currently | Whitelist extensions, max 50MB |
| **CORS lockdown** | `cors()` allows all origins | Restrict to frontend domain |

### Capacity Estimate

| Resource | Spec | Handles |
|---|---|---|
| 1 server (8 vCPU, 32GB) | PM2 with 4 Express + 4 pool workers | ~200 concurrent, 10K total users |
| Redis | 1GB RAM | ~1M keys |
| Qdrant | 10K collections × ~500 vectors each = 5M vectors | ~20GB disk |
| MinIO | 100GB | ~10K documents |

---

## Tier 1: 100K Users

**Goal:** Horizontal scaling, managed infrastructure, separation of concerns.

### Architecture

```
                         ┌───────────┐
                    ┌───▶│   CDN     │ ← Static assets (React app)
                    │    └───────────┘
┌──────────┐   ┌────┴─────┐
│  Users   │──▶│   ALB    │ ← AWS ALB / GCP LB / Cloudflare
└──────────┘   └────┬─────┘
                    │
         ┌──────────┼──────────┐
         ▼          ▼          ▼
   ┌───────────┐┌───────────┐┌───────────┐
   │  API Pod  ││  API Pod  ││  API Pod  │ ← Kubernetes / ECS (auto-scaled)
   │  (Express)││  (Express)││  (Express)│
   └─────┬─────┘└─────┬─────┘└─────┬─────┘
         │             │            │
         └──────────┬──┘────────────┘
                    │
    ┌───────────────┼───────────────────────────┐
    ▼               ▼               ▼           ▼
┌────────┐   ┌───────────┐   ┌──────────┐  ┌──────┐
│ Redis  │   │  Qdrant   │   │  S3 /    │  │ Queue│
│Cluster │   │ (3-node   │   │  MinIO   │  │(Bull)│
│(3-node)│   │  cluster) │   │          │  │      │
└────────┘   └───────────┘   └──────────┘  └──┬───┘
                                               │
                                    ┌──────────┼──────────┐
                                    ▼          ▼          ▼
                              ┌──────────┐┌──────────┐┌──────────┐
                              │ Worker   ││ Worker   ││ Worker   │
                              │ Pod      ││ Pod      ││ Pod      │
                              │(embed +  ││(embed +  ││(embed +  │
                              │ process) ││ process) ││ process) │
                              └──────────┘└──────────┘└──────────┘
```

### Key Changes

| Change | Why | How |
|---|---|---|
| **Containerize with Kubernetes** | Auto-scaling, rolling deploys, self-healing | Docker → K8s (EKS/GKE/AKS) |
| **Separate API and Worker pods** | Upload processing shouldn't compete with query serving | Dedicated worker deployment for document pipeline |
| **Job queue (Bull/BullMQ)** | Decouple upload arrival from processing; retry failed jobs | Bull backed by Redis; API enqueues, workers dequeue |
| **Redis Cluster (3 nodes)** | HA; single Redis is a SPOF | Redis Sentinel or Redis Cluster mode |
| **Qdrant Cluster (3 nodes)** | Replication + sharding; single Qdrant can't handle 100K collections | Qdrant distributed mode with 3 nodes, replication factor 2 |
| **CDN for frontend** | Reduce latency for static assets globally | CloudFront / Cloudflare |
| **Cloud Load Balancer** | Distribute traffic across API pods; health-check routing | ALB (AWS) / Cloud LB (GCP) |
| **API embedding via HTTP** | Local ONNX in API pods is wasteful at scale | Dedicated embedding microservice or use API (OpenAI, Cohere) |
| **Monitoring & Alerting** | Need visibility into latency, errors, queue depth | Prometheus + Grafana; or Datadog |
| **Database for metadata** | Redis isn't great for long-term document metadata | PostgreSQL for user accounts, document metadata, audit logs |

### Embedding Architecture Change

At 100K users, running `@xenova/transformers` locally becomes impractical for API queries (blocking). Split into:

```
Query Path (low latency):         Upload Path (throughput):
  API Pod                           Worker Pod
    │                                 │
    ▼                                 ▼
  Embedding API (HTTP)              Local ONNX (process pool)
  (OpenAI / Cohere / self-hosted    (Batch processing, latency
   TEI with GPU)                     doesn't matter)
```

### Qdrant Schema Rethink

**Problem:** 1 collection per user = 100K collections. Qdrant handles this poorly.

**Solution:** Shared collections with payload filtering.

```
BEFORE: docs_user1, docs_user2, ... docs_user100000  (100K collections)
AFTER:  documents (1 collection, all users, filter by userId payload)
```

```javascript
// Insert: add userId to every point's payload
payload: { text, docId, fileName, userId }

// Search: filter by userId
filter: { must: [
  { key: "userId", match: { value: userId } },
  { key: "docId", match: { value: docId } }  // optional
]}
```

**Create payload indexes on `userId` and `docId` for fast filtered search.**

### Capacity Estimate

| Resource | Spec | Handles |
|---|---|---|
| 3-6 API pods (2 vCPU, 4GB each) | Auto-scaled 3-6 based on CPU | ~1K concurrent queries |
| 3-6 Worker pods (4 vCPU, 8GB each) | Auto-scaled on queue depth | ~100 concurrent uploads |
| Redis Cluster (3 nodes, 4GB each) | Sentinel failover | Sessions, queue, upload state |
| Qdrant Cluster (3 nodes, 16GB each) | ~50M vectors | 100K users × 500 vectors |
| PostgreSQL (managed, e.g. RDS) | 2 vCPU, 8GB | User accounts, doc metadata |
| S3 | Unlimited | Document storage |

---

## Tier 2: 1M Users

**Goal:** Multi-region, read replicas, caching layer, GPU-backed embedding.

### Architecture

```
                    ┌───────────────────────────────┐
                    │     Global Load Balancer       │
                    │  (Cloudflare / AWS Global LB)  │
                    └───────────┬───────────────────┘
                                │
               ┌────────────────┼────────────────┐
               ▼                                 ▼
    ┌─────────────────────┐           ┌─────────────────────┐
    │    Region: US-East  │           │  Region: EU-West    │
    │                     │           │                     │
    │  ┌───────────────┐  │           │  ┌───────────────┐  │
    │  │  API Cluster   │  │           │  │  API Cluster   │  │
    │  │  (10-20 pods)  │  │           │  │  (10-20 pods)  │  │
    │  └───────┬───────┘  │           │  └───────┬───────┘  │
    │          │          │           │          │          │
    │  ┌───────┴───────┐  │           │  ┌───────┴───────┐  │
    │  │ Embedding Svc  │  │           │  │ Embedding Svc  │  │
    │  │ (GPU pods,     │  │           │  │ (GPU pods,     │  │
    │  │  TEI / vLLM)   │  │           │  │  TEI / vLLM)   │  │
    │  └───────────────┘  │           │  └───────────────┘  │
    │                     │           │                     │
    │  ┌───────────────┐  │           │  ┌───────────────┐  │
    │  │  Worker Pods   │  │           │  │  Worker Pods   │  │
    │  │  (10-30)       │  │           │  │  (10-30)       │  │
    │  └───────────────┘  │           │  └───────────────┘  │
    │                     │           │                     │
    │  Qdrant (primary)   │◀─────────▶│  Qdrant (replica)  │
    │  Redis  (primary)   │◀─────────▶│  Redis  (replica)  │
    │  PostgreSQL (primary)│◀─────────▶│  PostgreSQL (read) │
    └─────────────────────┘           └─────────────────────┘
```

### Key Changes

| Change | Why | How |
|---|---|---|
| **Multi-region deployment** | Latency for global users (>200ms cross-continent) | Deploy in 2+ regions; geo-route via DNS |
| **GPU-backed embedding service** | CPU ONNX can't keep up; 1M users × queries/day = millions of embeddings | HuggingFace TEI (Text Embeddings Inference) on GPU pods or use managed API (OpenAI) |
| **Embedding caching** | Same/similar queries re-embed wastefully | Redis cache with TTL for query embeddings |
| **Read replicas (Qdrant, PG, Redis)** | Single-region DB can't serve global reads | Cross-region async replication |
| **Connection pooling** | 20+ API pods all connecting to PG/Redis | PgBouncer for PostgreSQL; Redis Cluster handles natively |
| **LLM abstraction layer** | At 1M users you need failover between providers | Route to cheapest/fastest available LLM; fallback chain |
| **Async document processing** | Upload spikes shouldn't degrade query latency | Separate auto-scaling groups for workers; queue buffering |
| **User quotas & billing** | Free tier + paid tiers | Quota middleware: X docs, Y queries/day per plan |

### Embedding Service (GPU)

Replace local ONNX with a dedicated embedding microservice:

```
┌──────────────────────────────────────────────────┐
│  Embedding Service (HuggingFace TEI)             │
│                                                  │
│  - Model: all-MiniLM-L6-v2 (or better)          │
│  - Runtime: GPU (NVIDIA T4/A10G)                 │
│  - Batched inference: 256 texts per batch        │
│  - Throughput: ~10K embeddings/sec per GPU       │
│  - Auto-scaled: 2-8 GPU pods                     │
│                                                  │
│  POST /embed  { texts: ["chunk1", "chunk2"] }    │
│  → { embeddings: [[0.1, ...], [0.2, ...]] }     │
└──────────────────────────────────────────────────┘
```

**Why TEI?** Open-source, GPU-optimized, batched, supports all HuggingFace models, deployed as a container.

### Caching Layer

```
Query flow with caching:

  User asks question
       │
       ▼
  Hash(question) → check Redis cache
       │
    ┌──┴──┐
    │Cache │─── HIT ──▶ return cached embedding (0ms)
    │Miss  │
    └──┬───┘
       ▼
  Call Embedding Service (~5ms GPU)
       │
       ▼
  Store in Redis (TTL: 1 hour)
       │
       ▼
  Qdrant search → LLM → stream response
```

### Capacity Estimate

| Resource | Spec | Handles |
|---|---|---|
| 20-40 API pods (per region) | HPA on CPU/RPS | ~10K concurrent queries |
| 10-30 Worker pods (per region) | HPA on queue depth | ~500 concurrent uploads |
| 2-8 GPU pods (embedding) | NVIDIA T4/A10G | ~10K embeddings/sec/GPU |
| Qdrant (6 nodes, 3 per region) | ~500M vectors | 1M users × 500 vectors |
| Redis Cluster (6 nodes) | 32GB per node | Caching, sessions, queues |
| PostgreSQL (managed, multi-AZ) | 8 vCPU, 32GB | User/doc metadata |

---

## Tier 3: 10M Users

**Goal:** Microservices, event-driven architecture, data partitioning.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Global Edge (CDN + WAF)                         │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    │   API Gateway       │ ← Kong / AWS API GW / Envoy
                    │   (auth, rate limit,│
                    │    routing)         │
                    └──────────┬──────────┘
                               │
          ┌────────────────────┼────────────────────────┐
          ▼                    ▼                         ▼
  ┌──────────────┐    ┌──────────────┐          ┌──────────────┐
  │  Query Svc   │    │  Upload Svc  │          │  User Svc    │
  │  (stateless) │    │  (stateless) │          │  (stateless) │
  │              │    │              │          │              │
  │  Embed →     │    │  Accept →    │          │  Auth, quota │
  │  Search →    │    │  Queue job   │          │  billing     │
  │  LLM stream  │    │              │          │              │
  └──────┬───────┘    └──────┬───────┘          └──────┬───────┘
         │                   │                         │
         ▼                   ▼                         ▼
  ┌────────────┐     ┌─────────────┐           ┌────────────┐
  │ Embedding  │     │  Message    │           │ PostgreSQL │
  │ Service    │     │  Queue      │           │ (sharded)  │
  │ (GPU)      │     │ (Kafka /    │           └────────────┘
  └────────────┘     │  SQS)      │
                     └──────┬─────┘
                            │
               ┌────────────┼────────────┐
               ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Process  │ │ Process  │ │ Process  │  ← Document processing workers
        │ Worker   │ │ Worker   │ │ Worker   │
        └──────────┘ └──────────┘ └──────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ Qdrant   │  │ Qdrant   │  │ Qdrant   │  ← Sharded cluster (9+ nodes)
        │ Shard 1  │  │ Shard 2  │  │ Shard 3  │
        └──────────┘  └──────────┘  └──────────┘
```

### Key Changes

| Change | Why | How |
|---|---|---|
| **Microservices split** | Monolith can't scale query vs. upload independently; teams can't deploy independently | Query Svc, Upload Svc, User Svc, Embedding Svc, Processing Workers |
| **API Gateway** | Centralized auth, rate limiting, routing, circuit breaking | Kong / Envoy / AWS API Gateway |
| **Event-driven processing** | Bull/Redis queue can't handle 10M users' upload volume reliably | Kafka / SQS / RabbitMQ for durable message processing |
| **Qdrant sharding** | 5B+ vectors won't fit on 3 nodes | Shard by userId hash; 9+ nodes |
| **PostgreSQL sharding** | 10M user rows + document metadata | Shard by userId (Citus / Vitess) |
| **LLM routing service** | Need to balance cost, latency, availability across providers | Smart router: Ollama (local) → cheap cloud → expensive cloud |
| **Distributed tracing** | Can't debug across microservices with logs alone | Jaeger / OpenTelemetry |
| **Feature flags** | Need to roll out changes gradually | LaunchDarkly / Unleash |
| **Multi-tenancy** | Enterprise customers want data isolation | Tenant ID in every request; namespace isolation in Qdrant |

### Qdrant Sharding Strategy

```
10M users × avg 500 vectors = 5 BILLION vectors

Sharding approach: hash(userId) % num_shards

Shard 0: userId hash 0-999    → Qdrant nodes 1-3 (replicated)
Shard 1: userId hash 1000-1999 → Qdrant nodes 4-6 (replicated)
Shard 2: userId hash 2000-2999 → Qdrant nodes 7-9 (replicated)
...

Each shard holds ~1.6B vectors across 3 replicas
```

### LLM Routing

```
┌──────────────────────────────────────────────────┐
│  LLM Router                                      │
│                                                  │
│  Priority chain:                                 │
│  1. Self-hosted vLLM (cheapest, lowest latency)  │
│  2. Cloud Provider A (budget: $X/day)            │
│  3. Cloud Provider B (fallback)                  │
│                                                  │
│  Logic:                                          │
│  - Route based on user tier (free → cheap model) │
│  - Circuit breaker per provider                  │
│  - Token budget tracking per user                │
│  - Response quality monitoring                   │
└──────────────────────────────────────────────────┘
```

### Capacity Estimate

| Resource | Spec | Handles |
|---|---|---|
| Query Svc: 50-100 pods | 2 vCPU, 4GB each | ~50K concurrent queries |
| Upload Svc: 10-20 pods | 2 vCPU, 4GB each | ~5K concurrent uploads |
| Processing Workers: 50-100 pods | 4 vCPU, 8GB each | ~2K concurrent pipeline jobs |
| Embedding Svc: 10-20 GPU pods | A10G / A100 | ~100K embeddings/sec |
| Qdrant: 9-15 nodes | 64GB RAM, NVMe | ~5B vectors |
| Kafka: 6 brokers | Standard | Message throughput |
| PostgreSQL: sharded (3 shards) | 16 vCPU, 64GB each | 10M users |
| Redis: 12 nodes (cluster) | 32GB each | Caching, rate limiting |

---

## Tier 4: 100M Users

**Goal:** Global presence, near-zero downtime, cost optimization, platform play.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Global Traffic Management                          │
│               (Cloudflare / AWS Global Accelerator)                    │
│                                                                        │
│  DNS-based geo-routing → nearest region                                │
└──────────────┬─────────────────┬─────────────────┬─────────────────────┘
               │                 │                 │
    ┌──────────▼──────┐ ┌───────▼────────┐ ┌──────▼──────────┐
    │  US-East        │ │  EU-West       │ │  APAC           │
    │  (Primary)      │ │  (Primary)     │ │  (Primary)      │
    ├─────────────────┤ ├────────────────┤ ├─────────────────┤
    │                 │ │                │ │                 │
    │ API Gateway     │ │ API Gateway    │ │ API Gateway     │
    │ Query Svc (100) │ │ Query Svc (80)│ │ Query Svc (60)  │
    │ Upload Svc (30) │ │ Upload Svc(25)│ │ Upload Svc (20) │
    │ User Svc (20)   │ │ User Svc (15) │ │ User Svc (10)   │
    │ Embed Svc (GPU) │ │ Embed Svc     │ │ Embed Svc       │
    │ Workers (100)   │ │ Workers (80)  │ │ Workers (60)    │
    │                 │ │                │ │                 │
    │ Qdrant Cluster  │ │ Qdrant Cluster│ │ Qdrant Cluster  │
    │ Redis Cluster   │ │ Redis Cluster │ │ Redis Cluster   │
    │ PG (sharded)    │ │ PG (sharded)  │ │ PG (sharded)    │
    │ Kafka Cluster   │ │ Kafka Cluster │ │ Kafka Cluster   │
    └─────────────────┘ └────────────────┘ └─────────────────┘
              │                  │                  │
              └──────────────────┼──────────────────┘
                                 │
                    Cross-region replication
                    (async, eventual consistency)
```

### Key Changes

| Change | Why | How |
|---|---|---|
| **3+ region active-active** | Latency below 100ms for all users globally; can lose an entire region | Each region fully independent; async cross-region data sync |
| **CQRS (Command Query Responsibility Segregation)** | Read and write paths have completely different scaling needs | Separate read-optimized and write-optimized data stores |
| **Tiered storage** | 100M users × docs = petabytes; not all data is hot | Hot (NVMe) / Warm (SSD) / Cold (S3 Glacier) for vectors and docs |
| **Embedding model distillation** | Smaller model = cheaper inference at this scale | Distill MiniLM to a custom 128-dim model for common queries |
| **Self-hosted LLM fleet** | Cloud LLM API costs astronomical at 100M users | vLLM / TGI on A100 clusters; reserved instances |
| **Data sovereignty** | EU users' data must stay in EU (GDPR) | Region-pinned data; no cross-border vector replication for EU users |
| **Service mesh** | Need mTLS, retries, circuit breakers between 500+ services | Istio / Linkerd |
| **Chaos engineering** | Must validate fault tolerance | Chaos Monkey / Litmus; regular disaster recovery drills |
| **FinOps** | Cloud bill is $M/month; need cost visibility | Per-user cost attribution; spot instances for workers; reserved for DBs |
| **Multi-model RAG** | Users want image, audio, video understanding too | CLIP embeddings for images; Whisper for audio; store in same Qdrant |

### CQRS Pattern

```
Write Path (Upload):                    Read Path (Query):
                                        
  Upload Svc                              Query Svc
     │                                       │
     ▼                                       ▼
  Kafka (upload events)                   Redis Cache (embedding cache)
     │                                       │ miss
     ▼                                       ▼
  Workers                                 Embedding Svc (GPU)
     │                                       │
     ▼                                       ▼
  Qdrant (write primary)                  Qdrant (read replicas)
  PostgreSQL (write primary)              PostgreSQL (read replicas)
     │                                    
     ▼                                    
  Emit "doc.indexed" event               
     │                                    
     ▼                                    
  Update read replicas (async)            
```

### Tiered Vector Storage

```
┌───────────────────────────────────────────────────────┐
│  Tier    │ Storage    │ Latency │ Cost    │ Data Age  │
├───────────────────────────────────────────────────────┤
│  Hot     │ NVMe/RAM   │ <10ms   │ $$$$   │ < 30 days │
│  Warm    │ SSD        │ <50ms   │ $$     │ 30-180d   │
│  Cold    │ S3+Qdrant  │ <500ms  │ $      │ > 180d    │
│          │  snapshots │         │        │           │
└───────────────────────────────────────────────────────┘

Auto-migration: if user hasn't queried a doc in 180 days → move vectors to cold.
On query: if vectors are cold → load into warm, serve, keep warm for 7 days.
```

### Capacity Estimate

| Resource | Spec (per region, 3 regions) | Total |
|---|---|---|
| API pods | 100-200 per region | 300-600 |
| Worker pods | 100-150 per region | 300-450 |
| GPU pods (embedding) | 20-40 per region (A100) | 60-120 |
| GPU pods (LLM, self-hosted) | 50-100 per region (A100) | 150-300 |
| Qdrant nodes | 30-50 per region | 90-150 |
| PostgreSQL shards | 10+ per region | 30+ |
| Kafka brokers | 9 per region | 27 |
| Redis nodes | 20 per region | 60 |
| Total vectors | ~50B | Petabyte-scale storage |

---

## Tier 5: 1B Users

**Goal:** Planetary-scale, custom infrastructure, multi-modal, AI-native platform.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Global Control Plane                                │
│  (service discovery, config management, fleet orchestration)               │
└─────────────────────────────────────────┬───────────────────────────────────┘
                                          │
    ┌──────────┬──────────┬──────────┬────┴─────┬──────────┬──────────┐
    │          │          │          │          │          │          │
    ▼          ▼          ▼          ▼          ▼          ▼          ▼
 US-East   US-West   EU-West   EU-East    APAC-SG   APAC-JP   LATAM
 (full     (full     (full     (full      (full     (full     (full
  stack)    stack)    stack)    stack)     stack)    stack)    stack)

Each region:
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  Edge Layer:     CDN + WAF + DDoS protection           │
│  Gateway Layer:  API GW + Auth + Rate Limit            │
│  Service Layer:  Query / Upload / User / Billing       │
│  AI Layer:       Embedding (GPU) + LLM (GPU) + Ranker  │
│  Data Layer:     Qdrant + PostgreSQL + Redis + Kafka    │
│  Storage Layer:  S3 + Glacier (tiered)                 │
│  Observability:  Metrics + Logs + Traces + Profiling   │
│                                                         │
└─────────────────────────────────────────────────────────┘

Cross-region:
  - Async data replication (CRDTs for metadata)
  - Global user directory (Cassandra / CockroachDB)
  - Federated search (query local first, fan out if needed)
```

### Key Changes

| Change | Why | How |
|---|---|---|
| **7+ region deployment** | Sub-50ms latency for all humans on Earth | Deploy in every major cloud region |
| **Custom vector DB / fork Qdrant** | Off-the-shelf config of Qdrant may not handle 500B+ vectors efficiently | Fork/contribute to Qdrant or build custom sharding layer |
| **CockroachDB / Spanner** | PostgreSQL sharding is painful at 1B users | Globally distributed SQL (CockroachDB / Google Spanner) |
| **CRDTs for state** | Eventual consistency across 7 regions without coordination | Conflict-free replicated data types for user state |
| **Federated search** | User queries should search local region first | Local-first search; fan-out to other regions only if user has cross-region docs |
| **Custom embedding model** | Generic models waste compute on your domain | Fine-tune on your users' document corpus for better relevance |
| **Multi-modal RAG** | Text, images, PDFs, audio, video, code | CLIP (images), Whisper (audio), CodeBERT (code); unified vector space |
| **AI-powered ops** | Human SREs can't manage 7 regions × 1000s of pods | AIOps: anomaly detection, auto-scaling prediction, auto-remediation |
| **Edge inference** | Some queries can be answered without hitting the data center | Small models at CDN edge for simple queries; escalate complex ones |
| **Per-user model adaptation** | Power users want personalized answers | Store user preference embeddings; re-rank results per user |
| **Compliance automation** | GDPR, CCPA, HIPAA, SOC2 across jurisdictions | Automated data classification, retention, deletion pipelines |

### Data Architecture at 1B Scale

```
Users: 1,000,000,000
Avg docs per user: 10
Avg chunks per doc: 50
Total vectors: 1B × 10 × 50 = 500 BILLION vectors

Vector dimensions: 384
Storage per vector: 384 × 4 bytes = 1.5 KB (payload + overhead ≈ 3 KB)
Total vector storage: 500B × 3 KB = 1.5 PETABYTES

But with tiered storage:
  Hot  (active users, 5%):  25B vectors → 75 TB
  Warm (recent, 20%):       100B vectors → 300 TB
  Cold (inactive, 75%):     375B vectors → S3 (cheap)
```

### Custom Vector Layer

```
┌──────────────────────────────────────────────────────────┐
│  AiHelper Vector Layer (custom)                          │
│                                                          │
│  Routing Layer:                                          │
│    hash(userId) → region → shard → node                  │
│                                                          │
│  Hot Tier (Qdrant clusters, NVMe, in-memory index):      │
│    └── 50 nodes × 7 regions = 350 nodes                 │
│                                                          │
│  Warm Tier (Qdrant clusters, SSD, disk-backed index):    │
│    └── 100 nodes × 7 regions = 700 nodes                │
│                                                          │
│  Cold Tier (S3 snapshots, loaded on demand):             │
│    └── Load into warm tier within 5 seconds on query     │
│                                                          │
│  Replication: 3× within region, async cross-region       │
│  Consistency: eventual (< 5 second lag)                  │
└──────────────────────────────────────────────────────────┘
```

### Self-Hosted LLM Fleet

```
┌──────────────────────────────────────────────────────────┐
│  LLM Inference Fleet                                     │
│                                                          │
│  Per region:                                             │
│    Tier 1 (fast, cheap):  Llama 8B on A10G × 50         │
│    Tier 2 (smart):        Llama 70B on A100 × 20        │
│    Tier 3 (best):         Cloud API fallback             │
│                                                          │
│  Routing logic:                                          │
│    Free users   → Tier 1 (8B model)                      │
│    Pro users    → Tier 2 (70B model)                     │
│    Enterprise   → Tier 3 (best available)                │
│                                                          │
│  Total GPU fleet: ~500 GPUs per region                   │
│  Estimated cost: ~$2M/month per region                   │
└──────────────────────────────────────────────────────────┘
```

### Capacity Estimate

| Resource | Per Region | 7 Regions Total |
|---|---|---|
| API pods | 500+ | 3,500+ |
| Worker pods | 300+ | 2,100+ |
| Embedding GPU pods | 50+ (A100) | 350+ |
| LLM GPU pods | 70+ (A100/H100) | 490+ |
| Qdrant nodes (hot+warm) | 150+ | 1,050+ |
| CockroachDB nodes | 20+ | 140+ |
| Kafka brokers | 15+ | 105+ |
| Redis nodes | 30+ | 210+ |
| S3 storage | ~200 TB | ~1.5 PB |
| Engineering team | 50+ per region | 200+ total |

---

## Cross-Cutting Concerns

These apply at **every tier** and should be progressively improved:

### 1. Security

| Tier | Measures |
|---|---|
| 10K | JWT auth, HTTPS, CORS lockdown, rate limiting, input validation |
| 100K | WAF, API key management, RBAC, audit logs, dependency scanning |
| 1M | SOC2 compliance, encryption at rest + transit, secrets management (Vault) |
| 10M | Penetration testing, bug bounty, data loss prevention, zero-trust networking |
| 100M | GDPR/CCPA automation, data residency enforcement, HSM for keys |
| 1B | Compliance-as-code, automated threat response, sovereign cloud options |

### 2. Observability

| Tier | Stack |
|---|---|
| 10K | Structured JSON logs + Uptime monitoring (Uptime Robot) |
| 100K | Prometheus + Grafana + PagerDuty; basic distributed tracing |
| 1M | Full OpenTelemetry (metrics + logs + traces); APM (Datadog/New Relic) |
| 10M | Custom dashboards per service; SLO tracking; error budget policies |
| 100M | AIOps anomaly detection; predictive auto-scaling; cost attribution dashboards |
| 1B | Real-time fleet-wide observability; self-healing systems; chaos engineering continuous |

### 3. CI/CD & Deployment

| Tier | Strategy |
|---|---|
| 10K | GitHub Actions → Docker → PM2 deploy |
| 100K | GitHub Actions → Docker → K8s rolling deploy |
| 1M | GitOps (ArgoCD); canary deployments; feature flags |
| 10M | Progressive delivery (canary → 1% → 10% → 100%); automated rollback |
| 100M | Multi-region progressive rollout; blue-green per region; A/B deploy |
| 1B | Dark launches; per-region deploy pipelines; automated qualification gates |

### 4. Disaster Recovery

| Tier | RPO/RTO | Strategy |
|---|---|---|
| 10K | RPO: 1h, RTO: 4h | Daily backups, documented restore procedure |
| 100K | RPO: 15m, RTO: 1h | Automated backups, hot standby Redis/PG |
| 1M | RPO: 5m, RTO: 15m | Cross-region replication, automated failover |
| 10M | RPO: 1m, RTO: 5m | Active-active multi-region; no single region dependency |
| 100M | RPO: ~0, RTO: <1m | Active-active, zero-downtime failover, tested quarterly |
| 1B | RPO: 0, RTO: 0 | All regions active; loss of any region = zero impact |

### 5. Cost Optimization

| Tier | Strategy |
|---|---|
| 10K | Single server, minimal spend (~$50-100/month) |
| 100K | Reserved instances for base load; spot for workers (~$2-5K/month) |
| 1M | Spot fleet for workers; reserved for DBs; S3 lifecycle policies (~$20-50K/month) |
| 10M | FinOps team; per-service cost allocation; aggressive spot usage (~$200-500K/month) |
| 100M | Custom pricing with cloud provider; mixed on-prem + cloud (~$2-5M/month) |
| 1B | Multi-cloud arbitrage; own hardware for LLM inference (~$15-30M/month) |

---

## Data Flow at Scale

### Upload Path (all tiers, increasing sophistication)

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌──────────┐    ┌─────────┐
│  Client  │──▶│  Upload  │──▶│  Object  │──▶│  Queue   │──▶│ Workers │
│  chunks  │   │  Service │   │  Store   │   │ (Kafka)  │   │         │
└─────────┘    └─────────┘    │  (S3)    │   └──────────┘   │ Extract │
                              └─────────┘                    │ Chunk   │
                                                             │ Embed   │
                                                             │ Insert  │
                                                             └────┬────┘
                                                                  │
                                                   ┌──────────────┼──────┐
                                                   ▼              ▼      ▼
                                              ┌─────────┐  ┌─────────┐ ┌──┐
                                              │ Qdrant  │  │   PG    │ │S3│
                                              │(vectors)│  │(metadata│ │  │
                                              └─────────┘  └─────────┘ └──┘
```

### Query Path (all tiers)

```
┌─────────┐    ┌─────────┐    ┌──────────┐    ┌─────────┐    ┌─────────┐
│  Client  │──▶│  Query   │──▶│ Embedding│──▶│ Qdrant  │──▶│  LLM    │
│  question│   │  Service │   │ Service  │   │ Search  │   │ Stream  │
└─────────┘    └─────────┘   │ (GPU)    │   └─────────┘   └────┬────┘
                    ▲         └──────────┘                      │
                    │              ▲                             │
                    │         ┌────┴────┐                       ▼
                    │         │  Cache  │                  ┌─────────┐
                    │         │ (Redis) │                  │  SSE    │
                    │         └─────────┘                  │ Stream  │──▶ Client
                    │                                      └─────────┘
                    └──────────────────────────────────────────────┘
```

---

## Cost Estimation Model

Rough monthly estimates (cloud pricing, US region, 2026):

| Tier | Users | Compute | Storage | LLM/GPU | Infra (DB, Queue, Cache) | Total/Month |
|---|---|---|---|---|---|---|
| **Baseline** | <1K | $0 (local) | $0 | $0 (Ollama) | $0 (Docker) | ~$0 |
| **10K** | 10K | $100-300 | $20-50 | $50-200 | $50-100 | **$200-650** |
| **100K** | 100K | $1-3K | $200-500 | $500-2K | $500-1K | **$2-7K** |
| **1M** | 1M | $10-30K | $2-5K | $5-20K | $3-8K | **$20-60K** |
| **10M** | 10M | $50-150K | $10-30K | $50-200K | $20-50K | **$130-430K** |
| **100M** | 100M | $300K-1M | $50-200K | $500K-2M | $100-300K | **$1-3.5M** |
| **1B** | 1B | $2-5M | $500K-2M | $5-15M | $1-3M | **$8-25M** |

> **Note:** LLM inference dominates cost at scale. Self-hosting reduces it by 3-5× vs. API pricing.

---

## Migration Strategy (Tier-to-Tier)

### Baseline → 10K (Week 1-2)

1. Add Nginx reverse proxy + TLS
2. PM2 cluster mode
3. Add JWT authentication
4. Move uploads to MinIO/S3
5. Enable Redis persistence
6. Add structured logging + health checks

### 10K → 100K (Month 1-2)

1. Containerize → Kubernetes
2. Split API and Worker deployments
3. Add Bull/BullMQ job queue
4. Migrate to Qdrant cluster (3 nodes)
5. Add PostgreSQL for metadata
6. Merge per-user collections → shared collection with userId payload filter
7. Set up monitoring (Prometheus + Grafana)

### 100K → 1M (Month 3-6)

1. Deploy second region
2. Set up GPU embedding service (TEI)
3. Add Redis caching for embeddings
4. Set up cross-region DB replication
5. Introduce user quotas/billing
6. Migrate to managed databases (RDS, ElastiCache)

### 1M → 10M (Month 6-12)

1. Break monolith into microservices (Query, Upload, User)
2. Replace Bull with Kafka/SQS
3. Add API Gateway (Kong/Envoy)
4. Shard PostgreSQL
5. Self-host LLM fleet (vLLM)
6. Add distributed tracing (OpenTelemetry)

### 10M → 100M (Year 1-2)

1. Deploy to 3+ regions active-active
2. Implement CQRS
3. Add tiered vector storage (hot/warm/cold)
4. Train custom embedding model
5. Data sovereignty compliance (GDPR)
6. Build FinOps practice

### 100M → 1B (Year 2-5)

1. Expand to 7+ regions
2. Move to globally distributed SQL (CockroachDB/Spanner)
3. Build custom vector routing layer
4. Multi-modal RAG (images, audio, video)
5. Edge inference at CDN layer
6. AIOps for fleet management

---

*Scale incrementally. Don't build for 1B users on day one — but design so you **can** get there without a rewrite.*
