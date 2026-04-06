/**
 * Mock Disney API — Time-Series State Machine
 * 
 * Simulates the Disney Lightning Lane availability API with:
 *   1. Temporal State Engine (finite inventory with decay curves)
 *   2. Chaos Injector (simulated cart abandonment / re-releases)
 *   3. Negotiation endpoints (counter-offers on sold-out windows)
 *   4. Configurable ride tiers and inventory
 * 
 * Usage: npm run dev (or npm start for production)
 * Default port: 3099
 */

import express, { Request, Response } from 'express';

const app = express();
app.use(express.json());

const PORT = process.env.MOCK_DISNEY_PORT || 3099;

// ─── CONFIGURATION ──────────────────────────────────────────────────

interface RideConfig {
  id: string;
  name: string;
  tier: 1 | 2;
  initialSlots: Record<string, number>;  // key = time window, value = slot count
}

interface ServerConfig {
  /** Simulated error rate (0-1). 0.05 = 5% of requests return 503 */
  errorRate: number;
  /** Simulated latency range in ms [min, max] */
  latencyRange: [number, number];
  /** Chaos injector: probability of slot re-release per heartbeat (0-1) */
  chaosReReleaseRate: number;
  /** Chaos heartbeat interval in ms */
  chaosIntervalMs: number;
  /** Rate limit: max requests per second per "user" */
  rateLimitPerSecond: number;
}

const DEFAULT_CONFIG: ServerConfig = {
  errorRate: 0.03,
  latencyRange: [50, 300],
  chaosReReleaseRate: 0.05,
  chaosIntervalMs: 5000,
  rateLimitPerSecond: 2,
};

// ─── RIDE INVENTORY ─────────────────────────────────────────────────

const RIDE_CONFIGS: RideConfig[] = [
  // Tier 1: Headliners — aggressive logarithmic decay
  { id: 'MK_TRON', name: 'TRON Lightcycle / Run', tier: 1,
    initialSlots: { '09:00': 500, '09:15': 500, '09:30': 400, '09:45': 400, '10:00': 350, '10:15': 350,
      '10:30': 300, '10:45': 300, '11:00': 250, '11:15': 250, '11:30': 200, '11:45': 200 } },
  { id: 'MK_7DMT', name: 'Seven Dwarfs Mine Train', tier: 1,
    initialSlots: { '09:00': 450, '09:15': 450, '09:30': 400, '09:45': 350, '10:00': 300, '10:15': 300,
      '10:30': 250, '10:45': 250, '11:00': 200, '11:15': 200, '11:30': 150, '11:45': 150 } },
  { id: 'MK_TIANA', name: "Tiana's Bayou Adventure", tier: 1,
    initialSlots: { '09:00': 500, '09:15': 500, '09:30': 450, '09:45': 400, '10:00': 350, '10:15': 350,
      '10:30': 300, '10:45': 300, '11:00': 250, '11:15': 250, '11:30': 200, '11:45': 200 } },
  // Tier 2: Mid-tier — linear decay
  { id: 'MK_HM', name: 'Haunted Mansion', tier: 2,
    initialSlots: { '09:00': 600, '09:15': 600, '09:30': 600, '09:45': 550, '10:00': 550, '10:15': 500,
      '10:30': 500, '10:45': 450, '11:00': 450, '11:15': 400, '11:30': 400, '11:45': 350,
      '12:00': 350, '12:15': 300, '12:30': 300, '12:45': 250, '13:00': 250, '13:15': 200 } },
  { id: 'MK_JUNGLE', name: 'Jungle Cruise', tier: 2,
    initialSlots: { '09:00': 550, '09:15': 550, '09:30': 500, '09:45': 500, '10:00': 450, '10:15': 450,
      '10:30': 400, '10:45': 400, '11:00': 350, '11:15': 350, '11:30': 300, '11:45': 300,
      '12:00': 250, '12:15': 250, '12:30': 200, '12:45': 200, '13:00': 150, '13:15': 150 } },
  { id: 'MK_SPACE', name: 'Space Mountain', tier: 2,
    initialSlots: { '09:00': 500, '09:15': 500, '09:30': 500, '09:45': 450, '10:00': 450, '10:15': 400,
      '10:30': 400, '10:45': 350, '11:00': 350, '11:15': 300, '11:30': 300, '11:45': 250,
      '12:00': 250, '12:15': 200, '12:30': 200, '12:45': 150, '13:00': 150, '13:15': 100 } },
];

