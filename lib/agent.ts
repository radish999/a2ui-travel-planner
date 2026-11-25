/**
 * The agent loop: tool-calling LLM + A2UI compilation.
 * Produces an ordered stream of events consumed by /api/chat.
 */

import { a2uiPromptSnippet, parseAnswer, type ParsedPart } from './a2ui';
import { callLlm, type ChatMessage } from './llm';
import { TOOL_DEFINITIONS, searchAttractions, getWeather, CITY_COORDS } from './tools';

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'a2ui'; messages: unknown[] }
  | { type: 'tool'; name: string; source: string; notice: string; data: unknown }
  | { type: 'notice'; message: string }
  | { type: 'error'; message: string }
  | { type: 'done'; mode: 'llm' | 'demo'; sources: string[] };

const SYSTEM_PROMPT = `你是一位专业的旅行规划助手。你的每一次回复都必须输出一个 A2UI 卡片，把答案渲染成原生交互卡片，而不是只输出文字。

最重要的规则（违反即为错误）：
- 卡片里的城市、景点名称、天气数值必须**逐字取自工具返回结果**。绝对禁止换成别的城市，绝对禁止编造工具没有返回的景点、天气或"数据源异常"之类的警告。
- 用户问哪个城市，就查哪个城市、写哪个城市。工具返回「大理」的景点和天气，卡片就必须写大理，不能写京都、北京或其他任何城市。
- **用户说的天数必须原样保留**：说"5日游"就写"5天行程"并分 5 天安排，说"一日游"就写"1天行程"。绝对不能把 5 天改成 1 天，或自作主张改成"一日推荐"之类的说法。
- 如果工具返回失败或数据为空，就如实说明，不要脑补内容。

一般规则：
1. 需要真实数据时调用工具：景点/玩什么/行程推荐 → searchAttractions；天气/温度/穿什么 → getWeather。必须基于工具返回的数据回答，并说明数据来源是真实还是演示。
2. 输出格式**只能是**下面这种 A2UI Express 语法，写在 <a2ui> 与 </a2ui> 标签内。不要输出 JSON，不要输出 Markdown 代码块，不要发明其他标签。示例：

<a2ui>
surface("trip")
root = Card(Column([
  Text("**大理 3 天行程**"),
  Text("天气：21°C 多云", variant="caption"),
  Divider(),
  Text("第 1 天：洱海骑行"),
  Button(Text("保存行程"), variant="primary", action=Event("save_trip", {title: "大理 3 天", city: "大理", days: 3}))
]))
</a2ui>

3. 可用组件只有：Card(child=...)、Column(children=[...])、Row(children=[...])、Text(text, variant="body"|"caption")、Divider()、Button(child, variant="primary"|"default"|"borderless", action=Event(...))。Text 支持简单 Markdown 如 **加粗**。
4. surface id 固定用 "trip"。卡片外不要输出大段文字。

${a2uiPromptSnippet()}`;

/** Deterministic fallback used when the model is unavailable or its output is rejected. */
function demoAnswer(surfaceId: string, message: string, toolResults: Record<string, unknown>): string {
  const attractions = (toolResults.searchAttractions as { data?: { name: string; category: string }[] } | undefined)?.data ?? [];
  const weather = (toolResults.getWeather as { data?: { city: string; temp: string; text: string } } | undefined)?.data;
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const rows = attractions.length
    ? attractions.slice(0, 6).map(a => `    Text("• ${esc(a.name)}（${esc(a.category)}）")`).join(',\n')
    : '    Text("未找到景点数据")';
  const weatherLine = weather ? `  Text("天气：${esc(weather.city)} ${esc(weather.temp)} ${esc(weather.text)}"),\n` : '';
  const sourceNote = Object.values(toolResults).some((r: unknown) => (r as { source?: string })?.source === 'demo')
    ? '部分数据为内置演示数据（未配置 API key）。'
    : '';

  return `已根据你的需求整理行程。${sourceNote}

<a2ui>
surface("${surfaceId}")
root = Card(Column([
  Text("**${esc(message.slice(0, 40))}**"),
  Text("这是一张通过 A2UI 生成的原生卡片。", variant="caption"),
${weatherLine}  Divider(),
  Text("**推荐景点**"),
${rows},
  Button(Text("保存行程"), variant="primary", action=Event("save_trip", {title: "${esc(message.slice(0, 20))}", city: "${esc(weather?.city || '大理')}", days: 3}))
]))
</a2ui>`;
}

/** Collect every literal Text string in an A2UI message batch. */
function collectTexts(messages: unknown[]): string {
  const out: string[] = [];
  for (const message of messages) {
    const batch = (message as { updateComponents?: { components?: unknown[] }; createSurface?: { components?: unknown[] } });
    const components = batch.updateComponents?.components ?? batch.createSurface?.components ?? [];
    for (const raw of components) {
      const component = raw as { text?: unknown; value?: unknown };
      if (typeof component.text === 'string') out.push(component.text);
      if (typeof component.value === 'string') out.push(component.value);
    }
  }
  return out.join(' | ');
}

