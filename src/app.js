import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import { env } from './config/env.js';
import { notFound, errorHandler } from './middleware/error.js';
import authRoutes from './routes/auth.routes.js';
import publicRoutes from './routes/public.routes.js';
import accountRoutes from './routes/account.routes.js';
import managerRoutes from './routes/manager.routes.js';
import riderRoutes from './routes/rider.routes.js';
import adminRoutes from './routes/admin.routes.js';
import { orders, payments } from './routes/orders.routes.js';

const app = express();
const uploads = path.join(path.dirname(fileURLToPath(import.meta.url)), '../uploads');

const isDev = env.nodeEnv === 'development';
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (origin === env.clientUrl || (isDev && (/^http:\/\/localhost(:\d+)?$/.test(origin) || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)))) {
      return callback(null, true);
    }
    return callback(new Error('Blocked by CORS'));
  },
  credentials: true
}));
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } })); // rawBody for webhook signature
app.use(express.urlencoded({ extended: true }));
if (env.nodeEnv !== 'test') app.use(morgan('dev'));
app.use('/uploads', express.static(uploads));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api', publicRoutes);
app.use('/api/me', accountRoutes);
app.use('/api/orders', orders);
app.use('/api/payments', payments);
app.use('/api/manager', managerRoutes);
app.use('/api/rider', riderRoutes);
app.use('/api/admin', adminRoutes);

app.use(notFound);
app.use(errorHandler);
export default app;
