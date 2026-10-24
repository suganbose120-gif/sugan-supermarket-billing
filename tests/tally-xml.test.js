import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import {
  assertLocalTallyEndpoint, buildCurrentCompanyRequest, buildSalesVoucherXml, getTallyEndpointInfo,
  buildStockItemImportXml, parseCurrentCompany, parseTallyImportResponse,
  parseTallyMasters, parseTrialBalance, parseXml, reconcileSale, TallyError,
  testTallyConnection, validateXml, xmlEscape,
} from '../server/tally.js';
import { normalizeTallySettings } from '../server/tally-queue.js';

const sampleSale = {
  id: 1,
  bill_number: 'SG-TEST-001',
  created_at: '2026-10-21 12:34:56',
  payment_method: 'cash',
  subtotal_paise: 11200,
  discount_paise: 200,
  tax_paise: 1000,
  total_paise: 11000,
  items: [{
    product_id: 7, product_name: 'Rice & grain', hsn_code: '1006', unit: 'packet',
    quantity_milli: 1000, unit_price_paise: 11200, discount_paise: 200,
    gst_rate: 10, tax_paise: 1000, line_total_paise: 11000,
  }],
};

const sampleConfig = {
  company_name: 'Sugan & Co', voucher_type: 'Sales', stock_group: 'Goods',
  cash_ledger: 'Cash', upi_ledger: 'UPI Bank', sales_ledger: 'Sales',
  taxable_sales_ledger: 'Taxable Sales', discount_ledger: 'Discount',
  gst_mode: 'single', gst_ledger: 'Output GST', unit_map: { packet: 'Pkt' },
  company_state: 'Tamil Nadu', gst_effective_from: '2026-04-01',
};

test('Tally XML escaping and validation reject malformed or entity-bearing documents', () => {
  assert.equal(xmlEscape(`A & <B> "C" 'D'`), 'A &amp; &lt;B&gt; &quot;C&quot; &apos;D&apos;');
  assert.throws(() => validateXml('<ENVELOPE><BROKEN></ENVELOPE>'), error => error.kind === 'invalid_xml');
  assert.throws(() => validateXml('<!DOCTYPE x [<!ENTITY y "bad">]><x>&y;</x>'), error => error.kind === 'invalid_xml');
  assert.deepEqual(parseXml('<ENVELOPE><STATUS>1</STATUS></ENVELOPE>').ENVELOPE.STATUS, '1');
});

test('Tally import acceptance requires exact created or altered statistics, not HTTP/XML alone', () => {
  const accepted = parseTallyImportResponse('<RESPONSE><STATUS>1</STATUS><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><CANCELLED>0</CANCELLED><IGNORED>0</IGNORED></RESPONSE>');
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.created, 1);
  assert.throws(
    () => parseTallyImportResponse('<RESPONSE><STATUS>1</STATUS><CREATED>0</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS></RESPONSE>'),
    error => error.kind === 'tally_unverified',
  );
  assert.throws(
    () => parseTallyImportResponse('<RESPONSE><STATUS>1</STATUS><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>Unknown ledger</LINEERROR></RESPONSE>'),
    error => error.kind === 'tally_import_error' && /Unknown ledger/.test(error.message),
  );
});

test('local endpoint guard allows only HTTP loopback and rejects external XML targets', () => {
  assert.equal(assertLocalTallyEndpoint('http://localhost:9000').port, '9000');
  assert.deepEqual(getTallyEndpointInfo('http://localhost:9000'), { host: 'localhost', port: 9000, error: null });
  assert.throws(() => assertLocalTallyEndpoint('https://localhost:9000'), error => error.kind === 'configuration_error');
  assert.throws(() => assertLocalTallyEndpoint('http://example.com:9000'), error => error.kind === 'configuration_error');
  assert.throws(() => assertLocalTallyEndpoint('http://localhost:9000/path'), error => error.kind === 'configuration_error');
});

test('connection test reports actionable local endpoint guidance when connection is refused', async () => {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  await assert.rejects(
    testTallyConnection({ url: `http://127.0.0.1:${port}`, timeoutMs: 1000 }),
    error => error instanceof TallyError && error.kind === 'connection_error' && error.message.includes(`127.0.0.1:${port}`) && /Start TallyPrime/.test(error.message) && /billing backend/i.test(error.message),
  );
});

test('company and master parsers read names and stable stock part numbers from Tally XML', () => {
  const companyRequest = buildCurrentCompanyRequest();
  assert.match(companyRequest, /SVCURRENTCOMPANY/);
  const company = parseCurrentCompany(parseXml('<ENVELOPE><BODY><DATA><CURRENTCOMPANY>Sugan Supermarket</CURRENTCOMPANY><COMPANYSTATE>Tamil Nadu</COMPANYSTATE></DATA></BODY></ENVELOPE>'));
  assert.deepEqual(company, { companyName: 'Sugan Supermarket', companyState: 'Tamil Nadu' });
  const tallyPrimeCompany = parseCurrentCompany(parseXml('<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION><CURRENTCOMPANY NAME="CurrentCompany"><COMPANYSTATE TYPE="String">Tamil Nadu</COMPANYSTATE><CURRENTCOMPANY TYPE="String">Sugan Super Market</CURRENTCOMPANY></CURRENTCOMPANY></COLLECTION></DATA></BODY></ENVELOPE>'));
  assert.deepEqual(tallyPrimeCompany, { companyName: 'Sugan Super Market', companyState: 'Tamil Nadu' });
  const masters = parseTallyMasters(parseXml('<ENVELOPE><STOCKITEM NAME="Rice"><NAME>Rice</NAME><PARENT>Goods</PARENT><BASEUNITS>Pkt</BASEUNITS><MAILINGNAME.LIST><MAILINGNAME>RICE-001</MAILINGNAME></MAILINGNAME.LIST></STOCKITEM></ENVELOPE>'), 'stockItems');
  assert.deepEqual(masters, [{ name: 'Rice', parent: 'Goods', unit: 'Pkt', partNumber: 'RICE-001' }]);
  const ledgers = parseTallyMasters(parseXml('<ENVELOPE><LEDGER NAME="Cash"><NAME>Cash</NAME></LEDGER><LEDGER NAME="UPI"><NAME>UPI</NAME></LEDGER></ENVELOPE>'), 'ledgers');
  assert.deepEqual(ledgers.map(item => item.name), ['Cash', 'UPI']);
});

