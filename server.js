// ═══════════════════════════════════════════════════════════════
//  RAZI-NOVA SOLUTIONS — Main Backend Server
//  Razco Foods Supermarket
//  Stack: Node.js + Express + SQLite + Twilio + OpenAI
// ═══════════════════════════════════════════════════════════════

const express    = require('express');
const cors       = require('cors');
const Database   = require('better-sqlite3');
const twilio     = require('twilio');
const OpenAI     = require('openai');
const cron       = require('node-cron');
const path       = require('path');
const fs         = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── ENV CONFIG ──────────────────────────────────────────────────
const PORT             = process.env.PORT || 3000;
const TWILIO_SID       = process.env.TWILIO_SID;
const TWILIO_TOKEN     = process.env.TWILIO_TOKEN;
const TWILIO_PHONE     = process.env.TWILIO_PHONE;       // e.g. +12105551234
const TWILIO_WHATSAPP  = process.env.TWILIO_WHATSAPP;    // e.g. whatsapp:+14155238886
const OPENAI_KEY       = process.env.OPENAI_API_KEY;
const MANAGER_PIN      = process.env.MANAGER_PIN || '1234';

// ── CLIENTS ──────────────────────────────────────────────────────
const twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
const openai       = new OpenAI({ apiKey: OPENAI_KEY });

// ── DATABASE ──────────────────────────────────────────────────────
const db = new Database('./razco.db');

db.exec(`
  -- CUSTOMERS
  CREATE TABLE IF NOT EXISTS customers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    phone       TEXT    UNIQUE NOT NULL,
    email       TEXT,
    opt_in_sms  INTEGER DEFAULT 0,
    points      INTEGER DEFAULT 50,
    visits      INTEGER DEFAULT 1,
    total_spent REAL    DEFAULT 0,
    tier        TEXT    DEFAULT 'Bronze',
    register    TEXT,
    created_at  TEXT    DEFAULT (datetime('now')),
    last_visit  TEXT    DEFAULT (datetime('now'))
  );

  -- PURCHASES (for AI shopping list behavior tracking)
  CREATE TABLE IF NOT EXISTS purchases (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER REFERENCES customers(id),
    items       TEXT,   -- JSON array of items bought
    total       REAL,
    register    TEXT,
    bought_at   TEXT DEFAULT (datetime('now'))
  );

  -- CAMPAIGNS
  CREATE TABLE IF NOT EXISTS campaigns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    type        TEXT NOT NULL, -- weekly_sale | in_store | online | weekend | push_list | coupon | giveway
    message     TEXT NOT NULL,
    image_url   TEXT,
    channel     TEXT DEFAULT 'sms', -- sms | whatsapp | both
    status      TEXT DEFAULT 'draft', -- draft | scheduled | sent
    target      TEXT DEFAULT 'all', -- all | tier:Gold | visits:5+
    sent_count  INTEGER DEFAULT 0,
    scheduled_at TEXT,
    sent_at     TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  -- CAMPAIGN SENDS LOG
  CREATE TABLE IF NOT EXISTS campaign_sends (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER REFERENCES campaigns(id),
    customer_id INTEGER REFERENCES customers(id),
    status      TEXT DEFAULT 'sent', -- sent | delivered | failed
    sent_at     TEXT DEFAULT (datetime('now'))
  );

  -- DIGITAL COUPONS
  CREATE TABLE IF NOT EXISTS coupons (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    code         TEXT UNIQUE NOT NULL,
    title        TEXT NOT NULL,
    description  TEXT,
    discount_type TEXT NOT NULL, -- percent | fixed | free_item | bogo
    discount_val  REAL,
    free_item     TEXT,
    min_purchase  REAL DEFAULT 0,
    max_uses      INTEGER DEFAULT 999,
    used_count    INTEGER DEFAULT 0,
    valid_from    TEXT,
    valid_until   TEXT,
    target_tier   TEXT DEFAULT 'all', -- all | Bronze | Silver | Gold | Platinum
    active        INTEGER DEFAULT 1,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  -- COUPON REDEMPTIONS
  CREATE TABLE IF NOT EXISTS coupon_redemptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    coupon_id   INTEGER REFERENCES coupons(id),
    customer_id INTEGER REFERENCES customers(id),
    redeemed_at TEXT DEFAULT (datetime('now'))
  );

  -- WEEKLY DEALS (for kiosk display)
  CREATE TABLE IF NOT EXISTS weekly_deals (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    dept      TEXT,
    item      TEXT NOT NULL,
    desc      TEXT,
    price     TEXT NOT NULL,
    note      TEXT,
    special   INTEGER DEFAULT 0,
    ad_start  TEXT,
    ad_end    TEXT,
    active    INTEGER DEFAULT 1
  );

  -- AI SHOPPING LISTS
  CREATE TABLE IF NOT EXISTS shopping_lists (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER REFERENCES customers(id),
    list_json   TEXT,  -- AI-generated list as JSON
    sent        INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  -- SPIN WHEEL PRIZES LOG
  CREATE TABLE IF NOT EXISTS prize_wins (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER REFERENCES customers(id),
    prize       TEXT,
    redeemed    INTEGER DEFAULT 0,
    won_at      TEXT DEFAULT (datetime('now'))
  );
`);

