import { query } from '../config/db.js';
import { sendEmail } from './email.js';
import { sendSms } from './sms.js';

// In-app + email + SMS. Never throws: a failed alert must not break the main action.
export async function notify(userId, title, body, { email = true, sms = true } = {}) {
  try {
    const { rows } = await query('SELECT email,phone FROM users WHERE id=$1', [userId]);
    if (!rows[0]) return;
    await query('INSERT INTO notifications(user_id,title,body) VALUES($1,$2,$3)', [userId, title, body]);
    const jobs = [];
    if (email) jobs.push(sendEmail(rows[0].email, title, body));
    if (sms) jobs.push(sendSms(rows[0].phone, `${title}: ${body}`));
    await Promise.allSettled(jobs);
  } catch (e) {
    console.error('notify failed:', e.message);
  }
}
