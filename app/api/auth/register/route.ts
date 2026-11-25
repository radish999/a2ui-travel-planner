import { NextResponse } from 'next/server';
import { hashPassword, startSession } from '@/lib/auth';
import { createUser, getUserByEmail, initDb } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const { email, password } = await request.json() as { email?: string; password?: string };
    if (!email || !password || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) {
      return NextResponse.json({ error: '请输入有效邮箱和至少 8 位密码' }, { status: 400 });
    }
    await initDb();
    if (await getUserByEmail(email)) {
      return NextResponse.json({ error: '该邮箱已注册' }, { status: 409 });
    }
    const user = await createUser(email.toLowerCase(), hashPassword(password));
    await startSession(user.id);
    return NextResponse.json({ ok: true, user: { id: user.id, email: user.email } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '注册失败' }, { status: 500 });
  }
}
