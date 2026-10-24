import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(here, '..', 'data'));
const dbPath = path.join(dataDir, 'sugan-supermarket.sqlite');
let db;

export const schema = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  barcode TEXT UNIQUE,
  sku TEXT UNIQUE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  purchase_price_paise INTEGER NOT NULL DEFAULT 0 CHECK (purchase_price_paise >= 0),
  selling_price_paise INTEGER NOT NULL CHECK (selling_price_paise >= 0),
  stock_milli INTEGER NOT NULL DEFAULT 0,
  low_stock_milli INTEGER NOT NULL DEFAULT 5000 CHECK (low_stock_milli >= 0),
  unit TEXT NOT NULL DEFAULT 'piece',
  expiry_date TEXT,
  gst_rate REAL NOT NULL DEFAULT 0 CHECK (gst_rate >= 0 AND gst_rate <= 100),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_number TEXT NOT NULL UNIQUE,
  request_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  subtotal_paise INTEGER NOT NULL CHECK (subtotal_paise >= 0),
  discount_paise INTEGER NOT NULL CHECK (discount_paise >= 0),
  tax_paise INTEGER NOT NULL CHECK (tax_paise >= 0),
  total_paise INTEGER NOT NULL CHECK (total_paise >= 0),
  -- Keep card only so historical sales from older versions remain readable; the API rejects new card sales.
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','upi','card')),
  amount_received_paise INTEGER NOT NULL DEFAULT 0,
  change_paise INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  barcode TEXT,
  sku TEXT,
  unit TEXT NOT NULL,
  quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
  unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise >= 0),
  purchase_price_paise INTEGER NOT NULL CHECK (purchase_price_paise >= 0),
  discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  gst_rate REAL NOT NULL DEFAULT 0,
  tax_paise INTEGER NOT NULL DEFAULT 0,
  line_total_paise INTEGER NOT NULL CHECK (line_total_paise >= 0)
);
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('sale','adjustment','restock')),
  quantity_milli INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id, created_at);
