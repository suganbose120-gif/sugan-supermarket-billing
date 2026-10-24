import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initDb, getDb, persist, getDbPath, restoreDatabase, rows, one, run, inTransaction } from './db.js';
import {
  adoptTallyProduct, checkTallyConnection, enableLiveSync, fetchTallyMasters,
  getTallyDashboard, getTallySettings, getTrialBalance, previewProducts,
  previewSales, queueCompletedSales, queueProductSync, retryQueueJob,
  saveTallySettings, startTallyWorker, verifyConfiguredCompany,
} from './tally-queue.js';

const app = express();
const port = Number(process.env.API_PORT || process.env.PORT || 4318);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
app.use(express.json({ limit: '100mb' }));
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });

// Protect the remotely hosted POS with HTTP Basic Authentication.
// Configure APP_USERNAME and APP_PASSWORD in the hosting dashboard.
// Local development remains unchanged when NODE_ENV is not production.
app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  if (process.env.NODE_ENV !== 'production') return next();

  const username = String(process.env.APP_USERNAME || '');
  const password = String(process.env.APP_PASSWORD || '');
  if (!username || !password) {
    return res.status(503).send('Application access is not configured. Set APP_USERNAME and APP_PASSWORD.');
  }

  const header = String(req.headers.authorization || '');
  const match = header.match(/^Basic\\s+([A-Za-z0-9+/=]+)$/);
  let suppliedUser = '', suppliedPassword = '';
  if (match) {
    try {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator >= 0) {
        suppliedUser = decoded.slice(0, separator);
        suppliedPassword = decoded.slice(separator + 1);
      }
    } catch { /* Treat malformed credentials as unauthenticated. */ }
  }

  const safeEqual = (left, right) => {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  if (!safeEqual(suppliedUser, username) || !safeEqual(suppliedPassword, password)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Sugan Supermarket POS", charset="UTF-8"');
    return res.status(401).send('Authentication required.');
  }
  next();
});

const fail = (status, message) => Object.assign(new Error(message), { status });
const asInt = (v, label, min = 0) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min) throw fail(400, `${label} is invalid`);
  return n;
};
const paiseFromRupees = (v, label) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100000000) throw fail(400, `${label} must be a valid non-negative price`);
  return Math.round(n * 100);
};
const getSettings = () => Object.fromEntries(rows('SELECT key,value FROM settings').map(({key,value}) => [key,value]));
const productSelect = `SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id=p.category_id`;
function requireTallyAdmin(req, _res, next) {
  const expected = String(process.env.TALLY_ADMIN_TOKEN || '');
  const supplied = String(req.get('x-tally-admin-token') || '');
  if (!expected) return next(fail(503, 'Tally write actions are disabled until TALLY_ADMIN_TOKEN is configured on this computer'));
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  if (expectedBytes.length !== suppliedBytes.length || !crypto.timingSafeEqual(expectedBytes, suppliedBytes)) {
    return next(fail(403, 'Administrator token is missing or invalid'));
  }
  next();
}

