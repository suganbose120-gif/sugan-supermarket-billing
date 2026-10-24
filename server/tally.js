import crypto from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

export class TallyError extends Error {
  constructor(kind, message, options = {}) {
    super(message, options);
    this.name = 'TallyError';
    this.kind = kind;
    this.retryable = Boolean(options.retryable);
    this.details = options.details || null;
  }
}

export function xmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[character]));
}

export function validateXml(xml, label = 'XML') {
  if (typeof xml !== 'string' || !xml.trim() || Buffer.byteLength(xml, 'utf8') > 4_000_000) {
    throw new TallyError('invalid_xml', `${label} is empty or exceeds the 4 MB limit`);
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) {
    throw new TallyError('invalid_xml', `${label} must not contain a document type or entity declaration`);
  }
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new TallyError('invalid_xml', `${label} is not well-formed XML`, { details: validation });
  }
  return xml;
}

export function parseXml(xml) {
  validateXml(xml, 'Tally response');
  try { return parser.parse(xml); }
  catch (error) { throw new TallyError('invalid_xml', 'Tally returned XML that could not be parsed', { cause: error }); }
}

function walk(node, callback) {
  if (Array.isArray(node)) { for (const item of node) walk(item, callback); return; }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    callback(key, value, node);
    walk(value, callback);
  }
}

function tagValues(document, wanted) {
  const found = [];
  const target = wanted.toUpperCase();
  walk(document, (key, value) => {
    if (key.toUpperCase() !== target) return;
    if (Array.isArray(value)) found.push(...value);
    else found.push(value);
  });
  return found;
}

function textOf(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'object') return String(value).trim();
  if (Array.isArray(value)) return textOf(value[0]);
  if (value['#text'] !== undefined) return textOf(value['#text']);
  return '';
}

function scalar(document, tag) { return textOf(tagValues(document, tag)[0]); }

export function parseTallyImportResponse(xml, expectedCount = 1) {
  const document = parseXml(xml);
  const status = scalar(document, 'STATUS');
  const lineErrors = tagValues(document, 'LINEERROR').map(textOf).filter(Boolean);
  const errors = Number(scalar(document, 'ERRORS') || 0);
  const cancelled = Number(scalar(document, 'CANCELLED') || 0);
  const created = Number(scalar(document, 'CREATED') || 0);
  const altered = Number(scalar(document, 'ALTERED') || 0);
  const combined = Number(scalar(document, 'COMBINED') || 0);
  const ignored = Number(scalar(document, 'IGNORED') || 0);
  if (status === '0' || lineErrors.length || errors > 0 || cancelled > 0) {
    throw new TallyError('tally_import_error', lineErrors[0] || scalar(document, 'DESC') || 'Tally reported an import error', {
      details: { status, created, altered, errors, cancelled, ignored, lineErrors },
    });
  }
  if (created + altered !== expectedCount || combined !== 0 || ignored !== 0) {
    throw new TallyError('tally_unverified', 'Tally response did not confirm the expected number of imported records', {
      details: { status, created, altered, combined, errors, cancelled, ignored, expectedCount },
    });
  }
  return {
    accepted: true,
    created,
    altered,
    lastVoucherId: scalar(document, 'LASTVCHID') || null,
    lastMasterId: scalar(document, 'LASTMID') || null,
    response: { status: status || null, created, altered, combined, ignored, errors, cancelled },
  };
}

export function assertLocalTallyEndpoint(endpoint = process.env.TALLY_XML_URL || 'http://127.0.0.1:9000') {
  let url;
  try { url = new URL(endpoint); }
  catch { throw new TallyError('configuration_error', 'TALLY_XML_URL must be a valid local HTTP URL'); }
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (url.protocol !== 'http:' || !localHosts.has(url.hostname.toLowerCase()) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new TallyError('configuration_error', 'TALLY_XML_URL must point to the local Tally HTTP server (for example http://127.0.0.1:9000)');
  }
  return url;
}

