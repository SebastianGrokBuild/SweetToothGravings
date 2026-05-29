# Bakesy Images Replacement Guide

This guide helps you replace the current placeholder/Grok-generated images with your real, high-quality photos from your Bakesy shop.

## Status: ✅ COMPLETE

All Bakesy product photos have been successfully added to the website, renamed cleanly, and assigned to the correct menu items.

The `SweetToothCravings/` folder contents were processed.

---

## Step-by-Step Instructions (Easiest Method)

### On Mobile (Recommended - Fastest)

1. Open this link on your phone:  
   https://bakesy.shop/b/sweettoothcravings

2. For **each product**, do the following:
   - Tap on the product to open the detail view.
   - Long-press on the main/large photo.
   - Choose **"Download image"** or **"Save image"**.
   - Repeat for any additional photos shown in that product's detail page (these are usually better quality).

3. After downloading all images, transfer them to your computer.

4. Place them in this folder:
   ```
   /Users/sebastianmenendez/sweettooth-cravings/assets/images/
   ```

5. Rename the files using the **Suggested Filenames** table below.

6. Once renamed, tell me (or run the site) and I will update all the image paths in the code for you.

---

## Product → Suggested Filename Mapping

Use these exact filenames for best results with the current code:

| Product Name                    | Suggested Filename                  | Notes / Bakesy Tip                     |
|--------------------------------|-------------------------------------|----------------------------------------|
| 2 Tier Cakes                   | 2-tier-cakes.jpg                    | Use the best 2-tier photo              |
| Chocolate Covered Strawberries | chocolate-strawberries.jpg          | Get close-up of the strawberries       |
| Letter / Number Cakes          | letter-cake.jpg                     | One clear letter/number cake photo     |
| Breakable Hearts               | breakable-heart.jpg                 | The heart (broken or whole)            |
| Sheet Cakes / Rectangle Cakes  | sheet-cake.jpg                      | Full sheet cake shot                   |
| Churro Cheesecake              | churro-cheesecake.jpg               | Top-down or side view with churros     |
| Cupcakes                       | cupcakes.jpg                        | Nice assortment or close-up            |
| Bento Cake Box                 | bento-cake.jpg                      | The full bento box                     |
| Caterings                      | catering.jpg                        | Best group shot or platter             |
| Creamy Flan                    | flan.jpg                            | Classic flan photo                     |
| Coquito                        | coquito.jpg                         | Bottle + glass if available            |
| Tres Leches Trays              | tres-leches.jpg                     | Tray or slice shot                     |
| Custom Cakes                   | custom-cake.jpg                     | Best custom cake photo                 |
| Mini Chocoflans                | mini-chocoflans.jpg                 | Multiple minis together                |
| Mini Cakes                     | mini-cakes.jpg                      | Group of mini cakes                    |
| Dog Cakes                      | dog-cake.jpg                        | The dog cake                           |
| Chocoflan                      | chocoflan.jpg                       | Good layered shot                      |

**Hero Image** (current: `hero.jpg`):
- You can keep the current one or replace it with a beautiful hero shot from Bakesy (wide dessert spread works great).

---

## After You Add the Images

Once the files are in `assets/images/` with the names above, run this command in terminal (or just tell me):

```bash
cd /Users/sebastianmenendez/sweettooth-cravings
```

Then reply here with:

> "Images added"

I will immediately update the `products` array in `index.html` so everything points to the new real photos.

---

## Pro Tips

- **Quality**: Bakesy photos are usually high resolution. You can compress them later if the site feels slow.
- **Multiple photos**: If you want some products to have more than one photo later, let me know — we can add a simple gallery in the modal.
- **Logo**: Your current `logo.gpj.png` is good. You can also export a clean version of your logo from Bakesy if you prefer.

---

Need help with anything else (image optimization, adding more photos per product, etc.)? Just say the word.