function normalizeProduct(body) {
  const name = String(body.name || '').trim();
  if (!name || name.length > 160) throw fail(400, 'Product name is required (up to 160 characters)');
  const barcode = String(body.barcode || '').trim() || null;
  const sku = String(body.sku || '').trim() || null;
  if (barcode && barcode.length > 128) throw fail(400, 'Barcode must be 128 characters or shorter');
  if (sku && sku.length > 80) throw fail(400, 'Product code must be 80 characters or shorter');
  const category = String(body.category || '').trim();
  const unit = String(body.unit || 'piece').trim().toLowerCase();
  if (!['piece','kg','g','litre','ml','packet','box','dozen','other'].includes(unit)) throw fail(400, 'Choose a valid unit');
  const purchase = paiseFromRupees(body.purchase_price ?? 0, 'Purchase price');
  const selling = paiseFromRupees(body.selling_price, 'Selling price');
  const stock = Math.round(Number(body.stock ?? 0) * 1000);
  const low = Math.round(Number(body.low_stock ?? getSettings().default_low_stock ?? 5) * 1000);
  if (!Number.isSafeInteger(stock) || stock < 0 || !Number.isSafeInteger(low) || low < 0) throw fail(400, 'Stock values must be non-negative numbers');
  const gst = Number(body.gst_rate ?? 0);
  if (!Number.isFinite(gst) || gst < 0 || gst > 100) throw fail(400, 'GST rate must be between 0 and 100');
  const hsnCode = String(body.hsn_code || '').trim();
  if (hsnCode.length > 32 || /[\u0000-\u001f\u007f]/.test(hsnCode)) throw fail(400, 'HSN/SAC must be 32 characters or shorter');
  const expiry = String(body.expiry_date || '').trim() || null;
  if (expiry && !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw fail(400, 'Expiry date must be a valid date');
  return { name, barcode, sku, category, unit, purchase, selling, stock, low, gst, hsnCode, expiry };
}
function setCategory(name) {
  if (!name) return null;
  run('INSERT OR IGNORE INTO categories(name) VALUES(?)', [name]);
  return one('SELECT id FROM categories WHERE name=? COLLATE NOCASE', [name]).id;
}
function presentProduct(p) {
  return { ...p, purchase_price: p.purchase_price_paise / 100, selling_price: p.selling_price_paise / 100,
    stock: p.stock_milli / 1000, low_stock: p.low_stock_milli / 1000, hsn_code: p.hsn_code || '' };
}
function billRow(saleId) {
  const sale = one('SELECT * FROM sales WHERE id=?', [saleId]);
  if (!sale) return null;
  return { ...sale, items: rows('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id', [saleId]), settings: getSettings() };
}
function createSale(body) {
  const requestKey = String(body.request_key || '').trim();
  if (!requestKey || requestKey.length > 120) throw fail(400, 'A unique sale request key is required');
  const existing = one('SELECT id FROM sales WHERE request_key=?', [requestKey]);
  if (existing) return billRow(existing.id);
  const method = String(body.payment_method || 'cash').toLowerCase();
  if (!['cash','upi'].includes(method)) throw fail(400, 'Choose cash or UPI payment');
  const paymentReference = method === 'upi' ? String(body.payment_reference || '').trim() : null;
  if (method === 'upi') {
    if (!paymentReference || paymentReference !== requestKey || paymentReference.length > 80 || !/^[A-Za-z0-9._-]+$/.test(paymentReference)) {
      throw fail(400, 'A valid bill-specific UPI payment reference is required');
    }
    if (body.payment_verification !== 'cashier_asserted') {
      throw fail(409, 'Verify the payment credit in the merchant UPI app before completing this bill');
    }
  }
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 500) throw fail(400, 'Add at least one item to the bill');
  const gstEnabled = getSettings().gst_enabled !== 'false';
  const taxInclusive = getSettings().tax_inclusive !== 'false';
  return inTransaction(() => {
    const duplicateRequest = one('SELECT id FROM sales WHERE request_key=?', [requestKey]);
    if (duplicateRequest) return billRow(duplicateRequest.id);
    let subtotal = 0, discount = 0, tax = 0;
    const prepared = [];
    for (const line of body.items) {
      const productId = asInt(Number(line.product_id), 'Product');
      const qty = asInt(Number(line.quantity_milli), 'Quantity', 1);
      const product = one(`${productSelect} WHERE p.id=? AND p.active=1`, [productId]);
      if (!product) throw fail(400, 'A product in this bill no longer exists');
      const qtyBefore = prepared.filter(p => p.product.id === productId).reduce((sum,p) => sum + p.qty, 0);
      if (getSettings().allow_negative_stock !== 'true' && product.stock_milli < qtyBefore + qty) {
        throw fail(409, `Insufficient stock for ${product.name}. Available: ${(product.stock_milli - qtyBefore) / 1000} ${product.unit}`);
      }
      const gross = Math.round(product.selling_price_paise * qty / 1000);
      const lineDiscount = Math.min(gross, asInt(Number(line.discount_paise ?? 0), 'Discount'));
      const rate = gstEnabled ? product.gst_rate : 0;
      const taxable = gross - lineDiscount;
      const lineTax = rate ? Math.round(taxInclusive ? taxable * rate / (100 + rate) : taxable * rate / 100) : 0;
      const lineTotal = taxInclusive ? taxable : taxable + lineTax;
      subtotal += gross; discount += lineDiscount; tax += lineTax;
      prepared.push({ product, qty, gross, lineDiscount, rate, lineTax, lineTotal });
    }
    const total = taxInclusive ? subtotal - discount : subtotal - discount + tax;
    if (method === 'upi' && asInt(Number(body.payment_amount_paise), 'UPI QR amount', 1) !== total) {
      throw fail(409, 'The bill total changed after this UPI QR was generated. Generate and verify a QR for the updated amount.');
    }
    const amountReceived = method === 'cash' ? paiseFromRupees(body.amount_received ?? 0, 'Amount received') : total;
    if (method === 'cash' && amountReceived < total) throw fail(400, 'Amount received is less than the bill total');
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const random = Math.random().toString(36).slice(2, 6).toUpperCase();
    const billNumber = `SG-${stamp}-${random}`;
    const { id: saleId } = run(`INSERT INTO sales(bill_number,request_key,subtotal_paise,discount_paise,tax_paise,total_paise,payment_method,amount_received_paise,change_paise,payment_reference,payment_verification)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [billNumber,requestKey,subtotal,discount,tax,total,method,amountReceived,method === 'cash' ? amountReceived-total : 0,paymentReference,method === 'upi' ? 'cashier_asserted' : 'not_required']);
    for (const item of prepared) {
      const { product, qty, gross, lineDiscount, rate, lineTax, lineTotal } = item;
      run(`INSERT INTO sale_items(sale_id,product_id,product_name,barcode,sku,hsn_code,unit,quantity_milli,unit_price_paise,purchase_price_paise,discount_paise,gst_rate,tax_paise,line_total_paise)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [saleId,product.id,product.name,product.barcode,product.sku,product.hsn_code || null,product.unit,qty,product.selling_price_paise,product.purchase_price_paise,lineDiscount,rate,lineTax,lineTotal]);
      run('UPDATE products SET stock_milli=stock_milli-?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?', [qty,product.id]);
      run('INSERT INTO stock_movements(product_id,sale_id,movement_type,quantity_milli,note) VALUES(?,?,?,?,?)', [product.id,saleId,'sale',-qty,`Bill ${billNumber}`]);
    }
    run(`INSERT OR IGNORE INTO tally_sync_queue(entity_type,entity_id,idempotency_key,status)
      VALUES('sale',?,?, 'pending')`, [saleId, `sale:${billNumber}`]);
    return { ...billRow(saleId), subtotal_paise: subtotal, discount_paise: discount, tax_paise: tax,
      total_paise: total, amount_received_paise: amountReceived, change_paise: method === 'cash' ? amountReceived-total : 0 };
  });
}

