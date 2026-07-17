// ═══════════════════════════════════════════════════════════════
//  RAZI-NOVA SOLUTIONS — Main Backend Server
//  Razco Foods Supermarket
//  Stack: Node.js + Express + SQLite + Twilio + OpenAI
// ═══════════════════════════════════════════════════════════════

const express  = require('express');
const cors     = require('cors');
const Database = require('better-sqlite3');
const twilio   = require('twilio');
const OpenAI   = require('openai');
const cron     = require('node-cron');
const path     = require('path');

const app = express();
app.use(cors({ origin:'*', methods:['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders:['Content-Type','Authorization'] }));
app.options('*', cors());

// FIX 1: 100mb payload limit for base64 images
app.use(express.json({ limit:'100mb' }));
app.use(express.urlencoded({ limit:'100mb', extended:true }));

// ── ENV ──────────────────────────────────────────────────────
const PORT          = process.env.PORT || 3000;
const TWILIO_SID    = process.env.TWILIO_SID;
const TWILIO_TOKEN  = process.env.TWILIO_TOKEN;
const TWILIO_PHONE  = process.env.TWILIO_PHONE;
const OPENAI_KEY    = process.env.OPENAI_API_KEY;
const MANAGER_PIN   = process.env.MANAGER_PIN || '1234';

// ── CLIENTS ──────────────────────────────────────────────────
const twilioClient = TWILIO_SID && TWILIO_TOKEN ? twilio(TWILIO_SID, TWILIO_TOKEN) : null;
const openai       = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

// ── DATABASE ─────────────────────────────────────────────────
const db = new Database('./razco.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    email TEXT,
    opt_in_sms INTEGER DEFAULT 1,
    points INTEGER DEFAULT 0,
    visits INTEGER DEFAULT 0,
    tier TEXT DEFAULT 'Bronze',
    birthday TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_visit TEXT
  );

  CREATE TABLE IF NOT EXISTS punch_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    reward TEXT NOT NULL,
    visits_required INTEGER DEFAULT 10,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS customer_punches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    punch_card_id INTEGER,
    punches INTEGER DEFAULT 0,
    redeemed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(customer_id) REFERENCES customers(id),
    FOREIGN KEY(punch_card_id) REFERENCES punch_cards(id)
  );

  CREATE TABLE IF NOT EXISTS coupons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    type TEXT DEFAULT 'percent',
    value TEXT,
    free_item TEXT,
    valid_until TEXT,
    tier_required TEXT DEFAULT 'all',
    max_uses INTEGER DEFAULT 500,
    used_count INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    type TEXT DEFAULT 'weekly_sale',
    message TEXT,
    image_url TEXT,
    target TEXT DEFAULT 'all',
    sent_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'draft',
    scheduled_at TEXT,
    sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS raffles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prize TEXT NOT NULL,
    draw_date TEXT,
    message TEXT,
    status TEXT DEFAULT 'active',
    winner_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS raffle_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raffle_id INTEGER,
    customer_id INTEGER,
    ticket_number TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(raffle_id) REFERENCES raffles(id),
    FOREIGN KEY(customer_id) REFERENCES customers(id)
  );

  CREATE TABLE IF NOT EXISTS weekly_ad (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dates TEXT,
    images TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Insert default punch card if none exists
const pcCount = db.prepare('SELECT COUNT(*) as n FROM punch_cards').get();
if (pcCount.n === 0) {
  db.prepare('INSERT INTO punch_cards (name, reward, visits_required, active) VALUES (?,?,?,?)').run('Standard Loyalty Card', 'FREE 2-Liter Soda', 10, 1);
}

// ── HELPERS ──────────────────────────────────────────────────
function getTier(points) {
  if (points >= 5000) return 'Platinum';
  if (points >= 1000) return 'Gold';
  if (points >= 300)  return 'Silver';
  return 'Bronze';
}

// FIX 2: cleanPhone helper — always store and send as 10 digits, format for Twilio with +1
function normalizePhone(raw) {
  return (raw || '').replace(/\D/g, '').slice(-10);
}
function twilioPhone(tenDigit) {
  return '+1' + tenDigit;
}

async function sendSMS(to, body) {
  if (!twilioClient) return { success: false, error: 'Twilio not configured' };
  try {
    // to should already be +1XXXXXXXXXX
    const formatted = to.startsWith('+') ? to : '+1' + to.replace(/\D/g,'').slice(-10);
    const msg = await twilioClient.messages.create({ from: TWILIO_PHONE, to: formatted, body });
    return { success: true, sid: msg.sid };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getOptedInCustomers(target) {
  if (target === 'all') return db.prepare("SELECT * FROM customers WHERE opt_in_sms=1").all();
  if (target === 'gold') return db.prepare("SELECT * FROM customers WHERE opt_in_sms=1 AND tier IN ('Gold','Platinum')").all();
  if (target === 'platinum') return db.prepare("SELECT * FROM customers WHERE opt_in_sms=1 AND tier='Platinum'").all();
  return db.prepare("SELECT * FROM customers WHERE opt_in_sms=1").all();
}

// ── HEALTH ───────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const customerCount = db.prepare('SELECT COUNT(*) as n FROM customers').get().n;
  res.json({ status: 'ok', service: 'Razi-Nova Backend', store: 'Razco Foods Supermarket', customers: customerCount, twilio: !!twilioClient, openai: !!openai });
});

// ══════════════════════════════════════════════════════════════
//  CUSTOMERS
// ══════════════════════════════════════════════════════════════
app.get('/api/customers', (req, res) => {
  const customers = db.prepare('SELECT * FROM customers ORDER BY created_at DESC').all();
  res.json({ success: true, customers, total: customers.length });
});

app.post('/api/customers/signup', (req, res) => {
  const { name, phone, email, opt_in_sms, birthday } = req.body;
  if (!name || !phone) return res.status(400).json({ success: false, error: 'Name and phone required' });

  // FIX 2: normalize to 10 digits for storage
  const cleanPhone = normalizePhone(phone);
  if (cleanPhone.length !== 10) return res.status(400).json({ success: false, error: 'Invalid phone number' });

  const existing = db.prepare('SELECT * FROM customers WHERE phone=?').get(cleanPhone);
  if (existing) return res.json({ success: false, error: 'Phone already registered', customer: existing });

  const result = db.prepare('INSERT INTO customers (name,phone,email,opt_in_sms,points,visits,tier,birthday,last_visit) VALUES (?,?,?,?,50,1,?,?,datetime("now"))').run(
    name, cleanPhone, email||'', opt_in_sms?1:0, 'Bronze', birthday||''
  );
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(result.lastInsertRowid);

  // Assign to active punch cards
  const activePCs = db.prepare('SELECT * FROM punch_cards WHERE active=1').all();
  activePCs.forEach(pc => {
    db.prepare('INSERT INTO customer_punches (customer_id, punch_card_id, punches) VALUES (?,?,0)').run(customer.id, pc.id);
  });

  // Welcome SMS
  if (opt_in_sms && twilioClient) {
    const msg = `¡Bienvenido ${name}! You've joined Razco Foods Rewards 🎉 You have 50 bonus points. Show this text at checkout for your FREE spin prize! Reply STOP to unsubscribe.`;
    sendSMS(twilioPhone(cleanPhone), msg);
  }

  res.json({ success: true, customer, message: 'Welcome to Razco Rewards!' });
});

app.post('/api/customers/checkin', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, error: 'Phone required' });

  // FIX 2: normalize to 10 digits
  const cleanPhone = normalizePhone(phone);
  const customer = db.prepare('SELECT * FROM customers WHERE phone=?').get(cleanPhone);
  if (!customer) return res.json({ success: false, error: 'Customer not found' });

  db.prepare('UPDATE customers SET visits=visits+1, points=points+10, tier=?, last_visit=datetime("now") WHERE id=?').run(getTier(customer.points+10), customer.id);

  const activePCs = db.prepare('SELECT * FROM punch_cards WHERE active=1').all();
  const punchResults = [];
  activePCs.forEach(pc => {
    let cp = db.prepare('SELECT * FROM customer_punches WHERE customer_id=? AND punch_card_id=?').get(customer.id, pc.id);
    if (!cp) { db.prepare('INSERT INTO customer_punches (customer_id,punch_card_id,punches) VALUES (?,?,0)').run(customer.id, pc.id); cp = {punches:0}; }
    const newPunches = cp.punches + 1;
    const earned = newPunches >= pc.visits_required;
    if (earned) {
      db.prepare('UPDATE customer_punches SET punches=0, redeemed=redeemed+1 WHERE customer_id=? AND punch_card_id=?').run(customer.id, pc.id);
      punchResults.push({ card: pc.name, reward: pc.reward, earned: true, punches: 0, required: pc.visits_required });
    } else {
      db.prepare('UPDATE customer_punches SET punches=? WHERE customer_id=? AND punch_card_id=?').run(newPunches, customer.id, pc.id);
      punchResults.push({ card: pc.name, reward: pc.reward, earned: false, punches: newPunches, required: pc.visits_required });
    }
  });

  const updated = db.prepare('SELECT * FROM customers WHERE id=?').get(customer.id);
  res.json({ success: true, customer: updated, punch_cards: punchResults });
});

