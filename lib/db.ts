/**
 * Persistence: Vercel Postgres when POSTGRES_URL is set, otherwise a local
 * JSON file (.data/db.json) so the app is fully usable during development.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export interface SessionRecord {
  token: string;
  userId: string;
  expiresAt: string;
}

export interface TripRecord {
  id: string;
  userId: string;
  title: string;
  city: string;
  days: number;
  content: string;
  createdAt: string;
}

interface DbShape {
  users: UserRecord[];
  sessions: SessionRecord[];
  trips: TripRecord[];
}

const dataDir = path.join(process.cwd(), '.data');
const dataFile = path.join(dataDir, 'db.json');

function emptyDb(): DbShape {
  return { users: [], sessions: [], trips: [] };
}

function readLocal(): DbShape {
  try {
    if (!fs.existsSync(dataFile)) return emptyDb();
    return { ...emptyDb(), ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) };
  } catch {
    return emptyDb();
  }
}

function writeLocal(db: DbShape): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(db, null, 2));
}

export function hasPostgres(): boolean {
  return Boolean(process.env.POSTGRES_URL || process.env.DATABASE_URL);
}

async function pg() {
  const { sql } = await import('@vercel/postgres');
  return sql;
}

export async function initDb(): Promise<void> {
  if (!hasPostgres()) {
    if (!fs.existsSync(dataFile)) writeLocal(emptyDb());
    return;
  }
  const sql = await pg();
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS trips (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      city TEXT NOT NULL,
      days INTEGER NOT NULL DEFAULT 3,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS trips_user_idx ON trips(user_id)`;
}

export async function createUser(email: string, passwordHash: string): Promise<UserRecord> {
  const user: UserRecord = {
    id: crypto.randomUUID(),
    email,
    passwordHash,
    createdAt: new Date().toISOString(),
  };
  if (hasPostgres()) {
    const sql = await pg();
    await sql`INSERT INTO users (id, email, password_hash, created_at) VALUES (${user.id}, ${user.email}, ${user.passwordHash}, ${user.createdAt})`;
  } else {
    const db = readLocal();
    db.users.push(user);
    writeLocal(db);
  }
  return user;
}

export async function getUserByEmail(email: string): Promise<UserRecord | null> {
  if (hasPostgres()) {
    const sql = await pg();
    const result = await sql`SELECT id, email, password_hash AS "passwordHash", created_at AS "createdAt" FROM users WHERE email = ${email} LIMIT 1`;
    return (result.rows[0] as UserRecord) ?? null;
  }
  return readLocal().users.find(u => u.email === email) ?? null;
}

export async function getUserById(id: string): Promise<UserRecord | null> {
  if (hasPostgres()) {
    const sql = await pg();
    const result = await sql`SELECT id, email, created_at AS "createdAt" FROM users WHERE id = ${id} LIMIT 1`;
    return (result.rows[0] as UserRecord) ?? null;
  }
  return readLocal().users.find(u => u.id === id) ?? null;
}

export async function createSession(userId: string, days = 7): Promise<SessionRecord> {
  const session: SessionRecord = {
    token: crypto.randomBytes(32).toString('hex'),
    userId,
    expiresAt: new Date(Date.now() + days * 86400_000).toISOString(),
  };
  if (hasPostgres()) {
    const sql = await pg();
    await sql`INSERT INTO sessions (token, user_id, expires_at) VALUES (${session.token}, ${session.userId}, ${session.expiresAt})`;
  } else {
    const db = readLocal();
    db.sessions.push(session);
    writeLocal(db);
  }
  return session;
}

export async function getSession(token: string): Promise<SessionRecord | null> {
  if (hasPostgres()) {
    const sql = await pg();
    const result = await sql`SELECT token, user_id AS "userId", expires_at AS "expiresAt" FROM sessions WHERE token = ${token} LIMIT 1`;
    const row = result.rows[0] as SessionRecord | undefined;
    if (!row) return null;
    if (new Date(row.expiresAt).getTime() < Date.now()) return null;
    return row;
  }
  const session = readLocal().sessions.find(s => s.token === token);
  if (!session || new Date(session.expiresAt).getTime() < Date.now()) return null;
  return session;
}

export async function deleteSession(token: string): Promise<void> {
  if (hasPostgres()) {
    const sql = await pg();
    await sql`DELETE FROM sessions WHERE token = ${token}`;
  } else {
    const db = readLocal();
    db.sessions = db.sessions.filter(s => s.token !== token);
    writeLocal(db);
  }
}

export async function listTrips(userId: string): Promise<TripRecord[]> {
  if (hasPostgres()) {
    const sql = await pg();
    const result = await sql`SELECT id, user_id AS "userId", title, city, days, content, created_at AS "createdAt" FROM trips WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 50`;
    return result.rows as TripRecord[];
  }
  return readLocal().trips.filter(t => t.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
}

export async function insertTrip(trip: TripRecord): Promise<void> {
  if (hasPostgres()) {
    const sql = await pg();
    await sql`INSERT INTO trips (id, user_id, title, city, days, content, created_at) VALUES (${trip.id}, ${trip.userId}, ${trip.title}, ${trip.city}, ${trip.days}, ${trip.content}, ${trip.createdAt})`;
  } else {
    const db = readLocal();
    db.trips.push(trip);
    writeLocal(db);
  }
}

export async function deleteTrip(userId: string, tripId: string): Promise<boolean> {
  if (hasPostgres()) {
    const sql = await pg();
    const result = await sql`DELETE FROM trips WHERE id = ${tripId} AND user_id = ${userId}`;
    return (result.rowCount ?? 0) > 0;
  }
  const db = readLocal();
  const before = db.trips.length;
  db.trips = db.trips.filter(t => !(t.id === tripId && t.userId === userId));
  writeLocal(db);
  return db.trips.length < before;
}