console.log('✅ Database ready — razco.db');

// ═══════════════════════════════════════════════════════════════
//  HELPER: Determine Customer Tier
// ═══════════════════════════════════════════════════════════════
function getTier(visits, points) {
  if (points >= 5000 || visits >= 50) return 'Platinum';
  if (points >= 2000 || visits >= 20) return 'Gold';
  if (points >= 500  || visits >= 5)  return 'Silver';
  return 'Bronze';
}

// ─────────────────────────────────────────────────────────────
//  HELPER: Format phone for Twilio
// ─────────────────────────────────────────────────────────────
function formatPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

// ─────────────────────────────────────────────────────────────
//  HELPER: Send SMS
// ─────────────────────────────────────────────────────────────
async function sendSMS(to, message, imageUrl = null) {
  const params = {
    body: message,
    from: TWILIO_PHONE,
    to: formatPhone(to)
  };
  if (imageUrl) params.mediaUrl = [imageUrl]; // MMS with image
  return await twilioClient.messages.create(params);
}

// ─────────────────────────────────────────────────────────────
//  HELPER: Send WhatsApp
// ─────────────────────────────────────────────────────────────
async function sendWhatsApp(to, message, imageUrl = null) {
  const params = {
    body: message,
    from: `whatsapp:${TWILIO_WHATSAPP}`,
    to: `whatsapp:${formatPhone(to)}`
  };
  if (imageUrl) params.mediaUrl = [imageUrl];
  return await twilioClient.messages.create(params);
}

// ═══════════════════════════════════════════════════════════════
//  ROUTES — CUSTOMERS
// ═══════════════════════════════════════════════════════════════

