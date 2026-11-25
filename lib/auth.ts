/** Email + password auth using scrypt and an httpOnly session cookie. */
import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { createSession, deleteSession, getSession, getUserById, type UserRecord } from './db';

export const COOKIE_NAME = 'a2ui_session';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

export async function startSession(userId: string): Promise<string> {
  const session = await createSession(userId);
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, session.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 86400,
  });
  return session.token;
}

export async function endSession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (token) await deleteSession(token);
  cookieStore.delete(COOKIE_NAME);
}

export async function currentUser(): Promise<UserRecord | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;
  const session = await getSession(token);
  if (!session) return null;
  return getUserById(session.userId);
}
