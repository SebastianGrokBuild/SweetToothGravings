# Sweet Tooth Cravings — Website

A clean, modern, and easy-to-order baking website for Sweet Tooth Cravings in Miami, Florida.

## Features

- **Beautiful modern design** — Warm cream and berry-rose palette, elegant typography, generous whitespace
- **High-quality custom images** — All desserts photographed in a premium food photography style
- **Easy ordering flow**:
  - Click **Add** on any product to quickly add it
  - **View Details** opens a rich customization modal (quantity, size, notes)
  - Floating **Order** button shows cart drawer
  - **Request Order** opens a complete professional request form
- Full order request form includes:
  - Customer details
  - Date picker (enforces 4-day minimum lead time)
  - Pickup or Delivery selection
  - Live order summary
  - Allergies + special notes
  - Clear messaging about 50% deposit requirement
- Mobile responsive with hamburger menu
- Cart persists in localStorage
- Instagram prominently linked (@sweettoothcravings__)

## Getting Started

Run the site with the built-in server (required for custom cake orders & admin):

```bash
cd sweettooth-cravings
node serve.js
```

Or double-click **`Run Server.command`** (Mac), or run `./start.sh` / `npm start`.

- Website: **http://localhost:8080** (if port is busy, the next free port is used automatically)
- Admin: **http://localhost:8080/admin.html** (password in `.env`, default `sweettooth-admin`)
- Health check: **http://localhost:8080/api/health** → should show `{"ok":true}`

**Keep the terminal window open** while you use the site. If you only open `index.html` in the browser, the menu works but custom orders will say “can’t connect.”

No `npm install` needed — the server uses only Node.js built-ins.

## Customization

- All product data lives in a clean JS array near the top of the `<script>` tag
- Replace images in `/assets/images/` as needed (they are already optimized)
- Colors are controlled via Tailwind classes + a few CSS variables (rose accent is #C4457D)

## Policies Highlighted

- 4–5 day minimum lead time
- 50% non-refundable deposit required
- Pickup or delivery (+ fee) in Miami area
- Allergies must be listed in the form

## Order requests → Google Sheets

All **Submit Request** actions (custom cakes + menu cart) save to your Google Sheet. Inspiration photos upload to Google Drive with links in the sheet.

**Setup (one time):** follow **GOOGLE-SHEETS-SETUP.md**

- Custom cakes: menu banner, nav, or Custom Cakes card → wizard with photos
- Menu items: add to cart → **Submit Request** → contact form → saved to sheet

Optional: **admin.html** for Stripe payment links after you set a final price.

## Next Steps (Recommended)

- Add `STRIPE_SECRET_KEY` in `.env` for live payment links
- Set up a Stripe webhook to `https://your-domain.com/api/webhooks/stripe` (event: `checkout.session.completed`)
- Deploy to Railway, Render, or a VPS so the API runs 24/7 (not static hosting alone)

Built with ❤️ for Sweet Tooth Cravings. Enjoy the sweetness!

---

**Instagram**: [@sweettoothcravings__](https://www.instagram.com/sweettoothcravings__)  
**Location**: Miami, Florida
