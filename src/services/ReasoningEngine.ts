import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { env } from "../config/env";
import { StrategyProfile, ParkID, SubscriptionTier } from "../models/types";
import { ParkStatusRegistry } from "./ParkStatusRegistry";
import { ModelRouter, AIModelConfig } from "../utils/ModelRouter";
import { PLAID_EXPERT_KNOWLEDGE, STRATEGY_PILLARS } from "../data/ExpertKnowledge";

export class ReasoningEngine {
    private parkStatus: ParkStatusRegistry;

    constructor() {
        this.parkStatus = new ParkStatusRegistry();
    }

    private getModel(tier: SubscriptionTier | undefined, complexity: any): BaseChatModel {
        const config: AIModelConfig = ModelRouter.getModelForTask(tier, complexity);

        if (config.provider === 'google') {
            return new ChatGoogleGenerativeAI({
                apiKey: env.GEMINI_API_KEY,
                model: config.model,
                temperature: 0.2,
            });
        }

        return new ChatOpenAI({
            openAIApiKey: env.OPENAI_API_KEY,
            modelName: config.model,
            temperature: 0.2,
        });
    }

    /**
     * Generates a "Magic Pivot" strategy based on a disruption and the user's modular strategy.
     * Now queries ParkStatusRegistry FIRST to prevent hallucinations.
     */
    async generatePivotStrategy(
        context: string,
        disruptionEvent: string,
        strategy: StrategyProfile,
        parkId?: ParkID,
        subscriptionTier?: SubscriptionTier
    ): Promise<string> {
        // ── Phase 5A: Query closure registry BEFORE constructing prompt ──
        let closureContext = 'PARK STATUS: All attractions currently operational.';
        if (parkId) {
            closureContext = await this.parkStatus.generateClosureContext(parkId);
        }

        const parkKnowledge = parkId ? PLAID_EXPERT_KNOWLEDGE[parkId] || PLAID_EXPERT_KNOWLEDGE[`WDW_${parkId}`] || [] : [];
        const knowledgeTable = parkKnowledge.length > 0 
            ? `PARK-SPECIFIC ATTRACTION VALUES:\n${parkKnowledge.map(a => `- ${a.name} (${a.land}): LL Priority: ${a.llPriority}, Sell-out Risk: ${a.sellOutRisk}, Rope Drop Priority: ${a.ropeDropPriority}`).join('\n')}`
            : '';

        const prompt = `
      You are the elite "Plaid" VIP Concierge for a family at a Disney Park.
      Maintain a tone that is "Ritz-Carlton meets Magic Kingdom"—warm, authoritative, and magical.

      ${closureContext}

      ${knowledgeTable}

      FAMILY STRATEGY PROFILE:
      - Pacing: ${strategy.pacingFilter}
      - Focus: ${strategy.primaryFocus}
      - Dining Style: ${strategy.diningStyle}
      - Splurge Appetite: ${strategy.splurgeAppetite.toUpperCase()}
      - Premium Interests: ${strategy.premiumInterests.join(', ') || 'N/A'}
      - Arrival Intent: ${strategy.arrivalIntent || 'Standard'}
      - Single Rider Allowed: ${strategy.singleRiderAllowed}
      - DAS Enabled: ${strategy.dasAllowed}
      - Minimize Walking: ${strategy.rideDirectives.minimizeWalking}
      - Lightning Lane Multi Pass: ${strategy.budgetDirectives.llMultiPassAllowed}
      - Lightning Lane Single Pass: ${strategy.budgetDirectives.llSinglePassAllowed}

      Current Itinerary Context:
      ${context}

      STRATEGY PILLARS & HUMAN REALITIES:
      - ${STRATEGY_PILLARS.ROPE_DROP}
      - ${STRATEGY_PILLARS.LL_SEQUENCING}
      - ${STRATEGY_PILLARS.STANDBY_OPTIMIZATION}
      - ${STRATEGY_PILLARS.GEOGRAPHICAL_CLUSTERING}

      CRITICAL DISRUPTION ALERT:
      ${disruptionEvent}

      Your task: Create a detailed "Magic Pivot" strategy. 
      Recommend the immediate next best step. If a ride went down, recommend the closest low-wait alternative or a nearby dining/snack option. 
      
      EXPLAIN YOUR REASONING clearly based on:
      1. LL Popularity/Sell-out Risk (refer to priorities).
      2. Standby vs LL Heuristics (walk-on vs saving LL).
      3. Logistical Shadows (transit, parade pathing).
      4. Geographical Clustering (if 'Minimize Walking' is true, group by land).
      
      PREMIUM UPSCALE LOGIC:
      - If Splurge Appetite is HIGH, prioritize suggesting premium add-ons.
      - If any Premium Interests match, suggest those as meaningful pivots.

      Respect the Family Strategy Profile. Keep the response under 4 sentences.
    `;

        try {
            const model = this.getModel(subscriptionTier, 'logistical_pivot');
            const response = await model.invoke(prompt);
            return response.content.toString();
        } catch (error) {
            console.error("Reasoning Engine Error:", error);
            return "Pardon the pixie dust, we are recalibrating your magic. Please head towards a nearby shaded area while we find an alternative plan.";
        }
    }
}
