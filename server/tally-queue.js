import crypto from 'node:crypto';
import { inTransaction, one, persist, rows, run } from './db.js';
import {
  buildListOfAccountsRequest, buildSalesVoucherXml, reconcileSale,
  buildStockItemImportXml, buildTrialBalanceRequest, buildVoucherLookupRequest,
  findVoucherByRemoteId, parseCurrentCompany, parseTallyImportResponse,
  parseTallyMasters, postTallyXml, stableProductPartNumber, TallyError,
  parseTrialBalance, testTallyConnection, getTallyEndpointInfo,
} from './tally.js';

const appUnits = new Set(['piece', 'kg', 'g', 'litre', 'ml', 'packet', 'box', 'dozen', 'other']);
const maxAttempts = 8;
let workerTimer;
let workerBusy = false;

export function getTallySettings() {
  return Object.fromEntries(rows('SELECT key,value FROM tally_settings').map(({ key, value }) => [key, value]));
}

export function getConnectionState() {
  return one('SELECT * FROM tally_connection_state WHERE id=1') || { status: 'not_checked' };
}

function recordEvent(queueId, type, status, message, details = null) {
  run('INSERT INTO tally_sync_events(queue_id,event_type,status,message,details_json) VALUES(?,?,?,?,?)', [queueId || null, type, status, String(message).slice(0, 1200), details ? JSON.stringify(details).slice(0, 12000) : null]);
}

function saveConnectionState({ status, selectedCompany = null, companyState = null, errorKind = null, errorMessage = null, connectionSuccessful = false }) {
  run(`UPDATE tally_connection_state SET status=?,selected_company=?,company_state=?,checked_at=datetime('now','localtime'),
    last_successful_at=CASE WHEN ? THEN datetime('now','localtime') ELSE last_successful_at END,error_kind=?,error_message=? WHERE id=1`,
  [status, selectedCompany, companyState, connectionSuccessful ? 1 : 0, errorKind, errorMessage]);
  persist();
}

export async function checkTallyConnection() {
  try {
    const settings = getTallySettings();
    const expectedCompany = settings.company_name || process.env.TALLY_EXPECTED_COMPANY || 'Sugan Super Market';
    const result = await testTallyConnection({ expectedCompany });
    const companyMismatch = result.companyIdentified && !result.companyMatchesExpected;
    const status = !result.companyIdentified ? 'company_unknown' : companyMismatch ? 'company_mismatch' : 'connected';
    const errorMessage = !result.companyIdentified
      ? 'Tally returned valid XML but did not identify a loaded company. Open the intended company in Tally, then test again.'
      : companyMismatch
        ? `Tally has “${result.selectedCompany}” loaded, but the expected company is “${expectedCompany}”. Live synchronization remains disabled; load and verify the expected company.`
        : null;
    if (status !== 'connected') {
      run("UPDATE tally_settings SET value='false' WHERE key IN ('company_verified','live_enabled')");
      recordEvent(null, 'connection', status, errorMessage);
    }
    // Record a successful verification only after Tally identifies the expected
    // company. A valid XML response from an unknown/wrong company is not success.
    saveConnectionState({ status, selectedCompany: result.selectedCompany, companyState: result.companyState, errorKind: status === 'connected' ? null : status, errorMessage, connectionSuccessful: status === 'connected' });
    return result;
  } catch (error) {
    const kind = error instanceof TallyError ? error.kind : 'connection_error';
    run("UPDATE tally_settings SET value='false' WHERE key IN ('company_verified','live_enabled')");
    saveConnectionState({ status: 'error', errorKind: kind, errorMessage: error.message });
    recordEvent(null, 'connection', 'failed', error.message, { kind, liveSyncDisabled: true });
    persist();
    throw error;
  }
}

function cleanText(value, label, maxLength = 160) {
  const text = String(value ?? '').trim();
  if (text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) throw new TallyError('validation_error', `${label} is too long or contains control characters`);
  return text;
}

