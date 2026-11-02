import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

const transporter = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
  : null;

export async function sendEmail(to, subject, text) {
  if (!transporter) return console.log(`[EMAIL → ${to}] ${subject}\n${text}\n`);
  await transporter.sendMail({ from: process.env.MAIL_FROM || env.appName, to, subject, text });
}
