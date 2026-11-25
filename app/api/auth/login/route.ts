import { NextResponse } from 'next/server';
import { startSession, verifyPassword } from '@/lib/auth';
import { getUserByEmail, initDb } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const { email, password } = await request.json() as { email?: string; password?: string };
    if (!email || !password) return NextResponse.json({ error: '请输入邮箱和密码' }, { status: 400 });
    await initDb();
    const user = await getUserByEmail(email.toLowerCase());
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return NextResponse.json({ error: '邮箱或密码不正确' }, { status: 401 });
    }
    await startSession(user.id);
    return NextResponse.json({ ok: true, user: { id: user.id, email: user.email } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '登录失败' }, { status: 500 });
  }
}
