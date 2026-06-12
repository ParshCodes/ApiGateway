import express from 'express';

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const INSTANCE_ID = process.env.INSTANCE_ID || `backend-${PORT}`;

// Probability that this backend returns a 500 (simulates real-world flakiness)
const ERROR_RATE = Number(process.env.ERROR_RATE) || 0.05; // 5%

// Latency range in ms
const MIN_LATENCY = Number(process.env.MIN_LATENCY) || 10;
const MAX_LATENCY = Number(process.env.MAX_LATENCY) || 100;

function randomDelay(): Promise<void> {
  const ms = MIN_LATENCY + Math.random() * (MAX_LATENCY - MIN_LATENCY);
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Health probe — returns instantly so the gateway can check us quickly
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', instance: INSTANCE_ID });
});

// Generic catch-all: simulate work with variable latency
app.use(async (req, res) => {
  await randomDelay();

  if (Math.random() < ERROR_RATE) {
    res.status(500).json({
      error: 'Internal Server Error',
      instance: INSTANCE_ID,
      path: req.path,
    });
    return;
  }

  res.json({
    message: 'OK',
    instance: INSTANCE_ID,
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () =>
  console.log(`[${INSTANCE_ID}] listening on :${PORT}`)
);