app.get('/api/customers/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ success: false, error: 'Not found' });
  const punches = db.prepare('SELECT cp.*, pc.name, pc.reward, pc.visits_required FROM customer_punches cp JOIN punch_cards pc ON cp.punch_card_id=pc.id WHERE cp.customer_id=?').all(c.id);
  res.json({ success: true, customer: c, punch_cards: punches });
});

app.put('/api/customers/:id/points', (req, res) => {
  const { points } = req.body;
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!customer) return res.status(404).json({ success: false, error: 'Not found' });
  const newPts = customer.points + parseInt(points);
  db.prepare('UPDATE customers SET points=?, tier=? WHERE id=?').run(newPts, getTier(newPts), customer.id);
  res.json({ success: true, points: newPts, tier: getTier(newPts) });
});

// ══════════════════════════════════════════════════════════════
//  PUNCH CARDS
// ══════════════════════════════════════════════════════════════
app.get('/api/punch-cards', (req, res) => {
  const cards = db.prepare('SELECT * FROM punch_cards ORDER BY created_at DESC').all();
  res.json({ success: true, punch_cards: cards });
});

app.post('/api/punch-cards', (req, res) => {
  const { name, reward, visits_required } = req.body;
  if (!name || !reward) return res.status(400).json({ success: false, error: 'Name and reward required' });
  const result = db.prepare('INSERT INTO punch_cards (name, reward, visits_required, active) VALUES (?,?,?,1)').run(name, reward, visits_required||10);
  const card = db.prepare('SELECT * FROM punch_cards WHERE id=?').get(result.lastInsertRowid);
  const customers = db.prepare('SELECT id FROM customers').all();
  customers.forEach(c => { db.prepare('INSERT OR IGNORE INTO customer_punches (customer_id,punch_card_id,punches) VALUES (?,?,0)').run(c.id, card.id); });
  res.json({ success: true, punch_card: card });
});

