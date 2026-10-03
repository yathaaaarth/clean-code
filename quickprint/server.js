const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const Razorpay = require('razorpay');

const CONFIG = {
  PORT: Number(process.env.PORT) || 3000,
  SHOP_NAME: 'QuickPrint',
  SHOP_UPI_ID: 'shop@upi',          // <-- fallback UPI ID (only used when Razorpay isn't configured)
  RATE_PER_PAGE: 5,                  // rupees per page
  ADMIN_PIN: '1234',
  MAX_FILE_MB: 25,
  ALLOWED_EXT: ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.jpg', '.jpeg', '.png', '.txt'],
  // Auto-printing: when a payment is verified the file is sent straight to the
  // printer and (after AUTO_CLEAR_DELAY_SEC) the order is marked done + file deleted.
  AUTO_PRINT: true,
  PRINTER_NAME: '',                  // '' = Windows default printer
  AUTO_CLEAR_DELAY_SEC: 15,          // seconds after triggering print before "done + delete"
  // Razorpay payment gateway (test-mode keys work for demos, no KYC needed).
  // Get them at https://dashboard.razorpay.com -> Settings -> API Keys.
  // Leave empty to fall back to the QR/UPI-deep-link flow.
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || 'rzp_test_TeNfjnqt63iOky',
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || 'fvkjRD1dMFub9HNZ5Ft9pA3r'
};

let rzp = null;
if (CONFIG.RAZORPAY_KEY_ID && CONFIG.RAZORPAY_KEY_SECRET) {
  rzp = new Razorpay({ key_id: CONFIG.RAZORPAY_KEY_ID, key_secret: CONFIG.RAZORPAY_KEY_SECRET });
}
const PAYMENT_MODE = rzp ? 'razorpay' : 'upi-link';

const UPLOAD_DIR = process.env.QP_UPLOADS || path.join(__dirname, 'uploads');
const DATA_DIR = process.env.QP_DATA || path.join(__dirname, 'data');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
const COUNTER_FILE = path.join(DATA_DIR, 'counter.json');

for (const d of [UPLOAD_DIR, DATA_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let orders = readJSON(QUEUE_FILE, []);
let counter = readJSON(COUNTER_FILE, { date: '', value: 0 });

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
function nextQueueNo() {
  if (counter.date !== todayKey()) {
    counter = { date: todayKey(), value: 0 };
  }
  counter.value += 1;
  writeJSON(COUNTER_FILE, counter);
  return counter.value;
}

// ---------- persisted runtime settings ----------
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
try {
  const saved = readJSON(SETTINGS_FILE, {});
  if (typeof saved.autoPrint === 'boolean') CONFIG.AUTO_PRINT = saved.autoPrint;
  if (typeof saved.printerName === 'string') CONFIG.PRINTER_NAME = saved.printerName;
  if (typeof saved.autoClearDelaySec === 'number') CONFIG.AUTO_CLEAR_DELAY_SEC = saved.autoClearDelaySec;
} catch {}
function saveSettings() {
  writeJSON(SETTINGS_FILE, {
    autoPrint: CONFIG.AUTO_PRINT,
    printerName: CONFIG.PRINTER_NAME,
    autoClearDelaySec: CONFIG.AUTO_CLEAR_DELAY_SEC
  });
}

// ---------- auto-printing ----------
const printTimers = {};
function psQuote(s) { return String(s).replace(/'/g, "''"); }

function sendToPrinter(filePath) {
  const printer = CONFIG.PRINTER_NAME;
  if (process.env.AUTO_PRINT_DRYRUN === '1') {
    console.log('  [autoprint-dryrun] would print ' + path.basename(filePath) + ' to ' + (printer || 'DEFAULT'));
    return printer || 'DEFAULT';
  }
  const script =
    `$f='${psQuote(filePath)}';` +
    `$p='${psQuote(printer)}';` +
    `if(-not $p){$p=((Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Windows').Device -split ',')[0];}` +
    `if(-not $p){Write-Host 'NO_PRINTER';exit 1;}` +
    `$sh=New-Object -ComObject Shell.Application;` +
    `$sh.ShellExecute($f,'printto',$p,'',0)`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
    detached: true, stdio: 'ignore'
  });
  child.on('error', e => console.warn('[print] spawn error:', e.message));
  child.unref();
  return printer || 'DEFAULT';
}

function markDoneAndDelete(order) {
  const fp = path.join(UPLOAD_DIR, order.fileName);
  order.status = 'done';
  save();
  if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch {} }
  delete printTimers[order.queueNo];
}

function triggerAutoPrint(order) {
  order.autoPrinted = true;
  order.status = 'printing';
  save();
  const filePath = path.join(UPLOAD_DIR, order.fileName);
  const used = fs.existsSync(filePath) ? sendToPrinter(filePath) : null;
  console.log(`[autoprint] order #${order.queueNo} sent to printer (${used})`);
  if (!used) {
    order.status = 'printing';
    save();
  }
  if (CONFIG.AUTO_CLEAR_DELAY_SEC > 0) {
    if (printTimers[order.queueNo]) clearTimeout(printTimers[order.queueNo]);
    printTimers[order.queueNo] = setTimeout(() => {
      const o = orders.find(x => x.queueNo === order.queueNo);
      if (o && o.autoPrinted && o.status === 'printing') {
        markDoneAndDelete(o);
        console.log(`[autoprint] order #${o.queueNo} cleared after ${CONFIG.AUTO_CLEAR_DELAY_SEC}s`);
      }
    }, CONFIG.AUTO_CLEAR_DELAY_SEC * 1000);
  }
}

// ---------- multer setup ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const orderId = req.body._orderId || `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    cb(null, `${orderId}-${file.originalname.replace(/[^a-z0-9._-]/gi, '_')}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: CONFIG.MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, CONFIG.ALLOWED_EXT.includes(ext));
  }
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- simple admin session (in-memory) ----------
const sessions = new Set();
function requireAdmin(req, res, next) {
  if (sessions.has(req.headers['x-admin-token'])) return next();
  return res.status(401).json({ error: 'Admin login required' });
}

