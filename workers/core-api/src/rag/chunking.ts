import type { ChunkInput, Chunk } from "./types";

const MIN_WORDS = 150;
const MAX_WORDS = 400;

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function splitSentences(text: string): string[] {
  const result: string[] = [];
  const parts = text.split(/(?<=[.!?])\s+/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed) result.push(trimmed);
  }
  return result;
}

export function chunkDocument(doc: ChunkInput): Chunk[] {
  const paragraphs = doc.content.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const chunks: Chunk[] = [];
  let buffer: string[] = [];
  let overlap = "";

  function flushBuffer(index: number): void {
    const text = buffer.join("\n\n");
    if (text.trim()) {
      const finalText = overlap ? overlap + "\n" + text : text;
      chunks.push({ chunkIndex: index, text: finalText, title: doc.title, type: doc.type, tags: doc.tags ?? [], sourceId: doc.source_id ?? crypto.randomUUID() });
      const sentences = finalText.split(/(?<=[.!?])\s+/);
      overlap = sentences.length > 1 ? sentences[sentences.length - 1] : "";
    }
    buffer = [];
  }

  let chunkIdx = 0;
  for (const para of paragraphs) {
    const wc = wordCount(para);

    if (wc > MAX_WORDS) {
      flushBuffer(chunkIdx);
      if (overlap) buffer.push(overlap);
      overlap = "";
      const sentences = splitSentences(para);
      let subBuffer: string[] = [];
      for (const sentence of sentences) {
        subBuffer.push(sentence);
        if (wordCount(subBuffer.join(" ")) >= MIN_WORDS) {
          chunks.push({ chunkIndex: chunkIdx++, text: subBuffer.join(" "), title: doc.title, type: doc.type, tags: doc.tags ?? [], sourceId: doc.source_id ?? crypto.randomUUID() });
          const last = subBuffer.length > 1 ? subBuffer[subBuffer.length - 1] : "";
          subBuffer = last ? [last] : [];
        }
      }
      if (subBuffer.length > 0) {
        const remaining = buffer.concat(subBuffer);
        chunks.push({ chunkIndex: chunkIdx++, text: remaining.join("\n\n"), title: doc.title, type: doc.type, tags: doc.tags ?? [], sourceId: doc.source_id ?? crypto.randomUUID() });
      }
      continue;
    }

    const currentWords = wordCount(buffer.join("\n\n"));
    if (currentWords + wc > MAX_WORDS && currentWords >= MIN_WORDS) {
      flushBuffer(chunkIdx++);
    }
    buffer.push(para);
  }

  if (buffer.length > 0) {
    flushBuffer(chunkIdx);
  }

  if (chunks.length === 0) {
    chunks.push({ chunkIndex: 0, text: doc.content.trim(), title: doc.title, type: doc.type, tags: doc.tags ?? [], sourceId: doc.source_id ?? crypto.randomUUID() });
  }

  return chunks;
}