/**
 * Guard against the model drifting to another city or inventing data.
 * If tool data exists and the answer mentions a *different* known city, or
 * mentions none of the tool-returned attraction names, reject it.
 */
function answerMatchesTools(
  parts: ParsedPart[],
  toolResults: Record<string, unknown>,
  requestedCity: string,
  expectedDays?: number,
): boolean {
  const attractions = (toolResults.searchAttractions as { data?: { name: string }[] } | undefined)?.data;
  const weather = (toolResults.getWeather as { data?: { city: string } } | undefined)?.data;
  if (!attractions?.length && !weather) return true; // no tool data to check against

  const text = collectTexts(parts.flatMap(part => Array.isArray(part.a2ui) ? part.a2ui : []));
  if (!text) return true;

  // A different well-known city appearing is a strong drift signal.
  for (const city of Object.keys(CITY_COORDS)) {
    if (city !== requestedCity && text.includes(city)) return false;
  }
  // The answer must mention the city that was actually queried (strip 市/区 suffix).
  const cityStem = requestedCity.replace(/[市区县]$/, '');
  if (!text.includes(cityStem)) return false;
  // When attractions were returned, require at least one of them verbatim.
  if (attractions?.length && !attractions.some(a => text.includes(a.name))) return false;
  // Trip length must match what the user asked ("5日游" must not become "一日推荐").
  if (expectedDays) {
    const cn: Record<number, string> = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七' };
    const patterns = [
      `${expectedDays}天`, `${expectedDays}日`,
      `第${expectedDays}天`, cn[expectedDays] ? `${cn[expectedDays]}天` : '',
    ].filter(Boolean);
    if (!patterns.some(p => text.includes(p))) return false;
    // A different day count in the answer is a drift signal too.
    for (let d = 1; d <= 7; d++) {
      if (d === expectedDays) continue;
      if (text.includes(`${d}天`) || text.includes(`${d}日游`)) return false;
    }
  }
  return true;
}

/** Parse trip length from both Arabic and Chinese numerals ("3天", "一日游", "两天"). */
function parseDays(message: string): number {
  const arabic = message.match(/(\d+)\s*[天日]/);
  if (arabic) return Math.min(Math.max(Number(arabic[1]), 1), 7);
  const cn: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 半: 1 };
  const match = message.match(/([一二两三四五六七])\s*[天日]/);
  if (match) return cn[match[1]] ?? 3;
  return 3;
}

/** Build a deterministic, good-looking A2UI card purely from the real tool results. */
function toolBackedAnswer(surfaceId: string, message: string, requestedCity: string, toolResults: Record<string, unknown>): string {
  const attractions = (toolResults.searchAttractions as { data?: { name: string; address: string; category: string }[] } | undefined)?.data ?? [];
  const weather = (toolResults.getWeather as { data?: { temp: string; text: string; wind: string; humidity: string; reportTime: string } } | undefined)?.data;
  const days = parseDays(message);
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const isLive = Object.values(toolResults).some((r: unknown) => (r as { source?: string })?.source === 'live');

  const lines: string[] = [
    `  Text("**${esc(requestedCity)} ${days} 天行程**"),`,
    weather
      ? `  Text("当前天气 ${esc(weather.temp)} · ${esc(weather.text)} · ${esc(weather.wind)} · 湿度 ${esc(weather.humidity)}", variant="caption"),`
      : '',
  ];
  // Distribute attractions evenly across ALL requested days (5 days => 5 sections),
  // e.g. 8 attractions / 5 days => 2,2,2,1,1 instead of 2,2,2,2,(none).
  let cursor = 0;
  for (let d = 0; d < days; d++) {
    const remainingDays = days - d;
    const remainingAttractions = attractions.length - cursor;
    const count = remainingDays > 0 ? Math.max(1, Math.ceil(remainingAttractions / remainingDays)) : 0;
    const slice = attractions.slice(cursor, cursor + count);
    cursor += slice.length;
    lines.push(`  Divider(),`);
    lines.push(`  Text("**第 ${d + 1} 天**"),`);
    if (slice.length) {
      for (const a of slice) lines.push(`  Text("• ${esc(a.name)}（${esc(a.address || a.category)}）"),`);
    } else {
      lines.push(`  Text("自由安排 / 周边探索", variant="caption"),`);
    }
  }
  lines.push(`  Divider(),`);
  lines.push(`  Text("数据来源：${isLive ? '高德地图 / 和风天气实时查询' : '内置演示数据'}", variant="caption"),`);
  lines.push(`  Button(Text("保存这份行程"), variant="primary", action=Event("save_trip", {title: "${esc(requestedCity)} ${days} 天行程", city: "${esc(requestedCity)}", days: ${days}}))`);

  return `<a2ui>\nsurface("${surfaceId}")\nroot = Card(Column([\n${lines.filter(Boolean).join('\n')}\n]))\n</a2ui>`;
}