function publicOrder(o) {
  return {
    id: o.id,
    queueNo: o.queueNo,
    name: o.name,
    pages: o.pages,
    amount: o.amount,
    paid: o.paid,
    pickupTime: o.pickupTime,
    status: o.status,
    fileName: o.fileName,
    createdAt: o.createdAt
  };
}

function save() {
  writeJSON(QUEUE_FILE, orders);
}

// ---------- APIs ----------
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (check type: ' + CONFIG.ALLOWED_EXT.join(', ') + ')' });
    const { name = 'Customer', phone = '', pages = 1, pickupTime = '', amount } = req.body;
    const id = `${todayKey().replace(/-/g, '')}-${nextQueueNo()}`;
    const queueNo = counter.value;
    const amt = amount && !isNaN(amount) ? Number(amount) : Number(pages) * CONFIG.RATE_PER_PAGE;

    const order = {
      id,
      queueNo,
      name: String(name).slice(0, 60),
      phone: String(phone),
      pages: Number(pages) || 1,
      amount: Math.max(0, Math.round(amt)),
      paid: false,
      pickupTime: String(pickupTime),
      status: 'waiting',
      fileName: req.file.filename,
      originalName: req.file.originalname,
      fileSize: req.file.size,
      createdAt: new Date().toISOString()
    };
    orders.push(order);
    save();
    return res.json({ order: publicOrder(order), upiLink: upiDeepLink(order), paymentQR: null });
  } catch (e) {
    return res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

function upiDeepLink(order) {
  const tn = `Print order #${order.queueNo} ${order.name}`;
  const params = new URLSearchParams({
    pa: CONFIG.SHOP_UPI_ID,
    pn: CONFIG.SHOP_NAME,
    am: String(order.amount),
    cu: 'INR',
    tn
  });
  return `upi://pay?${params.toString()}`;
}

app.get('/api/qr/payment/:queueNo', async (req, res) => {
  const order = orders.find(o => String(o.queueNo) === String(req.params.queueNo));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const qr = await QRCode.toDataURL(upiDeepLink(order));
  res.json({ queueNo: order.queueNo, amount: order.amount, upiLink: upiDeepLink(order), qr });
});

app.get('/api/qr/shop', async (_req, res) => {
  const host = getHost(_req);
  const qr = await QRCode.toDataURL(`${host}/`);
  res.json({ url: `${host}/`, qr });
});

app.get('/api/qr/order/:queueNo', async (req, res) => {
  const order = orders.find(o => String(o.queueNo) === String(req.params.queueNo));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const host = getHost(req);
  const qr = await QRCode.toDataURL(`${host}/order.html?q=${order.queueNo}`);
  res.json({ url: `${host}/order.html?q=${order.queueNo}`, qr });
});

function getHost(req) {
  return `${req.protocol}://${req.get('host')}`;
}

app.get('/api/orders', requireAdmin, (_req, res) => {
  res.json({ orders: [...orders].sort((a, b) => a.queueNo - b.queueNo).map(publicOrder) });
});

app.get('/api/orders/:queueNo', (req, res) => {
  const order = orders.find(o => String(o.queueNo) === String(req.params.queueNo));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ order: publicOrder(order), upiLink: upiDeepLink(order) });
});

