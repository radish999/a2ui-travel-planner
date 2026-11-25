import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { deleteTrip, initDb, insertTrip, listTrips } from '@/lib/db';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  await initDb();
  return NextResponse.json({ trips: await listTrips(user.id) });
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  const body = await request.json() as { title?: string; city?: string; days?: number; content?: string };
  const title = String(body.title || '未命名行程').slice(0, 120);
  if (!body.content) return NextResponse.json({ error: '缺少行程内容' }, { status: 400 });
  await initDb();
  const trip = {
    id: crypto.randomUUID(),
    userId: user.id,
    title,
    city: String(body.city || '').slice(0, 60),
    days: Math.min(Math.max(Number(body.days) || 1, 1), 60),
    content: String(body.content).slice(0, 200_000),
    createdAt: new Date().toISOString(),
  };
  await insertTrip(trip);
  return NextResponse.json({ ok: true, trip });
}

export async function DELETE(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: '缺少 id' }, { status: 400 });
  const removed = await deleteTrip(user.id, id);
  return NextResponse.json({ ok: removed });
}
