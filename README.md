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

1. Open `index.html` directly in any browser, **or**
2. Run a local server:

```bash
# From this folder
python3 -m http.server 8000
# Then visit http://localhost:8000
```

## Customization

- All product data lives in a clean JS array near the top of the `<script>` tag
- Replace images in `/assets/images/` as needed (they are already optimized)
- Colors are controlled via Tailwind classes + a few CSS variables (rose accent is #C4457D)

## Policies Highlighted

- 4–5 day minimum lead time
- 50% non-refundable deposit required
- Pickup or delivery (+ fee) in Miami area
- Allergies must be listed in the form

## Next Steps (Recommended)

- **Images from Bakesy** → ✅ Your real high-quality product photos from the Bakesy shop have been added and are now live on the website (assigned to each item).
- Connect the order form to a real backend (Formspree, Netlify Forms, or custom email endpoint)
- Add actual Google reviews / Instagram feed embed
- Add a small admin view or Google Sheet integration for incoming requests

Built with ❤️ for Sweet Tooth Cravings. Enjoy the sweetness!

---

**Instagram**: [@sweettoothcravings__](https://www.instagram.com/sweettoothcravings__)  
**Location**: Miami, Florida
