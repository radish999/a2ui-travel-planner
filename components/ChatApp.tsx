'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageProcessor, peekValue, type ActionPayload } from '@a2ui/web_core';
import { basicCatalog } from '@a2ui/web_core/catalogs/basic/v1';
import type { ReactCatalogComponent } from '@a2ui/react';
import { SurfaceView, type SurfaceHost } from './SurfaceView';

interface User { id: string; email: string }
interface Status { llm: boolean; amap: boolean; qweather: boolean; database: boolean }
interface Trip { id: string; title: string; city: string; days: number; content: string; createdAt: string }
interface Turn {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  surfaceIds: string[];
  notices: string[];
  pending?: boolean;
}

const SUGGESTIONS = [
  '帮我安排大理 3 天，看看有什么景点和天气',
  '成都 4 天亲子游，推荐景点',
  '京都 2 天，天气怎么样？',
];

type Catalog = ConstructorParameters<typeof MessageProcessor<ReactCatalogComponent>>[0][number];

export default function ChatApp({ initialUser, status }: { initialUser: User | null; status: Status }) {
  const [user, setUser] = useState<User | null>(initialUser);
  const [authOpen, setAuthOpen] = useState(!initialUser);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);

  const host = useMemo<SurfaceHost>(() => {
    const processor = new MessageProcessor<ReactCatalogComponent>([basicCatalog as unknown as Catalog], (action: ActionPayload) => {
      actionRef.current?.(action);
    });
    let version = 0;
    const listeners = new Set<() => void>();
    const bump = () => { version++; listeners.forEach(listener => listener()); };
    processor.onSurfaceCreated(bump);
    processor.onSurfaceDeleted(bump);
    return {
      processor,
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      getVersion: () => version,
      getSurface: id => processor.getSurface(id),
    };
  }, []);

  const actionRef = useRef<((action: ActionPayload) => void) | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const turnsRef = useRef<Turn[]>([]);
  const [input, setInput] = useState('');
  const [trips, setTrips] = useState<Trip[]>([]);
  const [mode, setMode] = useState<'llm' | 'demo'>(status.llm ? 'llm' : 'demo');
  const turnCounter = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { turnsRef.current = turns; }, [turns]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turns]);
  useEffect(() => () => { host.processor.dispose(); }, [host]);

  const loadTrips = useCallback(async () => {
    const response = await fetch('/api/trips', { cache: 'no-store' });
    if (response.ok) {
      const data = await response.json();
      setTrips(data.trips || []);
    }
  }, []);

  useEffect(() => { if (user) void loadTrips(); }, [user, loadTrips]);

  const patchTurn = useCallback((id: number, patch: Partial<Turn>) => {
    setTurns(previous => previous.map(turn => (turn.id === id ? { ...turn, ...patch } : turn)));
  }, []);

  const applyMessages = useCallback((messages: unknown[], turnId: number, surfaceIds: string[]) => {
    for (const message of messages) {
      for (const error of host.processor.processMessagesWithErrors([message])) {
        console.warn('[a2ui] rejected:', error.error?.message);
      }
      const surfaceId = (message as { createSurface?: { surfaceId?: string }; updateComponents?: { surfaceId?: string } })
        ?.createSurface?.surfaceId
        ?? (message as { updateComponents?: { surfaceId?: string } })?.updateComponents?.surfaceId;
      if (surfaceId && !surfaceIds.includes(surfaceId)) surfaceIds.push(surfaceId);
    }
    patchTurn(turnId, { surfaceIds: [...surfaceIds] });
  }, [host, patchTurn]);

  const submitAuth = useCallback(async () => {
    setAuthBusy(true);
    setAuthError('');
    try {
      const response = await fetch(`/api/auth/${authMode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json();
      if (!response.ok) { setAuthError(data.error || '操作失败'); return; }
      setUser(data.user);
      setAuthOpen(false);
      setPassword('');
      await loadTrips();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '网络错误');
    } finally {
      setAuthBusy(false);
    }
  }, [authMode, email, password, loadTrips]);

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
    setTrips([]);
    setAuthOpen(true);
    setTurns([]);
  }, []);

  const saveTrip = useCallback(async (context: Record<string, unknown>) => {
    const surfaceIds = turnsRef.current.flatMap(turn => turn.surfaceIds);
    const latest = surfaceIds[surfaceIds.length - 1];
    const signal = latest ? host.processor.getSurface(latest)?.dataModel.getSignal<Record<string, unknown>>('/') : undefined;
    const dataModel = signal ? peekValue(signal) : undefined;
    const response = await fetch('/api/trips', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: String(context.title || '我的旅行计划'),
        city: String(context.city || ''),
        days: Number(context.days) || 3,
        content: JSON.stringify({ context, dataModel }),
      }),
    });
    if (response.ok) {
      await loadTrips();
      patchTurn(turnsRef.current.length, {});
    }
  }, [host, loadTrips]);

  useEffect(() => {
    actionRef.current = (action: ActionPayload) => {
      if (action.name === 'save_trip') void saveTrip(action.context);
    };
  }, [saveTrip]);

  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || turns.some(turn => turn.pending)) return;
    turnCounter.current += 1;
    const localTurn = turnCounter.current;
    const userId = Date.now() + localTurn;
    const assistantId = userId + 1;
    setInput('');

    const history = turnsRef.current
      .filter(turn => turn.text.trim())
      .map(turn => ({ role: turn.role, content: turn.text }));
    history.push({ role: 'user', content: text });

    setTurns(previous => [
      ...previous,
      { id: userId, role: 'user', text, surfaceIds: [], notices: [] },
      { id: assistantId, role: 'assistant', text: '', surfaceIds: [], notices: [], pending: true },
    ]);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text, history }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        patchTurn(assistantId, { notices: [error.error || `请求失败 (${response.status})`] });
        return;
      }
      if (!response.body) throw new Error('服务端没有返回数据流');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const surfaceIds: string[] = [];
      const handleChunk = (chunk: string) => {
        let event = 'message';
        let payload = '';
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          if (line.startsWith('data: ')) payload += line.slice(6);
        }
        if (!payload) return;
        const data = JSON.parse(payload);
        if (event === 'text') {
          setTurns(previous => previous.map(turn => turn.id === assistantId ? { ...turn, text: turn.text + data.text } : turn));
        } else if (event === 'a2ui') {
          applyMessages(data.messages, assistantId, surfaceIds);
        } else if (event === 'tool') {
          // Tool calls are internal plumbing — not shown to the user.
        } else if (event === 'error') {
          // Only real failures are shown to the user.
          patchTurn(assistantId, { notices: [...turnsRef.current.find(t => t.id === assistantId)?.notices || [], data.message] });
        } else if (event === 'done') {
          setMode(data.mode === 'llm' ? 'llm' : 'demo');
        }
        // 'notice' events are internal diagnostics — intentionally ignored.
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separator = buffer.indexOf('\n\n');
        while (separator >= 0) {
          handleChunk(buffer.slice(0, separator));
          buffer = buffer.slice(separator + 2);
          separator = buffer.indexOf('\n\n');
        }
      }
      if (buffer.trim()) handleChunk(buffer);
    } catch (error) {
      patchTurn(assistantId, { notices: [`请求失败：${error instanceof Error ? error.message : String(error)}`] });
    } finally {
      patchTurn(assistantId, { pending: false });
    }
  }, [turns, applyMessages, patchTurn]);

  const deleteTrip = useCallback(async (id: string) => {
    const response = await fetch(`/api/trips?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (response.ok) await loadTrips();
  }, [loadTrips]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">云</div>
          <div className="brand-copy"><strong>云上旅行</strong><span>A2UI 驱动的智能行程规划</span></div>
        </div>
        <div className="topbar-actions">
          {user ? (
            <>
              <button className="ghost-button" onClick={() => setTurns([])}>新建行程</button>
              <span className="user-email" title={user.email}>{user.email.split('@')[0]}</span>
              <button className="ghost-button" onClick={() => void logout()}>退出</button>
            </>
          ) : (
            <button className="primary-button" onClick={() => setAuthOpen(true)}>登录 / 注册</button>
          )}
        </div>
      </header>

      <div className="workspace">
        <main className="chat-panel">
          <div className="chat-scroll">
            {turns.length === 0 && (
              <section className="welcome">
                <div className="welcome-icon">✦</div>
                <h2>一句话，生成可交互的旅行卡片</h2>
                <p>Agent 会调用高德地图和和风天气获取真实数据，再用 A2UI 把结果渲染成原生卡片。你可以直接在卡片里保存行程。</p>
                <div className="suggestions">
                  {SUGGESTIONS.map(s => <button key={s} className="suggestion" onClick={() => void send(s)}>{s}</button>)}
                </div>
              </section>
            )}

            {turns.map(turn => (
              <div key={turn.id} className={`message-row ${turn.role}`}>
                {turn.role === 'assistant' && <div className="bot-avatar">云</div>}
                <div className="message-body">
                  {turn.text && <div className="message-text">{turn.text}</div>}
                  {turn.notices.map((notice, index) => (
                    <div key={index} className="notice error">{notice}</div>
                  ))}
                  {turn.surfaceIds.map(surfaceId => (
                    <SurfaceView key={surfaceId} host={host} surfaceId={surfaceId} />
                  ))}
                  {turn.pending && <div className="typing"><i /><i /><i /></div>}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          <form className="composer" onSubmit={event => { event.preventDefault(); void send(input); }}>
            <input value={input} onChange={event => setInput(event.target.value)} placeholder="例如：帮我安排大理 3 天，看看景点和天气" disabled={!user || turns.some(t => t.pending)} />
            <button type="submit" disabled={!user || !input.trim() || turns.some(t => t.pending)}>发送</button>
          </form>
        </main>

        <aside className="sidebar">
          <div className="side-section trips">
            <div className="side-title"><span>我的行程</span><span className="side-count">{trips.length}</span></div>
            {trips.length === 0 ? (
              <div className="empty-note">{user ? '还没有保存的行程。在交互卡片里点「保存行程」即可。' : '登录后可查看云端保存的行程。'}</div>
            ) : (
              <ul className="trip-list">
                {trips.map(trip => (
                  <li key={trip.id} className="trip-item">
                    <strong>{trip.title}</strong>
                    <p>{trip.city || '未指定城市'} · {trip.days} 天 · {new Date(trip.createdAt).toLocaleDateString('zh-CN')}</p>
                    <button onClick={() => void deleteTrip(trip.id)}>删除</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>

      {authOpen && (
        <div className="modal-backdrop" onClick={() => { if (user) setAuthOpen(false); }}>
          <div className="auth-modal" onClick={event => event.stopPropagation()}>
            <h2>{authMode === 'login' ? '登录' : '创建账号'}</h2>
            <p>行程会按账号隔离保存，只有你自己能访问。</p>
            <label>邮箱<input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" /></label>
            <label>密码<input type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder="至少 8 位" onKeyDown={event => { if (event.key === 'Enter') void submitAuth(); }} /></label>
            {authError && <div className="auth-error">{authError}</div>}
            <button className="auth-submit" disabled={authBusy} onClick={() => void submitAuth()}>{authBusy ? '请稍候…' : authMode === 'login' ? '登录' : '注册并登录'}</button>
            <button className="auth-switch" onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setAuthError(''); }}>
              {authMode === 'login' ? '还没有账号？点此注册' : '已有账号？点此登录'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
