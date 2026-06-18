// POST /api/shiba-checkout
// Creates a Stripe Checkout session for MKG HOME 芝 (hotel 30958695)

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
    roomId, rateId, roomName, totalAmount,
  } = req.body || {};

  if (!checkIn || !checkOut || !firstName || !lastName || !email || !totalAmount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const amount = Number(totalAmount);
  if (!amount || amount < 50) {
    return res.status(400).json({ error: `Invalid totalAmount: ${totalAmount}` });
  }

  const nights = Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);
  const productName = roomName
    ? `MKG HOME 芝 · ${roomName} · ${nights}泊`
    : `MKG HOME 芝 · ${nights}泊`;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'jpy',
          product_data: {
            name: productName,
            description: `${checkIn} ～ ${checkOut}  /  大人 ${adultCount || 2}名`,
          },
          unit_amount: amount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      customer_email: email,
      success_url: `${BASE}/home-shiba.html?booking=success&sid={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${BASE}/home-shiba.html?booking=cancelled`,
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
        roomId:      roomId || '',
        rateId:      rateId || '',
        roomName:    roomName || '',
        totalAmount: String(totalAmount),
        hotelId:     '30958695',
      },
    });
    res.status(200).json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
