import { OpenAIEmbeddings } from "@langchain/openai";
import { getSupabaseClient } from "../config/supabase";
import { env } from "../config/env";

export class KnowledgeLayer {
    private embeddings: OpenAIEmbeddings;

    constructor() {
        if (env.OPENAI_API_KEY) {
            this.embeddings = new OpenAIEmbeddings({
                openAIApiKey: env.OPENAI_API_KEY,
            });
            console.log("📚 KnowledgeLayer: RAG Engine initialized via Supabase pgvector.");
        } else {
            console.warn("⚠️  KnowledgeLayer: OPENAI_API_KEY missing. Embeddings disabled.");
            this.embeddings = {
                embedQuery: async () => [],
                embedDocuments: async () => []
            } as any;
        }
    }

    /**
     * Searches the pgvector database for specific rules, lore, or recent scrapes.
     */
    async retrieveContext(query: string, topK: number = 3): Promise<string> {
        if (!env.OPENAI_API_KEY) {
            return "Knowledge Layer offline (Missing Credentials).";
        }

        try {
            const queryEmbedding = await this.embeddings.embedQuery(query);
            const db = getSupabaseClient();

            // Perform semantic search via pgvector rpc
            const { data, error } = await db.rpc('match_knowledge_vectors', {
                query_embedding: queryEmbedding,
                match_threshold: 0.7, // Adjust threshold if needed, 0.7 implies strong cosine similarity
                match_count: topK
            });

            if (error) throw error;

            if (!data || data.length === 0) {
                return "No contextual lore found.";
            }

            // Stitch chunks together for context injection
            const context = data
                .map((match: any) => match.content || '')
                .join("\n\n---\n\n");

            return context;
        } catch (error) {
            console.error("Vector DB error:", error);
            return "Current operational knowledge unavailable. Reverting to base logic.";
        }
    }

    /**
     * Upserts a document into the Supabase knowledge_vectors table.
     * Used by the Scraper Pipeline and seed scripts to keep the knowledge layer current.
     */
    async upsertDocument(id: string, text: string, metadata: Record<string, string> = {}): Promise<void> {
        if (!env.OPENAI_API_KEY) {
            console.warn(`[KnowledgeLayer] Skip upsert for ${id}: RAG offline`);
            return;
        }

        try {
            const embedding = await this.embeddings.embedQuery(text);
            const db = getSupabaseClient();

            const { error } = await db.from('knowledge_vectors').upsert({
                id,
                content: text,
                embedding: embedding,
                metadata: {
                    ...metadata,
                    updatedAt: new Date().toISOString()
                }
            }, {
                onConflict: 'id'
            });

            if (error) throw error;

            console.log(`📚 Upserted document '${id}' into Supabase pgvector`);
        } catch (error) {
            console.error("Vector DB upsert error:", error);
        }
    }
}
