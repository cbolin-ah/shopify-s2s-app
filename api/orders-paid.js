const {
  validateRequest,
  hashEmail,
  getNoteAttr,
  sendToAudiohook,
} = require('./shared');

module.exports.config = { api: { bodyParser: false } };

module.exports = async function handler(req, res) {
  console.log('[audiohook-s2s] orders-paid invoked', req.url);

  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const ctx = await validateRequest(req, res);
  if (!ctx) return;

  const { rawBody, clientSlug, audiohookId } = ctx;

  try {
    const order       = JSON.parse(rawBody);
    const ordersCount = order.customer?.orders_count ?? 0;
    const eventName   = ordersCount <= 1 ? 'purchase' : 'repeatpurchase';

    // visitor_id and session_id written to order note attributes
    // by the Customer Events script during checkout_completed
    const visitorId = getNoteAttr(order, 'ah_visitor_id');
    const sessionId = getNoteAttr(order, 'ah_session_id');

    // Map Shopify line items to Audiohook items format
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
      url        : `https://${order.source_name || 'yourstore.com'}/checkout/success`,
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
      `| client: ${clientSlug}`,
      `| order: ${order.id}`,
      `| value: ${order.total_price} ${order.currency}`,
      `| visitor_id: ${visitorId || 'NOT SET'}`,
    );

  } catch (err) {
    console.error(
      `[audiohook-s2s] orders-paid failed | client: ${clientSlug} |`,
      err.message
    );
  }

  // Acknowledge Shopify after Audiohook POST completes
  // Vercel cancels execution after res is sent — must do all work first
  res.status(200).send('OK');
};
