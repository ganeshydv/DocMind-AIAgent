const { pipeline } = require("@xenova/transformers");

let embedder;

async function getEmbedder() {
  if (!embedder) {
    embedder = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2"
    );
  }
  return embedder;
}

async function createEmbedding(text) {
  const model = await getEmbedder();
  const output = await model(text, { pooling: "mean", normalize: true });

  return Array.from(output.data);
}

module.exports = { createEmbedding };