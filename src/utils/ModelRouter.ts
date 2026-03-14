import { SubscriptionTier } from '../models/types';

export type AIComplexity = 'summarization' | 'logistical_pivot' | 'concierge_rag' | 'morning_sitrep';

export type AIProvider = 'openai' | 'google';

export interface AIModelConfig {
    provider: AIProvider;
    model: string;
}

export class ModelRouter {
    /**
     * Determines the optimal model and provider based on task complexity and user tier.
     * Strategic Goal: Protect margins by balancing between OpenAI (Heavy) and Gemini (Light).
     */
    static getModelForTask(tier: SubscriptionTier | undefined, complexity: AIComplexity): AIModelConfig {
        // Free tier ALWAYS uses the cheapest multi-modal (Gemini Flash)
        if (!tier || tier === 'explorer') {
            return { provider: 'google', model: 'gemini-1.5-flash' };
        }

        // Tiered Logic for Paying Users
        switch (complexity) {
            case 'logistical_pivot':
                // High-stakes in-park changes require top-tier reasoning
                return tier === 'plaid_guardian' 
                    ? { provider: 'openai', model: 'gpt-4o' } 
                    : { provider: 'google', model: 'gemini-1.5-flash' };

            case 'morning_sitrep':
                // Nuance is key for briefings
                return tier === 'plaid_guardian' 
                    ? { provider: 'openai', model: 'gpt-4o' } 
                    : { provider: 'google', model: 'gemini-1.5-flash' };

            case 'concierge_rag':
                // RAG is often standard; use Flash unless it's a Guardian
                return tier === 'plaid_guardian' 
                    ? { provider: 'openai', model: 'gpt-4o' } 
                    : { provider: 'google', model: 'gemini-1.5-flash' };

            case 'summarization':
            default:
                // Fast/Cheap always wins for summaries
                return { provider: 'google', model: 'gemini-1.5-flash' };
        }
    }
}
