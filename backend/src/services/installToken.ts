import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { DOWNLOAD_LINK_SECONDS } from './r2Storage.js';

function signature(id: string, expires: number): string {
  if (!config.accessPassword)
    throw new Error('Private install links require ACCESS_PASSWORD');
  return createHmac('sha256', config.accessPassword)
    .update(`r2-install:${id}:${expires}`)
    .digest('hex');
}

export function createInstallToken(id: string, now = Date.now()): string {
  const expires = Math.floor(now / 1000) + DOWNLOAD_LINK_SECONDS;
  return `${expires}.${signature(id, expires)}`;
}

export function verifyInstallToken(
  id: string,
  token: unknown,
  now = Date.now(),
): boolean {
  if (!config.accessPassword || typeof token !== 'string') return false;
  const match = /^(\d+)\.([a-f0-9]{64})$/.exec(token);
  if (!match || Number(match[1]) <= Math.floor(now / 1000)) return false;
  return timingSafeEqual(
    Buffer.from(match[2], 'hex'),
    Buffer.from(signature(id, Number(match[1])), 'hex'),
  );
}
