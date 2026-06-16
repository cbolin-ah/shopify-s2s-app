const { kvGetMerchant } = require('./kv');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const shop = req.query.shop || '';
  if (!shop) return res.status(200).json({ audiohookId: null });

  const merchant = await kvGetMerchant(shop);
  return res.status(200).json({ audiohookId: merchant?.audiohookId || null });
};
