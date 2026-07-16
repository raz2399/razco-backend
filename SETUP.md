# Razi-Nova Solutions — Backend Setup Guide
## Get running in 30 minutes

---

## What You Need (All Free or Low Cost)

| Service | Cost | What For |
|---------|------|----------|
| Node.js | Free | Run the server |
| Railway.app or Render.com | Free tier | Host the backend online |
| Twilio | ~$0.008/SMS | Send text messages |
| OpenAI | ~$0.001/list | AI shopping lists |
| SQLite | Free | Customer database |

---

## Step 1 — Install Node.js on Your Computer

1. Go to **nodejs.org**
2. Download "LTS" version
3. Install it
4. Open Terminal (Mac) or Command Prompt (Windows)
5. Type: `node --version` — should show a number like v20.x.x

---

## Step 2 — Set Up Twilio (SMS Provider)

1. Go to **twilio.com** → Sign Up (free)
2. Get a phone number (~$1/month)
3. Find your:
   - **Account SID** (starts with AC...)
   - **Auth Token**
   - **Phone Number** (e.g. +12105551234)
4. Copy these into your `.env` file

**Cost to text customers:**
- Each SMS = ~$0.008 (less than 1 cent)
- 1,000 customers/week = ~$8/week
- vs SaleFish = $200-500/month

---

## Step 3 — Set Up OpenAI (AI Shopping Lists)

1. Go to **platform.openai.com** → Sign Up
2. Add $10 credit (lasts months)
3. Create API key
4. Copy into `.env` file

**Cost:**
- Each AI shopping list = ~$0.001
- 1,000 lists/week = ~$1

---

## Step 4 — Run Locally First

```bash
# Navigate to razco-backend folder
cd razco-backend

# Copy env file
cp .env.example .env

# Fill in your keys in .env file

# Install packages
npm install

# Start server
npm start
```

You should see:
```
🚀 Razi-Nova Solutions Backend running on port 3000
```

---

## Step 5 — Deploy Online (Railway.app — Free)

1. Go to **railway.app** → Sign Up with GitHub
2. Click "New Project" → "Deploy from GitHub repo"
3. Push your razco-backend folder to GitHub first:
   ```bash
   git init
   git add .
   git commit -m "Razco backend"
   git push
   ```
4. Railway auto-deploys
5. Add your environment variables in Railway dashboard
6. Get your live URL (e.g. `razco-backend.up.railway.app`)

---

## Step 6 — Connect Kiosk to Backend

In `razco-kiosk-v2.html`, find this line in the signup handler:
```javascript
// TODO: POST to your backend API here
```

Replace with:
```javascript
await fetch('https://YOUR-RAILWAY-URL.up.railway.app/api/customers', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, phone, email, opt_in_sms: optIn, prize: spinResult })
});
```

---

## API Quick Reference

### Register Customer (from kiosk)
```
POST /api/customers
{ "name": "Maria", "phone": "2105551234", "email": "", "opt_in_sms": true, "prize": "Free Drink" }
```

### Send Weekly Deals Campaign
```
POST /api/campaigns/1/send
```

### Generate AI Shopping List
```
POST /api/ai/shopping-list/42
{ "send_sms": true }
```

### Generate Campaign Message with AI
```
POST /api/ai/campaign-template
{ "type": "weekly_sale", "target_tier": "all" }
```

### Create Digital Coupon
```
POST /api/coupons
{ "title": "10% Off Produce", "discount_type": "percent", "discount_val": 10, "valid_until": "2026-07-31" }
```

### Get Analytics
```
GET /api/analytics
```

---

## Campaign Types

| Type | When to Use |
|------|-------------|
| `weekly_sale` | Every Monday — auto-sends current ad |
| `in_store` | Flash sale today only |
| `online` | Delivery/online order deals |
| `weekend` | Friday–Sunday specials |
| `push_list` | AI shopping list reminder |
| `coupon` | Digital coupon blast |
| `giveaway` | Contest/sweepstakes |

---

## Scheduled Auto-Campaigns

These run automatically once deployed:

| Schedule | What Happens |
|----------|-------------|
| Every Monday 8am | Weekly deals SMS to all customers |
| Every Friday 10am | Weekend special SMS |
| Every Sunday 9am | AI shopping lists to frequent shoppers |

---

## Loyalty Tiers

| Tier | Visits OR Points | Discount |
|------|-----------------|----------|
| Bronze | New | 0% |
| Silver | 5+ visits / 500+ pts | 2% |
| Gold | 20+ visits / 2000+ pts | 5% |
| Platinum | 50+ visits / 5000+ pts | 10% |

More visits = more discount. Automatically calculated.

---

## Questions?

Every piece of this is yours — the code, the data, the customers.
No monthly fee. No third party owning your data.

This is Razi-Nova Solutions.
