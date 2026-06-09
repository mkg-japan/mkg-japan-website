// Vercel Function: proxy SmartOrder calendar API
// GET /api/calendar?startDate=2026-07-01&endDate=2026-07-31&adultCount=2

const HOTEL_ID      = process.env.SMARTORDER_HOTEL_ID      || '51401486';
const ROOM_TYPE_ID  = process.env.SMARTORDER_ROOM_TYPE_ID  || '905007308';
const CLIENT_ID     = process.env.SMARTORDER_CLIENT_ID     || '1513859491169472512';
const CLIENT_SECRET = process.env.SMARTORDER_CLIENT_SECRET;
const TOKEN_URL     = 'https://idp.smartorder.ai/realms/smartorder-booking-api/protocol/openid-connect/token';
const BASE_URL      = 'https://api-open-booking.smartorder.ai';

let _cachedToken = null;
let _tokenExpiry = 0;

async function getToken() {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  const j = await r.json();
  _cachedToken = j.access_token;
  _tokenExpiry = Date.now() + (j.expires_in - 60) * 1000;
  return _cachedToken;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { startDate, endDate, adultCount = '1' } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'startDate and endDate required' });
  }

  try {
    const token = await getToken();
    const params = new URLSearchParams({ startDate, endDate, roomTypeId: ROOM_TYPE_ID, adultCount });
    const r = await fetch(`${BASE_URL}/booking/api/v3/calendar/${HOTEL_ID}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