export function getTallyRuntimeConfig() {
  const timeoutMs = Number(process.env.TALLY_TIMEOUT_MS || 8000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60000) {
    throw new TallyError('configuration_error', 'TALLY_TIMEOUT_MS must be an integer from 500 to 60000');
  }
  return { url: assertLocalTallyEndpoint(process.env.TALLY_XML_URL || 'http://127.0.0.1:9000'), timeoutMs };
}

export function getTallyEndpointInfo(endpoint = process.env.TALLY_XML_URL || 'http://127.0.0.1:9000') {
  try {
    const url = assertLocalTallyEndpoint(endpoint);
    return { host: url.hostname, port: Number(url.port || 80), error: null };
  } catch (error) {
    return { host: null, port: null, error: error.message };
  }
}

function endpointLabel(url) {
  return `${url.hostname}:${url.port || 80}`;
}

export async function postTallyXml(xml, options = {}) {
  validateXml(xml, 'Tally request');
  const url = options.url ? assertLocalTallyEndpoint(options.url) : getTallyRuntimeConfig().url;
  const timeoutMs = options.timeoutMs ?? getTallyRuntimeConfig().timeoutMs;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', Accept: 'text/xml, application/xml' },
      body: xml,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const kind = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'connection_error';
    const endpoint = endpointLabel(url);
    const message = kind === 'timeout'
      ? `TallyPrime did not respond at ${endpoint} within ${timeoutMs} ms. Check that TallyPrime is open and its HTTP/XML server is enabled on this port.`
      : `Could not connect to Tally at ${endpoint}. Start TallyPrime, load the intended company, and enable its HTTP/XML server on port ${url.port || 80}. This loopback endpoint is the computer running the billing backend; if Tally is on another computer, run this backend beside Tally or use an administrator-approved secure private tunnel.`;
    throw new TallyError(kind, message, { cause: error, retryable: true });
  }
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > 4_000_000) throw new TallyError('invalid_xml', 'Tally response exceeds the 4 MB limit');
  let responseXml;
  try { responseXml = await response.text(); }
  catch (error) { throw new TallyError('connection_error', 'Could not read the response from Tally', { cause: error, retryable: true }); }
  if (Buffer.byteLength(responseXml, 'utf8') > 4_000_000) throw new TallyError('invalid_xml', 'Tally response exceeds the 4 MB limit');
  if (!response.ok) throw new TallyError('tally_http_error', `Tally returned HTTP ${response.status}`, { retryable: response.status >= 500 });
  const document = parseXml(responseXml);
  const tallyStatus = scalar(document, 'STATUS');
  if (tallyStatus === '0') {
    const description = scalar(document, 'LINEERROR') || scalar(document, 'DESC') || 'Tally rejected the XML request';
    throw new TallyError('tally_request_error', description, { details: { tallyStatus } });
  }
  return { document, xml: responseXml };
}

