// Client registry — maps URL slug to Audiohook ID
// Slug:      short identifier used in the Shopify webhook URL
// Value:     the client’s Audiohook account ID
//
// To add a new client:
//   1. Add a line here: 'your-slug': 'their-audiohook-id'
//   2. Commit the change — Vercel redeploys automatically
//   3. Register a Shopify webhook with ?client=your-slug in the URL


module.exports = {
  'client-built-bars':    '601b02a2-9ed8-4848-a8b0-2e9d718104b0',
  'client-example': 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  // Add new clients below this line
};

