// Vercel Function: proxy SmartOrder booking creation
// POST /api/book  body: { checkIn, checkOut, adultCount, guestName, email, phone, note }

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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { return res.status(405).json({ error: 'Method not allowed' }); }

  const { checkIn, checkOut, adultCount, guestName, email, phone, note } = req.body || {};
  if (!checkIn || !checkOut || !guestName || !email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const token = await getToken();
    const payload = {
      hotelId: HOTEL_ID,
      roomTypeId: ROOM_TYPE_ID,
      checkIn,
      checkOut,
      adultCount: Number(adultCount) || 2,
      guestName,
      email,
      phone: phone || '',
      note: note || '',
    };
    const r = await fetch(`${BASE_URL}/booking/api/v3/hotels/${HOTEL_ID}/reservations/book`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
