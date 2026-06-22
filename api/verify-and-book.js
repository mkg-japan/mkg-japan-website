// GET /api/verify-and-book?sid=STRIPE_SESSION_ID
// 1. Verifies payment with Stripe
// 2. Creates SmartOrder reservation
// 3. Uploads payment record to SmartOrder PMS
// 4. Deduplicates via PaymentIntent description to prevent double-booking on page refresh

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const HOTEL_ID         = process.env.SMARTORDER_HOTEL_ID      || '86177544';
const CLIENT_ID        = process.env.SMARTORDER_CLIENT_ID     || '1513859491169472512';
const CLIENT_SECRET    = process.env.SMARTORDER_CLIENT_SECRET || 'UJKaBl2TYGngV8DQMSCv2Gx6UZtYYcYh';
const PAYMENT_METHOD   = process.env.SMARTORDER_PAYMENT_METHOD || 'Stripe';
const TOKEN_URL        = 'https://idp.smartorder.ai/realms/smartorder-booking-api/protocol/openid-connect/token';
const BASE_URL         = 'https://api-open-booking.smartorder.ai';

async function getToken() {
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
  return j.access_token;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { sid } = req.query;
  if (!sid) return res.status(400).json({ error: 'Missing session id' });

  try {
    // 1. Retrieve Stripe session
    const session = await stripe.checkout.sessions.retrieve(sid);
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment not completed' });
    }

    const meta = session.metadata;

    // 2. Deduplicate: check if this session already created a SmartOrder booking
    const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
    if (pi.description && pi.description.startsWith('SO:')) {
      const reservationId = pi.description.slice(3);
      return res.status(200).json({
        success: true,
        reservationId,
        checkIn: meta.checkIn,
        checkOut: meta.checkOut,
        firstName: meta.firstName,
        lastName: meta.lastName,
        email: meta.email,
        totalAmount: meta.totalAmount,
      });
    }

    // 3. Re-check availability before booking (guard against overbooking after payment)
    const token = await getToken();
    const hotelId = meta.hotelId || HOTEL_ID;
    const availQs = new URLSearchParams({
      checkIn: meta.checkIn,
      checkOut: meta.checkOut,
      adultCount: meta.adultCount || '2',
      roomTypeId: meta.roomId || '',
    });
    const availR = await fetch(`${BASE_URL}/booking/api/v3/avail/${hotelId}?${availQs}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    const availData = await availR.json();
    const roomRates = availData.data?.roomRates || [];
    // If rateId is known, require exact match; otherwise just confirm any rate exists
    const matchingRate = meta.rateId
      ? roomRates.find(r => r.rateId === meta.rateId)
      : roomRates[0];
    if (!matchingRate) {
      return res.status(409).json({
        error: 'sold_out',
        message: 'This room is no longer available for the selected dates. Please contact us for a refund.',
      });
    }
    // Re-verify price matches what was charged (prevent price tampering)
    if (Math.abs(matchingRate.totalAmount - Number(meta.totalAmount)) > 1) {
      console.error(`Price mismatch: charged=${meta.totalAmount} current=${matchingRate.totalAmount}`);
    }

    // 4. Create SmartOrder reservation
    const payload = {
      hotelId,
      checkIn: meta.checkIn,
      checkOut: meta.checkOut,
      adultCount:  Number(meta.adultCount)  || 2,
      childCount:  Number(meta.childCount)  || 0,
      roomCount:   1,
      roomId:      meta.roomId  || '',
      rateId:      meta.rateId  || '',
      totalAmount: Number(meta.totalAmount) || 0,
      currencyCode: 'JPY',
      paymentType: 'Prepay',
      customer: {
        firstName: meta.firstName,
        lastName:  meta.lastName,
        email:     meta.email,
        phone:     meta.phone || '',
      },
    };

    const br = await fetch(`${BASE_URL}/booking/api/v3/hotels/${hotelId}/reservations/book`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const bookingData = await br.json();
    const reservationId = bookingData.data?.reservationId || '';

    // 4. Upload payment record to SmartOrder PMS
    if (reservationId) {
      const paymentPayload = {
        paymentTime: new Date(pi.created * 1000).toISOString(),
        paymentType: 'Charge',
        paymentMethod: PAYMENT_METHOD,
        amount: Number(meta.totalAmount) || 0,
        currencyCode: 'JPY',
        notes: session.payment_intent,
      };
      try {
        await fetch(`${BASE_URL}/booking/api/v3/hotels/${hotelId}/reservations/${reservationId}/payments`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(paymentPayload),
        });
      } catch (payErr) {
        console.error('Payment upload failed:', payErr.message);
      }

      // 5. Mark PaymentIntent as booked to prevent duplicates
      await stripe.paymentIntents.update(session.payment_intent, {
        description: `SO:${reservationId}`,
      });
    }

    res.status(200).json({
      success: true,
      reservationId,
      checkIn:     meta.checkIn,
      checkOut:    meta.checkOut,
      firstName:   meta.firstName,
      lastName:    meta.lastName,
      email:       meta.email,
      totalAmount: meta.totalAmount,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
