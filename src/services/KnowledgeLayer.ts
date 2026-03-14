import { Pinecone } from "@pinecone-database/pinecone";
import { OpenAIEmbeddings } from "@langchain/openai";
import { env } from "../config/env";

export class KnowledgeLayer {
    private pinecone: Pinecone | null = null;
    private embeddings: OpenAIEmbeddings;
    private indexName = env.PINECONE_INDEX_NAME;

    constructor() {
        if (env.PINECONE_API_KEY) {
            this.pinecone = new Pinecone({
                apiKey: env.PINECONE_API_KEY,
            });
            console.log("📚 KnowledgeLayer: Pinecone initialized.");
        } else {
            console.warn("⚠️  KnowledgeLayer: PINECONE_API_KEY missing. Semantic search will be disabled.");
        }

        if (env.OPENAI_API_KEY) {
            this.embeddings = new OpenAIEmbeddings({
                openAIApiKey: env.OPENAI_API_KEY,
            });
        } else {
            console.warn("⚠️  KnowledgeLayer: OPENAI_API_KEY missing. Embeddings will be disabled.");
            // Stub it out to prevent crashes in methods
            this.embeddings = {
                embedQuery: async () => [],
                embedDocuments: async () => []
            } as any;
        }
    }

    /**
     * Searches the RAG database for specific rules, lore, or recent scrapes.
     */
    async retrieveContext(query: string, topK: number = 3): Promise<string> {
        if (!this.pinecone) {
            return "Knowledge Layer offline (Missing Credentials).";
        }

        try {
            const index = this.pinecone.Index(this.indexName);

            // Convert user query into a mathematical vector
            const queryEmbedding = await this.embeddings.embedQuery(query);

            // Perform semantic search
            const queryResponse = await index.query({
                vector: queryEmbedding,
                topK,
                includeMetadata: true,
            });

            // Stitch chunks together for context injection
            const context = queryResponse.matches
                .map(match => match.metadata?.text || '')
                .join("\n\n---\n\n");

            return context;
        } catch (error) {
            console.error("Vector DB error:", error);
            return "Current operational knowledge unavailable. Reverting to base logic.";
        }
    }

    /**
     * Upserts a document into the Vector DB.
     * Used by the Scraper Pipeline and seed scripts to keep the knowledge layer current.
     */
    async upsertDocument(id: string, text: string, metadata: Record<string, string> = {}): Promise<void> {
        if (!this.pinecone) {
            console.warn(`[KnowledgeLayer] Skip upsert for ${id}: Pinecone offline`);
            return;
        }

        try {
            const index = this.pinecone.Index(this.indexName);

            // Generate vector embedding from the text
            const embedding = await this.embeddings.embedQuery(text);

            // Upsert into Pinecone with metadata for filtered retrieval
            await index.upsert({
                records: [{
                    id,
                    values: embedding,
                    metadata: {
                        text,
                        ...metadata,
                        updatedAt: new Date().toISOString()
                    }
                }]
            });

            console.log(`📚 Upserted document '${id}' into KnowledgeLayer`);
        } catch (error) {
            console.error("Vector DB upsert error:", error);
        }
    }
}
