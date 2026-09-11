// Audiohook Web Pixel — Customer Events
//
// Must use the register() wrapper from @shopify/web-pixels-extension — this
// runtime does NOT expose analytics/browser/init as bare globals for 'APP'
// (extension-based) pixels, only inside register()'s callback argument.
// (An older bare-global convention still shows up in some scaffolds/examples
// but throws "ReferenceError: analytics is not defined" on the current Web
// Pixels Manager runtime — confirmed live against a real store.)
//
// Runs in Shopify's strict-mode pixel sandbox:
//   - NO direct document.cookie access, but `browser.cookie.get/set` is a
//     privileged async bridge that reads/writes the real top-frame cookie
//     jar — the SAME ah_visitor_id/ah_session_id cookies cart-sync.liquid
//     manages. Using it here means every event (browsing through purchase)
//     carries one consistent id, not two different ones.
//   - NO DOM access
//   - CAN make fetch() calls to external URLs
//
// Timing note: cart-sync.liquid's inline <script> runs synchronously during
// HTML parsing, well before this sandbox finishes spinning up, so in
// practice the cookie already exists by the time we read it here. If this
// pixel ever won the race and created the cookie first, cart-sync.liquid
// would just adopt that value instead (it also reads-before-writing) — same
// reconciliation the rest of this app already leans on elsewhere.

import { register } from '@shopify/web-pixels-extension';

var VERCEL_URL = 'https://cbolin-ah-shop-events-s2s-app.vercel.app';
var COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

