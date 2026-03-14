import { ParkID } from '../models/types';

export interface AttractionValue {
    id: string;
    name: string;
    land: string; // Geographical land for clustering
    parkId: ParkID;
    llPriority: 'Tier 1' | 'Tier 2' | 'Tier 3'; // Tier 1: Sells out fast, high value
    sellOutRisk: 'High' | 'Moderate' | 'Low';
    ropeDropPriority: number; // 1 (Highest) to 10
    standbyThresholdMins: number; // If wait < this, walk on instead of LL
    virtualQueue?: boolean;
    llMultiPassTier?: 1 | 2; // Specific to WDW LL Multi-Pass
}

export const PLAID_EXPERT_KNOWLEDGE: Record<string, AttractionValue[]> = {
    'WDW_MK': [
        { id: 'MK_7DMT', name: 'Seven Dwarfs Mine Train', land: 'Fantasyland', parkId: 'MK', llPriority: 'Tier 1', sellOutRisk: 'High', ropeDropPriority: 1, standbyThresholdMins: 45 },
        { id: 'MK_SPACE', name: 'Space Mountain', land: 'Tomorrowland', parkId: 'MK', llPriority: 'Tier 2', sellOutRisk: 'Moderate', ropeDropPriority: 3, standbyThresholdMins: 30, llMultiPassTier: 1 },
        { id: 'MK_PETER', name: "Peter Pan's Flight", land: 'Fantasyland', parkId: 'MK', llPriority: 'Tier 1', sellOutRisk: 'High', ropeDropPriority: 2, standbyThresholdMins: 20, llMultiPassTier: 1 },
        { id: 'MK_TRON', name: 'TRON Lightcycle / Run', land: 'Tomorrowland', parkId: 'MK', llPriority: 'Tier 1', sellOutRisk: 'High', ropeDropPriority: 1, standbyThresholdMins: 60, virtualQueue: true },
        { id: 'MK_TIANA', name: "Tiana's Bayou Adventure", land: 'Frontierland', parkId: 'MK', llPriority: 'Tier 1', sellOutRisk: 'High', ropeDropPriority: 1, standbyThresholdMins: 60, virtualQueue: true, llMultiPassTier: 1 },
        { id: 'MK_BTM', name: 'Big Thunder Mountain Railroad', land: 'Frontierland', parkId: 'MK', llPriority: 'Tier 2', sellOutRisk: 'Moderate', ropeDropPriority: 4, standbyThresholdMins: 35, llMultiPassTier: 1 },
        { id: 'MK_HM', name: 'Haunted Mansion', land: 'Liberty Square', parkId: 'MK', llPriority: 'Tier 2', sellOutRisk: 'Low', ropeDropPriority: 5, standbyThresholdMins: 25, llMultiPassTier: 2 },
        { id: 'MK_PIRATES', name: 'Pirates of the Caribbean', land: 'Adventureland', parkId: 'MK', llPriority: 'Tier 3', sellOutRisk: 'Low', ropeDropPriority: 6, standbyThresholdMins: 20, llMultiPassTier: 2 },
        { id: 'MK_JUNGLE', name: 'Jungle Cruise', land: 'Adventureland', parkId: 'MK', llPriority: 'Tier 1', sellOutRisk: 'High', ropeDropPriority: 2, standbyThresholdMins: 40, llMultiPassTier: 1 },
    ],
    'WDW_EP': [
        { id: 'EP_REMY', name: "Remy's Ratatouille Adventure", land: 'World Showcase', parkId: 'EP', llPriority: 'Tier 1', sellOutRisk: 'High', ropeDropPriority: 1, standbyThresholdMins: 45, llMultiPassTier: 1 },
        { id: 'EP_FROZEN', name: 'Frozen Ever After', land: 'World Showcase', parkId: 'EP', llPriority: 'Tier 1', sellOutRisk: 'High', ropeDropPriority: 2, standbyThresholdMins: 40, llMultiPassTier: 1 },
        { id: 'EP_GUARDIANS', name: 'Guardians of the Galaxy: Cosmic Rewind', land: 'World Discovery', parkId: 'EP', llPriority: 'Tier 1', sellOutRisk: 'High', ropeDropPriority: 1, standbyThresholdMins: 70, virtualQueue: true },
        { id: 'EP_SOARIN', name: 'Soarin\' Around the World', land: 'World Nature', parkId: 'EP', llPriority: 'Tier 2', sellOutRisk: 'Moderate', ropeDropPriority: 3, standbyThresholdMins: 30, llMultiPassTier: 1 },
        { id: 'EP_TEST_TRACK', name: 'Test Track', land: 'World Discovery', parkId: 'EP', llPriority: 'Tier 2', sellOutRisk: 'High', ropeDropPriority: 4, standbyThresholdMins: 40, llMultiPassTier: 1 },
    ],
    'WDW_HS': [
        { id: 'HS_RISE', name: 'Rise of the Resistance', land: 'Galaxy\'s Edge', parkId: 'HS', llPriority: 'Tier 1', sellOutRisk: 'High', ropeDropPriority: 1, standbyThresholdMins: 60 },
        { id: 'HS_SLINKY', name: 'Slinky Dog Dash', land: 'Toy Story Land', parkId: 'HS', llPriority: 'Tier 1', sellOutRisk: 'High', ropeDropPriority: 2, standbyThresholdMins: 40, llMultiPassTier: 1 },
        { id: 'HS_TOT', name: 'Tower of Terror', land: 'Sunset Blvd', parkId: 'HS', llPriority: 'Tier 2', sellOutRisk: 'Moderate', ropeDropPriority: 3, standbyThresholdMins: 35, llMultiPassTier: 1 },
        { id: 'HS_MMM', name: "Mickey & Minnie's Runaway Railway", land: 'Hollywood Blvd', parkId: 'HS', llPriority: 'Tier 2', sellOutRisk: 'Moderate', ropeDropPriority: 4, standbyThresholdMins: 30, llMultiPassTier: 1 },
        { id: 'HS_SMUGGLERS', name: "Millennium Falcon: Smugglers Run", land: 'Galaxy\'s Edge', parkId: 'HS', llPriority: 'Tier 2', sellOutRisk: 'Moderate', ropeDropPriority: 5, standbyThresholdMins: 35, llMultiPassTier: 1 },
    ],
    'WDW_AK': [
        { id: 'AK_FLIGHT', name: 'Avatar Flight of Passage', land: 'Pandora', parkId: 'AK', llPriority: 'Tier 1', sellOutRisk: 'High', ropeDropPriority: 1, standbyThresholdMins: 60 },
        { id: 'AK_NAVI', name: 'Na\'vi River Journey', land: 'Pandora', parkId: 'AK', llPriority: 'Tier 2', sellOutRisk: 'High', ropeDropPriority: 2, standbyThresholdMins: 40, llMultiPassTier: 1 },
        { id: 'AK_EVEREST', name: 'Expedition Everest', land: 'Asia', parkId: 'AK', llPriority: 'Tier 2', sellOutRisk: 'Moderate', ropeDropPriority: 3, standbyThresholdMins: 30, llMultiPassTier: 1 },
        { id: 'AK_SAFARI', name: 'Kilimanjaro Safaris', land: 'Africa', parkId: 'AK', llPriority: 'Tier 2', sellOutRisk: 'Moderate', ropeDropPriority: 4, standbyThresholdMins: 35, llMultiPassTier: 1 },
    ],
    'DL_DL': [
        { id: 'DL_RISE', name: 'Rise of the Resistance', land: 'Galaxy\'s Edge', parkId: 'DL', llPriority: 'Tier 1', sellOutRisk: 'High', ropeDropPriority: 1, standbyThresholdMins: 60 },
        { id: 'DL_INDY', name: 'Indiana Jones Adventure', land: 'Adventureland', parkId: 'DL', llPriority: 'Tier 1', sellOutRisk: 'Moderate', ropeDropPriority: 2, standbyThresholdMins: 40 },
        { id: 'DL_SPACE', name: 'Space Mountain', land: 'Tomorrowland', parkId: 'DL', llPriority: 'Tier 2', sellOutRisk: 'Moderate', ropeDropPriority: 3, standbyThresholdMins: 35 },
        { id: 'DL_MATTERHORN', name: 'Matterhorn Bobsleds', land: 'Fantasyland', parkId: 'DL', llPriority: 'Tier 2', sellOutRisk: 'Moderate', ropeDropPriority: 4, standbyThresholdMins: 30 },
        { id: 'DL_RUNAWAY', name: "Minnie & Mickey's Runaway Railway", land: 'Toontown', parkId: 'DL', llPriority: 'Tier 2', sellOutRisk: 'Moderate', ropeDropPriority: 5, standbyThresholdMins: 30 },
    ],
    'DL_DCA': [
        { id: 'DCA_RADIATOR', name: 'Radiator Springs Racers', land: 'Cars Land', parkId: 'DCA', llPriority: 'Tier 1', sellOutRisk: 'High', ropeDropPriority: 1, standbyThresholdMins: 60 },
        { id: 'DCA_WEB', name: 'WEB SLINGERS: A Spider-Man Adventure', land: 'Avengers Campus', parkId: 'DCA', llPriority: 'Tier 2', sellOutRisk: 'Moderate', ropeDropPriority: 2, standbyThresholdMins: 40 },
        { id: 'DCA_GUARDIANS', name: 'Guardians of the Galaxy - Mission: BREAKOUT!', land: 'Avengers Campus', parkId: 'DCA', llPriority: 'Tier 1', sellOutRisk: 'Moderate', ropeDropPriority: 3, standbyThresholdMins: 35 },
        { id: 'DCA_SOARIN', name: 'Soarin\' Around the World', land: 'Grizzly Peak', parkId: 'DCA', llPriority: 'Tier 2', sellOutRisk: 'Low', ropeDropPriority: 4, standbyThresholdMins: 30 },
    ]
};

