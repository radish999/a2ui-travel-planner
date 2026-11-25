import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { hasPostgres } from '@/lib/db';
import { llmReady } from '@/lib/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await currentUser();
  return NextResponse.json({
    user: user ? { id: user.id, email: user.email } : null,
    status: {
      llm: llmReady(),
      amap: Boolean(process.env.AMAP_KEY),
      qweather: Boolean(process.env.QWEATHER_KEY),
      database: hasPostgres(),
    },
  });
}
