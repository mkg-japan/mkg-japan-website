module.exports = function handler(req, res) {
  const key = process.env.STRIPE_SECRET_KEY || '';
  res.status(200).json({
    has_key: !!key,
    prefix: key.slice(0, 12),
    length: key.length,
  });
};