export const STRATEGY_PILLARS = {
    'ROPE_DROP': "Rope Drop logic: Prioritize Tier 1 attractions with highest ropeDropPriority. If 'Early Entry' is available, execute the 'Headed First' protocol (e.g., 7DMT or Rise). If wait is under standbyThresholdMins, walk on and save LL for later.",
    'LL_SEQUENCING': "LL Sequencing: Book Tier 1 LLs (those with high sellOutRisk) as early as possible (7:00 AM window). Churn LLs every 120 mins or immediately after scanning to maximize daily throughput.",
    'STANDBY_OPTIMIZATION': "Standby heuristic: Use standby for 'Tier 3' or if wait is < standbyThresholdMins. Monitor 'Logistical Shadows' like parades/fireworks to find wait time dips.",
    'VIRTUAL_QUEUE': "Virtual Queue protocol: Must hit the 7:00 AM or 1:00 PM drop exactly. If a VQ is secured, adjust the LL strategy to avoid overlap with the estimated callback window.",
    'TIERED_LLMP': "WDW LL Multi-Pass: In MK, EP, and HS, you can only pre-select ONE 'Tier 1' attraction. The AI must prioritize the highest sell-out risk Tier 1 (e.g., Slinky or Remy) for the pre-booking window.",
    'GEOGRAPHICAL_CLUSTERING': "Walking Minimization: If 'minimizeWalking' is TRUE, strongly favor attractions within the same 'land' as the previous/next step. Avoid 'ping-ponging' between opposite sides of the park (e.g., Tomorrowland to Adventureland) unless it's for a high-value Must-Do with high sell-out risk."
};
