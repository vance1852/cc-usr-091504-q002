import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'crypto';

export function newId(): string {
  return randomUUID();
}

/** 通行凭证明文令牌：仅在签发时返回一次，库中只存 SHA-256 摘要。 */
export function newPassToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(plain, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(plain, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** 证件号脱敏：保留前 4 位与后 4 位。 */
export function maskIdNumber(idNumber: string): string {
  if (idNumber.length <= 8) return '****';
  return `${idNumber.slice(0, 4)}${'*'.repeat(idNumber.length - 8)}${idNumber.slice(-4)}`;
}
