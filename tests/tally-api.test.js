import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adminToken = 'test-only-local-tally-admin-token';
const mockCompany = 'Sugan Mock Test Co';
let databaseDir;
let apiPort;
let mockPort;
let api;
let apiProcess;
let apiOutput = '';
let mockServer;
let failStockImports = 0;
let failVoucherImports = 0;
let dropVoucherResponseAfterAccept = false;
let dropStockResponseAfterAccept = false;
let dropCompanyResponse = false;
let lastCompanyHttpRequest = null;
let stockImports = 0;
let voucherImports = 0;
const stockItems = [];
const voucherRemoteIds = new Set();

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function tallyResponse(xml) {
  return `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY>${xml}</BODY></ENVELOPE>`;
}

function mockTallyRequest(body, response, request) {
  if (body.includes('<ID>SuganCurrentCompany</ID>')) {
    lastCompanyHttpRequest = { method: request.method, contentType: request.headers['content-type'], body };
    if (dropCompanyResponse) {
      dropCompanyResponse = false;
      response.destroy();
      return null;
    }
    return tallyResponse(`<DATA><CURRENTCOMPANY>${mockCompany}</CURRENTCOMPANY><COMPANYSTATE>Tamil Nadu</COMPANYSTATE></DATA>`);
  }
  if (body.includes('<ID>List of Accounts</ID>')) {
    const type = body.match(/<AccountType>([^<]+)<\/AccountType>/)?.[1] || '';
    if (type === 'Ledgers') {
      return tallyResponse('<DATA><LEDGER NAME="Cash"><NAME>Cash</NAME></LEDGER><LEDGER NAME="UPI Bank"><NAME>UPI Bank</NAME></LEDGER><LEDGER NAME="Sales"><NAME>Sales</NAME></LEDGER><LEDGER NAME="Taxable Sales"><NAME>Taxable Sales</NAME></LEDGER><LEDGER NAME="Discount"><NAME>Discount</NAME></LEDGER><LEDGER NAME="Output GST"><NAME>Output GST</NAME></LEDGER></DATA>');
    }
    if (type === 'Stock Groups') return tallyResponse('<DATA><STOCKGROUP NAME="Goods"><NAME>Goods</NAME></STOCKGROUP></DATA>');
    if (type === 'Units') return tallyResponse('<DATA><UNIT NAME="Nos"><NAME>Nos</NAME></UNIT></DATA>');
    if (type === 'Stock Items') {
      const items = stockItems.map(item => `<STOCKITEM NAME="${item.name}"><NAME>${item.name}</NAME><BASEUNITS>${item.unit}</BASEUNITS><MAILINGNAME.LIST><MAILINGNAME>${item.partNumber}</MAILINGNAME></MAILINGNAME.LIST></STOCKITEM>`).join('');
      return tallyResponse(`<DATA>${items}</DATA>`);
    }
  }
  if (body.includes('<ID>SuganVoucherLookup</ID>')) {
    const remoteId = [...voucherRemoteIds].find(id => body.includes(id));
    return remoteId ? tallyResponse(`<DATA><VOUCHER><MASTERID>999</MASTERID><REMOTEID>${remoteId}</REMOTEID></VOUCHER></DATA>`) : tallyResponse('<DATA/>');
  }
  if (body.includes('<ID>Trial Balance</ID>')) {
    return tallyResponse('<DSPACCNAME><DSPDISPNAME>Sales</DSPDISPNAME></DSPACCNAME><DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA></DSPCLDRAMTA></DSPCLDRAMT><DSPCLCRAMT><DSPCLCRAMTA>12.50</DSPCLCRAMTA></DSPCLCRAMT></DSPACCINFO>');
  }
  if (body.includes('<TALLYREQUEST>Import Data</TALLYREQUEST>') && body.includes('<STOCKITEM ')) {
    stockImports += 1;
    if (failStockImports > 0) {
      failStockImports -= 1;
      return tallyResponse('<DATA><CREATED>0</CREATED><ALTERED>0</ALTERED><ERRORS>1</ERRORS><LINEERROR>Mock stock item import failure</LINEERROR></DATA>');
    }
    const name = body.match(/<STOCKITEM NAME="([^"]+)"/)?.[1] || 'Unknown Item';
    const partNumber = body.match(/<MAILINGNAME>([^<]+)<\/MAILINGNAME>/)?.[1] || '';
    const unit = body.match(/<BASEUNITS>([^<]+)<\/BASEUNITS>/)?.[1] || 'Nos';
    if (!stockItems.some(item => item.partNumber === partNumber)) stockItems.push({ name, partNumber, unit });
    if (dropStockResponseAfterAccept) {
      dropStockResponseAfterAccept = false;
      response.destroy();
      return null;
    }
    return tallyResponse('<DATA><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><CANCELLED>0</CANCELLED><IGNORED>0</IGNORED><LASTMID>42</LASTMID></DATA>');
  }
  if (body.includes('<TALLYREQUEST>Import</TALLYREQUEST>') && body.includes('<VOUCHER ')) {
    voucherImports += 1;
    if (failVoucherImports > 0) {
      failVoucherImports -= 1;
      return tallyResponse('<DATA><CREATED>0</CREATED><ALTERED>0</ALTERED><ERRORS>1</ERRORS><LINEERROR>Mock voucher import failure</LINEERROR></DATA>');
    }
    const remoteId = body.match(/<REMOTEID>([^<]+)<\/REMOTEID>/)?.[1];
    if (remoteId) voucherRemoteIds.add(remoteId);
    if (dropVoucherResponseAfterAccept) {
      dropVoucherResponseAfterAccept = false;
      response.destroy();
      return null;
    }
    return tallyResponse('<DATA><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><CANCELLED>0</CANCELLED><IGNORED>0</IGNORED><LASTVCHID>999</LASTVCHID></DATA>');
  }
  return '<ENVELOPE><HEADER><STATUS>0</STATUS></HEADER><BODY><DATA><LINEERROR>Unexpected mock request</LINEERROR></DATA></BODY></ENVELOPE>';
}

