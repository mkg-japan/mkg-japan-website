// POST /api/create-checkout
// Creates a Stripe Checkout session for MKG HOME 新宿 (hotel 51401486)
// Includes server-side price verification via SmartOrder avail API

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const BASE = process.env.SITE_URL || 'https://mkg-japan-website.vercel.app';

const HOTEL_ID      = '51401486';
const CLIENT_ID     = process.env.SMARTORDER_CLIENT_ID     || '1513859491169472512';
const CLIENT_SECRET = process.env.SMARTORDER_CLIENT_SECRET || 'UJKaBl2TYGngV8DQMSCv2Gx6UZtYYcYh';
const TOKEN_URL     = 'https://idp.smartorder.ai/realms/smartorder-booking-api/protocol/openid-connect/token';
const BOOKING_URL   = 'https://api-open-booking.smartorder.ai';

async function getSmartOrderToken() {
  const params = new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
  const j = await r.json();
  return j.access_token;
}

async function getVerifiedPrice(checkIn, checkOut, adultCount, roomTypeId, rateId) {
  try {
    const token = await getSmartOrderToken();
    const qs = new URLSearchParams({ checkIn, checkOut, adultCount: String(adultCount || 2) });
    if (roomTypeId) qs.set('roomTypeId', roomTypeId);
    const r = await fetch(`${BOOKING_URL}/booking/api/v3/avail/${HOTEL_ID}?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    const rates = j.data?.roomRates || [];
    // If rateId provided, match exactly; otherwise use cheapest available rate
    const match = rateId ? rates.find(x => x.rateId === rateId) : rates.sort((a, b) => a.totalAmount - b.totalAmount)[0];
    return match ? match.totalAmount : null;
  } catch (e) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    checkIn, checkOut, adultCount, childCount,
    firstName, lastName, email, phone,
    roomId, rateId, totalAmount,
  } = req.body || {};

  if (!checkIn || !checkOut || !firstName || !lastName || !email || !totalAmount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Server-side price verification — prevent frontend price tampering
  const verifiedAmount = await getVerifiedPrice(checkIn, checkOut, adultCount, roomId, rateId);
  const clientAmount = Number(totalAmount);
  if (verifiedAmount !== null && Math.abs(verifiedAmount - clientAmount) > 1) {
    return res.status(400).json({ error: `Price mismatch: expected ${verifiedAmount}, got ${clientAmount}` });
  }
  const amount = verifiedAmount || clientAmount;
  if (!amount || amount < 50) {
    return res.status(400).json({ error: `Invalid totalAmount: ${totalAmount}` });
  }

  const nights = Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'jpy',
          product_data: {
            name: `MKG HOME 新宿 · ${nights}泊`,
            description: `${checkIn} ～ ${checkOut}  /  大人 ${adultCount || 2}名`,
            images: ['https://mkg-japan-website.vercel.app/assets/shinjuku/s01_bedroom_twin.jpg'],
          },
          unit_amount: amount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      customer_email: email,
      success_url: `${BASE}/home-shinjuku.html?booking=success&sid={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${BASE}/home-shinjuku.html?booking=cancelled`,
      locale: 'ja',
      metadata: {
        checkIn,
        checkOut,
        adultCount:  String(adultCount  || 2),
        childCount:  String(childCount  || 0),
        firstName,
        lastName,
        email,
        phone:       phone || '',
        roomId:      roomId || '905007308',
        rateId:      rateId || '',
        totalAmount: String(amount),
        hotelId:     '51401486',
      },
    });
    res.status(200).json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
