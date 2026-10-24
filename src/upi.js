export const UPI_PAYEE_NAME = 'Sugan Bose';
export const UPI_ID = 'suganbose120@okicici';
export const UPI_REFERENCE_QR_ASSET = import.meta.env?.VITE_UPI_QR_ASSET || '/upi-qr.png';

export function createBillReference() {
  const timestamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const nonce = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 12);
  return `SUGAN-${timestamp}-${nonce}`.toUpperCase();
}

export function buildUpiUri(amountPaise, billReference) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new Error('Add bill items before generating a UPI payment QR');
  }
  const reference = String(billReference || '').trim();
  if (!reference || reference.length > 80 || !/^[A-Z0-9._-]+$/i.test(reference)) {
    throw new Error('A valid bill reference is required for UPI payment');
  }

  const params = new URLSearchParams({
    pa: UPI_ID,
    pn: UPI_PAYEE_NAME,
    am: (amountPaise / 100).toFixed(2),
    cu: 'INR',
    tn: reference,
    mam: 'Y',
  });
  return `upi://pay?${params.toString()}`;
}
