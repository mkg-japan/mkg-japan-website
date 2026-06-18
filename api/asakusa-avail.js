// Vercel Function: SmartOrder avail for MKG HOTEL 浅草 (hotel 86177544)
// GET /api/asakusa-avail?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&adultCount=2

const HOTEL_ID      = '86177544';
const CLIENT_ID     = process.env.SMARTORDER_CLIENT_ID     || '1513859491169472512';
const CLIENT_SECRET = process.env.SMARTORDER_CLIENT_SECRET || 'UJKaBl2TYGngV8DQMSCv2Gx6UZtYYcYh';
const TOKEN_URL     = 'https://idp.smartorder.ai/realms/smartorder-booking-api/protocol/openid-connect/token';
const BASE_URL      = 'https://api-open-booking.smartorder.ai';

let _cachedToken = null;
let _tokenExpiry = 0;

async function getToken() {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const j = await r.json();
  _cachedToken = j.access_token;
  _tokenExpiry = Date.now() + (j.expires_in - 60) * 1000;
  return _cachedToken;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { checkIn, checkOut, adultCount = '2', roomTypeId } = req.query;
  if (!checkIn || !checkOut) {
    return res.status(400).json({ error: 'checkIn and checkOut required' });
  }

  try {
    const token = await getToken();
    const qs = new URLSearchParams({ checkIn, checkOut, adultCount });
    if (roomTypeId) qs.set('roomTypeId', roomTypeId);
    const r = await fetch(`${BASE_URL}/booking/api/v3/avail/${HOTEL_ID}?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
