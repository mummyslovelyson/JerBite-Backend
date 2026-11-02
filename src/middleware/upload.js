import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { HttpError } from '../utils/http.js';

const dest = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../uploads');
export const upload = multer({
  storage: multer.diskStorage({
    destination: dest,
    filename: (_r, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_r, file, cb) =>
    /^image\/(png|jpe?g|webp)$/.test(file.mimetype) ? cb(null, true) : cb(new HttpError(400, 'Only PNG, JPG or WEBP images are allowed'))
});
export const fileUrl = (f) => (f ? `/uploads/${f.filename}` : undefined);
