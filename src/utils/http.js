export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function need(obj, fields) {
  for (const f of fields) {
    const v = obj[f];
    if (v === undefined || v === null || String(v).trim() === '') {
      throw new HttpError(400, `${f} is required`);
    }
  }
}
