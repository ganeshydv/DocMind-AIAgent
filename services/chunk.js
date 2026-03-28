function chunkText(text, size = 500, overlap = 100) {
  const chunks = [];

  for (let i = 0; i < text.length; i += size - overlap) {
    chunks.push(text.slice(i, i + size));
  }

  return chunks;
}

  function cleanText(text) {
  return text
    .replace(/\r\n/g, '\n')           // normalize line endings
    .replace(/\n{3,}/g, '\n\n')       // collapse excessive newlines
    .replace(/[ \t]{2,}/g, ' ')       // collapse multiple spaces/tabs
    .replace(/[^\S\n]+/g, ' ')        // normalize whitespace (keep newlines)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // remove control chars
    .trim();
}
module.exports = { chunkText, cleanText };