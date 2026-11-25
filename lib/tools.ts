/**
 * Domain tools for the agent: Amap POI search and QWeather current conditions.
 * Both degrade gracefully to curated local data when no key is configured, so
 * the full A2UI pipeline is testable locally. The `source` field tells the UI
 * whether a result came from a live API or the fallback.
 */

export interface Attraction {
  name: string;
  address: string;
  category: string;
  rating?: string;
}

export interface Weather {
  city: string;
  temp: string;
  text: string;
  wind: string;
  humidity: string;
  reportTime: string;
}

export interface ToolResult<T> {
  source: 'live' | 'demo';
  data: T;
  notice: string;
}

const DEMO_ATTRACTIONS: Record<string, Attraction[]> = {
  大理: [
    { name: '洱海生态廊道', address: '大理市洱海西岸', category: '自然风光', rating: '4.8' },
    { name: '大理古城', address: '大理市复兴路', category: '历史街区', rating: '4.7' },
    { name: '崇圣寺三塔', address: '大理市三塔路', category: '人文古迹', rating: '4.7' },
    { name: '喜洲古镇', address: '大理市喜洲镇', category: '古镇村落', rating: '4.6' },
  ],
  京都: [
    { name: '清水寺', address: '京都市东山区清水', category: '人文古迹', rating: '4.8' },
    { name: '伏见稻荷大社', address: '京都市伏见区深草', category: '人文古迹', rating: '4.8' },
    { name: '岚山竹林', address: '京都市右京区嵯峨', category: '自然风光', rating: '4.7' },
    { name: '金阁寺', address: '京都市北区金阁寺町', category: '人文古迹', rating: '4.7' },
  ],
  成都: [
    { name: '成都大熊猫繁育研究基地', address: '成都市成华区熊猫大道', category: '亲子景点', rating: '4.8' },
    { name: '宽窄巷子', address: '成都市青羊区宽窄巷子', category: '历史街区', rating: '4.6' },
    { name: '都江堰景区', address: '成都市都江堰市', category: '人文古迹', rating: '4.8' },
    { name: '武侯祠', address: '成都市武侯区武侯祠大街', category: '人文古迹', rating: '4.7' },
  ],
  三亚: [
    { name: '亚龙湾海滩', address: '三亚市吉阳区亚龙湾', category: '海滨度假', rating: '4.8' },
    { name: '蜈支洲岛', address: '三亚市海棠区后海', category: '海岛度假', rating: '4.7' },
    { name: '天涯海角', address: '三亚市天涯区天涯镇', category: '海滨度假', rating: '4.6' },
    { name: '大东海', address: '三亚市吉阳区大东海', category: '海滨度假', rating: '4.6' },
  ],
};

/** Fallback coordinates for common cities: GeoAPI lookup is not enabled on every key. */
export const CITY_COORDS: Record<string, string> = {
  北京: '116.40,39.90', 上海: '121.47,31.23', 广州: '113.26,23.13', 深圳: '114.06,22.54',
  成都: '104.07,30.67', 大理: '100.27,25.60', 京都: '135.77,35.01', 三亚: '109.51,18.25',
  杭州: '120.15,30.28', 西安: '108.94,34.34', 重庆: '106.55,29.56', 南京: '118.80,32.06',
  苏州: '120.58,31.30', 厦门: '118.09,24.48', 青岛: '120.38,36.07', 昆明: '102.83,24.88',
  丽江: '100.23,26.87', 桂林: '110.29,25.27', 长沙: '112.94,28.23', 武汉: '114.30,30.59',
};

const DEMO_WEATHER: Record<string, Weather> = {
  大理: { city: '大理', temp: '21', text: '多云', wind: '西南风 2级', humidity: '58', reportTime: '内置演示数据' },
  京都: { city: '京都', temp: '16', text: '晴', wind: '东北风 2级', humidity: '52', reportTime: '内置演示数据' },
  成都: { city: '成都', temp: '19', text: '阴', wind: '微风 1级', humidity: '72', reportTime: '内置演示数据' },
  三亚: { city: '三亚', temp: '28', text: '晴', wind: '东南风 3级', humidity: '68', reportTime: '内置演示数据' },
};

function demoAttractions(city: string): ToolResult<Attraction[]> {
  const key = Object.keys(DEMO_ATTRACTIONS).find(name => city.includes(name)) || '大理';
  return {
    source: 'demo',
    data: DEMO_ATTRACTIONS[key],
    notice: `未配置 AMAP_KEY，景点使用「${key}」内置演示数据`,
  };
}

function demoWeather(city: string): ToolResult<Weather> {
  const key = Object.keys(DEMO_WEATHER).find(name => city.includes(name)) || '大理';
  return {
    source: 'demo',
    data: DEMO_WEATHER[key],
    notice: `未配置 QWEATHER_KEY，天气使用「${key}」内置演示数据`,
  };
}

