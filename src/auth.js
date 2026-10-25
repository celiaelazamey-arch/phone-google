import { safeEqual } from './security.js';

export function requireApiToken(config) {
  return (req, res, next) => {
    const authorization = req.get('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (!match || !safeEqual(match[1], config.apiToken)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
}
