// Client registry — maps URL slug to Audiohook ID
// Slug:      short identifier used in the Shopify webhook URL
// Value:     the client’s Audiohook account ID
//
// To add a new client:
//   1. Add a line here: 'your-slug': 'their-audiohook-id'
//   2. Commit the change — Vercel redeploys automatically
//   3. Register a Shopify webhook with ?client=your-slug in the URL


module.exports = {
  'client-built-bars':    '48197d46-f4d4-44e4-84c1-3db837381b3b',
  'client-example': 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  // Add new clients below this line
};