app.put('/api/punch-cards/:id', (req, res) => {
  const { name, reward, visits_required, active } = req.body;
  db.prepare('UPDATE punch_cards SET name=COALESCE(?,name), reward=COALESCE(?,reward), visits_required=COALESCE(?,visits_required), active=COALESCE(?,active) WHERE id=?').run(name||null, reward||null, visits_required||null, active!=null?active:null, req.params.id);
  res.json({ success: true, punch_card: db.prepare('SELECT * FROM punch_cards WHERE id=?').get(req.params.id) });
});

app.delete('/api/punch-cards/:id', (req, res) => {
  db.prepare('DELETE FROM punch_cards WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════
//  COUPONS
// ══════════════════════════════════════════════════════════════
app.get('/api/coupons', (req, res) => {
  res.json({ success: true, coupons: db.prepare('SELECT * FROM coupons ORDER BY created_at DESC').all() });
});

app.post('/api/coupons', (req, res) => {
  const { title, description, type, value, free_item, valid_until, tier_required, max_uses } = req.body;
  if (!title) return res.status(400).json({ success: false, error: 'Title required' });
  const code = 'RAZCO-' + Math.random().toString(36).substr(2,5).toUpperCase();
  const result = db.prepare('INSERT INTO coupons (code,title,description,type,value,free_item,valid_until,tier_required,max_uses) VALUES (?,?,?,?,?,?,?,?,?)').run(code, title, description||'', type||'percent', value||'', free_item||'', valid_until||'', tier_required||'all', max_uses||500);
  res.json({ success: true, coupon: db.prepare('SELECT * FROM coupons WHERE id=?').get(result.lastInsertRowid) });
});

app.put('/api/coupons/:id/toggle', (req, res) => {
  const c = db.prepare('SELECT * FROM coupons WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ success: false });
  db.prepare('UPDATE coupons SET active=? WHERE id=?').run(c.active?0:1, c.id);
  res.json({ success: true, active: !c.active });
});

app.delete('/api/coupons/:id', (req, res) => {
  db.prepare('DELETE FROM coupons WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════
//  CAMPAIGNS
// ══════════════════════════════════════════════════════════════
app.get('/api/campaigns', (req, res) => {
  res.json({ success: true, campaigns: db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all() });
});

app.post('/api/campaigns', (req, res) => {
  const { title, type, message, image_url, target } = req.body;
  if (!title || !message) return res.status(400).json({ success: false, error: 'Title and message required' });
  const result = db.prepare('INSERT INTO campaigns (title,type,message,image_url,target,status) VALUES (?,?,?,?,?,?)').run(title, type||'weekly_sale', message, image_url||'', target||'all', 'draft');
  res.json({ success: true, campaign: db.prepare('SELECT * FROM campaigns WHERE id=?').get(result.lastInsertRowid) });
});

app.post('/api/campaigns/:id/send', async (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id=?').get(req.params.id);
  if (!campaign) return res.status(404).json({ success: false, error: 'Not found' });
  const customers = getOptedInCustomers(campaign.target);
  let sent = 0, failed = 0;
  for (const customer of customers) {
    const result = await sendSMS(twilioPhone(customer.phone), campaign.message);
    if (result.success) sent++; else failed++;
  }
  db.prepare('UPDATE campaigns SET status=?, sent_count=?, sent_at=datetime("now") WHERE id=?').run('sent', sent, campaign.id);
  res.json({ success: true, sent, failed, total: customers.length });
});

app.post('/api/campaigns/send-now', async (req, res) => {
  const { title, type, message, target } = req.body;
  if (!message) return res.status(400).json({ success: false, error: 'Message required' });
  const customers = getOptedInCustomers(target||'all');
  let sent = 0, failed = 0;
  const result = db.prepare('INSERT INTO campaigns (title,type,message,target,status,sent_at) VALUES (?,?,?,?,?,datetime("now"))').run(title||'Campaign', type||'weekly_sale', message, target||'all', 'sent');
  for (const customer of customers) {
    const r = await sendSMS(twilioPhone(customer.phone), message);
    if (r.success) sent++; else failed++;
  }
  db.prepare('UPDATE campaigns SET sent_count=? WHERE id=?').run(sent, result.lastInsertRowid);
  res.json({ success: true, sent, failed, total: customers.length });
});

app.post('/api/flash', async (req, res) => {
  const { message, target } = req.body;
  if (!message) return res.status(400).json({ success: false, error: 'Message required' });
  const customers = getOptedInCustomers(target||'all');
  let sent = 0;
  for (const c of customers) {
    const r = await sendSMS(twilioPhone(c.phone), message);
    if (r.success) sent++;
  }
  res.json({ success: true, sent, total: customers.length });
});

// ══════════════════════════════════════════════════════════════
//  RAFFLES
// ══════════════════════════════════════════════════════════════
app.get('/api/raffles', (req, res) => {
  res.json({ success: true, raffles: db.prepare('SELECT * FROM raffles ORDER BY created_at DESC').all() });
});

app.post('/api/raffles', (req, res) => {
  const { prize, draw_date, message } = req.body;
  if (!prize) return res.status(400).json({ success: false, error: 'Prize required' });
  const result = db.prepare('INSERT INTO raffles (prize,draw_date,message,status) VALUES (?,?,?,?)').run(prize, draw_date||'', message||'', 'active');
  res.json({ success: true, raffle: db.prepare('SELECT * FROM raffles WHERE id=?').get(result.lastInsertRowid) });
});

app.post('/api/raffles/:id/send', async (req, res) => {
  const raffle = db.prepare('SELECT * FROM raffles WHERE id=?').get(req.params.id);
  if (!raffle) return res.status(404).json({ success: false });
  const customers = db.prepare('SELECT * FROM customers WHERE opt_in_sms=1').all();
  let sent = 0;
  for (const c of customers) {
    const ticket = 'RZ'+Math.floor(Math.random()*9000+1000);
    db.prepare('INSERT INTO raffle_entries (raffle_id,customer_id,ticket_number) VALUES (?,?,?)').run(raffle.id, c.id, ticket);
    const msg = (raffle.message||'🎰 ¡RIFA en Razco Foods! You\'re entered to win {PRIZE}! Ticket: #{TICKET}. ¡Buena suerte! 🍀').replace('{PRIZE}',raffle.prize).replace('{TICKET}',ticket).replace('{DATE}',raffle.draw_date||'TBD');
    const r = await sendSMS(twilioPhone(c.phone), msg);
    if (r.success) sent++;
  }
  res.json({ success: true, sent, total: customers.length });
});

app.post('/api/raffles/:id/draw', (req, res) => {
  const entries = db.prepare('SELECT re.*, c.name, c.phone FROM raffle_entries re JOIN customers c ON re.customer_id=c.id WHERE re.raffle_id=?').all(req.params.id);
  if (!entries.length) return res.status(400).json({ success: false, error: 'No entries' });
  const winner = entries[Math.floor(Math.random()*entries.length)];
  db.prepare('UPDATE raffles SET status=?, winner_id=? WHERE id=?').run('completed', winner.customer_id, req.params.id);
  res.json({ success: true, winner });
});

// ══════════════════════════════════════════════════════════════
//  WEEKLY AD
//  FIX 3: images stored as JSON array of {name, src} objects
//  Manager pushes → backend saves → kiosk fetches on load + every 5 min
// ══════════════════════════════════════════════════════════════
app.get('/api/weekly-ad', (req, res) => {
  const ad = db.prepare('SELECT * FROM weekly_ad WHERE active=1 ORDER BY created_at DESC LIMIT 1').get();
  if (!ad) return res.json({ success: true, ad: null });
  try {
    ad.images = JSON.parse(ad.images || '[]');
  } catch(e) {
    ad.images = [];
  }
  res.json({ success: true, ad });
});

app.post('/api/weekly-ad', (req, res) => {
  const { dates, images } = req.body;
  if (!images || !Array.isArray(images)) {
    return res.status(400).json({ success: false, error: 'images array required' });
  }
  // Deactivate all previous ads
  db.prepare('UPDATE weekly_ad SET active=0').run();
  // Save new ad — images is array of {name, src}
  const result = db.prepare('INSERT INTO weekly_ad (dates, images, active) VALUES (?,?,1)').run(
    dates || '',
    JSON.stringify(images)
  );
  res.json({ success: true, id: result.lastInsertRowid, count: images.length });
});

// ══════════════════════════════════════════════════════════════
//  AI
// ══════════════════════════════════════════════════════════════
app.post('/api/ai/write', async (req, res) => {
  const { type, audience, notes } = req.body;
  if (!openai) return res.json({ success: false, error: 'OpenAI not configured', message: '🛒 ¡Esta semana en Razco Foods!\n\n¡Ven y ahorra familia! 💚\nReply STOP' });
  try {
    const prompt = `Write a short bilingual (English + Spanish) SMS marketing message for Razco Foods Supermarket in Lindsay, CA. Type: ${type}. Audience: ${audience||'all customers'}. ${notes||''}. Keep under 160 characters for SMS. Warm, family-oriented tone. End with "Reply STOP to unsubscribe". Return only the message text.`;
    const r = await openai.chat.completions.create({ model:'gpt-3.5-turbo', messages:[{role:'user',content:prompt}], max_tokens:200 });
    res.json({ success: true, message: r.choices[0].message.content.trim() });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/ai/shopping-list', async (req, res) => {
  const { customer_id } = req.body;
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(customer_id);
  if (!customer) return res.status(404).json({ success: false });
  const ad = db.prepare('SELECT * FROM weekly_ad WHERE active=1 ORDER BY created_at DESC LIMIT 1').get();
  if (!openai) return res.json({ success: true, message: `🛒 ¡Hola ${customer.name}! Your Razco list this week:\n\n🔥 Check out our latest deals in store!\n\n¡Te esperamos! 💚` });
  try {
    const prompt = `Write a personalized shopping list SMS for ${customer.name}, a Razco Foods customer with ${customer.visits} visits and ${customer.points} points (${customer.tier} tier). Current week dates: ${ad?.dates||'this week'}. Make it warm, bilingual (English+Spanish), under 300 chars. Include 3-4 items. End with "¡Te esperamos! 💚"`;
    const r = await openai.chat.completions.create({ model:'gpt-3.5-turbo', messages:[{role:'user',content:prompt}], max_tokens:200 });
    res.json({ success: true, message: r.choices[0].message.content.trim() });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  ANALYTICS
// ══════════════════════════════════════════════════════════════
app.get('/api/analytics', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as n FROM customers').get().n;
  const opted = db.prepare('SELECT COUNT(*) as n FROM customers WHERE opt_in_sms=1').get().n;
  const tiers = db.prepare("SELECT tier, COUNT(*) as count FROM customers GROUP BY tier").all();
  const topCustomers = db.prepare('SELECT * FROM customers ORDER BY points DESC LIMIT 10').all();
  const campaigns = db.prepare('SELECT COUNT(*) as n FROM campaigns WHERE status="sent"').get().n;
  const redeemed = db.prepare('SELECT SUM(redeemed) as n FROM customer_punches').get().n || 0;
  const newToday = db.prepare("SELECT COUNT(*) as n FROM customers WHERE date(created_at)=date('now')").get().n;
  res.json({ success:true, total, opted, tiers, topCustomers, campaigns, redeemed, newToday });
});

// ══════════════════════════════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════════════════════════════
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const s = {};
  rows.forEach(r => s[r.key] = r.value);
  res.json({ success: true, settings: s });
});

app.post('/api/settings', (req, res) => {
  Object.entries(req.body).forEach(([k,v]) => {
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(k, v);
  });
  res.json({ success: true });
});

// ── MYSTERY COUPON ────────────────────────────────────────────
app.post('/api/mystery', async (req, res) => {
  const { prizes, message } = req.body;
  const prizePool = (prizes||'FREE 2-Liter Soda|10% Off|50 Bonus Points|Free Bakery Item').split('|');
  const customers = db.prepare('SELECT * FROM customers WHERE opt_in_sms=1').all();
  let sent = 0;
  for (const c of customers) {
    const prize = prizePool[Math.floor(Math.random()*prizePool.length)];
    const code = 'MYS-'+Math.random().toString(36).substr(2,5).toUpperCase();
    db.prepare('INSERT INTO coupons (code,title,description,type,free_item,max_uses,used_count,tier_required) VALUES (?,?,?,?,?,1,0,"all")').run(code,'Mystery Reward for '+c.name,'Personalized mystery reward','free_item',prize,1);
    const msg = (message||'🎁 ¡Tu regalo misterioso de Razco Foods! Your prize: {PRIZE}! Code: {CODE}. Show at checkout today! ¡Ven y disfruta! 💚 Reply STOP').replace('{PRIZE}',prize).replace('{CODE}',code);
    const r = await sendSMS(twilioPhone(c.phone), msg);
    if (r.success) sent++;
  }
  res.json({ success: true, sent, total: customers.length });
});

// ── CRON JOBS ─────────────────────────────────────────────────
cron.schedule('0 8 * * 1', async () => {
  const ad = db.prepare("SELECT * FROM weekly_ad WHERE active=1 ORDER BY created_at DESC LIMIT 1").get();
  if (!ad) return;
  const customers = db.prepare("SELECT * FROM customers WHERE opt_in_sms=1").all();
  for (const c of customers) {
    await sendSMS(twilioPhone(c.phone), `🛒 ¡Esta semana en Razco Foods! ${ad.dates}. ¡Ven y ahorra familia! 💚 Reply STOP`);
  }
});

cron.schedule('0 9 * * 0', async () => {
  const customers = db.prepare("SELECT * FROM customers WHERE opt_in_sms=1 AND visits>=2").all();
  for (const c of customers) {
    const r = await fetch(`http://localhost:${PORT}/api/ai/shopping-list`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({customer_id:c.id}) });
    const d = await r.json();
    if (d.message) await sendSMS(twilioPhone(c.phone), d.message);
  }
});

// ── START ────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Razi-Nova Backend running on port ${PORT}`));