app.get('/api/health', (_req,res) => res.json({ ok: true }));
app.get('/api/bootstrap', (_req,res) => res.json({ settings: getSettings(), products: rows(`${productSelect} WHERE p.active=1 ORDER BY p.name COLLATE NOCASE`).map(presentProduct), categories: rows('SELECT name FROM categories ORDER BY name') }));
app.get('/api/products', (req,res) => {
  const q = String(req.query.q || '').trim();
  const search = q ? `%${q}%` : '%';
  res.json(rows(`${productSelect} WHERE p.active=1 AND (p.name LIKE ? COLLATE NOCASE OR COALESCE(p.barcode,'') LIKE ? OR COALESCE(p.sku,'') LIKE ?) ORDER BY p.name COLLATE NOCASE LIMIT 500`, [search,search,search]).map(presentProduct));
});
app.post('/api/products', (req,res) => {
  const p = normalizeProduct(req.body); const categoryId = setCategory(p.category);
  const { id } = run(`INSERT INTO products(name,barcode,sku,category_id,purchase_price_paise,selling_price_paise,stock_milli,low_stock_milli,unit,expiry_date,gst_rate,hsn_code)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [p.name,p.barcode,p.sku,categoryId,p.purchase,p.selling,p.stock,p.low,p.unit,p.expiry,p.gst,p.hsnCode || null]);
  if (p.stock) run('INSERT INTO stock_movements(product_id,movement_type,quantity_milli,note) VALUES(?,?,?,?)', [id,'adjustment',p.stock,'Opening stock']);
  persist(); res.status(201).json(presentProduct(one(`${productSelect} WHERE p.id=?`, [id])));
});
app.put('/api/products/:id', (req,res) => {
  const id = asInt(Number(req.params.id),'Product',1), p = normalizeProduct(req.body);
  const old = one('SELECT * FROM products WHERE id=?', [id]); if (!old) throw fail(404,'Product not found');
  const categoryId = setCategory(p.category);
  run(`UPDATE products SET name=?,barcode=?,sku=?,category_id=?,purchase_price_paise=?,selling_price_paise=?,stock_milli=?,low_stock_milli=?,unit=?,expiry_date=?,gst_rate=?,hsn_code=?,updated_at=datetime('now','localtime') WHERE id=?`, [p.name,p.barcode,p.sku,categoryId,p.purchase,p.selling,p.stock,p.low,p.unit,p.expiry,p.gst,p.hsnCode || null,id]);
  const diff = p.stock - old.stock_milli;
  if (diff) run('INSERT INTO stock_movements(product_id,movement_type,quantity_milli,note) VALUES(?,?,?,?)', [id,'adjustment',diff,'Product edit stock adjustment']);
  persist(); res.json(presentProduct(one(`${productSelect} WHERE p.id=?`,[id])));
});
app.delete('/api/products/:id', (req,res) => {
  const id = asInt(Number(req.params.id),'Product',1);
  const result = run('UPDATE products SET active=0, updated_at=datetime(\'now\',\'localtime\') WHERE id=? AND active=1',[id]);
  if (!result.changes) throw fail(404,'Product not found'); persist(); res.json({ok:true});
});
app.post('/api/products/import', (req,res) => {
  const input = String(req.body.csv || ''); if (!input.trim()) throw fail(400,'Choose a non-empty CSV file');
  const parse = (text) => { const out=[]; let row=[], field='', quoted=false; for(let i=0;i<text.length;i++){const c=text[i]; if(quoted){if(c==='"'&&text[i+1]==='"'){field+='"';i++;}else if(c==='"')quoted=false;else field+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(field);field='';}else if(c==='\n'){row.push(field);out.push(row);row=[];field='';}else if(c!=='\r')field+=c;} row.push(field);if(row.some(v=>v!==''))out.push(row); return out;};
  const all = parse(input); const headers = all.shift().map(h=>h.trim().toLowerCase().replaceAll(' ','_'));
  const imported=[]; const errors=[];
  for (let i=0;i<all.length;i++) { try {const record=Object.fromEntries(headers.map((h,j)=>[h,all[i][j]??''])); const p=normalizeProduct(record); const categoryId=setCategory(p.category);
      const {id}=run(`INSERT INTO products(name,barcode,sku,category_id,purchase_price_paise,selling_price_paise,stock_milli,low_stock_milli,unit,expiry_date,gst_rate,hsn_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,[p.name,p.barcode,p.sku,categoryId,p.purchase,p.selling,p.stock,p.low,p.unit,p.expiry,p.gst,p.hsnCode||null]);
      if(p.stock)run('INSERT INTO stock_movements(product_id,movement_type,quantity_milli,note) VALUES(?,?,?,?)',[id,'adjustment',p.stock,'CSV opening stock']); imported.push(id);
    }catch(e){errors.push(`Row ${i+2}: ${e.message}`);} }
  persist(); res.json({ imported: imported.length, errors });
});
app.get('/api/products/export.csv', (_req,res) => {
  const products=rows(`${productSelect} WHERE p.active=1 ORDER BY p.name`);
  const cell = (v) => `"${String(v ?? '').replaceAll('"','""')}"`;
  const lines=[['name','barcode','sku','category','purchase_price','selling_price','stock','low_stock','unit','expiry_date','gst_rate','hsn_code'], ...products.map(p=>[p.name,p.barcode,p.sku,p.category,p.purchase_price_paise/100,p.selling_price_paise/100,p.stock_milli/1000,p.low_stock_milli/1000,p.unit,p.expiry_date,p.gst_rate,p.hsn_code])];
  res.setHeader('Content-Type','text/csv'); res.setHeader('Content-Disposition','attachment; filename="sugan-products.csv"'); res.send(lines.map(row=>row.map(cell).join(',')).join('\r\n'));
});