export function buildCurrentCompanyRequest() {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>SuganCurrentCompany</ID></HEADER><BODY><DESC><STATICVARIABLES/><TDL><TDLMESSAGE><OBJECT NAME="CurrentCompany"><LOCALFORMULA>CurrentCompany:##SVCURRENTCOMPANY</LOCALFORMULA><LOCALFORMULA>CompanyState:$StateName:Company:##SVCURRENTCOMPANY</LOCALFORMULA></OBJECT><COLLECTION NAME="SuganCurrentCompany" ISMODIFY="No"><OBJECTS>CurrentCompany</OBJECTS></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

export function parseCurrentCompany(document) {
  // TallyPrime can wrap the current-company fields in an outer object with the
  // same tag name. Skip that container and use the first non-empty leaf value.
  const companyName = ['CURRENTCOMPANY', 'SERVERCOMPANYNAME', 'COMPANYNAME']
    .flatMap(tag => tagValues(document, tag).map(textOf))
    .find(Boolean) || null;
  const companyState = scalar(document, 'COMPANYSTATE') || scalar(document, 'STATENAME');
  return { companyName, companyState: companyState || null };
}

export async function testTallyConnection(options = {}) {
  const { expectedCompany = process.env.TALLY_EXPECTED_COMPANY || 'Sugan Super Market', ...requestOptions } = options;
  const { document } = await postTallyXml(buildCurrentCompanyRequest(), requestOptions);
  const { companyName, companyState } = parseCurrentCompany(document);
  const companyMatchesExpected = Boolean(companyName && companyName === expectedCompany);
  return {
    connected: true,
    companyIdentified: Boolean(companyName),
    companyMatchesExpected,
    expectedCompany,
    selectedCompany: companyName,
    companyState,
    message: !companyName
      ? 'Tally responded with valid XML, but no loaded company name was found.'
      : companyMatchesExpected
        ? `TallyPrime is reachable and the expected company “${expectedCompany}” is loaded.`
        : `TallyPrime is reachable, but “${companyName}” is loaded instead of the expected company “${expectedCompany}”.`,
  };
}

export function buildListOfAccountsRequest(companyName, accountType) {
  if (!companyName || !['Ledgers', 'Stock Items', 'Stock Groups', 'Units'].includes(accountType)) {
    throw new TallyError('mapping_error', 'A company and supported Tally master type are required');
  }
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Accounts</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(companyName)}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><AccountType>${xmlEscape(accountType)}</AccountType></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
}

export function buildTrialBalanceRequest(companyName, fromDate, toDate) {
  if (!companyName) throw new TallyError('mapping_error', 'A verified Tally company is required');
  const formatDate = date => String(date || '').replaceAll('-', '');
  if (!/^\d{8}$/.test(formatDate(fromDate)) || !/^\d{8}$/.test(formatDate(toDate))) {
    throw new TallyError('validation_error', 'Report dates must be valid YYYY-MM-DD dates');
  }
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Trial Balance</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(companyName)}</SVCURRENTCOMPANY><SVFROMDATE>${formatDate(fromDate)}</SVFROMDATE><SVTODATE>${formatDate(toDate)}</SVTODATE><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
}

function childText(object, tag) {
  if (!object || typeof object !== 'object') return '';
  const key = Object.keys(object).find(name => name.toUpperCase() === tag.toUpperCase());
  return key ? textOf(object[key]) : '';
}

export function parseTallyMasters(document, kind) {
  const tagName = { ledgers: 'LEDGER', stockItems: 'STOCKITEM', stockGroups: 'STOCKGROUP', units: 'UNIT' }[kind];
  if (!tagName) throw new TallyError('validation_error', 'Unsupported Tally master type');
  const result = [];
  for (const raw of tagValues(document, tagName)) {
    const item = raw && typeof raw === 'object' ? raw : {};
    const name = item['@_NAME'] || childText(item, 'NAME') || childText(item, 'NAME.LIST');
    if (!name) continue;
    const partNumber = childText(item, 'PARTNO') || childText(item['MAILINGNAME.LIST'], 'MAILINGNAME') || childText(item, 'MAILINGNAME');
    result.push({ name: String(name).trim(), parent: childText(item, 'PARENT') || null, unit: childText(item, 'BASEUNITS') || null, partNumber: partNumber || null });
  }
  return result;
}

function findChild(object, wanted) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return undefined;
  const key = Object.keys(object).find(name => name.toUpperCase() === wanted.toUpperCase());
  return key ? object[key] : undefined;
}