`;

const defaults = {
  store_name: 'Sugan Supermarket', address: '', phone: '', currency: 'INR', receipt_width: '80',
  default_low_stock: '5', gst_enabled: 'true', tax_inclusive: 'true', allow_negative_stock: 'false',
  receipt_footer: 'Thank you for shopping with us!',
};

const migrations = [
  { version: 1, up(database) { database.run(schema); } },
  { version: 2, up(database) {
    const columns = database.exec('PRAGMA table_info(sales)')[0]?.values.map(row => row[1]) || [];
    if (!columns.includes('payment_reference')) database.run('ALTER TABLE sales ADD COLUMN payment_reference TEXT');
    if (!columns.includes('payment_verification')) database.run("ALTER TABLE sales ADD COLUMN payment_verification TEXT NOT NULL DEFAULT 'not_required'");
    database.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_payment_reference ON sales(payment_reference) WHERE payment_reference IS NOT NULL');
  } },
  { version: 3, up(database) {
    const productColumns = database.exec('PRAGMA table_info(products)')[0]?.values.map(row => row[1]) || [];
    if (!productColumns.includes('hsn_code')) database.run('ALTER TABLE products ADD COLUMN hsn_code TEXT');
    const saleItemColumns = database.exec('PRAGMA table_info(sale_items)')[0]?.values.map(row => row[1]) || [];
    if (!saleItemColumns.includes('hsn_code')) database.run('ALTER TABLE sale_items ADD COLUMN hsn_code TEXT');
    database.run(`
      CREATE TABLE IF NOT EXISTS tally_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tally_product_mappings (
        product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
        tally_stock_item_name TEXT NOT NULL,
        stable_part_number TEXT NOT NULL UNIQUE,
        product_hash TEXT NOT NULL,
        sync_status TEXT NOT NULL DEFAULT 'pending' CHECK(sync_status IN ('pending','synced','failed')),
        last_synced_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE TABLE IF NOT EXISTS tally_sync_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL CHECK(entity_type IN ('sale','product')),
        entity_id INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','retrying','synced','failed','held')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        next_attempt_at TEXT,
        last_attempt_at TEXT,
        last_error_kind TEXT,
        last_error TEXT,
        remote_identifier TEXT,
        response_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_tally_queue_status_due ON tally_sync_queue(status,next_attempt_at,created_at);
      CREATE INDEX IF NOT EXISTS idx_tally_queue_entity ON tally_sync_queue(entity_type,entity_id);
      CREATE TABLE IF NOT EXISTS tally_sync_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_id INTEGER REFERENCES tally_sync_queue(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_tally_events_created ON tally_sync_events(created_at DESC);
      CREATE TABLE IF NOT EXISTS tally_connection_state (
        id INTEGER PRIMARY KEY CHECK(id=1),
        status TEXT NOT NULL DEFAULT 'not_checked',
        selected_company TEXT,
        company_state TEXT,
        checked_at TEXT,
        last_successful_at TEXT,
        error_kind TEXT,
        error_message TEXT
      );
      INSERT OR IGNORE INTO tally_connection_state(id,status) VALUES(1,'not_checked');
    `);
    const tallyDefaults = {
      company_name: '', company_state: '', gst_effective_from: '', company_verified: 'false', live_enabled: 'false',
      voucher_type: 'Sales', stock_group: '', cash_ledger: '', upi_ledger: '',
      sales_ledger: '', taxable_sales_ledger: '', sales_return_ledger: '', discount_ledger: '', gst_mode: 'none', gst_ledger: '',
      cgst_ledger: '', sgst_ledger: '', igst_ledger: '', unit_map: '{}',
      last_successful_sync: '',
    };
    for (const [key, value] of Object.entries(tallyDefaults)) {
      database.run('INSERT OR IGNORE INTO tally_settings(key,value) VALUES(?,?)', [key, value]);
    }
  } },
  { version: 4, up(database) {
    const columns = database.exec('PRAGMA table_info(tally_connection_state)')[0]?.values.map(row => row[1]) || [];
    if (!columns.includes('last_successful_at')) database.run('ALTER TABLE tally_connection_state ADD COLUMN last_successful_at TEXT');
  } },
];

export async function initDb() {
  fs.mkdirSync(dataDir, { recursive: true });
  const SQL = await initSqlJs();
  db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  let version = Number(db.exec('PRAGMA user_version')[0]?.values?.[0]?.[0] || 0);
  for (const migration of migrations) {
    if (migration.version <= version) continue;
    db.run('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.run(`PRAGMA user_version = ${migration.version}`);
      db.run('COMMIT');
      version = migration.version;
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
  }
  for (const [key, value] of Object.entries(defaults)) {
    db.run('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)', [key, value]);
  }
  persist();
  return db;
}

export function getDb() { if (!db) throw new Error('Database is not initialized'); return db; }
export function persist() {
  const pendingPath = `${dbPath}.pending`;
  fs.writeFileSync(pendingPath, Buffer.from(getDb().export()));
  fs.renameSync(pendingPath, dbPath);
}
export function getDbPath() { return dbPath; }
export function restoreDatabase(bytes) {
  const Database = getDb().constructor;
  const restored = new Database(bytes);
  try {
    restored.run('PRAGMA foreign_keys = ON');
    const integrity = restored.exec('PRAGMA integrity_check');
    if (integrity?.[0]?.values?.[0]?.[0] !== 'ok') throw new Error('Backup integrity check failed');
    const required = ['products', 'categories', 'sales', 'sale_items', 'stock_movements', 'settings'];
    for (const table of required) {
      const found = restored.exec("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table]);
      if (!found.length) throw new Error('Backup is missing required tables');
    }
    db.close();
    db = restored;
    persist();
  } catch (error) {
    restored.close();
    throw error;
  }
}

export function rows(sql, params = []) {
  const stmt = getDb().prepare(sql);
  try { stmt.bind(params); const result = []; while (stmt.step()) result.push(stmt.getAsObject()); return result; }
  finally { stmt.free(); }
}
export function one(sql, params = []) { return rows(sql, params)[0] || null; }
export function run(sql, params = []) {
  getDb().run(sql, params);
  return { changes: getDb().getRowsModified(), id: getDb().exec('SELECT last_insert_rowid() AS id')[0]?.values[0][0] };
}
export function inTransaction(fn) {
  const database = getDb();
  database.run('BEGIN IMMEDIATE');
  try { const result = fn(); database.run('COMMIT'); persist(); return result; }
  catch (error) { database.run('ROLLBACK'); throw error; }
}
