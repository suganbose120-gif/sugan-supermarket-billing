import assert from 'node:assert/strict';
import test from 'node:test';
import QRCode from 'qrcode';
import { buildUpiUri, createBillReference, UPI_ID, UPI_PAYEE_NAME } from '../src/upi.js';

test('UPI URI contains the payee, exact paise-derived amount, bill reference, currency and minimum amount flag', () => {
  const reference = 'SUGAN-TEST-REF-001';
  const uri = buildUpiUri(12345, reference);
  const parsed = new URL(uri);

  assert.equal(parsed.protocol, 'upi:');
  assert.equal(parsed.hostname, 'pay');
  assert.equal(UPI_ID, 'suganbose120@okicici');
  assert.equal(UPI_PAYEE_NAME, 'Sugan Bose');
  assert.equal(parsed.searchParams.get('pa'), UPI_ID);
  assert.equal(parsed.searchParams.get('pn'), UPI_PAYEE_NAME);
  assert.equal(parsed.searchParams.get('am'), '123.45');
  assert.equal(parsed.searchParams.get('cu'), 'INR');
  assert.equal(parsed.searchParams.get('tn'), reference);
  assert.equal(parsed.searchParams.get('mam'), 'Y');
});

test('bill-specific QR data changes with the amount and retains the same bill reference', async () => {
  const reference = createBillReference();
  const firstUri = buildUpiUri(1000, reference);
  const changedUri = buildUpiUri(1299, reference);
  const firstQr = await QRCode.toDataURL(firstUri);
  const changedQr = await QRCode.toDataURL(changedUri);

  assert.match(firstQr, /^data:image\/png;base64,/);
  assert.match(changedQr, /^data:image\/png;base64,/);
  assert.notEqual(firstQr, changedQr);
  assert.equal(new URL(changedUri).searchParams.get('am'), '12.99');
  assert.equal(new URL(changedUri).searchParams.get('tn'), reference);
});

test('bill reference generator produces unique payment references', () => {
  assert.notEqual(createBillReference(), createBillReference());
});

test('UPI QR builder rejects zero, fractional paise, and missing references', () => {
  assert.throws(() => buildUpiUri(0, 'SUGAN-TEST-REF'));
  assert.throws(() => buildUpiUri(100.5, 'SUGAN-TEST-REF'));
  assert.throws(() => buildUpiUri(100, ''));
});
