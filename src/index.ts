import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import { metricsMiddleware } from './services/MetricsEmitter';
import { logger } from './utils/Logger';

logger.init();

const app = express();

app.use(cors());
app.use(express.json());
app.use(metricsMiddleware); // CloudWatch latency + error tracking

// Health check — always available, no dependencies
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'castle-backend', port: env.PORT });
});

// Start server IMMEDIATELY — before loading heavy modules
const server = app.listen(env.PORT, () => {
  console.log(`🏰 Castle Companion Backend running on port ${env.PORT}`);
  
  // THEN load API routes + QueueManager asynchronously
  import('./routes/api').then((apiModule) => {
    // Stripe Webhook MUST use raw body — mount BEFORE json parser
    import('./controllers/PaymentController').then((paymentModule) => {
      app.post('/api/payment/webhook', express.raw({ type: 'application/json' }), paymentModule.PaymentController.handleWebhook);
    });

    app.use('/api', apiModule.default);
    console.log('✅ API routes loaded');
  }).catch((err) => {
    console.error('❌ Failed to load API routes:', err.message);
    // Server still runs with /health endpoint
  });

  // Start Safety Watchdog
  import('./services/SafetyProtocol').then((m) => {
    m.SafetyProtocol.startWatchdog();
  }).catch(() => {});
});