app.post('/api/orders/:queueNo/paid', (req, res) => {
  const order = orders.find(o => String(o.queueNo) === String(req.params.queueNo));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  order.paid = true;
  save();
  if (CONFIG.AUTO_PRINT && !order.autoPrinted) {
    try { triggerAutoPrint(order); } catch (e) { console.warn('autoprint failed:', e.message); }
  }
  res.json({ order: publicOrder(order) });
});

// ---------- Razorpay payment gateway ----------
app.post('/api/orders/:queueNo/payment', async (req, res) => {
  if (!rzp) return res.status(400).json({ error: 'Razorpay not configured', mode: PAYMENT_MODE });
  const order = orders.find(o => String(o.queueNo) === String(req.params.queueNo));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.paid) return res.json({ alreadyPaid: true, order: publicOrder(order) });

  try {
    const rzpOrder = await createRzpOrder(order);
    order.rzpOrderId = rzpOrder.id;
    order.rzpCreatedAt = new Date().toISOString();
    save();
    return res.json({
      mode: 'razorpay',
      order_id: rzpOrder.id,
      key_id: CONFIG.RAZORPAY_KEY_ID,
      amount: order.amount,
      currency: 'INR',
      name: order.name,
      phone: order.phone
    });
  } catch (e) {
    return res.status(502).json({ error: 'Payment gateway error: ' + (e.message || JSON.stringify(e.error || {})) });
  }
});

// Try a UPI-only order; if the account has no UPI enabled, fall back to its
// normal payment methods (card / netbanking / wallet).
async function createRzpOrder(order) {
  const base = { amount: order.amount * 100, currency: 'INR', receipt: `qp-${order.queueNo}-${Date.now()}`, notes: { queueNo: order.queueNo } };
  try {
    return await rzp.orders.create({ ...base, method: 'upi', upi: { collect: {} } });
  } catch (e) {
    const msg = JSON.stringify(e.error || {});
    if (e.statusCode === 400 && /upi/i.test(msg)) {
      return await rzp.orders.create(base);
    }
    throw e;
  }
}

app.post('/api/payment/verify', (req, res) => {
  if (!rzp) return res.status(400).json({ error: 'Razorpay not configured' });
  const { order_id, payment_id, signature } = req.body || {};
  if (!order_id || !payment_id || !signature) return res.status(400).json({ error: 'Missing payment details' });

  let ok = false;
  try {
    rzp.validatePaymentVerification({ order_id, payment_id }, signature);
    ok = true;
  } catch {
    ok = false;
  }
  const order = orders.find(o => o.rzpOrderId === order_id);
  if (!order) {
    return ok
      ? res.json({ verified: true, note: 'payment valid but order not found' })
      : res.status(400).json({ error: 'Invalid payment signature' });
  }
  if (ok) {
    order.paid = true;
    order.rzpPaymentId = payment_id;
    order.paidAt = new Date().toISOString();
    save();
    if (CONFIG.AUTO_PRINT && !order.autoPrinted) {
      try { triggerAutoPrint(order); } catch (e) { console.warn('autoprint failed:', e.message); }
    }
    return res.json({ verified: true, autoPrinted: !!(CONFIG.AUTO_PRINT && order.autoPrinted), order: publicOrder(order) });
  }
  return res.status(400).json({ error: 'Invalid payment signature', verified: false });
});

app.post('/api/orders/:queueNo/payment/refresh', requireAdmin, async (req, res) => {
  if (!rzp) return res.status(400).json({ error: 'Razorpay not configured' });
  const order = orders.find(o => String(o.queueNo) === String(req.params.queueNo));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!order.rzpOrderId) return res.status(400).json({ error: 'No payment was attempted for this order' });

  try {
    const payments = await rzp.orders.fetchPayments(order.rzpOrderId);
    const captured = (payments.items || []).find(p => p.status === 'captured');
    if (captured) {
      order.paid = true;
      order.rzpPaymentId = captured.id;
      order.paidAt = new Date().toISOString();
      save();
      if (CONFIG.AUTO_PRINT && !order.autoPrinted) {
        try { triggerAutoPrint(order); } catch (e) { console.warn('autoprint failed:', e.message); }
      }
      return res.json({ order: publicOrder(order), autoPrinted: !!(CONFIG.AUTO_PRINT && order.autoPrinted), paymentStatus: captured.status });
    }
    return res.json({ order: publicOrder(order), paymentStatus: 'not_captured' });
  } catch (e) {
    return res.status(502).json({ error: 'Razorpay error: ' + e.message });
  }
});

