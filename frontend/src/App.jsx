import { useState, useRef, useEffect } from "react";

const API = "http://localhost:3000";
const CHUNK_SIZE = 1024 * 1024; // 1 MB per chunk

function App() {
  const [userId, setUserId] = useState("");
  const [isUserSet, setIsUserSet] = useState(false);

  // Upload state
  const [file, setFile] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState("");
  const [processingStatus, setProcessingStatus] = useState(null);
  const [isUploading, setIsUploading] = useState(false);

  // Document list state
  const [docs, setDocs] = useState([]);
  const [selectedDocId, setSelectedDocId] = useState(""); // "" means "all docs"

  // Ask state
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [isAsking, setIsAsking] = useState(false);
  const [askStage, setAskStage] = useState(""); // analyzing | searching | referencing | thinking | streaming
  const [chatHistory, setChatHistory] = useState([]);
  const [provider, setProvider] = useState("gateway"); // "ollama" or "gateway"
  const [ollamaModels, setOllamaModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState(""); // "" = use server default

  const fileInputRef = useRef();

  const handleSetUser = () => {
    if (userId.trim()) setIsUserSet(true);
  };

  // ─── Fetch User's Documents ─────────────────────────────────────

  const fetchDocs = async () => {
    try {
      const res = await fetch(`${API}/docs/${userId}`);
      const data = await res.json();
      setDocs(data.docs || []);
    } catch {
      setDocs([]);
    }
  };

  useEffect(() => {
    if (isUserSet && userId) fetchDocs();
  }, [isUserSet]);

  // Fetch available Ollama models when provider is ollama
  useEffect(() => {
    if (provider === "ollama") {
      fetch(`${API}/models/ollama`)
        .then((r) => r.json())
        .then((data) => {
          setOllamaModels(data.models || []);
          // Auto-select first model if none selected
          if (!selectedModel && data.models?.length > 0) {
            setSelectedModel(data.models[0].name);
          }
        })
        .catch(() => setOllamaModels([]));
    }
  }, [provider]);

  const handleDeleteDoc = async (docId) => {
    if (!confirm("Delete this document and all its vectors?")) return;
    try {
      await fetch(`${API}/docs/${userId}/${docId}`, { method: "DELETE" });
      setDocs((prev) => prev.filter((d) => d.docId !== docId));
      if (selectedDocId === docId) setSelectedDocId("");
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
  };

  // ─── Chunked Upload with Resume ────────────────────────────────

  const handleUpload = async () => {
    if (!file) return;
    setIsUploading(true);
    setUploadProgress(0);
    setUploadStatus("Initializing...");
    setProcessingStatus(null);

    try {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

      // Step 1: Init upload session
      const initRes = await fetch(`${API}/upload/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          fileName: file.name,
          fileSize: file.size,
          totalChunks,
        }),
      });
      const { uploadId } = await initRes.json();

      // Step 2: Check what's already uploaded (for resume)
      const resumeRes = await fetch(`${API}/upload/resume/${uploadId}`);
      const resumeData = await resumeRes.json();
      const uploadedSet = new Set(resumeData.uploadedChunks || []);

      // Step 3: Send chunks, skipping already-uploaded ones
      setUploadStatus(`Uploading (${totalChunks} chunks)...`);
      for (let i = 0; i < totalChunks; i++) {
        if (uploadedSet.has(i)) {
          setUploadProgress(((i + 1) / totalChunks) * 100);
          continue; // already received by server — skip
        }

        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        await fetch(`${API}/upload/chunk/${uploadId}/${i}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: chunk,
        });

        setUploadProgress(((i + 1) / totalChunks) * 100);
      }

      setUploadStatus("All chunks sent. Processing document...");

      // Step 4: Subscribe to processing progress via SSE
      const eventSource = new EventSource(
        `${API}/upload/status/${uploadId}`
      );

      eventSource.onmessage = (event) => {
        const status = JSON.parse(event.data);
        setProcessingStatus(status);

        if (status.stage === "complete") {
          setUploadStatus("Done! Document processed successfully.");
          setIsUploading(false);
          fetchDocs(); // refresh document list
          eventSource.close();
        } else if (status.stage === "error") {
          setUploadStatus(`Error: ${status.error}`);
          setIsUploading(false);
          eventSource.close();
        }
      };

      eventSource.onerror = () => {
        setUploadStatus("Connection lost. Refresh to check status.");
        setIsUploading(false);
        eventSource.close();
      };
    } catch (err) {
      setUploadStatus(`Error: ${err.message}`);
      setIsUploading(false);
    }
  };

  // ─── Streaming Ask ─────────────────────────────────────────────

  const handleAsk = async () => {
    if (!question.trim()) return;
    const q = question;
    setQuestion("");
    setIsAsking(true);
    setAnswer("");
    setAskStage("analyzing");

    // Add user message to history
    const updatedHistory = [...chatHistory, { role: "user", text: q }];
    setChatHistory(updatedHistory);

    let fullAnswer = "";
    let addedToHistory = false;

    try {
      // Send chat history so LLM has conversation context
      const res = await fetch(`${API}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          question: q,
          provider,
          model: provider === "ollama" ? selectedModel || undefined : undefined,
          docId: selectedDocId || undefined, // filter to specific doc or search all
          history: updatedHistory.slice(-10), // last 10 messages for context
        }),
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.stage) {
                setAskStage(data.stage);
              }
              if (data.token) {
                fullAnswer += data.token;
                // Use a microtask yield to let the browser paint each token
                setAnswer(fullAnswer);
                await new Promise((r) => setTimeout(r, 0));
              }
              if (data.error) {
                fullAnswer += `\n\nError: ${data.error}`;
                setAnswer(fullAnswer);
              }
            } catch {
              // partial JSON, skip
            }
          }
        }
      }
    } catch (err) {
      fullAnswer = `Error: ${err.message}`;
      setAnswer(fullAnswer);
    } finally {
      // Add AI response to history exactly once
      if (fullAnswer && !addedToHistory) {
        addedToHistory = true;
        setChatHistory((prev) => [
          ...prev,
          { role: "assistant", text: fullAnswer },
        ]);
      }
      setIsAsking(false);
      setAskStage("");
    }
  };

  // ─── Helpers ────────────────────────────────────────────────────

  const getStageLabel = (stage) => {
    const labels = {
      assembling: "Assembling file from chunks...",
      extracting: "Extracting text from document...",
      chunking: "Splitting text into chunks...",
      embedding: "Creating embeddings & storing in vector DB...",
      complete: "Complete!",
      error: "Error occurred",
    };
    return labels[stage] || stage;
  };

  // ─── User ID Screen ────────────────────────────────────────────

  if (!isUserSet) {
    return (
      <div className="container">
        <h1>🤖 AI Helper</h1>
        <p className="subtitle">Upload a document and ask questions about it</p>
        <div className="card">
          <h2>Enter Your User ID</h2>
          <p className="hint">Each user gets an isolated knowledge base</p>
          <input
            type="text"
            placeholder="e.g. ganesh"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSetUser()}
            autoFocus
          />
          <button onClick={handleSetUser} disabled={!userId.trim()}>
            Continue
          </button>
        </div>
      </div>
    );
  }

  // ─── Main App ──────────────────────────────────────────────────

  return (
    <div className="container">
      <div className="header">
        <h1>🤖 AI Helper</h1>
        <div className="header-right">
          <div className="provider-toggle">
            <button
              className={`toggle-btn ${provider === "ollama" ? "active" : ""}`}
              onClick={() => setProvider("ollama")}
            >
              🖥️ Ollama
            </button>
            <button
              className={`toggle-btn ${provider === "gateway" ? "active" : ""}`}
              onClick={() => setProvider("gateway")}
            >
              ☁️ Gateway
            </button>
          </div>
          {provider === "ollama" && ollamaModels.length > 0 && (
            <select
              className="model-select"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
            >
              {ollamaModels.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name} {m.parameterSize ? `(${m.parameterSize})` : ""}
                </option>
              ))}
            </select>
          )}
          <span className="user-badge">👤 {userId}</span>
        </div>
      </div>

      {/* Upload Section */}
      <div className="card">
        <h2>📄 Upload Document</h2>
        <p className="hint">
          Supports PDF, DOCX, Excel, TXT, MD, CSV, JSON, HTML — sent in 1 MB chunks, resumable
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx,.xlsx,.xls,.txt,.md,.csv,.json,.html,.htm,.xml,.log"
          onChange={(e) => setFile(e.target.files[0])}
        />
        <button onClick={handleUpload} disabled={!file || isUploading}>
          {isUploading ? "Uploading..." : "Upload & Process"}
        </button>

        {uploadProgress > 0 && (
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${uploadProgress}%` }}
            />
            <span>{Math.round(uploadProgress)}% uploaded</span>
          </div>
        )}

        {uploadStatus && <p className="status">{uploadStatus}</p>}

        {processingStatus && processingStatus.stage !== "uploading" && (
          <div className="processing">
            <p>{getStageLabel(processingStatus.stage)}</p>
            {processingStatus.total > 0 && (
              <div className="progress-bar">
                <div
                  className="progress-fill processing-fill"
                  style={{
                    width: `${
                      (processingStatus.progress / processingStatus.total) * 100
                    }%`,
                  }}
                />
                <span>
                  {processingStatus.progress} / {processingStatus.total} chunks
                </span>
              </div>
            )}
          </div>
        )}

        {/* Uploaded Documents List */}
        {docs.length > 0 && (
          <div className="doc-list">
            <h3>📁 Your Documents ({docs.length})</h3>
            {docs.map((d) => (
              <div key={d.docId} className="doc-item">
                <span className="doc-name">{d.fileName}</span>
                <button
                  className="doc-delete-btn"
                  onClick={() => handleDeleteDoc(d.docId)}
                  title="Delete document"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Ask Section */}
      <div className="card">
        <h2>💬 Ask a Question</h2>

        {/* Document Selector */}
        {docs.length > 0 && (
          <div className="doc-selector">
            <label>Search in: </label>
            <select
              value={selectedDocId}
              onChange={(e) => setSelectedDocId(e.target.value)}
            >
              <option value="">All documents</option>
              {docs.map((d) => (
                <option key={d.docId} value={d.docId}>
                  {d.fileName}
                </option>
              ))}
            </select>
          </div>
        )}

        {chatHistory.length > 0 && (
          <div className="chat-history">
            {chatHistory.map((msg, i) => (
              <div key={i} className={`chat-msg ${msg.role}`}>
                <span className="chat-label">
                  {msg.role === "user" ? "You" : "AI"}
                </span>
                <p>{msg.text}</p>
              </div>
            ))}
          </div>
        )}

        {isAsking && askStage && (
          <div className="ask-pipeline">
            {["analyzing", "searching", "referencing", "thinking", "streaming"].map((s) => {
              const stages = ["analyzing", "searching", "referencing", "thinking", "streaming"];
              const currentIdx = stages.indexOf(askStage);
              const thisIdx = stages.indexOf(s);
              const status = thisIdx < currentIdx ? "done" : thisIdx === currentIdx ? "active" : "pending";
              const labels = {
                analyzing: "Analyzing",
                searching: "Collection",
                referencing: "Reference",
                thinking: "Thinking",
                streaming: "Responding",
              };
              return (
                <div key={s} className={`stage-step ${status}`}>
                  <div className="stage-dot">
                    {status === "done" ? "✓" : status === "active" ? "●" : "○"}
                  </div>
                  <span className="stage-label">{labels[s]}</span>
                </div>
              );
            })}
          </div>
        )}

        {isAsking && answer && (
          <div className="chat-msg assistant streaming">
            <span className="chat-label">AI</span>
            <p>{answer}<span className="cursor">▊</span></p>
          </div>
        )}

        <div className="ask-row">
          <input
            type="text"
            placeholder="Ask about your documents..."
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !isAsking && handleAsk()}
          />
          <button onClick={handleAsk} disabled={!question.trim() || isAsking}>
            {isAsking ? "..." : "Ask"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
