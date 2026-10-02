import { test } from "node:test";
import assert from "node:assert/strict";
import PDFDocument from "pdfkit";

const { extractText } = await import("../src/utils/extractText.js");
const { readRows } = await import("../src/leadgen/leadImport.js");

function makePdf(text: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const d = new PDFDocument();
    const chunks: Buffer[] = [];
    d.on("data", (c) => chunks.push(c));
    d.on("end", () => resolve(Buffer.concat(chunks)));
    d.text(text);
    d.end();
  });
}

test("PDF text extraction is reliable (same file, every time)", async () => {
  const pdf = await makePdf("Jordan Smith\nSenior Customer Success Manager\nSalesforce and Gainsight");
  for (let i = 0; i < 8; i++) {
    const t = await extractText(pdf, "pdf");
    assert.match(t, /Jordan Smith/);
    assert.match(t, /Salesforce and Gainsight/);
  }
});

test("corrupt PDFs and unknown types fail clearly", async () => {
  await assert.rejects(extractText(Buffer.from("not a pdf ".repeat(50)), "pdf"));
  await assert.rejects(extractText(Buffer.from("x"), "exe"), /Unsupported/);
});

test("lead spreadsheets: CSV/TSV parse, wrong types and empty files are rejected", async () => {
  assert.equal((await readRows(Buffer.from("Business Name,Phone\nAcme,5124777827\n"), "a.csv")).length, 1);
  assert.equal((await readRows(Buffer.from("Business Name\tPhone\nAcme\t5124777827\n"), "a.tsv"))[0]["Phone"], "5124777827");
  await assert.rejects(readRows(Buffer.from("%PDF"), "leads.pdf"), /Unsupported file type \.pdf/);
  await assert.rejects(readRows(Buffer.from("x"), "old.xls"), /\.xls/);
  await assert.rejects(readRows(Buffer.from("a,b\n"), "empty.csv"), /No rows/);
});