app.post('/api/sales', (req,res) => res.status(201).json(createSale(req.body)));
app.get('/api/sales', (req,res) => {
  const q=String(req.query.q||'').trim(), from=String(req.query.from||''), to=String(req.query.to||'');
  const list=rows(`SELECT s.*, (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id=s.id) AS item_count FROM sales s WHERE (?='' OR s.bill_number LIKE ?) AND (?='' OR date(s.created_at)>=date(?)) AND (?='' OR date(s.created_at)<=date(?)) ORDER BY s.id DESC LIMIT 500`,[q,`%${q}%`,from,from,to,to]);
  res.json(list);
});
app.get('/api/sales/:id', (req,res) => { const id=asInt(Number(req.params.id),'Sale',1);const sale=billRow(id);if(!sale)throw fail(404,'Bill not found');res.json(sale); });
app.get('/api/dashboard', (_req,res) => {
  const today=one(`SELECT COALESCE(SUM(total_paise),0) AS sales, COUNT(*) AS bills FROM sales WHERE date(created_at)=date('now','localtime')`);
  const recent=rows('SELECT * FROM sales ORDER BY id DESC LIMIT 6');
  const low=rows(`${productSelect} WHERE p.active=1 AND p.stock_milli<=p.low_stock_milli ORDER BY p.stock_milli ASC LIMIT 8`).map(presentProduct);
  res.json({ sales_today_paise:today.sales, bills_today:today.bills, product_count:one('SELECT COUNT(*) AS n FROM products WHERE active=1').n, low_stock_count:one('SELECT COUNT(*) AS n FROM products WHERE active=1 AND stock_milli<=low_stock_milli').n, low_stock:low, recent });
});
app.get('/api/inventory/movements', (req,res) => {const q=String(req.query.q||'').trim();res.json(rows(`SELECT m.*,p.name AS product_name,p.unit,s.bill_number FROM stock_movements m JOIN products p ON p.id=m.product_id LEFT JOIN sales s ON s.id=m.sale_id WHERE (?='' OR p.name LIKE ? COLLATE NOCASE) ORDER BY m.id DESC LIMIT 500`,[q,`%${q}%`]));});
app.post('/api/inventory/adjust', (req,res) => {
  const id=asInt(Number(req.body.product_id),'Product',1), qty=Math.round(Number(req.body.quantity)*1000), type=String(req.body.type||'adjustment');
  const note=String(req.body.note||'').trim(); if(!Number.isSafeInteger(qty)||qty<=0)throw fail(400,'Enter a positive quantity');if(!['adjustment','restock'].includes(type))throw fail(400,'Invalid movement type');
  const movementQty=type==='adjustment'?-qty:qty;
  inTransaction(()=>{const p=one('SELECT * FROM products WHERE id=? AND active=1',[id]);if(!p)throw fail(404,'Product not found');const after=p.stock_milli+movementQty;if(after<0&&getSettings().allow_negative_stock!=='true')throw fail(409,'Stock cannot be reduced below zero');run('UPDATE products SET stock_milli=?,updated_at=datetime(\'now\',\'localtime\') WHERE id=?',[after,id]);run('INSERT INTO stock_movements(product_id,movement_type,quantity_milli,note) VALUES(?,?,?,?)',[id,type,movementQty,note|| (type==='restock'?'Restock':'Manual adjustment')]);});
  res.json(presentProduct(one(`${productSelect} WHERE p.id=?`,[id])));
});
app.get('/api/reports', (req,res) => {
  const period=String(req.query.period||'daily'); const now=new Date(); let start;
  if(period==='weekly'){start=new Date(now);start.setDate(now.getDate()-6);}else if(period==='monthly'){start=new Date(now.getFullYear(),now.getMonth(),1);}else{start=new Date(now.getFullYear(),now.getMonth(),now.getDate());}
  const startStr=`${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}-${String(start.getDate()).padStart(2,'0')}`;
  const sales=rows(`SELECT * FROM sales WHERE date(created_at)>=date(?) ORDER BY created_at`,[startStr]);
  const methods=rows(`SELECT payment_method,COUNT(*) AS bills,SUM(total_paise) AS total_paise FROM sales WHERE date(created_at)>=date(?) GROUP BY payment_method`,[startStr]);
  const best=rows(`SELECT si.product_name,SUM(si.quantity_milli) AS quantity_milli,SUM(si.line_total_paise) AS total_paise,SUM((si.unit_price_paise-si.purchase_price_paise)*si.quantity_milli/1000-si.discount_paise) AS profit_paise FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE date(s.created_at)>=date(?) GROUP BY si.product_id,si.product_name ORDER BY quantity_milli DESC LIMIT 10`,[startStr]);
  const profit=one(`SELECT COALESCE(SUM((si.unit_price_paise-si.purchase_price_paise)*si.quantity_milli/1000-si.discount_paise),0) AS profit_paise FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE date(s.created_at)>=date(?)`,[startStr]);
  res.json({ period,start_date:startStr, sales, methods, best, profit_paise:profit.profit_paise, low_stock:rows(`${productSelect} WHERE p.active=1 AND p.stock_milli<=p.low_stock_milli ORDER BY p.stock_milli`).map(presentProduct) });
});
app.get('/api/reports/export.csv', (req,res) => {
  const from=String(req.query.from||'2000-01-01'),to=String(req.query.to||'2999-12-31');const list=rows(`SELECT s.bill_number,s.created_at,s.payment_method,s.subtotal_paise,s.discount_paise,s.tax_paise,s.total_paise,si.product_name,si.quantity_milli,si.line_total_paise FROM sales s JOIN sale_items si ON si.sale_id=s.id WHERE date(s.created_at) BETWEEN date(?) AND date(?) ORDER BY s.id`,[from,to]);
  const cell=v=>`"${String(v??'').replaceAll('"','""')}"`;const lines=[['bill_number','date','payment_method','subtotal_rupees','discount_rupees','tax_rupees','total_rupees','product','quantity','line_total_rupees'],...list.map(x=>[x.bill_number,x.created_at,x.payment_method,x.subtotal_paise/100,x.discount_paise/100,x.tax_paise/100,x.total_paise/100,x.product_name,x.quantity_milli/1000,x.line_total_paise/100])];res.setHeader('Content-Type','text/csv');res.setHeader('Content-Disposition','attachment; filename="sugan-sales-report.csv"');res.send(lines.map(row=>row.map(cell).join(',')).join('\r\n'));
});
app.get('/api/settings', (_req,res)=>res.json(getSettings()));
app.put('/api/settings', (req,res)=>{
  const allowed=['store_name','address','phone','receipt_width','default_low_stock','gst_enabled','tax_inclusive','allow_negative_stock','receipt_footer'];
  const next={...getSettings()};for(const key of allowed)if(req.body[key]!==undefined)next[key]=String(req.body[key]);
  if(!next.store_name.trim()||next.store_name.length>100)throw fail(400,'Store name is required and must be 100 characters or shorter');
  if(next.address.length>240||next.phone.length>40||next.receipt_footer.length>160)throw fail(400,'Address, phone, or receipt footer is too long');
  if(!['58','80'].includes(next.receipt_width))throw fail(400,'Receipt width must be 58 or 80 mm');
  const low=Number(next.default_low_stock);if(!Number.isFinite(low)||low<0||low>1000000000)throw fail(400,'Default low-stock threshold is invalid');
  for(const key of ['gst_enabled','tax_inclusive','allow_negative_stock'])if(!['true','false'].includes(next[key]))throw fail(400,`${key} must be true or false`);
  for(const key of allowed)run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[key,next[key]]);
  persist();res.json(getSettings());
});