export function normalizeTallySettings(input) {
  const gstMode = String(input.gst_mode ?? 'none');
  if (!['none', 'single', 'intra', 'inter'].includes(gstMode)) throw new TallyError('validation_error', 'Choose a supported GST posting strategy');
  const unitMap = input.unit_map && typeof input.unit_map === 'object' && !Array.isArray(input.unit_map)
    ? input.unit_map
    : (() => { try { return JSON.parse(String(input.unit_map || '{}')); } catch { throw new TallyError('validation_error', 'Unit mapping must be valid JSON'); } })();
  const normalizedUnitMap = {};
  for (const [appUnit, tallyUnit] of Object.entries(unitMap)) {
    if (!appUnits.has(appUnit)) throw new TallyError('validation_error', `Unknown application unit: ${appUnit}`);
    const name = cleanText(tallyUnit, `Tally unit for ${appUnit}`, 40);
    if (name) normalizedUnitMap[appUnit] = name;
  }
  const effectiveDate = cleanText(input.gst_effective_from, 'GST effective date', 10);
  if (effectiveDate && (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || Number.isNaN(Date.parse(`${effectiveDate}T00:00:00Z`)))) {
    throw new TallyError('validation_error', 'GST effective date must be a valid YYYY-MM-DD date');
  }
  return {
    company_name: cleanText(input.company_name, 'Tally company name'),
    company_state: cleanText(input.company_state, 'Company GST state', 80),
    voucher_type: cleanText(input.voucher_type || 'Sales', 'Tally sales voucher type', 80),
    stock_group: cleanText(input.stock_group, 'Tally stock group', 80),
    cash_ledger: cleanText(input.cash_ledger, 'Cash ledger', 80),
    upi_ledger: cleanText(input.upi_ledger, 'UPI/bank ledger', 80),
    sales_ledger: cleanText(input.sales_ledger, 'Sales ledger', 80),
    taxable_sales_ledger: cleanText(input.taxable_sales_ledger, 'Taxable sales ledger', 80),
    sales_return_ledger: cleanText(input.sales_return_ledger, 'Sales returns ledger', 80),
    discount_ledger: cleanText(input.discount_ledger, 'Discount ledger', 80),
    gst_mode: gstMode,
    gst_ledger: cleanText(input.gst_ledger, 'GST ledger', 80),
    cgst_ledger: cleanText(input.cgst_ledger, 'CGST ledger', 80),
    sgst_ledger: cleanText(input.sgst_ledger, 'SGST/UTGST ledger', 80),
    igst_ledger: cleanText(input.igst_ledger, 'IGST ledger', 80),
    gst_effective_from: effectiveDate,
    unit_map: JSON.stringify(normalizedUnitMap),
  };
}