app.get('/api/orders/:queueNo/file', requireAdmin, (req, res) => {
  const order = orders.find(o => String(o.queueNo) === String(req.params.queueNo));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const filePath = path.join(UPLOAD_DIR, order.fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File already deleted' });
  res.download(filePath, order.originalName || order.fileName);
});

app.get('/api/orders/:queueNo/file/view', requireAdmin, (req, res) => {
  const order = orders.find(o => String(o.queueNo) === String(req.params.queueNo));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const filePath = path.join(UPLOAD_DIR, order.fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File already deleted' });
  res.sendFile(filePath);
});

app.post('/api/orders/:queueNo/print', requireAdmin, (req, res) => {
  const order = orders.find(o => String(o.queueNo) === String(req.params.queueNo));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  order.status = 'printing';
  save();
  res.json({ order: publicOrder(order) });
});

app.post('/api/orders/:queueNo/done', requireAdmin, (req, res) => {
  const order = orders.find(o => String(o.queueNo) === String(req.params.queueNo));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const filePath = path.join(UPLOAD_DIR, order.fileName);
  order.status = 'done';
  save();
  if (fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch {}
  }
  res.json({ order: publicOrder(order), deleted: true });
});

app.post('/api/admin/login', (req, res) => {
  if (String(req.body.pin) === CONFIG.ADMIN_PIN) {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessions.add(token);
    return res.json({ token });
  }
  res.status(401).json({ error: 'Wrong PIN' });
});

app.get('/api/admin/settings', requireAdmin, (_req, res) => {
  res.json({ autoPrint: CONFIG.AUTO_PRINT, printerName: CONFIG.PRINTER_NAME, autoClearDelaySec: CONFIG.AUTO_CLEAR_DELAY_SEC });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (typeof b.autoPrint === 'boolean') CONFIG.AUTO_PRINT = b.autoPrint;
  if (typeof b.printerName === 'string') CONFIG.PRINTER_NAME = b.printerName.slice(0, 100);
  const d = Number(b.autoClearDelaySec);
  if (!isNaN(d) && d >= 0) CONFIG.AUTO_CLEAR_DELAY_SEC = Math.round(d);
  saveSettings();
  res.json({ autoPrint: CONFIG.AUTO_PRINT, printerName: CONFIG.PRINTER_NAME, autoClearDelaySec: CONFIG.AUTO_CLEAR_DELAY_SEC });
});

app.post('/api/admin/printer/test', requireAdmin, (_req, res) => {
  const fp = path.join(UPLOAD_DIR, '_print-test.txt');
  fs.writeFileSync(fp, 'QUICKPRINT PRINT TEST\n========================\nIf you can read this, auto-printing is wired up correctly.');
  const used = sendToPrinter(fp);
  const cleanup = () => { try { fs.unlinkSync(fp); } catch {} };
  res.json({ sent: true, printer: used || 'DEFAULT', note: 'Sample page sent. Check the printer.' });
  setTimeout(cleanup, 30000);
});

app.get('/api/config', (_req, res) => {
  res.json({
    shopName: CONFIG.SHOP_NAME,
    ratePerPage: CONFIG.RATE_PER_PAGE,
    maxFileMB: CONFIG.MAX_FILE_MB,
    allowedExt: CONFIG.ALLOWED_EXT,
    paymentMode: PAYMENT_MODE,
    razorpayKeyId: CONFIG.RAZORPAY_KEY_ID,
    autoPrint: CONFIG.AUTO_PRINT,
    autoClearDelaySec: CONFIG.AUTO_CLEAR_DELAY_SEC
  });
});

app.listen(CONFIG.PORT, () => {
  console.log(`\nQuickPrint running (payment mode: ${PAYMENT_MODE}):`);
  console.log(`  Customer portal : http://localhost:${CONFIG.PORT}/`);
  console.log(`  Shopkeeper panel: http://localhost:${CONFIG.PORT}/admin.html`);
  console.log(`\nUse your PC's local IP (e.g. http://192.168.x.x:${CONFIG.PORT}/) from phones on the same WiFi.\n`);
});