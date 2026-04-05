import dotenv from 'dotenv';
dotenv.config();

export const env = {
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  PINECONE_API_KEY: process.env.PINECONE_API_KEY,
  PINECONE_INDEX_NAME: process.env.PINECONE_INDEX_NAME || 'castle-companion-lore',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  FIREBASE_SERVICE_ACCOUNT_PATH: process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'patchenu@gmail.com',
  ADMIN_PHONE: process.env.ADMIN_PHONE || '+15551234567',

  // ── Disney API Integration ──────────────────────────────────
  DISNEY_WDW_ORIGIN: process.env.DISNEY_WDW_ORIGIN || 'https://disneyworld.disney.go.com',
  DISNEY_DLR_ORIGIN: process.env.DISNEY_DLR_ORIGIN || 'https://disneyland.disney.go.com',
  DISNEY_VQ_WDW_ORIGIN: process.env.DISNEY_VQ_WDW_ORIGIN || 'https://vqguest-svc-wdw.wdprapps.disney.com',
  DISNEY_VQ_DLR_ORIGIN: process.env.DISNEY_VQ_DLR_ORIGIN || 'https://vqguest-svc.wdprapps.disney.com',
  DISNEY_API_JITTER_MIN_MS: parseInt(process.env.DISNEY_API_JITTER_MIN_MS || '200', 10),
  DISNEY_API_JITTER_MAX_MS: parseInt(process.env.DISNEY_API_JITTER_MAX_MS || '1500', 10),
  DISNEY_API_MAX_RPS_PER_SKIPPER: parseInt(process.env.DISNEY_API_MAX_RPS_PER_SKIPPER || '2', 10),

  // ── BG1 Sync Engine ─────────────────────────────────────────
  BG1_SYNC_ENABLED: process.env.BG1_SYNC_ENABLED !== 'false',
  BG1_SYNC_INTERVAL_MIN: parseInt(process.env.BG1_SYNC_INTERVAL_MIN || '15', 10),

  // ── Alerting ────────────────────────────────────────────────
  ALERT_WEBHOOK_URL: process.env.ALERT_WEBHOOK_URL, // n8n webhook for critical alerts
};

// Validation
const required = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'PINECONE_API_KEY', 'RESEND_API_KEY'];
required.forEach(key => {
  if (!process.env[key]) {
    console.warn(`⚠️  WARNING: Missing required environment variable: ${key}. Some features may malfunction.`);
  }
});