export function saveTallySettings(input) {
  const next = normalizeTallySettings(input);
  const old = getTallySettings();
  const fields = Object.keys(next);
  const changed = fields.some(key => String(old[key] ?? '') !== String(next[key] ?? ''));
  inTransaction(() => {
    for (const [key, value] of Object.entries(next)) run('INSERT INTO tally_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, value]);
    if (changed) {
      run("UPDATE tally_settings SET value='false' WHERE key IN ('company_verified','live_enabled')");
      recordEvent(null, 'configuration', 'changed', 'Tally mappings changed; company verification and live synchronization were disabled until reviewed again.');
    }
  });
  return getTallySettings();
}

export async function verifyConfiguredCompany() {
  const settings = getTallySettings();
  if (!settings.company_name) throw new TallyError('mapping_error', 'Enter the company currently loaded in Tally');
  const connection = await checkTallyConnection();
  if (!connection.selectedCompany) throw new TallyError('company_unknown', 'Tally responded but did not identify its selected company; live synchronization remains disabled');
  if (connection.selectedCompany !== settings.company_name) {
    run("UPDATE tally_settings SET value='false' WHERE key IN ('company_verified','live_enabled')");
    persist();
    throw new TallyError('company_mismatch', `Tally currently has “${connection.selectedCompany}” loaded, which does not exactly match “${settings.company_name}”`);
  }
  run("UPDATE tally_settings SET value='true' WHERE key='company_verified'");
  persist();
  recordEvent(null, 'company', 'verified', `Verified loaded Tally company: ${connection.selectedCompany}`);
  persist();
  return connection;
}

export async function fetchTallyMasters(companyName = getTallySettings().company_name) {
  const connection = await checkTallyConnection();
  if (!connection.selectedCompany) throw new TallyError('company_unknown', 'The selected company could not be identified; master synchronization is unavailable');
  if (connection.selectedCompany !== companyName) throw new TallyError('company_mismatch', `Tally has “${connection.selectedCompany}” loaded, not “${companyName}”`);
  const accountTypeByKey = { ledgers: 'Ledgers', stockItems: 'Stock Items', stockGroups: 'Stock Groups', units: 'Units' };
  const result = { company: connection.selectedCompany, companyState: connection.companyState };
  for (const [key, accountType] of Object.entries(accountTypeByKey)) {
    const { document } = await postTallyXml(buildListOfAccountsRequest(companyName, accountType));
    result[key] = parseTallyMasters(document, key);
  }
  return result;
}

function unitMapOf(config) {
  try { return typeof config.unit_map === 'string' ? JSON.parse(config.unit_map || '{}') : (config.unit_map || {}); }
  catch { throw new TallyError('mapping_error', 'Saved application-to-Tally unit mappings are invalid'); }
}

function productHash(product, config) {
  const payload = JSON.stringify({ name: product.name, part: stableProductPartNumber(product), unit: unitMapOf(config)[product.unit] || '', group: config.stock_group, gst: product.gst_rate, hsn: product.hsn_code || '', state: config.company_state || '', effective: config.gst_effective_from || '' });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function localProducts() {
  return rows('SELECT * FROM products WHERE active=1 ORDER BY id');
}

function remoteItemByName(items, name) { return items.find(item => item.name.toLowerCase() === String(name || '').toLowerCase()); }
function remoteItemByPart(items, part) { return items.find(item => item.partNumber && item.partNumber.toLowerCase() === String(part || '').toLowerCase()); }

export async function previewProducts() {
  const config = getTallySettings();
  if (!config.company_name) throw new TallyError('mapping_error', 'Configure the Tally company name before previewing products');
  const masters = await fetchTallyMasters(config.company_name);
  const mappings = new Map(rows('SELECT * FROM tally_product_mappings').map(mapping => [Number(mapping.product_id), mapping]));
  const unitMap = unitMapOf(config);
  return localProducts().map(product => {
    const partNumber = stableProductPartNumber(product);
    const mapping = mappings.get(Number(product.id));
    const partMatch = remoteItemByPart(masters.stockItems, partNumber);
    const nameMatch = remoteItemByName(masters.stockItems, product.name);
    let action = 'create';
    let tallyName = product.name;
    let warning = null;
    if (mapping) {
      const target = remoteItemByName(masters.stockItems, mapping.tally_stock_item_name) || partMatch;
      if (target) { action = 'alter'; tallyName = target.name; }
    } else if (partMatch || nameMatch) {
      action = 'adopt';
      tallyName = (partMatch || nameMatch).name;
      warning = 'Existing Tally item requires explicit adoption before it can be altered.';
    }
    let error = null;
    if (!config.stock_group || !masters.stockGroups.some(group => group.name.toLowerCase() === config.stock_group.toLowerCase())) error = `Tally stock group “${config.stock_group || '(not mapped)'}” is missing`;
    else if (!unitMap[product.unit] || !masters.units?.some(unit => unit.name.toLowerCase() === String(unitMap[product.unit]).toLowerCase())) error = `No existing Tally unit is mapped for “${product.unit}”`;
    else if (product.gst_rate > 0 && !product.hsn_code) error = `HSN/SAC is missing for taxable product “${product.name}”`;
    else if (product.gst_rate > 0 && (!config.company_state || !config.gst_effective_from)) error = 'Company GST state and GST effective date are required for taxable stock items';
    else if (mapping && !remoteItemByName(masters.stockItems, mapping.tally_stock_item_name) && !partMatch) {
      action = 'create';
      warning = 'The previously mapped Tally item was not found; its stable part number will be reused to avoid a duplicate.';
    }
    return {
      product_id: product.id, product_name: product.name, sku: product.sku, barcode: product.barcode,
      unit: product.unit, tally_unit: unitMap[product.unit] || null, gst_rate: product.gst_rate,
      hsn_code: product.hsn_code || null, stable_part_number: partNumber, tally_name: tallyName,
      action, error, warning, synced: mapping?.sync_status === 'synced' && mapping.product_hash === productHash(product, config),
    };
  });
}

export async function adoptTallyProduct(productId, tallyName) {
  const product = one('SELECT * FROM products WHERE id=? AND active=1', [productId]);
  if (!product) throw new TallyError('validation_error', 'Active product was not found');
  const config = getTallySettings();
  const masters = await fetchTallyMasters(config.company_name);
  const part = stableProductPartNumber(product);
  const target = masters.stockItems.find(item => item.name === tallyName);
  if (!target || (target.partNumber && target.partNumber.toLowerCase() !== part.toLowerCase() && target.name.toLowerCase() !== product.name.toLowerCase())) {
    throw new TallyError('mapping_error', 'Choose the existing Tally item shown for this product; no matching Tally stock item was found');
  }
  run(`INSERT INTO tally_product_mappings(product_id,tally_stock_item_name,stable_part_number,product_hash,sync_status,last_error)
    VALUES(?,?,?,?, 'pending',NULL)
    ON CONFLICT(product_id) DO UPDATE SET tally_stock_item_name=excluded.tally_stock_item_name,stable_part_number=excluded.stable_part_number,product_hash=excluded.product_hash,sync_status='pending',last_error=NULL,updated_at=datetime('now','localtime')`, [productId, target.name, part, productHash(product, config)]);
  persist();
  recordEvent(null, 'product_mapping', 'adopted', `Product ${product.name} was explicitly mapped to Tally stock item ${target.name}.`);
  persist();
  return { product_id: productId, tally_stock_item_name: target.name, stable_part_number: part };
}

function currentSalesAndTaxableProducts() {
  const products = localProducts();
  const sales = rows('SELECT * FROM sales ORDER BY id');
  const taxExists = sales.some(sale => Number(sale.tax_paise) > 0) || products.some(product => Number(product.gst_rate) > 0);
  return { products, sales, taxExists };
}

function validateConfiguredMappings(config, masters) {
  if (config.company_verified !== 'true') throw new TallyError('company_unverified', 'Verify the company currently loaded in Tally before enabling live synchronization');
  if (!config.company_name || !config.stock_group || !config.voucher_type || !config.cash_ledger || !config.upi_ledger || !config.sales_ledger) {
    throw new TallyError('mapping_error', 'Company, stock group, voucher type, cash/UPI ledgers, and sales ledger mappings are required');
  }
  const ledgerNames = new Set((masters.ledgers || []).map(ledger => ledger.name.toLowerCase()));
  const groupNames = new Set((masters.stockGroups || []).map(group => group.name.toLowerCase()));
  for (const key of ['cash_ledger', 'upi_ledger', 'sales_ledger']) if (!ledgerNames.has(config[key].toLowerCase())) throw new TallyError('mapping_error', `Tally ledger “${config[key]}” was not found`);
  if (!groupNames.has(config.stock_group.toLowerCase())) throw new TallyError('mapping_error', `Tally stock group “${config.stock_group}” was not found`);
  const { products, sales, taxExists } = currentSalesAndTaxableProducts();
  if (taxExists && config.gst_mode === 'none') throw new TallyError('mapping_error', 'Taxable products or sales exist; choose and map the GST posting strategy first');
  const taxLedgers = config.gst_mode === 'single' ? ['gst_ledger'] : config.gst_mode === 'intra' ? ['cgst_ledger', 'sgst_ledger'] : config.gst_mode === 'inter' ? ['igst_ledger'] : [];
  if (taxExists && (!config.taxable_sales_ledger || !ledgerNames.has(config.taxable_sales_ledger.toLowerCase()))) {
    throw new TallyError('mapping_error', `Tally taxable-sales ledger “${config.taxable_sales_ledger || ''}” was not found`);
  }
  if (config.sales_return_ledger && !ledgerNames.has(config.sales_return_ledger.toLowerCase())) {
    throw new TallyError('mapping_error', `Tally sales-return ledger “${config.sales_return_ledger}” was not found`);
  }
  for (const key of taxLedgers) if (!config[key] || !ledgerNames.has(config[key].toLowerCase())) throw new TallyError('mapping_error', `Tally GST ledger “${config[key] || ''}” was not found`);
  if (sales.some(sale => Number(sale.discount_paise) > 0) && (!config.discount_ledger || !ledgerNames.has(config.discount_ledger.toLowerCase()))) {
    throw new TallyError('mapping_error', 'Map an existing Tally discount ledger because saved bills contain discounts');
  }
  const unitMap = unitMapOf(config);
  for (const product of products) {
    const tallyUnit = unitMap[product.unit];
    if (!tallyUnit || !masters.units?.some(unit => unit.name.toLowerCase() === tallyUnit.toLowerCase())) {
      throw new TallyError('mapping_error', `Map the application unit “${product.unit}” to an existing Tally unit`);
    }
    if (product.gst_rate > 0 && (!product.hsn_code || !config.company_state || !config.gst_effective_from)) {
      throw new TallyError('mapping_error', `Add HSN/SAC, company state, and GST effective date for taxable product “${product.name}”`);
    }
  }
  return { products, sales };
}

export async function enableLiveSync(enabled) {
  if (!enabled) {
    run("UPDATE tally_settings SET value='false' WHERE key='live_enabled'");
    persist();
    recordEvent(null, 'live_sync', 'disabled', 'Live Tally synchronization was disabled by the administrator.');
    persist();
    return getTallySettings();
  }
  const config = getTallySettings();
  const connection = await checkTallyConnection();
  if (!connection.selectedCompany || connection.selectedCompany !== config.company_name || config.company_verified !== 'true') {
    throw new TallyError('company_unverified', 'The currently loaded Tally company does not match the verified company mapping');
  }
  const masters = await fetchTallyMasters(config.company_name);
  validateConfiguredMappings(config, masters);
  run("UPDATE tally_settings SET value='true' WHERE key='live_enabled'");
  persist();
  recordEvent(null, 'live_sync', 'enabled', `Live synchronization enabled for ${connection.selectedCompany}.`);
  persist();
  return getTallySettings();
}

function saleSnapshot(saleId) {
  const sale = one('SELECT * FROM sales WHERE id=?', [saleId]);
  if (!sale) return null;
  return { ...sale, items: rows('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id', [saleId]) };
}

export function queueCompletedSales(saleIds) {
  if (!Array.isArray(saleIds) || !saleIds.length || saleIds.length > 500) throw new TallyError('validation_error', 'Select between 1 and 500 completed bills');
  const queued = [];
  inTransaction(() => {
    for (const rawId of [...new Set(saleIds.map(Number))]) {
      if (!Number.isSafeInteger(rawId) || rawId <= 0) throw new TallyError('validation_error', 'Sale selection contains an invalid ID');
      const sale = one('SELECT id,bill_number,payment_method FROM sales WHERE id=?', [rawId]);
      if (!sale) throw new TallyError('validation_error', `Completed sale ${rawId} was not found`);
      if (!['cash', 'upi'].includes(sale.payment_method)) throw new TallyError('mapping_error', `Historical ${sale.payment_method} bill ${sale.bill_number} is not eligible for Tally export`);
      run(`INSERT OR IGNORE INTO tally_sync_queue(entity_type,entity_id,idempotency_key,status)
        VALUES('sale',?,?, 'pending')`, [sale.id, `sale:${sale.bill_number}`]);
      const job = one('SELECT id,status FROM tally_sync_queue WHERE idempotency_key=?', [`sale:${sale.bill_number}`]);
      queued.push({ sale_id: sale.id, bill_number: sale.bill_number, queue_id: job.id, status: job.status });
    }
  });
  return queued;
}

export async function previewSales(saleIds) {
  const config = getTallySettings();
  if (!config.company_name) throw new TallyError('mapping_error', 'Configure the Tally company before previewing sales');
  const connection = await checkTallyConnection();
  if (connection.selectedCompany !== config.company_name) throw new TallyError('company_mismatch', 'The currently loaded Tally company differs from the configured company');
  const ids = Array.isArray(saleIds) ? [...new Set(saleIds.map(Number))] : rows('SELECT id FROM sales ORDER BY id DESC LIMIT 50').map(sale => Number(sale.id));
  if (!ids.length || ids.length > 500) throw new TallyError('validation_error', 'Preview between 1 and 500 completed bills');
  const previews = [];
  for (const id of ids) {
    const sale = saleSnapshot(id);
    if (!sale) { previews.push({ sale_id: id, error: 'Completed bill was not found' }); continue; }
    try {
      const productIds = [...new Set(sale.items.map(item => Number(item.product_id)).filter(Boolean))];
      const mappings = Object.fromEntries(productIds.map(productId => {
        const mapping = one('SELECT tally_stock_item_name,stable_part_number FROM tally_product_mappings WHERE product_id=?', [productId]);
        return [productId, mapping ? { ...mapping } : null];
      }));
      const xml = buildSalesVoucherXml(sale, config, mappings);
      const reconciled = reconcileSale(sale);
      previews.push({ sale_id: sale.id, bill_number: sale.bill_number, payment_method: sale.payment_method, total_paise: sale.total_paise, tax_paise: sale.tax_paise, debit_paise: reconciled.debitPaise, credit_paise: reconciled.creditPaise, balanced: reconciled.debitPaise === reconciled.creditPaise, xml });
    } catch (error) {
      previews.push({ sale_id: sale.id, bill_number: sale.bill_number, payment_method: sale.payment_method, total_paise: sale.total_paise, tax_paise: sale.tax_paise, error: error.message, error_kind: error.kind || 'mapping_error' });
    }
  }
  return previews;
}

export function queueProductSync(productIds) {
  if (!Array.isArray(productIds) || !productIds.length || productIds.length > 2000) throw new TallyError('validation_error', 'Select products to synchronize');
  const config = getTallySettings();
  const productList = localProducts().filter(product => productIds.map(Number).includes(Number(product.id)));
  const queued = [];
  inTransaction(() => {
    for (const product of productList) {
      const hash = productHash(product, config);
      const key = `product:${product.id}:${hash}`;
      run(`INSERT OR IGNORE INTO tally_sync_queue(entity_type,entity_id,idempotency_key,status)
        VALUES('product',?,?, 'pending')`, [product.id, key]);
      const job = one('SELECT id,status FROM tally_sync_queue WHERE idempotency_key=?', [key]);
      queued.push({ product_id: product.id, product_name: product.name, queue_id: job.id, status: job.status });
    }
  });
  return queued;
}

export function retryQueueJob(jobId, options = {}) {
  const job = one('SELECT * FROM tally_sync_queue WHERE id=?', [jobId]);
  if (!job) throw new TallyError('validation_error', 'Synchronization record was not found');
  if (job.status === 'synced') throw new TallyError('validation_error', 'A verified synchronization cannot be retried');
  const ambiguous = job.last_error_kind === 'unknown_outcome';
  let responseMarker = null;
  if (ambiguous) {
    try { responseMarker = JSON.parse(job.response_json || '{}'); } catch { responseMarker = {}; }
    if (responseMarker.verify_only && options.confirmedNotImported !== true) {
      throw new TallyError('unknown_outcome', 'First check Tally by the stable record reference. Confirm the record is absent before authorizing another import.');
    }
    responseMarker = { ...responseMarker, verify_only: !options.confirmedNotImported, confirmed_not_imported: options.confirmedNotImported === true };
  }
  run(`UPDATE tally_sync_queue SET status='pending',next_attempt_at=NULL,
    last_error_kind=?,last_error=?,response_json=?,updated_at=datetime('now','localtime') WHERE id=?`, [
    ambiguous ? 'unknown_outcome' : null,
    ambiguous ? job.last_error : null,
    ambiguous ? JSON.stringify(responseMarker) : null,
    jobId,
  ]);
  recordEvent(jobId, 'retry', 'queued', ambiguous
    ? (options.confirmedNotImported ? 'Administrator confirmed the Tally record is absent; retry is authorized after another reference check.' : 'Verification-only retry queued. The worker checks Tally by stable reference and will not re-import an unverified record.')
    : 'Retry queued after a definite Tally rejection or local error.', { confirmedNotImported: options.confirmedNotImported === true });
  persist();
  return one('SELECT * FROM tally_sync_queue WHERE id=?', [jobId]);
}

function updateJob(jobId, fields) {
  const names = Object.keys(fields);
  const assignments = names.map(name => `${name}=?`).join(',');
  run(`UPDATE tally_sync_queue SET ${assignments},updated_at=datetime('now','localtime') WHERE id=?`, [...names.map(name => fields[name]), jobId]);
}

function delaySeconds(attempt) { return Math.min(3600, [5, 30, 120, 600, 1800, 3600][Math.min(attempt - 1, 5)]); }

function markFailure(job, error) {
  const kind = error.kind || 'integration_error';
  const attempts = Number(job.attempts) + 1;
  const retryable = Boolean(error.retryable) && attempts < maxAttempts;
  const status = retryable ? 'retrying' : 'failed';
  const delay = retryable ? delaySeconds(attempts) : null;
  updateJob(job.id, {
    status,
    attempts,
    last_attempt_at: new Date().toISOString(),
    next_attempt_at: delay ? new Date(Date.now() + delay * 1000).toISOString().replace('T', ' ').slice(0, 19) : null,
    last_error_kind: kind,
    last_error: String(error.message || error).slice(0, 1200),
  });
  recordEvent(job.id, 'sync', status, error.message || String(error), { kind, attempts, retryable, delaySeconds: delay, details: error.details || null });
  persist();
}

function markSynced(job, remoteIdentifier, response) {
  updateJob(job.id, {
    status: 'synced', attempts: Number(job.attempts) + 1,
    last_attempt_at: new Date().toISOString(), next_attempt_at: null,
    last_error_kind: null, last_error: null,
    remote_identifier: remoteIdentifier || null,
    response_json: JSON.stringify(response || {}).slice(0, 12000),
  });
  if (job.entity_type === 'sale') run("UPDATE tally_settings SET value=datetime('now','localtime') WHERE key='last_successful_sync'");
  recordEvent(job.id, 'sync', 'synced', 'Tally import statistics confirmed the record was accepted.', { remoteIdentifier, response });
  persist();
}

function saveProductMap(product, config, tallyName, status = 'synced', error = null) {
  const part = stableProductPartNumber(product);
  run(`INSERT INTO tally_product_mappings(product_id,tally_stock_item_name,stable_part_number,product_hash,sync_status,last_synced_at,last_error)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(product_id) DO UPDATE SET tally_stock_item_name=excluded.tally_stock_item_name,stable_part_number=excluded.stable_part_number,product_hash=excluded.product_hash,sync_status=excluded.sync_status,last_synced_at=excluded.last_synced_at,last_error=excluded.last_error,updated_at=datetime('now','localtime')`, [product.id, tallyName, part, productHash(product, config), status, status === 'synced' ? new Date().toISOString() : null, error]);
}

function queueMarker(job) {
  try { return JSON.parse(job?.response_json || '{}'); } catch { return {}; }
}

async function importTallyRecord(jobId, xml, label) {
  updateJob(jobId, { response_json: JSON.stringify({ pending_import: true, confirmed_not_imported: false, verify_only: false }) });
  persist();
  try {
    const { xml: responseXml } = await postTallyXml(xml);
    const result = parseTallyImportResponse(responseXml, 1);
    updateJob(jobId, { response_json: null });
    persist();
    return result;
  } catch (error) {
    if (['connection_error', 'timeout', 'tally_http_error', 'invalid_xml', 'tally_unverified'].includes(error.kind)) {
      throw new TallyError('unknown_outcome', `Tally may have processed this ${label}, but its import could not be verified. Check Tally before retrying.`, {
        details: { originalKind: error.kind, originalMessage: error.message, originalDetails: error.details || null },
      });
    }
    updateJob(jobId, { response_json: null });
    persist();
    throw error;
  }
}

async function currentCompanyMatches(config) {
  const connection = await checkTallyConnection();
  if (config.company_verified !== 'true' || !connection.selectedCompany || connection.selectedCompany !== config.company_name) {
    run("UPDATE tally_settings SET value='false' WHERE key IN ('company_verified','live_enabled')");
    persist();
    recordEvent(null, 'company', 'mismatch', 'Live sync was disabled because the loaded Tally company no longer matches the verified company.', { configuredCompany: config.company_name, selectedCompany: connection.selectedCompany });
    persist();
    throw new TallyError('company_mismatch', 'Live synchronization was disabled because the company currently loaded in Tally does not match the administrator-verified company');
  }
  return connection;
}

async function processProductJob(job, config) {
  const product = one('SELECT * FROM products WHERE id=?', [job.entity_id]);
  if (!product) throw new TallyError('mapping_error', 'The product no longer exists in the local database');
  const masters = await fetchTallyMasters(config.company_name);
  const stablePart = stableProductPartNumber(product);
  const mapping = one('SELECT * FROM tally_product_mappings WHERE product_id=?', [product.id]);
  const byPart = remoteItemByPart(masters.stockItems, stablePart);
  const byMapping = mapping && remoteItemByName(masters.stockItems, mapping.tally_stock_item_name);
  const byName = remoteItemByName(masters.stockItems, product.name);
  let target = byMapping || byPart;
  let action = target ? 'Alter' : 'Create';
  const marker = queueMarker(job);
  if (marker.pending_import && target) {
    saveProductMap(product, config, target.name, 'synced');
    markSynced(job, target.name, { recovered_by_stable_part_number: stablePart });
    return;
  }
  if (marker.pending_import && !marker.confirmed_not_imported) {
    throw new TallyError('unknown_outcome', 'A previous stock-item import may have succeeded, but its stable part number is not visible in Tally. Check Tally before authorizing another import.');
  }
  if (!mapping && target && Number(job.attempts) > 0) {
    saveProductMap(product, config, target.name, 'synced');
    markSynced(job, target.name, { recovered_by_stable_part_number: stablePart });
    return;
  }
  if (!mapping && (byPart || byName)) throw new TallyError('mapping_error', `Tally item “${(byPart || byName).name}” already exists and has not been explicitly mapped; adopt it first`);
  if (mapping && !target && byName) throw new TallyError('mapping_error', `Another Tally item named “${product.name}” exists; refusing to alter an unmapped item`);
  if (mapping && !target && Number(job.attempts) > 0) {
    throw new TallyError('unknown_outcome', 'A previous stock-item import has an unknown result and the stable part number was not found. Check Tally manually before continuing.');
  }
  if (mapping && !target) action = 'Create';
  target ||= mapping ? null : null;
  const targetName = target?.name || mapping?.tally_stock_item_name || product.name;
  const xml = buildStockItemImportXml(product, config, { action, existingName: targetName, partNumber: stablePart });
  const response = await importTallyRecord(job.id, xml, 'stock item');
  saveProductMap(product, config, targetName, 'synced');
  markSynced(job, targetName, response);
}

async function processSaleJob(job, config) {
  const sale = saleSnapshot(job.entity_id);
  if (!sale) throw new TallyError('mapping_error', 'Completed bill was not found in the local database');
  const remoteId = `SUGAN-SALE-${sale.bill_number}`;
  const lookupXml = buildVoucherLookupRequest(config.company_name, remoteId);
  const lookup = await postTallyXml(lookupXml);
  if (findVoucherByRemoteId(lookup.document, remoteId)) {
    markSynced(job, scalarValue(lookup.document, 'MASTERID') || remoteId, { recovered_by_remote_id: remoteId });
    return;
  }
  const marker = queueMarker(job);
  if (marker.pending_import && !marker.confirmed_not_imported) {
    throw new TallyError('unknown_outcome', 'Tally did not return the stable bill reference after an earlier unverified import. Check the company manually before authorizing another import.');
  }
  const productIds = [...new Set(sale.items.map(item => Number(item.product_id)).filter(Boolean))];
  const productMappings = Object.fromEntries(productIds.map(productId => {
    const mapping = one('SELECT tally_stock_item_name,stable_part_number FROM tally_product_mappings WHERE product_id=? AND sync_status=?', [productId, 'synced']);
    return [productId, mapping ? { ...mapping, unit: JSON.parse(config.unit_map || '{}')[one('SELECT unit FROM products WHERE id=?', [productId])?.unit] } : null];
  }));
  const xml = buildSalesVoucherXml(sale, config, productMappings);
  const response = await importTallyRecord(job.id, xml, 'sales voucher');
  markSynced(job, response.lastVoucherId || remoteId, response);
}

function scalarValue(document, tag) {
  const key = Object.keys(document || {}).find(name => name.toUpperCase() === tag.toUpperCase());
  if (!key) return null;
  const value = document[key];
  if (value && typeof value === 'object') return String(value['#text'] || '');
  return String(value ?? '');
}

async function processOne(job) {
  const config = getTallySettings();
  if (config.live_enabled !== 'true') return;
  if (config.company_verified !== 'true') throw new TallyError('company_unverified', 'Live sync is enabled without a verified company; disabling live sync');
  await currentCompanyMatches(config);
  if (job.entity_type === 'product') await processProductJob(job, config);
  else if (job.entity_type === 'sale') await processSaleJob(job, config);
  else throw new TallyError('validation_error', 'Unsupported Tally queue record type');
}

export async function processTallyQueue(limit = 5) {
  if (workerBusy) return { processed: 0, busy: true };
  workerBusy = true;
  let processed = 0;
  try {
    const config = getTallySettings();
    if (config.live_enabled !== 'true') return { processed: 0, disabled: true };
    const jobs = rows(`SELECT * FROM tally_sync_queue
      WHERE status IN ('pending','retrying')
        AND (next_attempt_at IS NULL OR datetime(next_attempt_at)<=datetime('now','localtime'))
      ORDER BY CASE entity_type WHEN 'product' THEN 0 ELSE 1 END,id LIMIT ?`, [limit]);
    for (const job of jobs) {
      if (getTallySettings().live_enabled !== 'true') break;
      try { await processOne(job); }
      catch (error) { markFailure(job, error instanceof Error ? error : new Error(String(error))); }
      processed += 1;
    }
    return { processed };
  } finally { workerBusy = false; }
}

export function startTallyWorker(intervalMs = Number(process.env.TALLY_SYNC_INTERVAL_MS || 15000)) {
  if (workerTimer) return;
  const cadence = Number.isInteger(intervalMs) && intervalMs >= 50 && intervalMs <= 3600000 ? intervalMs : 15000;
  workerTimer = setInterval(() => { void processTallyQueue().catch(error => console.error('Tally outbox worker error:', error.message)); }, cadence);
  workerTimer.unref?.();
}

export function getTallyDashboard() {
  const config = getTallySettings();
  const connection = getConnectionState();
  const endpoint = getTallyEndpointInfo();
  const queueCounts = Object.fromEntries(rows('SELECT status,COUNT(*) AS count FROM tally_sync_queue GROUP BY status').map(row => [row.status, Number(row.count)]));
  const entityCounts = Object.fromEntries(rows('SELECT entity_type,status,COUNT(*) AS count FROM tally_sync_queue GROUP BY entity_type,status').map(row => [`${row.entity_type}_${row.status}`, Number(row.count)]));
  const localSales = rows(`SELECT date(created_at) AS sale_date,payment_method,COUNT(*) AS bills,
    SUM(total_paise) AS total_paise,SUM(discount_paise) AS discount_paise,SUM(tax_paise) AS tax_paise
    FROM sales WHERE date(created_at)>=date('now','localtime','-30 day') GROUP BY date(created_at),payment_method ORDER BY sale_date DESC`);
  const mappingStatus = rows(`SELECT COUNT(*) AS total,(SELECT COUNT(*) FROM tally_product_mappings WHERE sync_status='synced') AS synced,
    (SELECT COUNT(*) FROM products WHERE active=1 AND gst_rate>0 AND COALESCE(hsn_code,'')='') AS missing_hsn FROM products WHERE active=1`)[0];
  const lastSuccessful = one("SELECT value FROM tally_settings WHERE key='last_successful_sync'")?.value || null;
  const recentQueue = rows(`SELECT q.*,CASE WHEN q.entity_type='sale' THEN s.bill_number ELSE p.name END AS display_name
    FROM tally_sync_queue q LEFT JOIN sales s ON q.entity_type='sale' AND s.id=q.entity_id
    LEFT JOIN products p ON q.entity_type='product' AND p.id=q.entity_id ORDER BY q.id DESC LIMIT 20`);
  const recentEvents = rows('SELECT * FROM tally_sync_events ORDER BY id DESC LIMIT 30');
  return {
    connection,
    configuration: { ...config, unit_map: unitMapOf(config), expectedCompany: config.company_name || process.env.TALLY_EXPECTED_COMPANY || 'Sugan Super Market', endpointConfigured: !endpoint.error, endpoint: undefined, endpointHost: endpoint.host, endpointPort: endpoint.port, endpointError: endpoint.error, adminTokenConfigured: Boolean(process.env.TALLY_ADMIN_TOKEN) },
    queueCounts,
    entityCounts,
    productMappings: mappingStatus,
    localSales,
    lastSuccessfulSync: lastSuccessful,
    recentQueue,
    recentEvents,
    liveSyncEnabled: config.live_enabled === 'true',
  };
}

export async function getTrialBalance(from, to) {
  const config = getTallySettings();
  const connection = await checkTallyConnection();
  if (config.company_verified !== 'true' || connection.selectedCompany !== config.company_name) throw new TallyError('company_unverified', 'Verify the configured company before requesting Tally accounting reports');
  const { document } = await postTallyXml(buildTrialBalanceRequest(config.company_name, from, to));
  return { source: 'Tally Trial Balance', company: connection.selectedCompany, from, to, entries: parseTrialBalance(document), document };
}