/** 高德地图 POI 文本搜索. */
export async function searchAttractions({ city, keyword }: { city: string; keyword?: string }): Promise<ToolResult<Attraction[]>> {
  const key = process.env.AMAP_KEY || '';
  if (!key) return demoAttractions(city);
  try {
    const params = new URLSearchParams({
      key,
      keywords: keyword || '风景名胜',
      types: '110000|120000|140000', // 风景名胜 / 公园广场 / 文化场馆，排除住宅区等噪声
      city,
      citylimit: 'true',
      offset: '20',
      page: '1',
      output: 'json',
      extensions: 'base',
    });
    const url = `https://restapi.amap.com/v3/place/text?${params}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const json = await response.json();
    if (json.status !== '1' || !Array.isArray(json.pois)) throw new Error(json.info || '高德返回异常');
    const blocked = /住宅|商务住宅|小区|停车场|加油站|银行|酒店|旅馆|餐饮|公司|工厂/;
    const data = json.pois
      .filter((poi: Record<string, string>) => !blocked.test(poi.name) && !blocked.test(String(poi.type || '')))
      .slice(0, 8)
      .map((poi: Record<string, string>) => ({
        name: poi.name,
        address: [poi.adname, poi.address].filter(Boolean).join(' ') || poi.name,
        category: String(poi.type || '').split(';').slice(0, 2).join('/') || '景点',
      }));
    if (!data.length) throw new Error('过滤后没有可用景点');
    return { source: 'live', data, notice: `高德地图实时查询「${city}」景点成功` };
  } catch (error) {
    const fallback = demoAttractions(city);
    return { ...fallback, notice: `高德查询失败（${error instanceof Error ? error.message : 'unknown'}），已降级为演示数据` };
  }
}

/** Resolve any Chinese city name to coordinates via Amap geocoding (fallback for cities not in CITY_COORDS). */
async function geocodeCity(city: string): Promise<string | null> {
  const key = process.env.AMAP_KEY || '';
  if (!key) return null;
  try {
    const params = new URLSearchParams({ key, address: city, output: 'json' });
    const response = await fetch(`https://restapi.amap.com/v3/geocode/geo?${params}`, {
      signal: AbortSignal.timeout(12_000),
    });
    const json = await response.json();
    const location = json.geocodes?.[0]?.location;
    return typeof location === 'string' && location.includes(',') ? location : null;
  } catch {
    return null;
  }
}

/** 和风天气实况。内置坐标优先，缺失时用高德地理编码动态解析，覆盖全国城市。 */
export async function getWeather({ city }: { city: string }): Promise<ToolResult<Weather>> {
  const key = process.env.QWEATHER_KEY || '';
  if (!key) return demoWeather(city);
  // QWeather assigns a per-account API Host (see console.qweather.com/setting).
  const host = (process.env.QWEATHER_HOST || 'api.qweather.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const name = Object.keys(CITY_COORDS).find(c => city.includes(c)) || city;
  let coords: string | undefined = CITY_COORDS[name];
  let resolvedVia = coords ? '内置坐标' : null;
  if (!coords) {
    coords = (await geocodeCity(city)) || undefined;
    if (coords) resolvedVia = '高德地理编码';
  }
  if (!coords) {
    const fallback = demoWeather(city);
    return { ...fallback, notice: `城市「${city}」坐标解析失败，使用演示天气数据` };
  }
  try {
    const nowParams = new URLSearchParams({ location: coords, key });
    const nowResponse = await fetch(`https://${host}/v7/weather/now?${nowParams}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const nowJson = await nowResponse.json();
    const now = nowJson.now;
    if (!now) throw new Error(nowJson.code ? `天气接口返回 ${nowJson.code}` : '天气接口无数据');

    return {
      source: 'live',
      data: {
        city: name,
        temp: `${now.temp}°C`,
        text: now.text,
        wind: `${now.windDir} ${now.windScale}级`,
        humidity: `${now.humidity}%`,
        reportTime: now.obsTime,
      },
      notice: `和风天气实时查询「${name}」成功（坐标：${resolvedVia}）`,
    };
  } catch (error) {
    const fallback = demoWeather(city);
    return { ...fallback, notice: `天气查询失败（${error instanceof Error ? error.message : 'unknown'}），已降级为演示数据` };
  }
}

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'searchAttractions',
      description: '查询某个城市的真实景点/POI 列表。当用户询问去某地玩什么、有什么景点、推荐行程时调用。',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名，例如 大理、京都、成都' },
          keyword: { type: 'string', description: '可选关键词，例如 古镇、亲子' },
        },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getWeather',
      description: '查询某个城市当前真实天气。当用户询问天气、温度、穿什么时调用。',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: '城市名，例如 大理' } },
        required: ['city'],
      },
    },
  },
];