app.get('/api/tally/status', (_req,res)=>res.json(getTallyDashboard()));
app.get('/api/tally/settings', (_req,res)=>res.json(getTallySettings()));
app.post('/api/tally/connection-test', async (_req,res)=>res.json(await checkTallyConnection()));
app.get('/api/tally/masters', async (_req,res)=>res.json(await fetchTallyMasters()));
app.put('/api/tally/settings', requireTallyAdmin, (req,res)=>res.json(saveTallySettings(req.body || {})));
app.post('/api/tally/settings/verify-company', requireTallyAdmin, async (_req,res)=>res.json(await verifyConfiguredCompany()));
app.post('/api/tally/settings/live', requireTallyAdmin, async (req,res)=>res.json(await enableLiveSync(req.body?.enabled === true)));
app.post('/api/tally/products/preview', async (_req,res)=>res.json(await previewProducts()));
app.post('/api/tally/products/adopt', requireTallyAdmin, async (req,res)=>{
  const productId=asInt(Number(req.body?.product_id),'Product',1);
  const tallyName=String(req.body?.tally_stock_item_name||'').trim();
  if(!tallyName||tallyName.length>160)throw fail(400,'Choose a Tally stock item');
  res.json(await adoptTallyProduct(productId,tallyName));
});
app.post('/api/tally/products/sync', requireTallyAdmin, async (req,res)=>{
  const preview=await previewProducts();
  const selected=Array.isArray(req.body?.product_ids)?new Set(req.body.product_ids.map(Number)):null;
  const considered=selected?preview.filter(item=>selected.has(Number(item.product_id))):preview;
  const ready=considered.filter(item=>!item.error&&['create','alter'].includes(item.action));
  const queued=ready.length?queueProductSync(ready.map(item=>item.product_id)):[];
  const skipped=considered.filter(item=>!ready.some(candidate=>candidate.product_id===item.product_id));
  res.json({queued,skipped,message:`Queued ${queued.length} product master(s); ${skipped.length} require mapping or correction.`});
});
app.post('/api/tally/sales/preview', async (req,res)=>res.json(await previewSales(req.body?.sale_ids)));
app.post('/api/tally/sales/sync', requireTallyAdmin, (req,res)=>res.json(queueCompletedSales(req.body?.sale_ids)));
app.post('/api/tally/queue/:id/retry', requireTallyAdmin, (req,res)=>{
  const id=asInt(Number(req.params.id),'Synchronization record',1);
  res.json(retryQueueJob(id, { confirmedNotImported: req.body?.confirmed_not_imported === true }));
});
app.get('/api/tally/reports/trial-balance', async (req,res)=>{
  const from=String(req.query.from||'').trim(),to=String(req.query.to||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to)throw fail(400,'Use valid from/to dates in YYYY-MM-DD order');
  res.json(await getTrialBalance(from,to));
});
app.get('/api/tally/reports/local', (req,res)=>{
  const from=String(req.query.from||'2000-01-01'),to=String(req.query.to||'2999-12-31');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to)throw fail(400,'Use valid from/to dates in YYYY-MM-DD order');
  const totals=one(`SELECT COUNT(*) AS bills,COALESCE(SUM(subtotal_paise),0) AS subtotal_paise,
    COALESCE(SUM(discount_paise),0) AS discount_paise,COALESCE(SUM(tax_paise),0) AS tax_paise,
    COALESCE(SUM(total_paise),0) AS total_paise FROM sales WHERE date(created_at) BETWEEN date(?) AND date(?)`,[from,to]);
  const methods=rows(`SELECT payment_method,COUNT(*) AS bills,COALESCE(SUM(total_paise),0) AS total_paise
    FROM sales WHERE date(created_at) BETWEEN date(?) AND date(?) GROUP BY payment_method`,[from,to]);
  const daily=rows(`SELECT date(created_at) AS sale_date,COUNT(*) AS bills,COALESCE(SUM(total_paise),0) AS total_paise,
    COALESCE(SUM(tax_paise),0) AS tax_paise FROM sales WHERE date(created_at) BETWEEN date(?) AND date(?) GROUP BY date(created_at) ORDER BY sale_date`,[from,to]);
  const dailyMethods=rows(`SELECT date(created_at) AS sale_date,payment_method,COUNT(*) AS bills,
    COALESCE(SUM(total_paise),0) AS total_paise,COALESCE(SUM(tax_paise),0) AS tax_paise
    FROM sales WHERE date(created_at) BETWEEN date(?) AND date(?) GROUP BY date(created_at),payment_method ORDER BY sale_date,payment_method`,[from,to]);
  const bestSelling=rows(`SELECT si.product_name,SUM(si.quantity_milli) AS quantity_milli,
    SUM(si.line_total_paise) AS total_paise FROM sale_items si JOIN sales s ON s.id=si.sale_id
    WHERE date(s.created_at) BETWEEN date(?) AND date(?) GROUP BY si.product_id,si.product_name
    ORDER BY quantity_milli DESC LIMIT 10`,[from,to]);
  const grossProfit=one(`SELECT COALESCE(SUM((si.unit_price_paise-si.purchase_price_paise)*si.quantity_milli/1000-si.discount_paise),0) AS gross_profit_paise
    FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE date(s.created_at) BETWEEN date(?) AND date(?)`,[from,to]);
  res.json({source:'Billing database (completed bills only)',from,to,totals,methods,daily,dailyMethods,bestSelling,grossProfit});
});
app.get('/api/tally/reports/local.csv', (req,res)=>{
  const from=String(req.query.from||'2000-01-01'),to=String(req.query.to||'2999-12-31');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to)throw fail(400,'Use valid from/to dates in YYYY-MM-DD order');
  const data=rows(`SELECT date(created_at) AS sale_date,payment_method,COUNT(*) AS bills,
    COALESCE(SUM(subtotal_paise),0) AS subtotal_paise,COALESCE(SUM(discount_paise),0) AS discount_paise,
    COALESCE(SUM(tax_paise),0) AS tax_paise,COALESCE(SUM(total_paise),0) AS total_paise
    FROM sales WHERE date(created_at) BETWEEN date(?) AND date(?) GROUP BY date(created_at),payment_method ORDER BY sale_date,payment_method`,[from,to]);
  const cell=value=>`"${String(value??'').replaceAll('"','""')}"`;
  const lines=[['sale_date','payment_method','bills','subtotal_rupees','discount_rupees','tax_rupees','total_rupees'],...data.map(row=>[row.sale_date,row.payment_method,row.bills,row.subtotal_paise/100,row.discount_paise/100,row.tax_paise/100,row.total_paise/100])];
  res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="sugan-tally-billing-report.csv"');res.send(lines.map(row=>row.map(cell).join(',')).join('\r\n'));
});
app.get('/api/backup', (_req,res)=>res.json({filename:path.basename(getDbPath()),database:Buffer.from(getDb().export()).toString('base64')}));
app.post('/api/restore', (req,res)=>{const encoded=String(req.body.database||'');if(!encoded||encoded.length>100_000_000)throw fail(400,'Invalid or oversized backup file');try{restoreDatabase(Buffer.from(encoded,'base64'));}catch{throw fail(400,'This file is not a valid Sugan Supermarket SQLite backup');}res.json({ok:true});});

const dist=path.join(root,'dist'); if(fs.existsSync(dist)){app.use(express.static(dist));app.use((req,res,next)=>{if(req.method==='GET'&&!req.path.startsWith('/api/'))return res.sendFile(path.join(dist,'index.html'));next();});}
app.use((err,_req,res,_next)=>{const tallyStatuses={configuration_error:500,validation_error:400,mapping_error:409,company_unverified:409,company_unknown:409,company_mismatch:409,reconciliation_error:409,connection_error:502,timeout:504,tally_http_error:502,invalid_xml:502,tally_request_error:422,tally_import_error:422,tally_unverified:409,unknown_outcome:409};const status=err.status||tallyStatuses[err.kind]|| (String(err.message).includes('UNIQUE constraint')?409:500);let message=err.message;if(status===409&&message.includes('UNIQUE constraint'))message='Barcode or product code already exists';res.status(status).json({error:message,...(err.kind?{kind:err.kind}:{}),...(err.details?{details:err.details}:{})});});

await initDb();
app.listen(port,'0.0.0.0',()=>console.log(`Sugan Supermarket Billing System running on port ${port}`));
startTallyWorker();
