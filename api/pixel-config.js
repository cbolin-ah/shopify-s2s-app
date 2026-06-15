const clients = require('../config/clients');

function shopToSlug(shop) {
  return 'client-' + shop
    .replace('.myshopify.com', '')
    .replace(/[^a-z0-9]/gi, '-')
    .toLowerCase();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const shop = req.query.shop || '';
  if (!shop) return res.status(200).json({ audiohookId: null });

  const slug = shopToSlug(shop);
  const client = clients[slug];

  return res.status(200).json({ audiohookId: client?.audiohookId || null });
};
