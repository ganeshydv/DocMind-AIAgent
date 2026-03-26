const fs = require("fs");
const path = require("path");
const { PDFParse } = require("pdf-parse");
const mammoth = require("mammoth");
const XLSX = require("xlsx");

/**
 * Universal text extractor — detects file type by extension
 * and extracts plain text from:
 *   .pdf         — via pdf-parse
 *   .docx        — via mammoth
 *   .xlsx / .xls — via xlsx (SheetJS)
 *   .txt / .md / .csv / .json / .html / .xml / .log — read as UTF-8
 *
 * @param {string} filePath - Absolute path to the assembled file
 * @returns {Promise<string>} Extracted plain text
 */
async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case ".pdf": {
      const pdfParse = new PDFParse({ data: fs.readFileSync(filePath) });
      const result = await pdfParse.getText();
      return result.text;
    }

    case ".docx": {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    }

    case ".xlsx":
    case ".xls": {
      const workbook = XLSX.readFile(filePath);
      const lines = [];
      for (const sheetName of workbook.SheetNames) {
        lines.push(`--- Sheet: ${sheetName} ---`);
        const sheet = workbook.Sheets[sheetName];
        // Convert each sheet to CSV-like text so the chunker gets readable rows
        const text = XLSX.utils.sheet_to_csv(sheet);
        lines.push(text);
      }
      return lines.join("\n");
    }

    // Plain-text formats — just read as UTF-8
    case ".txt":
    case ".md":
    case ".csv":
    case ".log":
    case ".xml":
    case ".html":
    case ".htm": {
      return fs.readFileSync(filePath, "utf-8");
    }

    case ".json": {
      const raw = fs.readFileSync(filePath, "utf-8");
      // Pretty-print JSON so the chunker gets readable text
      try {
        return JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        return raw; // invalid JSON — treat as plain text
      }
    }

    default:
      // Attempt to read as plain text — works for any text-based file
      try {
        return fs.readFileSync(filePath, "utf-8");
      } catch {
        throw new Error(`Unsupported file type: ${ext}`);
      }
  }
}

module.exports = { extractText };