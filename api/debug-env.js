const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  const key = process.env.STRIPE_SECRET_KEY || '';
  try {
    await stripe.checkout.sessions.list({ limit: 1 });
    res.status(200).json({ ok: true, prefix: key.slice(0, 12), length: key.length });
  } catch(e) {
    res.status(200).json({ ok: false, prefix: key.slice(0, 12), length: key.length, error: e.message, type: e.type });
  }
};