// ─── STATE ENGINE ───────────────────────────────────────────────────

interface SlotState {
  available: number;
  booked: number;
  heldInCart: number;  // Slots temporarily held during booking flow
}

interface BookingRecord {
  id: string;
  rideId: string;
  window: string;
  userId: string;
  status: 'confirmed' | 'pending' | 'cancelled';
  createdAt: number;
}

// Master state
let testStartTime: number = Date.now();
let inventory: Record<string, Record<string, SlotState>> = {};
let bookings: BookingRecord[] = [];
let config: ServerConfig = { ...DEFAULT_CONFIG };
let chaosInterval: NodeJS.Timeout | null = null;
let requestCount = 0;
let errorCount = 0;

function initializeInventory(): void {
  inventory = {};
  bookings = [];
  requestCount = 0;
  errorCount = 0;
  testStartTime = Date.now();

  for (const ride of RIDE_CONFIGS) {
    inventory[ride.id] = {};
    for (const [window, slots] of Object.entries(ride.initialSlots)) {
      inventory[ride.id][window] = {
        available: slots,
        booked: 0,
        heldInCart: 0,
      };
    }
  }
  console.log(`[MOCK] Inventory initialized: ${RIDE_CONFIGS.length} rides, T=0 at ${new Date(testStartTime).toISOString()}`);
}

// ─── DECAY ENGINE ───────────────────────────────────────────────────

function getElapsedSeconds(): number {
  return (Date.now() - testStartTime) / 1000;
}

/**
 * Apply decay to available slots based on ride tier and elapsed time.
 * Called on every availability check to simulate organic bookings.
 * 
 * Tier 1 (Headliners): Aggressive logarithmic decay
 *   - Early windows vanish in <8 seconds
 *   - Total inventory zeroed by T+120s
 * 
 * Tier 2 (Mid-tier): Linear decay extending to T+300s
 */
function applyDecay(rideId: string): void {
  const rideConfig = RIDE_CONFIGS.find(r => r.id === rideId);
  if (!rideConfig) return;

  const elapsed = getElapsedSeconds();
  const windows = Object.keys(inventory[rideId] || {});

  for (const window of windows) {
    const slot = inventory[rideId][window];
    const initialSlots = rideConfig.initialSlots[window] || 0;

    let decayFactor: number;

    if (rideConfig.tier === 1) {
      // Logarithmic decay: slots = initial * (1 - log(1 + elapsed/10) / log(13))
      // Zeroes out by ~T+120s
      decayFactor = Math.min(1, Math.log(1 + elapsed / 10) / Math.log(13));
    } else {
      // Linear decay: slots decrease linearly over 300s
      decayFactor = Math.min(1, elapsed / 300);
    }

    const targetAvailable = Math.max(0, Math.floor(initialSlots * (1 - decayFactor)) - slot.booked);
    if (slot.available > targetAvailable) {
      slot.available = targetAvailable;
    }
  }
}

// ─── CHAOS INJECTOR ─────────────────────────────────────────────────

/**
 * Simulates cart abandonment: periodically re-releases a small number
 * of held/booked slots to test the Recovery Wave Sniper.
 */
