// GET /api/shiba-prices
// Returns per-room nightly rates for MKG HOME 芝.
// Override defaults by setting Vercel env vars: SHIBA_RATE_101, SHIBA_RATE_102, etc.

const DEFAULTS = {
  '101': 20000,
  '102': 30000,
  '201': 25000,
  '202': 23000,
  '301': 28000,
  '401': 24000,
};

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const rates = {};
  for (const [room, def] of Object.entries(DEFAULTS)) {
    const envKey = `SHIBA_RATE_${room}`;
    const val = parseInt(process.env[envKey], 10);
    rates[room] = (val && val > 0) ? val : def;
  }

  res.status(200).json({ rates });
};
