import mammoth from "mammoth";

// pdf-parse has no ESM types export path that plays nicely with NodeNext;
// import lazily to dodge its debug-mode self-test on bare `require`.
async function loadPdfParse() {
  const mod = await import("pdf-parse");
  return (mod as any).default ?? mod;
}

export async function extractText(buffer: Buffer, fileType: string): Promise<string> {
  const ext = fileType.toLowerCase().replace(".", "");
  if (ext === "pdf") {
    const pdfParse = await loadPdfParse();
    const result = await pdfParse(buffer);
    return result.text;
  }
  if (ext === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (ext === "doc") {
    // Legacy .doc binary format isn't reliably parseable without native
    // tooling (antiword/catdoc). Surface a real, actionable error instead
    // of silently returning garbage or fabricated text.
    throw new Error("Legacy .doc files are not supported for parsing yet — please upload PDF or DOCX.");
  }
  if (ext === "txt") {
    return buffer.toString("utf8");
  }
  throw new Error(`Unsupported resume file type for text extraction: ${ext}`);
}
