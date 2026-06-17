// POST /api/create-checkout
// Creates a Stripe Checkout session, returns { url }
// Booking params stored in session.metadata → used by /api/verify-and-book after payment

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const BASE = process.env.SITE_URL || 'https://mkg-japan-website.vercel.app';

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

  const nights = Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);

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
        unit_amount: Number(totalAmount),
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
      totalAmount: String(totalAmount),
    },
  });

  res.status(200).json({ url: session.url });
};
