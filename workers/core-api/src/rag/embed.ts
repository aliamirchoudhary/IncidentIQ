import type { Chunk } from "./types";

const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

export interface AiRuntime {
  run(model: string, input: { text: string[] }): Promise<{ data: number[][] }>;
}

const EMBED_TIMEOUT_MS = 10000;

export async function generateEmbedding(text: string, ai: AiRuntime): Promise<number[]> {
  const result = await Promise.race([
    ai.run(EMBEDDING_MODEL, { text: [text] }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), EMBED_TIMEOUT_MS)),
  ]) as any;
  const embedding = result.data?.[0];
  if (!embedding || !Array.isArray(embedding)) {
    throw new Error("Unexpected embedding response format");
  }
  return embedding;
}

export async function generateEmbeddings(chunks: Chunk[], ai: AiRuntime): Promise<Array<{ chunk: Chunk; embedding: number[] }>> {
  const results: Array<{ chunk: Chunk; embedding: number[] }> = [];
  for (const chunk of chunks) {
    const embedding = await generateEmbedding(chunk.text, ai);
    results.push({ chunk, embedding });
  }
  return results;
}
