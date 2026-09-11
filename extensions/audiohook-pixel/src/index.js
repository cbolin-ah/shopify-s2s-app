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
//   - NO access to document.cookie (can't read the ah_visitor_id cookie
//     cart-sync.liquid sets — that's only readable via checkout.customAttributes,
//     and only once a checkout exists)
//   - NO DOM access
//   - CAN read event.data.checkout.customAttributes (set from cart attributes)
//   - CAN make fetch() calls to external URLs
//   - every event carries event.clientId — Shopify's own persistent per-browser
//     id, first-party and cookie-based on Shopify's side. For everything before
//     checkout (browsing, cart) this is the only visitor identity available in
//     here, so every event always carries it as visitor_id. It is not
//     guaranteed to equal ah_visitor_id — the two only reconcile once checkout
//     starts and customAttributes become readable, at which point visitor_id
//     is overridden with the real cookie-derived value.

import { register } from '@shopify/web-pixels-extension';

var VERCEL_URL = 'https://cbolin-ah-shop-events-s2s-app.vercel.app';

register(({ analytics }) => {
  var audiohookId = null;
  var shopDomain = null;
  var pending = [];

  function getAttr(attrs, key) {
    if (!Array.isArray(attrs)) return '';
    var found = attrs.find(function(a) { return a.key === key; });
    return (found && found.value) || '';
  }

  function baseFields(event) {
    var ctx = event.context || {};
    var doc = ctx.document || {};
    var nav = ctx.navigator || {};
    return {
      client_id: event.clientId || '',
      visitor_id: event.clientId || '',
      session_id: '',
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
      post(p);
    }
  }

  // audiohookId loads async off the first page_viewed — anything that fires
  // before it resolves (a product_viewed on the same tick, say) queues instead
  // of dropping silently.
  function forward(eventName, fields) {
    var payload = Object.assign(
      { event_name: eventName, audiohookId: audiohookId, shop: shopDomain },
      fields
    );
    if (!audiohookId) {
      pending.push(payload);
      return;
    }
    post(payload);
  }

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
    var customAttrs = (checkout && checkout.customAttributes) || [];
    var total = checkout && checkout.totalPrice;
    return {
      checkout: checkout,
      fields: Object.assign(baseFields(event), {
        visitor_id: getAttr(customAttrs, 'ah_visitor_id'),
        session_id: getAttr(customAttrs, 'ah_session_id'),
        value: total && total.amount,
        currency: total && total.currencyCode,
      }),
    };
  }

  // CHECKOUT STARTED
  // In strict mode we cannot read cookies, but checkout.customAttributes contains
  // the cart attributes set by the theme extension (ah_visitor_id, ah_session_id).
  // POST these to Vercel KV keyed by checkout_token so the orders/paid webhook
  // can retrieve them even when note_attributes is empty (e.g. dynamic checkout button).
  analytics.subscribe('checkout_started', function(event) {
    var c = checkoutFields(event);
    var checkout = c.checkout;
    if (checkout) {
      var token = checkout.token;
      var visitorId = c.fields.visitor_id;
      if (token && visitorId) {
        fetch(VERCEL_URL + '/api/checkout-visitor', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ token: token, visitorId: visitorId, sessionId: c.fields.session_id }),
        }).catch(function() {});
      }
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
