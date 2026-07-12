import type { ChunkInput } from "./types";
import { chunkDocument } from "./chunking";
import { generateEmbeddings, type AiRuntime } from "./embed";

export async function ingestDocument(
  doc: ChunkInput,
  db: D1Database,
  ai: AiRuntime,
): Promise<{ sourceId: string; chunkCount: number }> {
  const chunks = chunkDocument(doc);
  const embedded = await generateEmbeddings(chunks, ai);
  const now = new Date().toISOString();
  const sourceId = doc.source_id ?? crypto.randomUUID();

  for (const { chunk, embedding } of embedded) {
    const id = crypto.randomUUID();
    await db.prepare(
      "INSERT INTO knowledge_sources (id, source_id, title, type, content, tags, embedding, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      id, sourceId, chunk.title, chunk.type, chunk.text,
      JSON.stringify(chunk.tags), JSON.stringify(embedding), now, now,
    ).run();
  }

  return { sourceId, chunkCount: embedded.length };
}

export async function deleteDocumentSource(sourceId: string, db: D1Database): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(
    "UPDATE knowledge_sources SET deleted_at = ? WHERE source_id = ?"
  ).bind(now, sourceId).run();
}

export async function restoreDocumentSource(sourceId: string, db: D1Database): Promise<void> {
  await db.prepare(
    "UPDATE knowledge_sources SET deleted_at = NULL WHERE source_id = ?"
  ).bind(sourceId).run();
}
