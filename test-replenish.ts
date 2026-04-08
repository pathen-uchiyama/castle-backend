import * as dotenv from 'dotenv';
dotenv.config();

import { FleetOrchestrator } from './src/services/FleetOrchestrator';

async function runReplenishTest() {
  console.log('=== Castle Companion — Fleet Auto-Replenishment Test ===\n');
  
  const orchestrator = new FleetOrchestrator();
  try {
    // 1. Tell the orchestrator we want a buffer of 15 accounts.
    // 2. Set the max batch limit to 3 (which restricts Puppeteer instances).
    console.log('[Test] Triggering autoReplenishFleet(targetBuffer=15, batchLimit=3)...');
    
    const result = await orchestrator.autoReplenishFleet(15, 3);
    
    console.log('\n=== REPLENISHMENT RESULTS ===');
    console.log(`Seeded new UNREGISTERED accounts: ${result.seeded}`);
    console.log(`Successfully provisioned through Disney: ${result.provisioned}`);
    
    // Print current pool health
    const health = await orchestrator.getFleetHealth();
    console.log('\n=== POOL HEALTH ===');
    console.log(`Total: ${health.poolStats.total}`);
    console.log(`Available: ${health.poolStats.available}`);
    console.log(`Incubating: ${health.poolStats.incubating}`);
    console.log(`Unregistered: ${health.poolStats.unregistered}`);
    console.log(`Banned: ${health.poolStats.banned}`);

    process.exit(0);
  } catch (err) {
    console.error('Orchestrator error:', err);
    process.exit(1);
  }
}

runReplenishTest();
