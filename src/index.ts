import express from 'express';
import cors from 'cors';
import { env } from './config/env';

import apiRoutes from './routes/api';
import { PaymentController } from './controllers/PaymentController';
import { SafetyProtocol } from './services/SafetyProtocol';

const app = express();

app.use(cors());

// Stripe Webhook MUST use raw body for signature verification
app.post('/api/payment/webhook', express.raw({ type: 'application/json' }), PaymentController.handleWebhook);

app.use(express.json());

app.use('/api', apiRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'castle-backend' });
});

app.listen(env.PORT, () => {
  console.log(`🏰 Castle Companion Backend running on port ${env.PORT}`);
  
  // Start the Safety Watchdog
  SafetyProtocol.startWatchdog();
});