function chaosHeartbeat(): void {
  for (const rideId of Object.keys(inventory)) {
    for (const window of Object.keys(inventory[rideId])) {
      const slot = inventory[rideId][window];

      // 5% chance per window per heartbeat: release 1-3 slots
      if (Math.random() < config.chaosReReleaseRate && slot.booked > 0) {
        const released = Math.min(slot.booked, Math.floor(Math.random() * 3) + 1);
        slot.booked -= released;
        slot.available += released;
        console.log(`[CHAOS] Re-released ${released} slot(s): ${rideId} @ ${window} (available: ${slot.available})`);
      }

      // Release expired cart holds (>30s)
      if (slot.heldInCart > 0) {
        slot.heldInCart = Math.max(0, slot.heldInCart - 1);
        slot.available += 1;
      }
    }
  }
}

function startChaosInjector(): void {
  if (chaosInterval) clearInterval(chaosInterval);
  chaosInterval = setInterval(chaosHeartbeat, config.chaosIntervalMs);
  console.log(`[CHAOS] Injector started: ${config.chaosReReleaseRate * 100}% re-release rate every ${config.chaosIntervalMs}ms`);
}

// ─── UTILITY ────────────────────────────────────────────────────────

function simulateLatency(): Promise<void> {
  const [min, max] = config.latencyRange;
  const delay = Math.floor(Math.random() * (max - min)) + min;
  return new Promise(resolve => setTimeout(resolve, delay));
}

function shouldError(): boolean {
  return Math.random() < config.errorRate;
}