// POST /api/customers — Register new customer from kiosk
app.post('/api/customers', async (req, res) => {
  try {
    const { name, phone, email, opt_in_sms, register, prize } = req.body;

    // Check if already exists
    const existing = db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
    if (existing) {
      // Returning customer — add points and update visit
      const newPoints  = existing.points + 25;
      const newVisits  = existing.visits + 1;
      const newTier    = getTier(newVisits, newPoints);
      db.prepare(`
        UPDATE customers SET points=?, visits=?, tier=?, last_visit=datetime('now') WHERE id=?
      `).run(newPoints, newVisits, newTier, existing.id);

      // Determine discount based on visits (more visits = more discount)
      const discount = Math.min(existing.visits * 2, 20); // Up to 20% off

      // Send welcome back SMS
      if (existing.opt_in_sms && opt_in_sms) {
        const msg = `👋 Welcome back to Razco Foods, ${existing.name}! You now have ${newPoints} points. You've unlocked ${discount}% off your next visit! 🛒 #RazcoRewards`;
        await sendSMS(existing.phone, msg);
      }

      return res.json({
        success: true,
        returning: true,
        customer: { ...existing, points: newPoints, visits: newVisits, tier: newTier },
        discount
      });
    }

    // New customer
    const result = db.prepare(`
      INSERT INTO customers (name, phone, email, opt_in_sms, register)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, phone, email || null, opt_in_sms ? 1 : 0, register || 'reg-1');

    const customerId = result.lastInsertRowid;

    // Log prize win
    if (prize) {
      db.prepare('INSERT INTO prize_wins (customer_id, prize) VALUES (?, ?)').run(customerId, prize);
    }

    // Send welcome SMS
    if (opt_in_sms) {
      const welcomeMsg =
        `🎉 Welcome to Razco Rewards, ${name}! You earned 50 points + ${prize || 'a welcome reward'}!\n\n` +
        `🏷 You'll get exclusive member prices, digital coupons & weekly deals every week.\n\n` +
        `📲 Reply STOP to unsubscribe. — Razco Foods Supermarket`;
      await sendSMS(phone, welcomeMsg);
    }

    res.json({ success: true, returning: false, customerId, prize });
  } catch (err) {
    console.error('Customer signup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/customers — List all customers (manager)
app.get('/api/customers', (req, res) => {
  const { search, tier, opt_in } = req.query;
  let query = 'SELECT * FROM customers WHERE 1=1';
  const params = [];
  if (search) { query += ' AND (name LIKE ? OR phone LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  if (tier)   { query += ' AND tier = ?'; params.push(tier); }
  if (opt_in) { query += ' AND opt_in_sms = ?'; params.push(parseInt(opt_in)); }
  query += ' ORDER BY created_at DESC';
  res.json(db.prepare(query).all(...params));
});

// GET /api/customers/:id — Single customer
app.get('/api/customers/:id', (req, res) => {
  const customer  = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Not found' });
  const purchases = db.prepare('SELECT * FROM purchases WHERE customer_id = ? ORDER BY bought_at DESC LIMIT 20').all(req.params.id);
  const coupons   = db.prepare('SELECT c.* FROM coupon_redemptions cr JOIN coupons c ON cr.coupon_id=c.id WHERE cr.customer_id=?').all(req.params.id);
  const prizes    = db.prepare('SELECT * FROM prize_wins WHERE customer_id = ?').all(req.params.id);
  res.json({ customer, purchases, coupons, prizes });
});

// POST /api/customers/:id/points — Add/remove points
app.post('/api/customers/:id/points', (req, res) => {
  const { points, reason } = req.body;
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Not found' });
  const newPoints = Math.max(0, customer.points + parseInt(points));
  const newTier   = getTier(customer.visits, newPoints);
  db.prepare('UPDATE customers SET points=?, tier=? WHERE id=?').run(newPoints, newTier, req.params.id);
  res.json({ success: true, points: newPoints, tier: newTier });
});

// ═══════════════════════════════════════════════════════════════
//  ROUTES — CAMPAIGNS
// ═══════════════════════════════════════════════════════════════

// POST /api/campaigns — Create campaign
app.post('/api/campaigns', (req, res) => {
  const { title, type, message, image_url, channel, target, scheduled_at } = req.body;
  const result = db.prepare(`
    INSERT INTO campaigns (title, type, message, image_url, channel, target, scheduled_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, type, message, image_url || null, channel || 'sms', target || 'all',
         scheduled_at || null, scheduled_at ? 'scheduled' : 'draft');
  res.json({ success: true, campaignId: result.lastInsertRowid });
});

// GET /api/campaigns — List campaigns
app.get('/api/campaigns', (req, res) => {
  res.json(db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all());
});

// POST /api/campaigns/:id/send — Send campaign NOW
app.post('/api/campaigns/:id/send', async (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  // Build target audience
  let query = 'SELECT * FROM customers WHERE opt_in_sms = 1';
  const params = [];

  if (campaign.target.startsWith('tier:')) {
    query += ' AND tier = ?';
    params.push(campaign.target.replace('tier:', ''));
  } else if (campaign.target.startsWith('visits:')) {
    const minVisits = parseInt(campaign.target.replace('visits:', '').replace('+', ''));
    query += ' AND visits >= ?';
    params.push(minVisits);
  }

  const customers = db.prepare(query).all(...params);

  let sent = 0, failed = 0;
  const results = [];

  // Send in batches to respect Twilio rate limits
  for (const customer of customers) {
    try {
      if (campaign.channel === 'sms' || campaign.channel === 'both') {
        await sendSMS(customer.phone, campaign.message, campaign.image_url);
      }
      if (campaign.channel === 'whatsapp' || campaign.channel === 'both') {
        await sendWhatsApp(customer.phone, campaign.message, campaign.image_url);
      }
      db.prepare('INSERT INTO campaign_sends (campaign_id, customer_id, status) VALUES (?, ?, ?)').run(campaign.id, customer.id, 'sent');
      sent++;
      results.push({ id: customer.id, name: customer.name, status: 'sent' });
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      failed++;
      db.prepare('INSERT INTO campaign_sends (campaign_id, customer_id, status) VALUES (?, ?, ?)').run(campaign.id, customer.id, 'failed');
      results.push({ id: customer.id, name: customer.name, status: 'failed', error: err.message });
    }
  }

  db.prepare('UPDATE campaigns SET status=?, sent_count=?, sent_at=datetime(\'now\') WHERE id=?').run('sent', sent, campaign.id);
  res.json({ success: true, sent, failed, total: customers.length, results });
});

// ═══════════════════════════════════════════════════════════════
//  ROUTES — WEEKLY DEALS
// ═══════════════════════════════════════════════════════════════

app.get('/api/deals', (req, res) => {
  res.json(db.prepare('SELECT * FROM weekly_deals WHERE active = 1 ORDER BY id').all());
});

app.post('/api/deals', (req, res) => {
  const { deals } = req.body; // Array of deal objects
  db.prepare('UPDATE weekly_deals SET active = 0').run(); // Deactivate old
  const insert = db.prepare('INSERT INTO weekly_deals (dept, item, desc, price, note, special, ad_start, ad_end, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)');
  const insertMany = db.transaction((deals) => {
    for (const d of deals) insert.run(d.dept, d.item, d.desc, d.price, d.note || '', d.special ? 1 : 0, d.ad_start, d.ad_end);
  });
  insertMany(deals);
  res.json({ success: true, count: deals.length });
});

// ═══════════════════════════════════════════════════════════════
//  ROUTES — DIGITAL COUPONS
// ═══════════════════════════════════════════════════════════════

function generateCode() {
  return 'RAZCO-' + Math.random().toString(36).substr(2,6).toUpperCase();
}

app.get('/api/coupons', (req, res) => {
  res.json(db.prepare('SELECT * FROM coupons WHERE active = 1 ORDER BY created_at DESC').all());
});

app.post('/api/coupons', (req, res) => {
  const { title, description, discount_type, discount_val, free_item, min_purchase, max_uses, valid_from, valid_until, target_tier } = req.body;
  const code = generateCode();
  const result = db.prepare(`
    INSERT INTO coupons (code, title, description, discount_type, discount_val, free_item, min_purchase, max_uses, valid_from, valid_until, target_tier)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(code, title, description, discount_type, discount_val || null, free_item || null, min_purchase || 0, max_uses || 999, valid_from, valid_until, target_tier || 'all');
  res.json({ success: true, code, couponId: result.lastInsertRowid });
});

// POST /api/coupons/:code/redeem
app.post('/api/coupons/:code/redeem', (req, res) => {
  const { customer_id } = req.body;
  const coupon = db.prepare('SELECT * FROM coupons WHERE code = ? AND active = 1').get(req.params.code);
  if (!coupon) return res.status(404).json({ error: 'Coupon not found or expired' });
  if (coupon.used_count >= coupon.max_uses) return res.status(400).json({ error: 'Coupon fully redeemed' });

  // Check if customer already used this coupon
  const alreadyUsed = db.prepare('SELECT id FROM coupon_redemptions WHERE coupon_id = ? AND customer_id = ?').get(coupon.id, customer_id);
  if (alreadyUsed) return res.status(400).json({ error: 'Already redeemed by this customer' });

  db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?').run(coupon.id);
  db.prepare('INSERT INTO coupon_redemptions (coupon_id, customer_id) VALUES (?, ?)').run(coupon.id, customer_id);

  // Award bonus points for using coupon
  db.prepare('UPDATE customers SET points = points + 10 WHERE id = ?').run(customer_id);

  res.json({ success: true, coupon });
});

// POST /api/coupons/send-to-customers — Send coupons via SMS
app.post('/api/coupons/send-to-customers', async (req, res) => {
  const { coupon_id, target } = req.body;
  const coupon = db.prepare('SELECT * FROM coupons WHERE id = ?').get(coupon_id);
  if (!coupon) return res.status(404).json({ error: 'Coupon not found' });

  let query = 'SELECT * FROM customers WHERE opt_in_sms = 1';
  if (target === 'Gold' || target === 'Silver' || target === 'Platinum' || target === 'Bronze') {
    query += ` AND tier = '${target}'`;
  }
  const customers = db.prepare(query).all();
  let sent = 0;

  for (const c of customers) {
    const msg = `🎟 Razco Foods Member Coupon!\n\n${coupon.title}\n${coupon.description}\n\nCode: ${coupon.code}\nValid until: ${coupon.valid_until}\n\nShow this at checkout! 🛒`;
    try { await sendSMS(c.phone, msg); sent++; await new Promise(r => setTimeout(r, 100)); } catch(e) {}
  }

  res.json({ success: true, sent });
});

// ═══════════════════════════════════════════════════════════════
//  ROUTES — AI SHOPPING LIST
// ═══════════════════════════════════════════════════════════════

app.post('/api/ai/shopping-list/:customer_id', async (req, res) => {
  try {
    const customer  = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.customer_id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const purchases = db.prepare('SELECT * FROM purchases WHERE customer_id = ? ORDER BY bought_at DESC LIMIT 10').all(req.params.customer_id);
    const deals     = db.prepare('SELECT * FROM weekly_deals WHERE active = 1').all();

    const purchaseHistory = purchases.map(p => JSON.parse(p.items || '[]')).flat();
    const currentDeals    = deals.map(d => `${d.item} — ${d.price}`).join('\n');

    const prompt = `
You are a smart grocery shopping assistant for Razco Foods Supermarket.

Customer: ${customer.name}
Tier: ${customer.tier}
Total visits: ${customer.visits}
Past purchases: ${purchaseHistory.join(', ') || 'No history yet'}

This week's deals at Razco:
${currentDeals}

Create a personalized shopping list for this customer. 
- Include items they buy regularly
- Highlight this week's deals that match their habits
- Suggest complementary items
- Add a friendly personal touch
- Format as a clean list with emojis
- Keep it under 15 items
- End with their potential savings this week

Return as JSON: { "greeting": "...", "items": [{"item":"...", "note":"...", "deal":true/false, "price":"..."}], "savings": "...", "message": "..." }
    `.trim();

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 800
    });

    const list = JSON.parse(completion.choices[0].message.content);

    // Save to DB
    db.prepare('INSERT INTO shopping_lists (customer_id, list_json) VALUES (?, ?)').run(customer.id, JSON.stringify(list));

    // Send via SMS if customer opted in
    if (customer.opt_in_sms && req.body.send_sms) {
      const smsText =
        `🛒 ${list.greeting}\n\nYour Razco Shopping List:\n` +
        list.items.map(i => `${i.deal ? '🔥' : '•'} ${i.item}${i.price ? ' — ' + i.price : ''}`).join('\n') +
        `\n\n💰 Estimated savings: ${list.savings}\n\n${list.message}`;
      await sendSMS(customer.phone, smsText);
    }

    res.json({ success: true, list });
  } catch (err) {
    console.error('AI shopping list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/bulk-shopping-lists — Generate & send for all active customers
app.post('/api/ai/bulk-shopping-lists', async (req, res) => {
  const customers = db.prepare('SELECT * FROM customers WHERE opt_in_sms = 1 ORDER BY last_visit DESC LIMIT 100').all();
  let sent = 0;
  res.json({ success: true, queued: customers.length, message: 'Processing in background...' });

  // Process in background
  (async () => {
    for (const c of customers) {
      try {
        await fetch(`http://localhost:${PORT}/api/ai/shopping-list/${c.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ send_sms: true })
        });
        sent++;
        await new Promise(r => setTimeout(r, 500)); // Rate limit
      } catch (e) { console.error(`Failed for customer ${c.id}:`, e.message); }
    }
    console.log(`✅ Bulk shopping lists sent: ${sent}/${customers.length}`);
  })();
});

// ═══════════════════════════════════════════════════════════════
//  ROUTES — CAMPAIGN TEMPLATES (AI-Generated)
// ═══════════════════════════════════════════════════════════════

app.post('/api/ai/campaign-template', async (req, res) => {
  try {
    const { type, deals, target_tier, custom_notes } = req.body;
    const currentDeals = db.prepare('SELECT * FROM weekly_deals WHERE active = 1').all();
    const dealList = (deals || currentDeals).map(d => `${d.item}: ${d.price}`).join('\n');

    const typeDescriptions = {
      weekly_sale:  'Weekly ad sale announcement with all current deals',
      in_store:     'In-store only special — creates urgency to visit today',
      online:       'Online/delivery order promotion',
      weekend:      'Weekend-only flash sale — Friday through Sunday',
      push_list:    'Personalized push shopping list reminder',
      coupon:       'Digital coupon announcement',
      giveaway:     'Exciting giveaway or sweepstakes announcement',
      ai_recommend: 'AI-personalized product recommendation'
    };

    const prompt = `
You are a marketing expert for Razco Foods Supermarket, a Hispanic grocery store.
Write a ${typeDescriptions[type] || type} SMS campaign message.

Current deals:
${dealList}

Target audience: ${target_tier || 'All customers'}
${custom_notes ? 'Special notes: ' + custom_notes : ''}

Requirements:
- Write in a warm, family-friendly tone that matches Hispanic grocery culture
- Include Spanish phrases naturally (bilingual mix)
- Use emojis strategically
- Keep under 160 characters for SMS (or note if it needs MMS)
- Include a clear call to action
- Create urgency without being pushy

Return as JSON:
{
  "sms": "...(under 160 chars)...",
  "extended": "...(longer version for WhatsApp/MMS)...",
  "subject": "...(email subject if used)...",
  "tags": ["...hashtags..."],
  "best_send_time": "...(day and time recommendation)...",
  "expected_response_rate": "..."
}
    `.trim();

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 600
    });

    res.json({ success: true, template: JSON.parse(completion.choices[0].message.content) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  ROUTES — ANALYTICS
// ═══════════════════════════════════════════════════════════════

app.get('/api/analytics', (req, res) => {
  const stats = {
    customers: {
      total:     db.prepare('SELECT COUNT(*) as c FROM customers').get().c,
      opt_in:    db.prepare('SELECT COUNT(*) as c FROM customers WHERE opt_in_sms = 1').get().c,
      today:     db.prepare("SELECT COUNT(*) as c FROM customers WHERE date(created_at) = date('now')").get().c,
      by_tier:   db.prepare("SELECT tier, COUNT(*) as count FROM customers GROUP BY tier").all(),
    },
    campaigns: {
      total: db.prepare('SELECT COUNT(*) as c FROM campaigns').get().c,
      sent:  db.prepare("SELECT COUNT(*) as c FROM campaigns WHERE status = 'sent'").get().c,
      total_sends: db.prepare('SELECT SUM(sent_count) as c FROM campaigns').get().c || 0,
    },
    coupons: {
      active:    db.prepare('SELECT COUNT(*) as c FROM coupons WHERE active = 1').get().c,
      redeemed:  db.prepare('SELECT COUNT(*) as c FROM coupon_redemptions').get().c,
    },
    top_customers: db.prepare('SELECT id, name, phone, points, visits, tier FROM customers ORDER BY points DESC LIMIT 10').all(),
    recent_signups: db.prepare('SELECT id, name, phone, tier, created_at FROM customers ORDER BY created_at DESC LIMIT 10').all(),
  };
  res.json(stats);
});

// ═══════════════════════════════════════════════════════════════
//  SCHEDULED JOBS (Cron)
// ═══════════════════════════════════════════════════════════════

// Every Monday 8am — Send weekly deals to all opted-in customers
cron.schedule('0 8 * * 1', async () => {
  console.log('📅 Running weekly deals campaign...');
  const deals = db.prepare('SELECT * FROM weekly_deals WHERE active = 1').all();
  if (!deals.length) return;

  const dealText = deals.slice(0, 5).map(d => `• ${d.item}: ${d.price}`).join('\n');
  const message  = `🛒 ¡Hola! This week at Razco Foods:\n\n${dealText}\n\n+More deals in store! Valid this week only. Ven y ahorra! 💚`;

  const campaign = db.prepare(`
    INSERT INTO campaigns (title, type, message, channel, target, status)
    VALUES (?, 'weekly_sale', ?, 'sms', 'all', 'sent')
  `).run('Weekly Deals ' + new Date().toLocaleDateString(), message);

  const customers = db.prepare('SELECT * FROM customers WHERE opt_in_sms = 1').all();
  for (const c of customers) {
    try { await sendSMS(c.phone, message); await new Promise(r => setTimeout(r, 150)); } catch(e) {}
  }
  db.prepare('UPDATE campaigns SET sent_count=?, sent_at=datetime(\'now\') WHERE id=?').run(customers.length, campaign.lastInsertRowid);
  console.log(`✅ Weekly deals sent to ${customers.length} customers`);
});

// Every Friday 10am — Weekend only deals
cron.schedule('0 10 * * 5', async () => {
  console.log('📅 Running weekend deals campaign...');
  const message = `🔥 WEEKEND SPECIAL at Razco Foods!\n\nThis weekend only — exclusive member deals & double points on select items!\n\nValid Fri–Sun only. Don't miss it! 🛒 #RazcoRewards`;
  const customers = db.prepare('SELECT * FROM customers WHERE opt_in_sms = 1').all();
  for (const c of customers) {
    try { await sendSMS(c.phone, message); await new Promise(r => setTimeout(r, 150)); } catch(e) {}
  }
  console.log(`✅ Weekend deals sent to ${customers.length} customers`);
});

// Every Sunday 9am — AI Shopping lists for engaged customers
cron.schedule('0 9 * * 0', async () => {
  console.log('📅 Generating AI shopping lists...');
  const customers = db.prepare('SELECT * FROM customers WHERE opt_in_sms = 1 AND visits >= 2').all();
  for (const c of customers) {
    try {
      await fetch(`http://localhost:${PORT}/api/ai/shopping-list/${c.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ send_sms: true })
      });
      await new Promise(r => setTimeout(r, 1000));
    } catch(e) { console.error(`AI list failed for ${c.id}:`, e.message); }
  }
  console.log(`✅ AI shopping lists sent to ${customers.length} customers`);
});

// Birthday rewards — Daily at 9am
cron.schedule('0 9 * * *', async () => {
  // Would need birthday field — placeholder for when you add it
  console.log('🎂 Checking birthday rewards...');
});

// ── START ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Razi-Nova Solutions Backend running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🔌 API: http://localhost:${PORT}/api`);
  console.log(`\nEndpoints:`);
  console.log(`  POST /api/customers              — Register customer`);
  console.log(`  GET  /api/customers              — List all customers`);
  console.log(`  GET  /api/analytics              — Full analytics`);
  console.log(`  POST /api/campaigns              — Create campaign`);
  console.log(`  POST /api/campaigns/:id/send     — Send campaign`);
  console.log(`  POST /api/ai/campaign-template   — AI write message`);
  console.log(`  POST /api/ai/shopping-list/:id   — AI shopping list`);
  console.log(`  POST /api/coupons                — Create coupon`);
  console.log(`  POST /api/deals                  — Update weekly deals`);
});