test('sales voucher retains bill tax and discount snapshots and reconciles debit to credit', () => {
  const reconciled = reconcileSale(sampleSale);
  assert.equal(reconciled.taxInclusive, true);
  assert.equal(reconciled.debitPaise, 11200);
  assert.equal(reconciled.creditPaise, 11200);
  const xml = buildSalesVoucherXml(sampleSale, sampleConfig, { 7: { tally_stock_item_name: 'Rice', stable_part_number: 'RICE-001', unit: 'Pkt' } });
  assert.match(xml, /<VOUCHERNUMBER>SG-TEST-001<\/VOUCHERNUMBER>/);
  assert.match(xml, /<REMOTEID>SUGAN-SALE-SG-TEST-001<\/REMOTEID>/);
  assert.match(xml, /<LEDGERNAME>Discount<\/LEDGERNAME>/);
  assert.match(xml, /<LEDGERNAME>Output GST<\/LEDGERNAME>/);
  assert.match(xml, /<STOCKITEMNAME>Rice<\/STOCKITEMNAME>/);
  assert.match(xml, /<AMOUNT>102\.00<\/AMOUNT>/);
  const inconsistent = { ...sampleSale, tax_paise: 999 };
  assert.throws(() => reconcileSale(inconsistent), error => error.kind === 'reconciliation_error');
  assert.throws(() => buildSalesVoucherXml(sampleSale, { ...sampleConfig, gst_mode: 'none' }, { 7: { tally_stock_item_name: 'Rice', unit: 'Pkt' } }), error => error.kind === 'mapping_error');
});

test('stock-item XML never writes opening balances and requires explicit Tally unit mapping', () => {
  const product = { id: 7, name: 'Rice', sku: 'RICE-001', unit: 'packet', gst_rate: 0, hsn_code: '' };
  const xml = buildStockItemImportXml(product, { ...sampleConfig, unit_map: { packet: 'Pkt' } });
  assert.match(xml, /<STOCKITEM NAME="Rice" ACTION="Create">/);
  assert.match(xml, /<BASEUNITS>Pkt<\/BASEUNITS>/);
  assert.match(xml, /<MAILINGNAME>RICE-001<\/MAILINGNAME>/);
  assert.doesNotMatch(xml, /OPENINGBALANCE|OPENINGRATE|OPENINGVALUE/);
  assert.throws(() => buildStockItemImportXml(product, { ...sampleConfig, unit_map: {} }), error => error.kind === 'mapping_error');
});

test('GST-inclusive and GST-exclusive saved bills reconcile without guessing tax rates', () => {
  const exclusiveSale = {
    ...sampleSale, subtotal_paise: 10000, discount_paise: 1000,
    tax_paise: 900, total_paise: 9900,
    items: [{ ...sampleSale.items[0], unit_price_paise: 10000, discount_paise: 1000, tax_paise: 900, line_total_paise: 9900 }],
  };
  const totals = reconcileSale(exclusiveSale);
  assert.equal(totals.taxInclusive, false);
  assert.equal(totals.debitPaise, 10900);
  assert.equal(totals.creditPaise, 10900);
  const trialBalance = parseTrialBalance(parseXml('<ENVELOPE><DSPACCNAME><DSPDISPNAME>Sales</DSPDISPNAME></DSPACCNAME><DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA></DSPCLDRAMTA></DSPCLDRAMT><DSPCLCRAMT><DSPCLCRAMTA>123.45</DSPCLCRAMTA></DSPCLCRAMT></DSPACCINFO></ENVELOPE>'));
  assert.deepEqual(trialBalance, [{ name: 'Sales', debit_paise: 0, credit_paise: 12345 }]);
});

test('Tally settings validation rejects unsupported tax mappings, invalid units and dates', () => {
  const base = {
    company_name: 'Sugan', company_state: '', voucher_type: 'Sales', stock_group: 'Goods',
    cash_ledger: 'Cash', upi_ledger: 'UPI', sales_ledger: 'Sales', taxable_sales_ledger: '',
    sales_return_ledger: '', discount_ledger: '', gst_mode: 'none', gst_ledger: '',
    cgst_ledger: '', sgst_ledger: '', igst_ledger: '', gst_effective_from: '', unit_map: { piece: 'Nos' },
  };
  assert.equal(normalizeTallySettings(base).company_name, 'Sugan');
  assert.throws(() => normalizeTallySettings({ ...base, gst_mode: 'guess' }), error => error instanceof TallyError && error.kind === 'validation_error');
  assert.throws(() => normalizeTallySettings({ ...base, unit_map: { mystery: 'Each' } }), error => error.kind === 'validation_error');
  assert.throws(() => normalizeTallySettings({ ...base, gst_effective_from: '2026-99-42' }), error => error.kind === 'validation_error');
});