function amountPaise(value) {
  const raw = textOf(value).replaceAll(',', '').trim();
  if (!raw) return 0;
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const amount = Number(match[0]);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

export function parseTrialBalance(document) {
  const entries = [];
  const visit = node => {
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    if (!node || typeof node !== 'object') return;
    const nameNodes = findChild(node, 'DSPACCNAME');
    const infoNodes = findChild(node, 'DSPACCINFO');
    if (nameNodes !== undefined && infoNodes !== undefined) {
      const names = Array.isArray(nameNodes) ? nameNodes : [nameNodes];
      const infos = Array.isArray(infoNodes) ? infoNodes : [infoNodes];
      for (let index = 0; index < Math.min(names.length, infos.length); index += 1) {
        const name = scalar(names[index], 'DSPDISPNAME') || scalar(names[index], 'DSPACCNAME') || textOf(names[index]);
        const info = infos[index];
        const debit = amountPaise(tagValues(info, 'DSPCLDRAMTA')[0]);
        const credit = amountPaise(tagValues(info, 'DSPCLCRAMTA')[0]);
        if (name) entries.push({ name, debit_paise: debit, credit_paise: credit });
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(document);
  return entries;
}

export function stableProductPartNumber(product) {
  const code = String(product.sku || product.barcode || '').trim();
  return code || `SG-PRODUCT-${String(product.id).padStart(8, '0')}`;
}

function hsnXml(product, config) {
  const rate = Number(product.gst_rate || 0);
  if (!rate) return '';
  const code = String(product.hsn_code || '').trim();
  const state = String(config.company_state || '').trim();
  const effective = String(config.gst_effective_from || '').replaceAll('-', '');
  if (!code) throw new TallyError('mapping_error', `HSN/SAC is missing for ${product.name}`);
  if (!state) throw new TallyError('mapping_error', 'Enter the company GST state before syncing taxable products');
  if (!/^\d{8}$/.test(effective)) throw new TallyError('mapping_error', 'Set the GST detail effective date before syncing taxable products');
  return `<GSTAPPLICABLE>Applicable</GSTAPPLICABLE><HSNDETAILS.LIST><APPLICABLEFROM>${effective}</APPLICABLEFROM><HSNCODE>${xmlEscape(code)}</HSNCODE><SRCOFHSNDETAILS>Specify Details Here</SRCOFHSNDETAILS></HSNDETAILS.LIST><GSTDETAILS.LIST><APPLICABLEFROM>${effective}</APPLICABLEFROM><TAXABILITY>Taxable</TAXABILITY><CALCULATIONTYPE>On Value</CALCULATIONTYPE><NATUREOFGOODS>Goods</NATUREOFGOODS><STATEWISEDETAILS.LIST><STATENAME>${xmlEscape(state)}</STATENAME><RATEDETAILS.LIST><GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD><GSTRATE>${rate.toFixed(2)}</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST>`;
}

export function buildStockItemImportXml(product, config, { action = 'Create', existingName = null, partNumber = stableProductPartNumber(product) } = {}) {
  const unitMap = typeof config.unit_map === 'string' ? JSON.parse(config.unit_map || '{}') : (config.unit_map || {});
  const unit = String(unitMap[product.unit] || '').trim();
  if (!config.company_name || !config.stock_group) throw new TallyError('mapping_error', 'Verified company and stock group mappings are required');
  if (!unit) throw new TallyError('mapping_error', `Map the application unit “${product.unit}” to an existing Tally unit`);
  const targetName = existingName || product.name;
  const safeAction = action === 'Alter' ? 'Alter' : 'Create';
  const gst = Number(product.gst_rate || 0) > 0 ? hsnXml(product, config) : '';
  const partNoXml = `<MAILINGNAME.LIST TYPE="String"><MAILINGNAME>${xmlEscape(partNumber)}</MAILINGNAME></MAILINGNAME.LIST>`;
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(config.company_name)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><STOCKITEM NAME="${xmlEscape(targetName)}" ACTION="${safeAction}"><NAME>${xmlEscape(product.name)}</NAME><NAME.LIST TYPE="String"><NAME>${xmlEscape(product.name)}</NAME></NAME.LIST><PARENT>${xmlEscape(config.stock_group)}</PARENT><BASEUNITS>${xmlEscape(unit)}</BASEUNITS>${partNoXml}${gst}</STOCKITEM></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  return validateXml(xml, 'Stock-item import request');
}

function formatMoney(paise) {
  if (!Number.isSafeInteger(paise)) throw new TallyError('reconciliation_error', 'Monetary values must be safe integer paise');
  return `${paise < 0 ? '-' : ''}${(Math.abs(paise) / 100).toFixed(2)}`;
}

function formatQuantity(quantityMilli) {
  if (!Number.isSafeInteger(quantityMilli) || quantityMilli <= 0) throw new TallyError('reconciliation_error', 'Sale quantity is invalid');
  return (quantityMilli / 1000).toFixed(3).replace(/\.?0+$/, '');
}

function stableGuid(reference) {
  const hex = crypto.createHash('sha256').update(reference).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}

export function reconcileSale(sale) {
  if (!sale || !Array.isArray(sale.items) || !sale.items.length) throw new TallyError('reconciliation_error', 'Completed sale has no saved item lines');
  if (!['cash', 'upi'].includes(sale.payment_method)) throw new TallyError('mapping_error', `Payment method ${sale.payment_method} is not configured for Tally export`);
  const sum = (field, selector = item => Number(item[field] || 0)) => sale.items.reduce((total, item) => total + selector(item), 0);
  const gross = sum('subtotal_paise', item => Math.round(Number(item.unit_price_paise) * Number(item.quantity_milli) / 1000));
  const discount = sum('discount_paise');
  const tax = sum('tax_paise');
  const lineTotals = sum('line_total_paise');
  const inclusiveTotal = sale.subtotal_paise - sale.discount_paise;
  const exclusiveTotal = inclusiveTotal + sale.tax_paise;
  const taxInclusive = sale.total_paise === inclusiveTotal;
  if (gross !== sale.subtotal_paise || discount !== sale.discount_paise || tax !== sale.tax_paise || lineTotals !== sale.total_paise || (sale.total_paise !== inclusiveTotal && sale.total_paise !== exclusiveTotal)) {
    throw new TallyError('reconciliation_error', 'Saved bill header, item, discount, or tax totals do not reconcile; no voucher was generated', {
      details: { gross, subtotal: sale.subtotal_paise, discount, headerDiscount: sale.discount_paise, tax, headerTax: sale.tax_paise, lineTotals, total: sale.total_paise },
    });
  }
  return { taxInclusive, subtotalPaise: sale.subtotal_paise, discountPaise: sale.discount_paise, taxPaise: sale.tax_paise, totalPaise: sale.total_paise, debitPaise: sale.total_paise + sale.discount_paise, creditPaise: taxInclusive ? sale.subtotal_paise : sale.subtotal_paise + sale.tax_paise };
}

function taxLedgers(taxPaise, config) {
  if (taxPaise === 0) return [];
  switch (config.gst_mode) {
    case 'single':
      if (!config.gst_ledger) throw new TallyError('mapping_error', 'Map the single GST ledger before synchronizing taxable sales');
      return [{ name: config.gst_ledger, amount: taxPaise }];
    case 'intra':
      if (!config.cgst_ledger || !config.sgst_ledger) throw new TallyError('mapping_error', 'Map both CGST and SGST/UTGST ledgers for intra-state sales');
      return [{ name: config.cgst_ledger, amount: Math.floor(taxPaise / 2) }, { name: config.sgst_ledger, amount: taxPaise - Math.floor(taxPaise / 2) }];
    case 'inter':
      if (!config.igst_ledger) throw new TallyError('mapping_error', 'Map the IGST ledger for inter-state sales');
      return [{ name: config.igst_ledger, amount: taxPaise }];
    default:
      throw new TallyError('mapping_error', 'Taxable sale has no configured GST ledger strategy');
  }
}

function ledgerEntry(name, amountPaise, isDebit, children = '') {
  return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xmlEscape(name)}</LEDGERNAME><ISDEEMEDPOSITIVE>${isDebit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><ISPARTYLEDGER>No</ISPARTYLEDGER><AMOUNT>${formatMoney(isDebit ? -amountPaise : amountPaise)}</AMOUNT>${children}</ALLLEDGERENTRIES.LIST>`;
}

export function buildSalesVoucherXml(sale, config, productMappings = {}) {
  const reconciled = reconcileSale(sale);
  const paymentLedger = sale.payment_method === 'cash' ? config.cash_ledger : config.upi_ledger;
  if (!config.company_name || !config.voucher_type || !paymentLedger || !config.sales_ledger) {
    throw new TallyError('mapping_error', 'Map the verified company, voucher type, payment ledger, and sales ledger before exporting a sale');
  }
  if (sale.items.some(item => Number(item.tax_paise || 0) > 0) && !config.taxable_sales_ledger) {
    throw new TallyError('mapping_error', 'Map a taxable-sales ledger before exporting a bill containing GST');
  }
  if (reconciled.taxPaise && config.gst_mode === 'none') throw new TallyError('mapping_error', 'This bill contains tax but no GST ledger strategy is configured');
  if (reconciled.discountPaise && !config.discount_ledger) throw new TallyError('mapping_error', 'This bill has a discount but no discount ledger is mapped');
  const ledgerGroups = new Map();
  const allocationsTotal = sale.items.reduce((sum, item) => {
    const mapped = productMappings[item.product_id] || productMappings[String(item.product_id)];
    if (!mapped?.tally_stock_item_name) throw new TallyError('mapping_error', `No Tally stock-item mapping exists for ${item.product_name}`);
    if (Number(item.tax_paise || 0) > 0 && !String(item.hsn_code || '').trim()) throw new TallyError('mapping_error', `Saved bill line “${item.product_name}” has tax but no HSN/SAC snapshot`);
    const rateInclusive = reconciled.taxInclusive;
    const amount = Math.round(Number(item.unit_price_paise) * Number(item.quantity_milli) / 1000) - (rateInclusive ? Number(item.tax_paise || 0) : 0);
    const ledger = Number(item.tax_paise || 0) > 0 ? config.taxable_sales_ledger : config.sales_ledger;
    if (!ledger) throw new TallyError('mapping_error', `No sales ledger is mapped for ${item.tax_paise ? 'taxable' : 'non-taxable'} item ${item.product_name}`);
    const quantity = Number(item.quantity_milli);
    const rate = ((amount / 100) / (quantity / 1000)).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    const allocation = `<INVENTORYALLOCATIONS.LIST><STOCKITEMNAME>${xmlEscape(mapped.tally_stock_item_name)}</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><RATE>${rate}/${xmlEscape(mapped.unit || item.unit)}</RATE><AMOUNT>${formatMoney(amount)}</AMOUNT><ACTUALQTY>${formatQuantity(quantity)} ${xmlEscape(mapped.unit || item.unit)}</ACTUALQTY><BILLEDQTY>${formatQuantity(quantity)} ${xmlEscape(mapped.unit || item.unit)}</BILLEDQTY><BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><AMOUNT>${formatMoney(amount)}</AMOUNT><ACTUALQTY>${formatQuantity(quantity)} ${xmlEscape(mapped.unit || item.unit)}</ACTUALQTY><BILLEDQTY>${formatQuantity(quantity)} ${xmlEscape(mapped.unit || item.unit)}</BILLEDQTY></BATCHALLOCATIONS.LIST></INVENTORYALLOCATIONS.LIST>`;
    ledgerGroups.set(ledger, [...(ledgerGroups.get(ledger) || []), allocation]);
    return sum + amount;
  }, 0);
  const salesAmount = reconciled.taxInclusive ? sale.subtotal_paise - sale.tax_paise : sale.subtotal_paise;
  if (allocationsTotal !== salesAmount) throw new TallyError('reconciliation_error', 'Stock allocations do not match the saved sales ledger total');
  const salesEntries = [...ledgerGroups.entries()].map(([ledger, allocationList]) => {
    const amount = sale.items.reduce((sum, item) => {
      const itemLedger = Number(item.tax_paise || 0) > 0 ? config.taxable_sales_ledger : config.sales_ledger;
      return itemLedger === ledger ? sum + Math.round(Number(item.unit_price_paise) * Number(item.quantity_milli) / 1000) - (reconciled.taxInclusive ? Number(item.tax_paise || 0) : 0) : sum;
    }, 0);
    return ledgerEntry(ledger, amount, false, allocationList.join(''));
  }).join('');
  const taxEntries = taxLedgers(sale.tax_paise, config).map(entry => ledgerEntry(entry.name, entry.amount, false)).join('');
  const discountEntry = sale.discount_paise ? ledgerEntry(config.discount_ledger, sale.discount_paise, true) : '';
  if (reconciled.debitPaise !== salesAmount + sale.tax_paise) {
    throw new TallyError('reconciliation_error', 'Generated Tally debit and credit totals do not balance');
  }
  const billNumber = String(sale.bill_number || '').trim();
  if (!billNumber) throw new TallyError('validation_error', 'Bill number is missing');
  const remoteId = `SUGAN-SALE-${billNumber}`;
  const date = String(sale.created_at || '').slice(0, 10).replaceAll('-', '');
  if (!/^\d{8}$/.test(date)) throw new TallyError('validation_error', 'Bill date must be in YYYY-MM-DD format');
  const paymentEntry = ledgerEntry(paymentLedger, sale.total_paise, true);
  const voucher = `<VOUCHER VCHTYPE="${xmlEscape(config.voucher_type)}" ACTION="Create" OBJVIEW="Accounting Voucher View"><DATE>${date}</DATE><VOUCHERTYPENAME>${xmlEscape(config.voucher_type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${xmlEscape(billNumber)}</VOUCHERNUMBER><GUID>${stableGuid(remoteId)}</GUID><REMOTEID>${xmlEscape(remoteId)}</REMOTEID><REFERENCE>${xmlEscape(billNumber)}</REFERENCE><NARRATION>${xmlEscape(`Sugan POS bill ${billNumber}`)}</NARRATION><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE>${paymentEntry}${discountEntry}${salesEntries}${taxEntries}</VOUCHER>`;
  return validateXml(`<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(config.company_name)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC><DATA><TALLYMESSAGE>${voucher}</TALLYMESSAGE></DATA></BODY></ENVELOPE>`, 'Sales voucher request');
}

export function buildVoucherLookupRequest(companyName, remoteId) {
  if (!companyName || !/^SUGAN-SALE-[A-Za-z0-9._-]+$/.test(remoteId)) throw new TallyError('validation_error', 'Invalid voucher lookup key');
  const formula = `$$IsEqual:$RemoteID:"${remoteId}"`;
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>SuganVoucherLookup</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(companyName)}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="SuganVoucherLookup" TYPE="Voucher" ISMODIFY="No"><FETCH>RemoteID</FETCH><FETCH>GUID</FETCH><FETCH>VoucherNumber</FETCH><FETCH>MasterID</FETCH><FILTERS>SuganRemoteIdFilter</FILTERS></COLLECTION><SYSTEM TYPE="Formulae" NAME="SuganRemoteIdFilter">${formula}</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

export function findVoucherByRemoteId(document, remoteId) {
  return tagValues(document, 'VOUCHER').some(voucher => childText(voucher, 'REMOTEID') === remoteId || childText(voucher, 'REMOTEID').toUpperCase() === remoteId.toUpperCase());
}

