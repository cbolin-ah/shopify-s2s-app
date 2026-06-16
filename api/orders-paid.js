const {
  validateRequest,
  hashEmail,
  getNoteAttr,
  sendToAudiohook,
} = require('./shared');
const { kvGet } = require('./kv');

module.exports.config = { api: { bodyParser: false } };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const ctx = await validateRequest(req, res);
  if (!ctx) return;

  const { rawBody, shop, audiohookId } = ctx;

  try {
    const order       = JSON.parse(rawBody);
    const ordersCount = order.customer?.orders_count ?? 0;
    const eventName   = ordersCount <= 1 ? 'purchase' : 'repeatpurchase';

    // Primary path: cart attributes → note_attributes (set by theme extension)
    let visitorId = getNoteAttr(order, 'ah_visitor_id');
    let sessionId = getNoteAttr(order, 'ah_session_id');

    // Fallback path: pixel stored checkout_token → visitor_id in KV on checkout_started
    if (!visitorId && order.checkout_token) {
      const cached = await kvGet(`checkout:${order.checkout_token}`);
      if (cached?.visitorId) {
        visitorId = cached.visitorId;
        sessionId = cached.sessionId || '';
        console.log('[audiohook-s2s] visitor_id resolved via KV fallback');
      }
    }

    const items = (order.line_items || []).map(item => ({
      product_id:   String(item.product_id),
      product_name: item.title,
      price:        parseFloat(item.price),
      quantity:     item.quantity,
    }));

    const payload = {
      event_name : eventName,
      timestamp  : new Date(order.created_at).toISOString(),
      visitor_id : visitorId,
      session_id : sessionId,
      url        : `https://${shop}/checkout/success`,
      referrer   : order.landing_site || '',
      user_agent : order.client_details?.user_agent || '',
      ip_address : order.browser_ip || '0.0.0.0',
      order_id   : String(order.id),
      value      : parseFloat(order.total_price),
      currency   : order.currency,
      email      : hashEmail(order.email),
      items,
    };

    await sendToAudiohook(audiohookId, payload);

    console.log(
      `[audiohook-s2s] ${eventName} tracked`,
      `| shop: ${shop}`,
      `| order: ${order.id}`,
      `| value: ${order.total_price} ${order.currency}`,
      `| visitor_id: ${visitorId || 'NOT SET'}`,
    );

  } catch (err) {
    console.error(`[audiohook-s2s] orders-paid failed | shop: ${shop} |`, err.message);
  }

  res.status(200).send('OK');
};
