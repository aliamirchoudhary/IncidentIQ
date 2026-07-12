export interface ChunkInput {
  title: string;
  type: "runbook" | "past_incident";
  content: string;
  tags?: string[];
  source_id?: string;
}

export interface Chunk {
  chunkIndex: number;
  text: string;
  title: string;
  type: string;
  tags: string[];
  sourceId: string;
}

export interface StoredChunk {
  id: string;
  source_id: string;
  title: string;
  type: string;
  content: string;
  tags: string;
  embedding: string;
  created_at: string;
}

export interface RetrievalResult {
  chunkId: string;
  sourceId: string;
  title: string;
  type: string;
  content: string;
  tags: string[];
  score: number;
}
