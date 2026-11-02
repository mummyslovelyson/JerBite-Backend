import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
if (!process.env.JWT_SECRET) {
  dotenv.config({ path: path.join(__dirname, '../../.env') });
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 5001,
  appName: process.env.APP_NAME || 'FoodApp',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  currency: process.env.CURRENCY || 'GHS',
  paystackSecret: process.env.PAYSTACK_SECRET_KEY || ''
};

if (!env.jwtSecret) {
  console.error('JWT_SECRET is missing. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