function eventToYield(event: StreamEvent): StreamEvent {
  return event;
}

/** Run the full agent loop and yield SSE-ready events. */
export async function* runAgent(message: string, history: ChatMessage[]): AsyncGenerator<StreamEvent> {
  const surfaceId = `trip-${Date.now().toString(36)}`;
  const toolResults: Record<string, unknown> = {};
  const sources: string[] = [];
  // Prefer the city the tools were actually called with (authoritative), then known-list match.
  let requestedCity = Object.keys(CITY_COORDS).find(city => message.includes(city)) || '';
  let toolCity = '';

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-6),
    { role: 'user', content: message },
  ];

  let finalContent = '';
  let usedLlm = false;

  try {
    // Tool loop (at most 2 rounds).
    for (let round = 0; round < 2; round++) {
      const result = await callLlm(messages, TOOL_DEFINITIONS);
      usedLlm = true;
      if (!result.toolCalls.length) {
        finalContent = result.content;
        break;
      }
      messages.push({ role: 'assistant', content: result.content || '', tool_calls: result.toolCalls } as ChatMessage);
      for (const call of result.toolCalls) {
        const args = JSON.parse(call.function.arguments || '{}') as Record<string, string>;
        // The city passed to the tool is the ground truth for what the user asked about.
        if (args.city) toolCity = args.city;
        let toolResult: Record<string, unknown>;
        if (call.function.name === 'searchAttractions') {
          toolResult = { ...(await searchAttractions({ city: args.city || '大理', keyword: args.keyword })) };
        } else if (call.function.name === 'getWeather') {
          toolResult = { ...(await getWeather({ city: args.city || '大理' })) };
        } else {
          toolResult = { source: 'demo', data: null, notice: `未知工具 ${call.function.name}` };
        }
        toolResults[call.function.name] = toolResult;
        sources.push(`${call.function.name}:${(toolResult as { source: string }).source}`);
        yield eventToYield({
          type: 'tool',
          name: call.function.name,
          source: (toolResult as { source: string }).source,
          notice: (toolResult as { notice: string }).notice,
          data: (toolResult as { data: unknown }).data,
        });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify(toolResult),
        });
      }
    }
    if (!finalContent) {
      const last = await callLlm(messages);
      finalContent = last.content;
      if (last.toolCalls.length) finalContent = '';
    }
  } catch (error) {
    yield { type: 'notice', message: `模型调用失败，已切换到内置演示：${error instanceof Error ? error.message : String(error)}` };
    finalContent = '';
  }

  // Compile + validate through the official A2UI Agent SDK.
  let parts: ParsedPart[] = [];
  if (finalContent) {
    try {
      // Some DeepSeek builds emit a trailing DSML tool-call block after the answer;
      // strip it so it never leaks into the text part.
      const cleaned = finalContent.replace(/<｜｜DSML｜｜[\s\S]*?<\/｜｜DSML｜｜>/g, '').replace(/<｜｜DSML｜｜[\s\S]*$/g, '').trim();
      parts = parseAnswer(cleaned);
    } catch (error) {
      yield { type: 'notice', message: `A2UI 校验未通过，已使用备用卡片：${error instanceof Error ? error.message : String(error)}` };
      parts = [];
    }
  }
  // The city used in tool calls wins over any heuristic guess.
  const city = toolCity || requestedCity || '大理';

  // Consistency guard: never let a hallucinated city or invented data through.
  if (parts.length && !answerMatchesTools(parts, toolResults, city, parseDays(message))) {
    yield { type: 'notice', message: '模型输出与工具返回的地点不一致，已用实时工具数据重新生成卡片。' };
    parts = [];
  }
  if (!parts.length) {
    // Prefer a card built from real tool data; fall back to the generic demo only if there are no tools.
    const hasToolData = Boolean(toolResults.searchAttractions || toolResults.getWeather);
    parts = parseAnswer(hasToolData
      ? toolBackedAnswer(surfaceId, message, city, toolResults)
      : demoAnswer(surfaceId, message, toolResults));
    usedLlm = false;
  }

  for (const part of parts) {
    if (part.type === 'text' && part.text) {
      yield { type: 'text', text: part.text };
    } else if (part.type === 'a2ui' && Array.isArray(part.a2ui)) {
      yield { type: 'a2ui', messages: part.a2ui };
    }
  }
  yield { type: 'done', mode: usedLlm ? 'llm' : 'demo', sources };
}
