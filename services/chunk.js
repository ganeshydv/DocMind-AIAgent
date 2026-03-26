function chunkText(text, size = 500, overlap = 100) {
  const chunks = [];

  for (let i = 0; i < text.length; i += size - overlap) {
    chunks.push(text.slice(i, i + size));
  }

  return chunks;
}

module.exports = { chunkText };