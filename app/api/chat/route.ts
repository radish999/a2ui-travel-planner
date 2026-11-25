import { currentUser } from '@/lib/auth';
import { runAgent } from '@/lib/agent';
import type { ChatMessage } from '@/lib/llm';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });

  let body: { message?: string; history?: ChatMessage[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求格式不正确' }, { status: 400 });
  }
  const message = String(body.message || '').trim().slice(0, 2000);
  if (!message) return NextResponse.json({ error: '请输入内容' }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        for await (const item of runAgent(message, Array.isArray(body.history) ? body.history : [])) {
          send(item.type, item);
        }
      } catch (error) {
        send('error', { message: error instanceof Error ? error.message : '服务异常' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