register(async ({ analytics, browser }) => {
  var audiohookId = null;
  var shopDomain = null;
  var visitorId = null;
  var sessionId = null;
  var idsReady = false;
  var pending = [];

  function baseFields(event) {
    var ctx = event.context || {};
    var doc = ctx.document || {};
    var nav = ctx.navigator || {};
    return {
      client_id: event.clientId || '',
      timestamp: event.timestamp || new Date().toISOString(),
      url: (doc.location && doc.location.href) || '',
      referrer: doc.referrer || '',
      user_agent: nav.userAgent || '',
    };
  }

  function post(payload) {
    // text/plain avoids a CORS preflight (Remix's resource routes don't handle
    // OPTIONS) — the server parses the body as JSON regardless.
    fetch(VERCEL_URL + '/api/pixel-event', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
    }).catch(function(err) {
      console.error('[audiohook-pixel] fetch failed for', payload.event_name, err && err.message);
    });
  }

  function flushPending() {
    while (pending.length) {
      var p = pending.shift();
      p.audiohookId = audiohookId;
      p.visitor_id = visitorId || '';
      p.session_id = sessionId || '';
      post(p);
    }
  }

  // Queues until BOTH the shop's audiohookId and the real ah_visitor_id/
  // ah_session_id are resolved — everything gets the same ids regardless of
  // which of the two async lookups finishes first.
  function forward(eventName, fields) {
    var payload = Object.assign(
      { event_name: eventName, audiohookId: audiohookId, shop: shopDomain, visitor_id: visitorId || '', session_id: sessionId || '' },
      fields
    );
    if (!audiohookId || !idsReady) {
      pending.push(payload);
      return;
    }
    post(payload);
  }

  // Read the real cookies via the privileged browser API (works at any
  // point in the journey, not just once a checkout exists). Generates and
  // persists them here too, so a shopper whose very first pixel event fires
  // before cart-sync.liquid does still gets a durable id.
  (async function initIds() {
    try {
      var existingVisitor = await browser.cookie.get('ah_visitor_id');
      var existingSession = await browser.cookie.get('ah_session_id');
      visitorId = existingVisitor || generateUUID();
      sessionId = existingSession || generateUUID();
      if (!existingVisitor) {
        await browser.cookie.set('ah_visitor_id=' + visitorId + '; path=/; max-age=' + COOKIE_MAX_AGE + '; SameSite=Lax');
      }
      if (!existingSession) {
        await browser.cookie.set('ah_session_id=' + sessionId + '; path=/; max-age=' + COOKIE_MAX_AGE + '; SameSite=Lax');
      }
    } catch (err) {
      console.error('[audiohook-pixel] cookie read/write failed', err && err.message);
      visitorId = visitorId || '';
      sessionId = sessionId || '';
    }
    idsReady = true;
    flushPending();
  })();

  // PAGE VIEWED — capture shop domain and load audiohookId config once per session
  analytics.subscribe('page_viewed', function(event) {
    var shop = event.init && event.init.data && event.init.data.shop && event.init.data.shop.domain;
    if (shop) shopDomain = shop;

    forward('page_viewed', baseFields(event));

    if (audiohookId || !shop) return;

    fetch(VERCEL_URL + '/api/pixel-config?shop=' + encodeURIComponent(shop))
      .then(function(r) { return r.json(); })
      .then(function(cfg) {
        if (cfg && cfg.audiohookId) {
          audiohookId = cfg.audiohookId;
          flushPending();
        }
      })
      .catch(function(err) {
        console.error('[audiohook-pixel] pixel-config fetch failed', err && err.message);
      });
  });

  analytics.subscribe('collection_viewed', function(event) {
    var collection = event.data && event.data.collection;
    forward('collection_viewed', Object.assign(baseFields(event), {
      collection_id: collection && collection.id,
      collection_title: collection && collection.title,
    }));
  });

  analytics.subscribe('product_viewed', function(event) {
    var pv = event.data && event.data.productVariant;
    var product = pv && pv.product;
    forward('product_viewed', Object.assign(baseFields(event), {
      product_id: product && product.id,
      product_title: product && product.title,
      product_vendor: product && product.vendor,
      product_type: product && product.type,
      variant_id: pv && pv.id,
      sku: pv && pv.sku,
      price: pv && pv.price && pv.price.amount,
      currency: pv && pv.price && pv.price.currencyCode,
    }));
  });

  analytics.subscribe('search_submitted', function(event) {
    var sr = event.data && event.data.searchResult;
    forward('search_submitted', Object.assign(baseFields(event), {
      query: sr && sr.query,
      results_count: sr && sr.productVariants ? sr.productVariants.length : undefined,
    }));
  });

  analytics.subscribe('cart_viewed', function(event) {
    var cart = event.data && event.data.cart;
    var total = cart && cart.cost && cart.cost.totalAmount;
    forward('cart_viewed', Object.assign(baseFields(event), {
      line_count: cart && cart.totalQuantity,
      value: total && total.amount,
      currency: total && total.currencyCode,
    }));
  });

  function cartLineFields(event) {
    var cl = event.data && event.data.cartLine;
    var merch = cl && cl.merchandise;
    var product = merch && merch.product;
    var cost = cl && cl.cost && cl.cost.totalAmount;
    return {
      product_id: product && product.id,
      product_title: product && product.title,
      variant_id: merch && merch.id,
      sku: merch && merch.sku,
      quantity: cl && cl.quantity,
      value: cost && cost.amount,
      currency: cost && cost.currencyCode,
    };
  }

  analytics.subscribe('product_added_to_cart', function(event) {
    forward('product_added_to_cart', Object.assign(baseFields(event), cartLineFields(event)));
  });

  analytics.subscribe('product_removed_from_cart', function(event) {
    forward('product_removed_from_cart', Object.assign(baseFields(event), cartLineFields(event)));
  });

  function checkoutFields(event) {
    var checkout = event.data && event.data.checkout;
    var total = checkout && checkout.totalPrice;
    return {
      checkout: checkout,
      fields: Object.assign(baseFields(event), {
        value: total && total.amount,
        currency: total && total.currencyCode,
      }),
    };
  }

  // CHECKOUT STARTED — also bridges visitor/session id to Redis keyed by
  // checkout_token, so the orders/paid webhook can recover it even when
  // note_attributes is empty (Shop Pay / dynamic checkout buttons). Reading
  // visitorId from our own cookie lookup above (rather than from
  // checkout.customAttributes, which depends on cart-sync.liquid's sync
  // having already landed) means this fallback works even in the exact
  // cases it exists for.
  analytics.subscribe('checkout_started', function(event) {
    var c = checkoutFields(event);
    var checkout = c.checkout;
    if (checkout && checkout.token && visitorId) {
      fetch(VERCEL_URL + '/api/checkout-visitor', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ token: checkout.token, visitorId: visitorId, sessionId: sessionId }),
      }).catch(function() {});
    }
    forward('checkout_started', c.fields);
  });

  analytics.subscribe('checkout_contact_info_submitted', function(event) {
    forward('checkout_contact_info_submitted', checkoutFields(event).fields);
  });

  analytics.subscribe('checkout_address_info_submitted', function(event) {
    forward('checkout_address_info_submitted', checkoutFields(event).fields);
  });

  analytics.subscribe('checkout_shipping_info_submitted', function(event) {
    forward('checkout_shipping_info_submitted', checkoutFields(event).fields);
  });

  analytics.subscribe('payment_info_submitted', function(event) {
    forward('payment_info_submitted', checkoutFields(event).fields);
  });

  // No checkout_completed subscription — orders/paid already delivers
  // purchase/repeatpurchase server-side with full attribution for every
  // completed order, so a client-side completion event would be redundant.
});
