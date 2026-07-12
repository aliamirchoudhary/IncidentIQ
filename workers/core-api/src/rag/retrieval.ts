import type { StoredChunk, RetrievalResult } from "./types";
import { generateEmbedding, type AiRuntime } from "./embed";

const DEFAULT_TOP_K = 3;

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export async function retrieveRelevantKnowledge(
  query: string,
  db: D1Database,
  ai: AiRuntime,
  k: number = DEFAULT_TOP_K,
): Promise<RetrievalResult[]> {
  const queryEmbedding = await generateEmbedding(query, ai);

  const rows = await db.prepare(
    "SELECT id, source_id, title, type, content, tags, embedding FROM knowledge_sources WHERE deleted_at IS NULL AND embedding IS NOT NULL"
  ).all<StoredChunk>();

  const scored: Array<{ row: StoredChunk; score: number }> = [];

  for (const row of rows.results ?? []) {
    let stored: number[];
    try {
      stored = JSON.parse(row.embedding);
    } catch {
      continue;
    }
    if (!Array.isArray(stored)) continue;
    const score = cosineSimilarity(queryEmbedding, stored);
    scored.push({ row, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const topK = scored.slice(0, k);

  return topK.map(({ row, score }) => ({
    chunkId: row.id,
    sourceId: row.source_id,
    title: row.title,
    type: row.type,
    content: row.content,
    tags: parseTags(row.tags),
    score,
  }));
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
