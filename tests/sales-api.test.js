import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let databaseDir;
let apiPort;
let api;
let serverProcess;
let serverOutput = '';

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForApi() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (serverProcess.exitCode !== null) throw new Error(`Test API exited early:\n${serverOutput}`);
    try {
      const response = await fetch(`${api}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Test API did not start:\n${serverOutput}`);
}

async function post(route, body) {
  return fetch(`${api}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

before(async () => {
  databaseDir = await mkdtemp(path.join(projectRoot, '.sugan-test-db-'));
  apiPort = await unusedPort();
  api = `http://127.0.0.1:${apiPort}`;
  serverProcess = spawn(process.execPath, ['server/index.js'], {
    cwd: projectRoot,
    env: { ...process.env, API_PORT: String(apiPort), PORT: '', DATA_DIR: databaseDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
  serverProcess.stderr.on('data', chunk => { serverOutput += chunk.toString(); });
  await waitForApi();
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    const exited = once(serverProcess, 'exit');
    serverProcess.kill();
    await exited;
  }
  const resolvedDatabaseDir = path.resolve(databaseDir);
  if (!resolvedDatabaseDir.startsWith(`${projectRoot}${path.sep}`) || !path.basename(resolvedDatabaseDir).startsWith('.sugan-test-db-')) {
    throw new Error('Refusing to remove a path outside this test’s project-scoped temporary database folder');
  }
  await rm(resolvedDatabaseDir, { recursive: true, force: true });
});

test('API rejects Card, requires a matching UPI QR and records only a cashier-asserted UPI sale', async () => {
  const productResponse = await post('/api/products', {
    name: 'API test item', barcode: 'TEST-API-001', sku: 'TEST-API-001',
    purchase_price: 1, selling_price: 2.5, stock: 3, low_stock: 1, unit: 'piece', gst_rate: 0,
  });
  assert.equal(productResponse.status, 201);
  const product = await productResponse.json();
  const baseSale = {
    request_key: 'SUGAN-API-TEST-REF-001',
    payment_reference: 'SUGAN-API-TEST-REF-001',
    payment_method: 'upi',
    payment_amount_paise: 250,
    items: [{ product_id: product.id, quantity_milli: 1000, discount_paise: 0 }],
  };

  const card = await post('/api/sales', { ...baseSale, payment_method: 'card' });
  assert.equal(card.status, 400);

  const unverified = await post('/api/sales', baseSale);
  assert.equal(unverified.status, 409);
  assert.match((await unverified.json()).error, /Verify the payment credit/);

  const amountMismatch = await post('/api/sales', { ...baseSale, payment_verification: 'cashier_asserted', payment_amount_paise: 251 });
  assert.equal(amountMismatch.status, 409);
  assert.match((await amountMismatch.json()).error, /bill total changed/i);

  const completedResponse = await post('/api/sales', { ...baseSale, payment_verification: 'cashier_asserted' });
  assert.equal(completedResponse.status, 201);
  const completed = await completedResponse.json();
  assert.equal(completed.payment_method, 'upi');
  assert.equal(completed.payment_reference, baseSale.payment_reference);
  assert.equal(completed.payment_verification, 'cashier_asserted');
  assert.equal(completed.total_paise, 250);
  assert.equal(completed.items.length, 1);

  const salesResponse = await fetch(`${api}/api/sales`);
  const sales = await salesResponse.json();
  assert.equal(sales.length, 1);
});
