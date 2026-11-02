import { query } from '../config/db.js';

export const notFound = (_req, res) => res.status(404).json({ message: 'Route not found' });

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, _next) => {
  if (err.code === '23505') return res.status(409).json({ message: 'That record already exists (duplicate email, phone or name)' });
  if (err.code === '22P02') return res.status(400).json({ message: 'Invalid identifier supplied' });
  const status = err.status || 500;
  if (status >= 500) {
    console.error(`[API 500 Error] ${req.method} ${req.originalUrl || req.url}:`, err);
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
    query(
      `INSERT INTO api_error_logs(endpoint, method, status_code, error_message, stack_trace, user_id, ip_address)
       VALUES($1, $2, $3, $4, $5, $6, $7)`,
      [req.originalUrl || req.url, req.method, status, err.message, err.stack || '', req.user?.id || null, ip]
    ).catch(() => {});
  }
  const isDev = process.env.NODE_ENV !== 'production';
  res.status(status).json({
    message: status === 500 && !isDev ? 'Something went wrong on our side' : err.message,
    ...(isDev && status >= 500 ? { stack: err.stack } : {}),
    ...(err.extra || {})
  });
};
