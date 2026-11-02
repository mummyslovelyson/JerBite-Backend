import crypto from 'crypto';
import { env } from '../config/env.js';

const BASE = 'https://api.paystack.co';
const headers = () => ({ Authorization: `Bearer ${env.paystackSecret}`, 'Content-Type': 'application/json' });

export const newReference = () => `fd_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

export async function initializePayment({ email, amount, reference, callbackUrl }) {
  if (!env.paystackSecret) throw Object.assign(new Error('Payments are not configured yet (PAYSTACK_SECRET_KEY missing)'), { status: 503 });
  const res = await fetch(`${BASE}/transaction/initialize`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ email, amount: Math.round(amount * 100), reference, currency: env.currency, callback_url: callbackUrl })
  });
  const json = await res.json();
  if (!json.status) throw Object.assign(new Error(json.message || 'Could not start payment'), { status: 502 });
  return json.data; // { authorization_url, access_code, reference }
}

export async function verifyPayment(reference) {
  const res = await fetch(`${BASE}/transaction/verify/${encodeURIComponent(reference)}`, { headers: headers() });
  const json = await res.json();
  return json.status ? json.data : null; // data.status === 'success', data.amount in minor units
}

export async function refundPayment(reference) {
  if (!env.paystackSecret) throw Object.assign(new Error('Payments are not configured yet (PAYSTACK_SECRET_KEY missing)'), { status: 503 });
  const res = await fetch(`${BASE}/refund`, { method: 'POST', headers: headers(), body: JSON.stringify({ transaction: reference }) });
  const json = await res.json();
  if (!json.status) throw Object.assign(new Error(json.message || 'Paystack could not refund this payment'), { status: 502 });
  return json.data; // data.status: 'pending' | 'processing' | 'processed'
}

export const validWebhookSignature = (rawBody, signature) =>
  !!signature && crypto.createHmac('sha512', env.paystackSecret).update(rawBody).digest('hex') === signature;