function generateId(): string {
  return `BK-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

function findCounterOffer(rideId: string, requestedWindow: string): string | null {
  const rideInventory = inventory[rideId];
  if (!rideInventory) return null;

  // Find the next available window after the requested one
  const windows = Object.keys(rideInventory).sort();
  const requestedIdx = windows.indexOf(requestedWindow);

  for (let i = requestedIdx + 1; i < windows.length; i++) {
    if (rideInventory[windows[i]].available > 0) {
      return windows[i];
    }
  }
  return null;
}

// ─── ENDPOINTS ──────────────────────────────────────────────────────

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    testElapsed: `${getElapsedSeconds().toFixed(1)}s`,
    requestCount,
    errorCount,
  });
});

// Reset test state
app.post('/admin/reset', (req: Request, res: Response) => {
  const newConfig = req.body?.config;
  if (newConfig) {
    config = { ...DEFAULT_CONFIG, ...newConfig };
  }
  initializeInventory();
  startChaosInjector();
  res.json({ message: 'Test state reset', config, testStartTime: new Date(testStartTime).toISOString() });
});

// Get current state (admin/debugging)
app.get('/admin/state', (_req: Request, res: Response) => {
  res.json({
    elapsed: `${getElapsedSeconds().toFixed(1)}s`,
    inventory,
    bookingCount: bookings.length,
    requestCount,
    errorCount,
  });
});

// Check availability for a ride
app.get('/api/v1/availability/:rideId', async (req: Request, res: Response) => {
  requestCount++;
  await simulateLatency();

  if (shouldError()) {
    errorCount++;
    return res.status(503).json({ error: 'Service temporarily unavailable', code: 'DISNEY_503' });
  }

  const { rideId } = req.params;
  applyDecay(rideId);

  const rideInventory = inventory[rideId];
  if (!rideInventory) {
    return res.status(404).json({ error: 'Ride not found', code: 'RIDE_NOT_FOUND' });
  }

  const windows = Object.entries(rideInventory)
    .filter(([_, slot]) => slot.available > 0)
    .map(([window, slot]) => ({
      window,
      available: slot.available,
      total: slot.available + slot.booked + slot.heldInCart,
    }));

  res.json({
    rideId,
    elapsed: `${getElapsedSeconds().toFixed(1)}s`,
    availableWindows: windows,
    soldOut: windows.length === 0,
  });
});

// Book a slot
app.post('/api/v1/book', async (req: Request, res: Response) => {
  requestCount++;
  await simulateLatency();

  if (shouldError()) {
    errorCount++;
    return res.status(503).json({ error: 'Service temporarily unavailable', code: 'DISNEY_503' });
  }

  const { rideId, window, userId, idempotencyKey } = req.body;

  if (!rideId || !window || !userId) {
    return res.status(400).json({ error: 'Missing required fields: rideId, window, userId' });
  }

  // Idempotency check
  if (idempotencyKey) {
    const existing = bookings.find(b => b.id === idempotencyKey && b.status === 'confirmed');
    if (existing) {
      return res.status(200).json({ booking: existing, duplicate: true });
    }
  }

  applyDecay(rideId);

  const slot = inventory[rideId]?.[window];
  if (!slot || slot.available <= 0) {
    // 409: Sold out — provide counter-offer
    const counterOffer = findCounterOffer(rideId, window);
    return res.status(409).json({
      error: 'Window sold out',
      code: 'WINDOW_SOLD_OUT',
      requestedWindow: window,
      counterOffer: counterOffer ? {
        window: counterOffer,
        available: inventory[rideId][counterOffer].available,
        message: `${window} is sold out. ${counterOffer} has ${inventory[rideId][counterOffer].available} slots remaining.`,
      } : null,
    });
  }

  // Book the slot
  slot.available -= 1;
  slot.booked += 1;

  const booking: BookingRecord = {
    id: idempotencyKey || generateId(),
    rideId,
    window,
    userId,
    status: 'confirmed',
    createdAt: Date.now(),
  };
  bookings.push(booking);

  res.status(201).json({ booking });
});

// Confirm booking (two-phase commit — "Atomic Handshake")
app.post('/api/v1/confirm/:bookingId', async (req: Request, res: Response) => {
  requestCount++;
  await simulateLatency();

  const { bookingId } = req.params;
  const booking = bookings.find(b => b.id === bookingId);

  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  // Simulate occasional confirmation failure (tests Atomic Guarantee)
  if (shouldError()) {
    errorCount++;
    booking.status = 'cancelled';
    const slot = inventory[booking.rideId]?.[booking.window];
    if (slot) {
      slot.booked -= 1;
      slot.available += 1;
    }
    return res.status(503).json({
      error: 'Confirmation failed — booking rolled back',
      code: 'CONFIRM_FAILED',
      bookingId,
    });
  }

  res.json({ booking, confirmed: true });
});

// Cancel booking
app.delete('/api/v1/book/:bookingId', async (req: Request, res: Response) => {
  requestCount++;
  await simulateLatency();

  const { bookingId } = req.params;
  const booking = bookings.find(b => b.id === bookingId);

  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  booking.status = 'cancelled';
  const slot = inventory[booking.rideId]?.[booking.window];
  if (slot) {
    slot.booked -= 1;
    slot.available += 1;
  }

  res.json({ cancelled: true, bookingId });
});

// ─── STARTUP ────────────────────────────────────────────────────────

initializeInventory();
startChaosInjector();

app.listen(PORT, () => {
  console.log(`\n🏰 Mock Disney API running on http://localhost:${PORT}`);
  console.log(`   T=0: ${new Date(testStartTime).toISOString()}`);
  console.log(`   Rides: ${RIDE_CONFIGS.length}`);
  console.log(`   Error rate: ${config.errorRate * 100}%`);
  console.log(`   Latency: ${config.latencyRange[0]}-${config.latencyRange[1]}ms`);
  console.log(`   Chaos: ${config.chaosReReleaseRate * 100}% re-release every ${config.chaosIntervalMs}ms`);
  console.log(`\n   POST /admin/reset to restart with fresh inventory`);
  console.log(`   GET  /admin/state to inspect current state`);
  console.log(`   GET  /api/v1/availability/:rideId to check slots`);
  console.log(`   POST /api/v1/book to book a slot`);
  console.log(`   POST /api/v1/confirm/:bookingId to confirm (two-phase)`);
  console.log(`   DELETE /api/v1/book/:bookingId to cancel\n`);
});
