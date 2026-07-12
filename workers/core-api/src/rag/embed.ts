import type { Chunk } from "./types";

const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

export interface AiRuntime {
  run(model: string, input: { text: string[] }): Promise<{ data: number[][] }>;
}

export async function generateEmbedding(text: string, ai: AiRuntime): Promise<number[]> {
  const result = await ai.run(EMBEDDING_MODEL, { text: [text] });
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