function startMockTally() {
  mockServer = createHttpServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    const xml = mockTallyRequest(body, response, request);
    if (xml === null) return;
    response.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
    response.end(xml);
  });
  return new Promise(resolve => mockServer.listen(0, '127.0.0.1', () => {
    mockPort = mockServer.address().port;
    resolve();
  }));
}

async function startApi() {
  apiPort = await unusedPort();
  api = `http://127.0.0.1:${apiPort}`;
  apiOutput = '';
  apiProcess = spawn(process.execPath, ['server/index.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      API_PORT: String(apiPort), PORT: '', DATA_DIR: databaseDir,
      TALLY_XML_URL: `http://127.0.0.1:${mockPort}`,
      TALLY_EXPECTED_COMPANY: mockCompany,
      TALLY_ADMIN_TOKEN: adminToken,
      TALLY_TIMEOUT_MS: '1500',
      TALLY_SYNC_INTERVAL_MS: '50',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  apiProcess.stdout.on('data', chunk => { apiOutput += chunk.toString(); });
  apiProcess.stderr.on('data', chunk => { apiOutput += chunk.toString(); });
  await waitForApi();
}

async function stopApi() {
  if (!apiProcess || apiProcess.exitCode !== null) return;
  const exited = once(apiProcess, 'exit');
  apiProcess.kill();
  await exited;
}

async function waitForApi() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (apiProcess.exitCode !== null) throw new Error(`Test API exited early:\n${apiOutput}`);
    try {
      const response = await fetch(`${api}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Test API did not start:\n${apiOutput}`);
}

async function request(route, { method = 'GET', body, authorized = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (authorized) headers['x-tally-admin-token'] = adminToken;
  return fetch(`${api}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function waitForJob(jobId, expectedStatus, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request('/api/tally/status');
    if (response.ok) {
      const status = await response.json();
      const job = status.recentQueue.find(item => Number(item.id) === Number(jobId));
      if (job?.status === expectedStatus) return job;
    }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const last = await request('/api/tally/status');
  throw new Error(`Queue job ${jobId} did not reach ${expectedStatus}: ${JSON.stringify(await last.json())}`);
}

before(async () => {
  databaseDir = await mkdtemp(path.join(projectRoot, '.sugan-test-db-tally-'));
  await startMockTally();
  await startApi();
});

after(async () => {
  await stopApi();
  if (mockServer?.listening) await new Promise((resolve, reject) => mockServer.close(error => error ? reject(error) : resolve()));
  if (databaseDir) {
    const resolvedDatabaseDir = path.resolve(databaseDir);
    const resolvedRoot = path.resolve(projectRoot);
    if (!resolvedDatabaseDir.startsWith(`${resolvedRoot}${path.sep}`) || !path.basename(resolvedDatabaseDir).startsWith('.sugan-test-db-tally-')) {
      throw new Error('Refusing to remove a path outside this project-scoped temporary database folder');
    }
    await rm(resolvedDatabaseDir, { recursive: true, force: true });
  }
});

test('mock Tally connection, company review, dry run, sync outbox, safe retry, and duplicate prevention', async () => {
  const statusResponse = await request('/api/tally/status');
  assert.equal(statusResponse.status, 200);
  const initialStatus = await statusResponse.json();
  assert.equal(initialStatus.liveSyncEnabled, false);
  assert.equal(initialStatus.configuration.endpoint, undefined);
  assert.equal(initialStatus.configuration.endpointHost, '127.0.0.1');
  assert.equal(initialStatus.configuration.endpointPort, mockPort);
  assert.equal(initialStatus.configuration.expectedCompany, mockCompany);
  assert.equal(initialStatus.configuration.adminTokenConfigured, true);

  const invalidSettings = await request('/api/tally/settings', { method: 'PUT', authorized: true, body: { gst_mode: 'invented' } });
  assert.equal(invalidSettings.status, 400);
  assert.equal((await invalidSettings.json()).kind, 'validation_error');
  const unauthorizedSettings = await request('/api/tally/settings', { method: 'PUT', body: {} });
  assert.equal(unauthorizedSettings.status, 403);

  const connectionResponse = await request('/api/tally/connection-test', { method: 'POST', body: {} });
  assert.equal(connectionResponse.status, 200);
  const connection = await connectionResponse.json();
  assert.equal(connection.selectedCompany, mockCompany);
  assert.equal(connection.companyState, 'Tamil Nadu');
  assert.equal(connection.companyMatchesExpected, true);
  assert.equal(lastCompanyHttpRequest.method, 'POST');
  assert.match(lastCompanyHttpRequest.contentType, /text\/xml/i);
  assert.match(lastCompanyHttpRequest.body, /<TALLYREQUEST>Export<\/TALLYREQUEST>/);
  const connectedStatus = await (await request('/api/tally/status')).json();
  assert.ok(connectedStatus.connection.last_successful_at);

  const settings = {
    company_name: mockCompany, company_state: '', gst_effective_from: '', voucher_type: 'Sales',
    stock_group: 'Goods', cash_ledger: 'Cash', upi_ledger: 'UPI Bank', sales_ledger: 'Sales',
    taxable_sales_ledger: '', sales_return_ledger: '', discount_ledger: '', gst_mode: 'none',
    gst_ledger: '', cgst_ledger: '', sgst_ledger: '', igst_ledger: '', unit_map: { piece: 'Nos' },
  };
  const saveSettings = await request('/api/tally/settings', { method: 'PUT', authorized: true, body: settings });
  assert.equal(saveSettings.status, 200);
  const savedSettings = await saveSettings.json();
  assert.equal(savedSettings.company_name, mockCompany, `saved=${JSON.stringify(savedSettings)} get=${JSON.stringify(await (await request('/api/tally/settings')).json())} api=${apiOutput}`);
  const verify = await request('/api/tally/settings/verify-company', { method: 'POST', authorized: true, body: {} });
  assert.equal(verify.status, 200, JSON.stringify(await verify.clone().json()));
  assert.equal((await verify.json()).selectedCompany, mockCompany);

  const productResponse = await request('/api/products', {
    method: 'POST',
    body: { name: 'Mock Tally Item', barcode: 'TEST-TALLY-001', sku: 'TEST-TALLY-001', category: 'Test', purchase_price: 1, selling_price: 2.5, stock: 10, low_stock: 1, unit: 'piece', gst_rate: 0 },
  });
  assert.equal(productResponse.status, 201);
  const product = await productResponse.json();

  const productPreviewResponse = await request('/api/tally/products/preview', { method: 'POST', body: {} });
  assert.equal(productPreviewResponse.status, 200);
  const productPreview = await productPreviewResponse.json();
  assert.equal(productPreview.find(item => item.product_id === product.id).action, 'create');
  const queuedProductResponse = await request('/api/tally/products/sync', { method: 'POST', authorized: true, body: { product_ids: [product.id] } });
  assert.equal(queuedProductResponse.status, 200);
  const queuedProduct = (await queuedProductResponse.json()).queued[0];
  assert.ok(queuedProduct.queue_id);
  assert.equal(stockImports, 0, 'A queued item must not reach Tally while live synchronization is disabled');

  failStockImports = 1;
  const enable = await request('/api/tally/settings/live', { method: 'POST', authorized: true, body: { enabled: true } });
  assert.equal(enable.status, 200, JSON.stringify(await enable.clone().json()));
  const failedProduct = await waitForJob(queuedProduct.queue_id, 'failed');
  assert.equal(failedProduct.last_error_kind, 'tally_import_error');
  const retryProductResponse = await request(`/api/tally/queue/${queuedProduct.queue_id}/retry`, { method: 'POST', authorized: true, body: {} });
  assert.equal(retryProductResponse.status, 200);
  await waitForJob(queuedProduct.queue_id, 'synced');
  assert.equal(stockImports, 2);

  const duplicateProductResponse = await request('/api/tally/products/sync', { method: 'POST', authorized: true, body: { product_ids: [product.id] } });
  assert.equal(duplicateProductResponse.status, 200);
  const duplicateProduct = (await duplicateProductResponse.json()).queued[0];
  assert.equal(duplicateProduct.queue_id, queuedProduct.queue_id);
  assert.equal(duplicateProduct.status, 'synced');
  assert.equal(stockImports, 2, 'Stable product idempotency key must prevent a duplicate master import');

  const uncertainProductResponse = await request('/api/products', {
    method: 'POST',
    body: { name: 'Mock Uncertain Item', barcode: 'TEST-TALLY-002', sku: 'TEST-TALLY-002', category: 'Test', purchase_price: 1, selling_price: 3, stock: 4, low_stock: 1, unit: 'piece', gst_rate: 0 },
  });
  assert.equal(uncertainProductResponse.status, 201);
  const uncertainProduct = await uncertainProductResponse.json();
  dropStockResponseAfterAccept = true;
  const uncertainQueueResponse = await request('/api/tally/products/sync', { method: 'POST', authorized: true, body: { product_ids: [uncertainProduct.id] } });
  const uncertainJob = (await uncertainQueueResponse.json()).queued[0];
  const uncertainResult = await waitForJob(uncertainJob.queue_id, 'failed');
  assert.equal(uncertainResult.last_error_kind, 'unknown_outcome');
  const verifyOnlyRetry = await request(`/api/tally/queue/${uncertainJob.queue_id}/retry`, { method: 'POST', authorized: true, body: {} });
  assert.equal(verifyOnlyRetry.status, 200);
  await waitForJob(uncertainJob.queue_id, 'synced');
  assert.equal(stockImports, 3, 'After a lost response, the stable Tally part number is found without importing the item again');

  failVoucherImports = 1;
  const saleResponse = await request('/api/sales', {
    method: 'POST',
    body: { request_key: 'TALLY-MOCK-SALE-001', payment_method: 'cash', amount_received: 3, items: [{ product_id: product.id, quantity_milli: 1000, discount_paise: 0 }] },
  });
  assert.equal(saleResponse.status, 201);
  const sale = await saleResponse.json();
  assert.equal(sale.total_paise, 250);
  assert.equal(sale.change_paise, 50);
  const firstQueue = await request('/api/tally/sales/sync', { method: 'POST', authorized: true, body: { sale_ids: [sale.id] } });
  const secondQueue = await request('/api/tally/sales/sync', { method: 'POST', authorized: true, body: { sale_ids: [sale.id] } });
  assert.equal(firstQueue.status, 200);
  assert.equal(secondQueue.status, 200);
  const saleJob = (await firstQueue.json())[0];
  assert.equal((await secondQueue.json())[0].queue_id, saleJob.queue_id);
  const failedSale = await waitForJob(saleJob.queue_id, 'failed');
  assert.equal(failedSale.last_error_kind, 'tally_import_error');
  assert.equal(voucherRemoteIds.size, 0);
  dropVoucherResponseAfterAccept = true;
  const retrySale = await request(`/api/tally/queue/${saleJob.queue_id}/retry`, { method: 'POST', authorized: true, body: {} });
  assert.equal(retrySale.status, 200);
  const unknownSale = await waitForJob(saleJob.queue_id, 'failed');
  assert.equal(unknownSale.last_error_kind, 'unknown_outcome');
  assert.equal(voucherRemoteIds.size, 1, 'Mock Tally accepted the voucher before dropping its response');
  const recoverSale = await request(`/api/tally/queue/${saleJob.queue_id}/retry`, { method: 'POST', authorized: true, body: {} });
  assert.equal(recoverSale.status, 200, 'Sale retry is safe because the worker looks up the stable voucher reference first');
  await waitForJob(saleJob.queue_id, 'synced');
  assert.equal(voucherImports, 2);
  assert.equal(voucherRemoteIds.size, 1);

  const duplicateVoucherQueue = await request('/api/tally/sales/sync', { method: 'POST', authorized: true, body: { sale_ids: [sale.id] } });
  assert.equal((await duplicateVoucherQueue.json())[0].queue_id, saleJob.queue_id);
  assert.equal(voucherImports, 2, 'A repeated queue request must not import a duplicate voucher');
  const unsafeRetry = await request(`/api/tally/queue/${saleJob.queue_id}/retry`, { method: 'POST', authorized: true, body: {} });
  assert.equal(unsafeRetry.status, 400, 'A verified record cannot be retried');

  const localReportResponse = await request('/api/tally/reports/local?from=2000-01-01&to=2999-12-31');
  const localReport = await localReportResponse.json();
  assert.equal(localReport.source, 'Billing database (completed bills only)');
  assert.equal(localReport.totals.bills, 1);
  assert.equal(localReport.totals.total_paise, 250);
  assert.equal(localReport.daily[0].total_paise, 250);
  assert.equal(localReport.dailyMethods[0].payment_method, 'cash');
  assert.equal(localReport.grossProfit.gross_profit_paise, 150);
  const csvResponse = await request('/api/tally/reports/local.csv?from=2000-01-01&to=2999-12-31');
  assert.equal(csvResponse.status, 200);
  assert.match(await csvResponse.text(), /"sale_date","payment_method","bills"/);
  const tallyReportResponse = await request('/api/tally/reports/trial-balance?from=2026-10-01&to=2026-10-31');
  assert.equal(tallyReportResponse.status, 200);
  const tallyReport = await tallyReportResponse.json();
  assert.equal(tallyReport.source, 'Tally Trial Balance');
  assert.equal(tallyReport.entries[0].credit_paise, 1250);

  dropCompanyResponse = true;
  const failedConnection = await request('/api/tally/connection-test', { method: 'POST', body: {} });
  assert.equal(failedConnection.status, 502);
  const failure = await failedConnection.json();
  assert.equal(failure.kind, 'connection_error');
  assert.match(failure.error, /127\.0\.0\.1/);
  assert.match(failure.error, /Start TallyPrime/);
  const afterFailureStatus = await (await request('/api/tally/status')).json();
  assert.equal(afterFailureStatus.liveSyncEnabled, false, 'A failed connection test must disable live synchronization');
  assert.equal(afterFailureStatus.configuration.company_verified, 'false');
  assert.ok(afterFailureStatus.connection.last_successful_at, 'A failed check must preserve the last successful connection time');

  await stopApi();
  await startApi();
  const persistedStatus = await request('/api/tally/status');
  const persisted = await persistedStatus.json();
  assert.equal(persisted.recentQueue.find(job => job.id === saleJob.queue_id).status, 'synced');
  assert.equal(persisted.lastSuccessfulSync !== null, true);
  assert.equal(persisted.liveSyncEnabled, false);
  assert.ok(persisted.connection.last_successful_at);
  assert.equal(voucherImports, 2, 'Restart must not replay a verified Tally voucher');
});
