// api/verify-payment.js
// Verifies a Paystack transaction server-side, then forwards the CONFIRMED order to SheetMonkey.
//
// Required Vercel environment variables (Project → Settings → Environment Variables):
//   PAYSTACK_SECRET_KEY  - your Paystack secret key (sk_test_... or sk_live_...).
//                          NEVER put this in index.html or any client-side file — only here,
//                          and only via this env var. There is no bypass if it's missing:
//                          the function fails loudly instead, in every environment
//                          (production, previews, local dev alike).
//   SHEETMONKEY_URL       - your SheetMonkey form endpoint. Not hardcoded/committed to the repo.
//   ALLOWED_ORIGINS       - comma-separated list of origins allowed to call this function, e.g.
//                          "https://glowenvy-by-ivy.vercel.app,https://www.glowenvyivy.com"
//                          (swap in your real Vercel URL and custom domain once you have them)
//                          If unset, CORS falls back to "*" (open) with a warning in the logs —
//                          fine while testing, but set this before you launch for real.
//
// Local testing: run `vercel dev` with a real PAYSTACK_SECRET_KEY test key available locally —
// either in a .env file (already in .gitignore, never committed) or pulled from the values
// you've set in the Vercel dashboard with `vercel env pull`. Don't reintroduce a code-level
// "dev mode" shortcut that skips the real Paystack check — that's what let unverified/fake
// orders through before.

export default async function handler(req, res) {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  const requestOrigin = req.headers.origin || '';
  let allowOriginHeader = '*';

  if (allowedOrigins.length > 0) {
    // Only reflect the origin back if it's on the allowlist; otherwise deny.
    allowOriginHeader = allowedOrigins.includes(requestOrigin) ? requestOrigin : 'null';
  } else {
    console.warn('ALLOWED_ORIGINS is not set — CORS is open to any site. Set this env var before going live.');
  }

  res.setHeader('Access-Control-Allow-Origin', allowOriginHeader);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Vercel parses a JSON request body into req.body automatically — no
    // JSON.parse(event.body) needed here (that step was a Netlify-ism).
    const { reference, email, shipping, cart, subtotal } = req.body || {};

    if (!reference) {
      return res.status(400).json({ verified: false, error: 'Missing reference' });
    }

    const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
    const SHEETMONKEY_URL = process.env.SHEETMONKEY_URL;

    if (!PAYSTACK_SECRET_KEY) {
      // No bypass, in any environment. A missing key must never be treated as a paid order.
      console.error('PAYSTACK_SECRET_KEY is not set — refusing to verify without a real Paystack check.');
      return res.status(500).json({
        verified: false,
        error: 'Payment verification is not configured on the server. Set PAYSTACK_SECRET_KEY in Vercel environment variables.'
      });
    }

    // Verify with Paystack — this is the only source of truth for whether payment succeeded.
    const paystackRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const paystackData = await paystackRes.json();

    if (!paystackRes.ok || !paystackData.status || paystackData.data?.status !== 'success') {
      console.log('Paystack verification failed', paystackData);
      return res.status(200).json({ verified: false, data: paystackData, error: 'Transaction not successful' });
    }

    // Payment verified — now record it in SheetMonkey.
    const orderPayload = buildSheetPayload({
      reference,
      email: email || paystackData.data.customer?.email,
      shipping,
      cart,
      subtotal,
      paystackData: paystackData.data,
      verified: true
    });

    if (SHEETMONKEY_URL) {
      const sheetResult = await sendToSheetMonkey(SHEETMONKEY_URL, orderPayload);
      console.log('SheetMonkey result:', sheetResult);
    } else {
      console.error('SHEETMONKEY_URL is not set — this order was verified but NOT recorded anywhere. Payload:', orderPayload);
    }

    return res.status(200).json({
      verified: true,
      data: paystackData.data,
      sheetmonkey: SHEETMONKEY_URL ? 'sent' : 'not_configured',
      reference
    });

  } catch (err) {
    console.error('verify-payment error', err);
    return res.status(500).json({ verified: false, error: err.message });
  }
}

function buildSheetPayload({ reference, email, shipping, cart, subtotal, paystackData, verified }) {
  const safeShipping = shipping || {};
  const cartArray = Array.isArray(cart) ? cart : [];
  const cartSummary = cartArray.map(item => `${item.name || 'Item'} x${item.qty || 1} @ ₦${item.price || 0}`).join('; ');
  const now = new Date();

  return {
    Email: email || safeShipping.email || paystackData?.customer?.email || '',
    FullName: safeShipping.fullName || safeShipping.full_name || '',
    Phone: safeShipping.phone || '',
    Address: safeShipping.address || '',
    City: safeShipping.city || '',
    State: safeShipping.state || '',
    Country: 'Nigeria',
    Note: safeShipping.note || '',
    OrderSummary: cartSummary,
    ItemsJSON: JSON.stringify(cartArray),
    Subtotal: subtotal || paystackData?.amount ? (paystackData.amount / 100) : '',
    SubtotalKobo: paystackData?.amount || (subtotal ? subtotal * 100 : ''),
    PaystackReference: reference,
    PaystackTransactionId: paystackData?.id || '',
    PaymentVerified: verified ? 'YES' : 'NO',
    PaymentStatus: paystackData?.status || (verified ? 'success' : 'pending'),
    PaymentChannel: paystackData?.channel || '',
    PaidAt: paystackData?.paid_at || now.toISOString(),
    OrderDate: now.toISOString(),
    OrderDate_NG: now.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }),
    CustomerEmail: email || '',
    Source: 'GlowEnvy Website - Vercel Function',
    CreatedAt: Date.now()
  };
}

async function sendToSheetMonkey(url, payload) {
  // SheetMonkey is picky — try JSON first, then form-encoded.
  console.log('[SheetMonkey] Attempting to send to', url);
  console.log('[SheetMonkey] Payload:', JSON.stringify(payload).slice(0, 500));

  // Try 1: JSON
  try {
    const sheetRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await sheetRes.text();
    console.log('[SheetMonkey] JSON attempt - Status:', sheetRes.status, 'Body:', text.slice(0, 500));
    if (sheetRes.ok) {
      return { ok: true, status: sheetRes.status, body: text.slice(0, 500), method: 'json' };
    }
  } catch (e) {
    console.error('[SheetMonkey] JSON attempt failed', e.message);
  }

  // Try 2: Form-encoded (many SheetMonkey forms prefer this)
  try {
    const params = new URLSearchParams();
    Object.entries(payload).forEach(([k, v]) => {
      if (v !== undefined && v !== null) {
        params.append(k, String(v));
      }
    });
    const sheetRes2 = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const text2 = await sheetRes2.text();
    console.log('[SheetMonkey] Form attempt - Status:', sheetRes2.status, 'Body:', text2.slice(0, 500));
    return { ok: sheetRes2.ok, status: sheetRes2.status, body: text2.slice(0, 500), method: 'form' };
  } catch (e2) {
    console.error('[SheetMonkey] Form attempt failed', e2.message);
    return { ok: false, error: e2.message };
  }
}
