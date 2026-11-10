require('dotenv').config();
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const Stripe = require('stripe');

const app = express();
const port = Number(process.env.PORT || 3000);
const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
const ownerPassword = process.env.OWNER_PASSWORD || '';
const tokenSecret = process.env.TOKEN_SECRET || '';
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

if (ownerPassword.length < 12 || tokenSecret.length < 32) {
  console.error('Set OWNER_PASSWORD (12+ characters) and TOKEN_SECRET (32+ characters) in your environment.');
  process.exit(1);
}

const SESSION_COOKIE_NAME = 'restaurant_owner_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

app.set('trust proxy', 1);
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down.' }
  })
);
app.use(cookieParser());
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  })
);

const db = new Database(path.join(dataDir, 'restaurant.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
    available INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS tables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seats INTEGER NOT NULL CHECK(seats > 0),
    status TEXT NOT NULL DEFAULT 'Available' CHECK(status IN ('Available','Occupied','Reserved')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    order_type TEXT NOT NULL CHECK(order_type IN ('pickup','dine-in')),
    table_id INTEGER REFERENCES tables(id),
    payment_method TEXT NOT NULL CHECK(payment_method IN ('in_person','stripe')),
    payment_status TEXT NOT NULL DEFAULT 'unpaid',
    status TEXT NOT NULL DEFAULT 'received',
    total_cents INTEGER NOT NULL,
    stripe_session_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id INTEGER,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price_cents INTEGER NOT NULL
  );
`);

const menuCount = db.prepare('SELECT COUNT(*) AS count FROM menu_items').get().count;
if (!menuCount) {
  const insert = db.prepare('INSERT INTO menu_items (name,category,description,price_cents) VALUES (?,?,?,?)');
  const seeds = [
    ['Lemon Herb Salmon', "Chef's Picks", 'Grilled salmon with saffron rice, lemon butter, and seasonal greens.', 2600],
    ['Truffle Mushroom Pasta', 'Pasta', 'Creamy parmesan pasta with roasted mushrooms and truffle aroma.', 2200],
    ['Crispy Calamari', 'Starters', 'Golden-fried calamari with chili-lime aioli and citrus salt.', 1400],
    ['Garden Burrata Bowl', 'Salads', 'Organic greens, burrata, tomatoes, basil, and balsamic glaze.', 1600],
    ['Sunset Chicken Wrap', 'Mains', 'Grilled chicken, peppers, spinach, and herb dressing in a soft wrap.', 1800],
    ['Molten Lava Cake', 'Desserts', 'Warm dark chocolate cake with vanilla cream and berry compote.', 1100]
  ];
  const seed = db.transaction(() => seeds.forEach((item) => insert.run(...item)));
  seed();
}
if (!db.prepare('SELECT COUNT(*) AS count FROM tables').get().count) {
  const insertTable = db.prepare('INSERT INTO tables (seats,status) VALUES (?,?)');
  [[2, 'Available'], [4, 'Reserved'], [2, 'Available'], [6, 'Occupied'], [4, 'Available']]
    .forEach((item) => insertTable.run(...item));
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', tokenSecret).update(body).digest('base64url');
  return `${body}.${signature}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [body, signature] = token.split('.');
  if (!body || !signature) return false;
  const expected = crypto.createHmac('sha256', tokenSecret).update(body).digest();
  let received;
  try { received = Buffer.from(signature, 'base64url'); } catch { return false; }
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now();
  } catch { return false; }
}
function setOwnerSession(res, token) {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_MS,
    path: '/'
  });
}
function clearOwnerSession(res) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/'
  });
}
function getOwnerToken(req) {
  const authHeader = req.get('authorization') || '';
  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7);
  return req.cookies?.[SESSION_COOKIE_NAME] || '';
}
function requireOwner(req, res, next) {
  const token = getOwnerToken(req);
  if (!token || !verifyToken(token)) {
    return res.status(401).json({ error: 'Owner login required.' });
  }
  next();
}
function centsToItem(row) {
  return { id: row.id, name: row.name, category: row.category, description: row.description, price: row.price_cents / 100, available: Boolean(row.available) };
}
function validText(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.sendStatus(503);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    return res.status(400).send(`Webhook signature verification failed: ${error.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status === 'paid') {
      db.prepare("UPDATE orders SET payment_status='paid', status='confirmed' WHERE id=? AND stripe_session_id=?")
        .run(Number(session.metadata.order_id), session.id);
    }
  } else if (event.type === 'checkout.session.expired') {
    const session = event.data.object;
    db.prepare("UPDATE orders SET payment_status='failed', status='cancelled' WHERE stripe_session_id=? AND payment_status='pending'")
      .run(session.id);
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (_req, res) => {
  res.json({
    restaurant: {
      name: process.env.RESTAURANT_NAME || 'Harbor & Hearth',
      phone: process.env.RESTAURANT_PHONE || '(555) 010-2024',
      address: process.env.RESTAURANT_ADDRESS || '18 Bayview Avenue, Newport, CA 92660'
    },
    stripeEnabled: Boolean(stripe)
  });
});
app.get('/api/menu', (_req, res) => {
  const rows = db.prepare('SELECT * FROM menu_items WHERE available=1 ORDER BY id').all();
  res.json(rows.map(centsToItem));
});
app.get('/api/tables', (_req, res) => {
  res.json(db.prepare('SELECT id,seats,status FROM tables ORDER BY id').all());
});

const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' }
});

app.post('/api/owner/login', loginRateLimiter, (req, res) => {
  const password = req.body?.password;
  if (typeof password !== 'string') return res.status(400).json({ error: 'Enter the owner password.' });
  const actual = Buffer.from(password);
  const expected = Buffer.from(ownerPassword);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  const token = signToken({ role: 'owner', exp: Date.now() + SESSION_TTL_MS });
  setOwnerSession(res, token);
  res.json({ ok: true });
});

app.get('/api/owner/session', (req, res) => {
  const token = getOwnerToken(req);
  res.json({ authenticated: Boolean(token && verifyToken(token)) });
});

app.post('/api/owner/logout', requireOwner, (req, res) => {
  clearOwnerSession(res);
  res.json({ ok: true });
});

app.get('/api/owner/orders', requireOwner, (_req, res) => {
  const rows = db.prepare(`
    SELECT o.*, t.seats AS table_seats,
      (SELECT json_group_array(json_object('name',oi.name,'quantity',oi.quantity,'unit_price',oi.unit_price_cents)) FROM order_items oi WHERE oi.order_id=o.id) AS items
    FROM orders o LEFT JOIN tables t ON t.id=o.table_id ORDER BY o.id DESC LIMIT 200
  `).all();
  res.json(rows.map((row) => ({
    ...row,
    total: row.total_cents / 100,
    items: JSON.parse(row.items || '[]').map((item) => ({ ...item, unit_price: item.unit_price / 100 }))
  })));
});
app.patch('/api/owner/orders/:id', requireOwner, (req, res) => {
  const allowed = ['received', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'];
  const status = req.body?.status;
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid order status.' });
  const result = db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: 'Order not found.' });
  res.json({ ok: true });
});
app.post('/api/owner/menu', requireOwner, (req, res) => {
  const { name, category, description = '', price } = req.body || {};
  if (!validText(name, 100) || !validText(category, 60) || typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 10000 || typeof description !== 'string' || description.length > 500) {
    return res.status(400).json({ error: 'Provide a valid dish name, category, description, and price.' });
  }
  const result = db.prepare('INSERT INTO menu_items (name,category,description,price_cents) VALUES (?,?,?,?)')
    .run(name.trim(), category.trim(), description.trim(), Math.round(price * 100));
  res.status(201).json(centsToItem(db.prepare('SELECT * FROM menu_items WHERE id=?').get(result.lastInsertRowid)));
});
app.patch('/api/owner/menu/:id', requireOwner, (req, res) => {
  const available = req.body?.available;
  if (typeof available !== 'boolean') return res.status(400).json({ error: 'Availability must be true or false.' });
  const result = db.prepare('UPDATE menu_items SET available=? WHERE id=?').run(available ? 1 : 0, Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: 'Menu item not found.' });
  res.json({ ok: true });
});
app.post('/api/owner/tables', requireOwner, (req, res) => {
  const seats = Number(req.body?.seats);
  if (!Number.isInteger(seats) || seats < 1 || seats > 30) return res.status(400).json({ error: 'Seats must be between 1 and 30.' });
  const result = db.prepare('INSERT INTO tables (seats,status) VALUES (?,\'Available\')').run(seats);
  res.status(201).json({ id: Number(result.lastInsertRowid), seats, status: 'Available' });
});
app.patch('/api/owner/tables/:id', requireOwner, (req, res) => {
  const allowed = ['Available', 'Occupied', 'Reserved'];
  if (!allowed.includes(req.body?.status)) return res.status(400).json({ error: 'Invalid table status.' });
  const result = db.prepare('UPDATE tables SET status=? WHERE id=?').run(req.body.status, Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: 'Table not found.' });
  res.json({ ok: true });
});
app.get('/api/owner/tables/:id/qr', requireOwner, async (req, res) => {
  const table = db.prepare('SELECT id FROM tables WHERE id=?').get(Number(req.params.id));
  if (!table) return res.status(404).json({ error: 'Table not found.' });
  const url = `${baseUrl}/?table=${table.id}`;
  res.json({ url, dataUrl: await QRCode.toDataURL(url, { width: 360, margin: 2 }) });
});

app.post('/api/orders', async (req, res) => {
  try {
    const { customerName, phone, orderType, tableId, items, paymentMethod = 'in_person' } = req.body || {};
    if (!validText(customerName, 100) || !validText(phone, 40)) return res.status(400).json({ error: 'Name and phone are required.' });
    if (!['pickup', 'dine-in'].includes(orderType)) return res.status(400).json({ error: 'Choose pickup or dine-in.' });
    if (!['in_person', 'stripe'].includes(paymentMethod) || (paymentMethod === 'stripe' && !stripe)) return res.status(400).json({ error: 'Selected payment method is unavailable.' });
    if (!Array.isArray(items) || items.length < 1 || items.length > 50) return res.status(400).json({ error: 'Add at least one menu item.' });
    let selectedTable = null;
    if (orderType === 'dine-in') {
      selectedTable = Number(tableId);
      if (!Number.isInteger(selectedTable) || !db.prepare('SELECT id FROM tables WHERE id=?').get(selectedTable)) {
        return res.status(400).json({ error: 'Select a valid table.' });
      }
    }
    const menuLookup = db.prepare('SELECT id,name,price_cents FROM menu_items WHERE id=? AND available=1');
    const normalized = [];
    let totalCents = 0;
    for (const entry of items) {
      const id = Number(entry?.id);
      const quantity = Number(entry?.quantity);
      if (!Number.isInteger(id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) return res.status(400).json({ error: 'Invalid item or quantity.' });
      const item = menuLookup.get(id);
      if (!item) return res.status(400).json({ error: 'A selected menu item is no longer available.' });
      normalized.push({ ...item, quantity });
      totalCents += item.price_cents * quantity;
    }
    if (totalCents <= 0) return res.status(400).json({ error: 'Order total must be greater than zero.' });

    const createOrder = db.transaction(() => {
      const result = db.prepare(`INSERT INTO orders (customer_name,phone,order_type,table_id,payment_method,payment_status,status,total_cents)
        VALUES (?,?,?,?,?,?,?,?)`).run(
          customerName.trim(), phone.trim(), orderType, selectedTable,
          paymentMethod, paymentMethod === 'stripe' ? 'pending' : 'unpaid', 'received', totalCents
        );
      const orderId = Number(result.lastInsertRowid);
      const addItem = db.prepare('INSERT INTO order_items (order_id,menu_item_id,name,quantity,unit_price_cents) VALUES (?,?,?,?,?)');
      normalized.forEach((item) => addItem.run(orderId, item.id, item.name, item.quantity, item.price_cents));
      return orderId;
    });
    const orderId = createOrder();

    if (paymentMethod === 'stripe') {
      try {
        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          line_items: normalized.map((item) => ({
            quantity: item.quantity,
            price_data: {
              currency: 'usd',
              unit_amount: item.price_cents,
              product_data: { name: item.name }
            }
          })),
          success_url: `${baseUrl}/?order=${orderId}&payment=success`,
          cancel_url: `${baseUrl}/?order=${orderId}&payment=cancelled`,
          metadata: { order_id: String(orderId) }
        });
        db.prepare('UPDATE orders SET stripe_session_id=? WHERE id=?').run(session.id, orderId);
        return res.status(201).json({ orderId, checkoutUrl: session.url });
      } catch (error) {
        db.prepare("UPDATE orders SET payment_status='failed',status='cancelled' WHERE id=?").run(orderId);
        console.error('Stripe checkout error:', error.message);
        return res.status(502).json({ error: 'Could not start card payment. Please try pay at restaurant or try again.' });
      }
    }
    res.status(201).json({ orderId, message: 'Order received. Pay at the restaurant.' });
  } catch (error) {
    console.error('Order error:', error);
    res.status(500).json({ error: 'Could not place your order. Please try again.' });
  }
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => console.log(`Restaurant website running at ${baseUrl}`));
