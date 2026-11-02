export async function sendSms(to, message) {
  if (!process.env.SMS_API_KEY) return console.log(`[SMS → ${to}] ${message}`);
  const res = await fetch(process.env.SMS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: String(to).replace(/^\+/, ''),
      from: process.env.SMS_SENDER_ID,
      sms: message,
      type: 'plain',
      channel: 'generic',
      api_key: process.env.SMS_API_KEY
    })
  });
  if (!res.ok) throw new Error(`SMS provider responded ${res.status}`);
}
