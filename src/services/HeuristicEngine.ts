import { FleetOrchestrator, FleetHealth } from './FleetOrchestrator';

export interface FleetRecommendation {
    id: string;
    action: string;
    impact: 'High' | 'Medium' | 'Low';
    reasoning: string;
}

/**
 * HeuristicEngine
 * 
 * Analyzes fleet telemetry to generate automated operations recommendations
 * that are sent to the Admin Dashboard (Master Watchdog / Recommended Fleet Optimizations).
 * In a future iteration, this can be hooked directly to LangChain / GPT-4 for
 * truly dynamic LLM-driven inference on system behavior.
 */
export class HeuristicEngine {
    private orchestrator: FleetOrchestrator;

    constructor() {
        this.orchestrator = new FleetOrchestrator();
    }

    /**
     * Aggregates live data and generates actionable recommendations.
     */
    public async generateRecommendations(): Promise<FleetRecommendation[]> {
        const recommendations: FleetRecommendation[] = [];
        try {
            const health: FleetHealth = await this.orchestrator.getFleetHealth();
            const { wdw, dlr } = health.poolStats;
            
            // 1. Check if warm reserve is dangerously low
            if (health.warmReservePercent < 15) {
                recommendations.push({
                    id: 'REC-01',
                    action: 'Trigger Skipper Factory',
                    impact: 'High',
                    reasoning: `Reserve capacity at ${health.warmReservePercent.toFixed(1)}%. Recommend provisioning new batch to prevent starvation.`
                });
            }

            // 2. Imbalance between WDW and DLR logic
            if (wdw.available < dlr.available / 2) {
                recommendations.push({
                    id: 'REC-02',
                    action: 'Re-balance Capability Matrix',
                    impact: 'Medium',
                    reasoning: `WDW available pool (${wdw.available}) is disproportionately lower than DLR (${dlr.available}). Force capability synchronization.`
                });
            }

            // 3. Domain compromise detection
            if (health.recentBans24h > 5) {
                recommendations.push({
                    id: 'REC-03',
                    action: 'Deploy Fresh Domains',
                    impact: 'High',
                    reasoning: `Detected ${health.recentBans24h} ban waves in the last 24h. Recommend spinning up unused cloudflare utility domains.`
                });
            }
            
            // 4. Default nominal recommendation if healthy
            if (recommendations.length === 0) {
                recommendations.push({
                    id: 'REC-NOMINAL',
                    action: 'Maintain Current Posture',
                    impact: 'Low',
                    reasoning: `All heuristics within normal parameters. Capacity vs. demand curve is stable.`
                });
            }

            return recommendations;

        } catch (error) {
            console.error(`[HeuristicEngine] Analysis failed:`, error);
            // Fallback recommendation
            return [{
                id: 'REC-ERROR',
                action: 'Investigate Telemetry Failure',
                impact: 'High',
                reasoning: `Heuristic engine was unable to pull complete telemetry stream from the Fleet Orchestrator.`
            }];
        }
    }
}
