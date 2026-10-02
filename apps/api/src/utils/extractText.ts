import mammoth from "mammoth";

// Mozilla PDF.js (current release). The old pdf-parse bundle used a 2018
// engine that failed some valid PDFs intermittently ("bad XRef entry").
async function pdfText(buffer: Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, 50); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = "";
      const lines: string[] = [];
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
        if (typeof item.str !== "string") continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = "";
        }
      }
      if (line) lines.push(line);
      pages.push(lines.join("\n"));
      page.cleanup();
    }
    return pages.join("\n\n");
  } finally {
    await doc.destroy();
  }
}

export async function extractText(buffer: Buffer, fileType: string): Promise<string> {
  const ext = fileType.toLowerCase().replace(".", "");
  if (ext === "pdf") {
    return pdfText(buffer);
  }
  if (ext === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (ext === "doc") {
    // Legacy Word binary format, parsed in pure JS.
    const WordExtractor = ((await import("word-extractor")) as any).default;
    const doc = await new WordExtractor().extract(buffer);
    return [doc.getBody(), doc.getFootnotes?.(), doc.getHeaders?.({ includeFooters: true })].filter(Boolean).join("\n");
  }
  if (ext === "txt") {
    return buffer.toString("utf8");
  }
  throw new Error(`Unsupported resume file type for text extraction: ${ext}`);
}
