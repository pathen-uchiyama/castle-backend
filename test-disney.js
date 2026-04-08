require('dotenv').config();
require('ts-node').register();

const { SkipperFactory } = require('./src/services/disney/SkipperFactory');

async function runDisneyTest() {
  console.log('=== Castle Companion — Disney Live Test ===\n');
  
  const factory = new SkipperFactory();
  try {
    const result = await factory.provisionBatch(1);
    console.log('\n=== REGISTRATION RESULTS ===');
    console.log('Succeeded:', result.succeeded);
    console.log('Failed:', result.failed);
    process.exit(0);
  } catch (err) {
    console.error('Factory error:', err);
    process.exit(1);
  }
}

runDisneyTest();
