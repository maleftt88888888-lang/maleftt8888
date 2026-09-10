// 坐标解析: 接受地图链接(苹果地图 / 高德 / 百度, 含短链), 抠出经纬度+名称。
// 高德为 GCJ-02; 苹果地图在中国大陆同为 GCJ-02。两者都转 WGS84 再喂给 wloc;
// gcj02ToWgs84 内含 out_of_china 判断, 境外坐标原样返回(无操作)。

export function safeDecode(s) {
  if (!s) return "";
  try {
    return decodeURIComponent(String(s).replace(/\+/g, " "));
  } catch (e) {
    return String(s);
  }
}

// 纬度绝对值 <= 90, 经度 <= 180; NaN / Infinity 一并挡掉。
export function inRange(lat, lon) {
  return (
    Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
  );
}

// 从一段字符串里提取经纬度+名称
export function extractFromString(s, opts) {
  const hit = extractRaw(s, opts);
  return hit && inRange(hit.lat, hit.lon) ? hit : null;
}

function extractRaw(s, opts) {
  if (!s) return null;
  const allowBare = !opts || opts.allowBare !== false;
  const str = String(s);
  let m;

  // 苹果地图 coordinate=/ll=/sll=纬度,经度
  m = str.match(/(?:^|[?&])(?:coordinate|ll|sll)=(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)/i);
  if (m) return { lat: +m[1], lon: +m[2], name: queryName(str), src: "apple" };

  // Google: !3d<lat>!4d<lon>
  m = str.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (m) return { lat: +m[1], lon: +m[2], name: googleName(str), src: "google" };

  // 高德 ?p=POIID,纬度,经度,名称,城市
  m = str.match(
    /[?&]p=[^,&%]*(?:,|%2C)(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)(?:(?:,|%2C)((?:(?!,|%2C|&).)+))?/i
  );
  if (m) return { lat: +m[1], lon: +m[2], name: m[3] ? safeDecode(m[3]) : "", src: "amap" };

  // 高德 ?q=纬度,经度,名称 (带有经纬度防倒置容错)
  m = str.match(
    /[?&]q=(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)(?:(?:,|%2C)((?:(?!,|%2C|&).)+))?/i
  );
  if (m) {
    let lat = +m[1], lon = +m[2];
    if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) [lat, lon] = [lon, lat];
    return { lat, lon, name: m[3] ? safeDecode(m[3]) : "", src: "amap" };
  }

  // 高德 URI API 的 lnglat= / position= 是「经度,纬度」序
  m = str.match(/(?:^|[?&])(?:lnglat|position)=(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)/i);
  if (m) return { lat: +m[2], lon: +m[1], name: queryName(str), src: "amap" };

  // 百度网页版路径 BD09MC 米制坐标: /poi/名称/@12709535.375,2529761.45,19z
  m = str.match(/baidu\.com\/[^\s]*?@(-?\d{6,9}(?:\.\d+)?)(?:,|%2C)(-?\d{6,9}(?:\.\d+)?)/i);
  if (m) {
    const bd = bd09mcToBd09(+m[1], +m[2]);
    if (bd) return { lat: bd.lat, lon: bd.lon, name: baiduPathName(str), src: "baidu" };
  }

  // Google 视口中心中心坐标
  m = str.match(/\/maps\/[^\s]*@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (m) return { lat: +m[1], lon: +m[2], name: googleName(str), src: "google" };

  // 纯裸坐标解析（兼容逗号、%2C 以及空格分隔）
  if (allowBare) {
    m = str.match(/(-?\d{1,3}\.\d{4,})\s*(?:,|%2C|\s)\s*(-?\d{1,3}\.\d{4,})/);
    if (m) {
      let lat = +m[1], lon = +m[2];
      // 容错处理：若误将经度当作纬度输入，自动修正
      if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) {
        [lat, lon] = [lon, lat];
      }
      return { lat, lon, name: "", src: "text" };
    }
  }
  return null;
}

function queryName(str) {
  const m = str.match(/[?&]name=([^&]+)/i);
  return m ? safeDecode(m[1]) : "";
}

function baiduPathName(str) {
  const m = str.match(/\/poi\/([^/@?]+)/);
  return m ? safeDecode(m[1]).trim() : "";
}

function googleName(str) {
  const m = str.match(/\/maps\/place\/([^/@?]+)/);
  return m ? safeDecode(m[1]).replace(/\+/g, " ").trim() : "";
}

const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 512 * 1024;

function isFetchable(u) {
  let url;
  try {
    url = new URL(u);
  } catch (e) {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const h = url.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false; // 拦截 IPv4 字面量地址防 SSRF
  return true;
}

async function readCapped(resp) {
  if (!resp.body || typeof resp.body.getReader !== "function") {
    return (await resp.text()).slice(0, MAX_BODY_BYTES);
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  try {
    await reader.cancel();
  } catch (e) {}
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

function isBaiduHost(u) {
  try {
    return /(^|\.)baidu\.com$/i.test(new URL(u).hostname);
  } catch (e) {
    return false;
  }
}

// 核心主函数（已增强：支持高德短链完整跳转追踪，并支持纯文本地名自动搜索兜底）
export async function parseCoords(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("缺少输入的解析内容");

  const urlMatch = text.match(/https?:\/\/[^\s'"<>]+/i);
  let target = urlMatch ? urlMatch[0] : text;

  // 1. 先尝试直接从输入文本/URL 中正则提取（针对长链接或直接复制的坐标）
  let hit = extractFromString(target);
  if (hit) return hit;

  // 2. 如果包含网络链接（如高德短链 surl.amap.com），使用 redirect: "follow" 自动追踪多级跳转
  if (urlMatch) {
    let cur = target;
    if (isFetchable(cur)) {
      let resp;
      try {
        resp = await fetch(cur, {
          method: "GET",
          redirect: "follow", // 关键修改：自动跟随所有跳转，直达最终页面
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: {
            "user-agent":
              "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/24A5370h Safari/604.1",
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "zh-CN,zh-Hans;q=0.9",
          },
        });
      } catch (e) {
        throw new Error("地图链接网络请求失败或超时，请检查链接是否有效");
      }

      // 优先从跳转后的最终 URL 中提取经纬度
      hit = extractFromString(resp.url);
      if (hit) return hit;

      // 检查头部 location
      const loc = resp.headers.get("location");
      if (loc) {
        hit = extractFromString(loc);
        if (hit) return hit;
      }

      // 读取网页正文提取
      try {
        const body = await readCapped(resp);
        hit = extractFromString(body, { allowBare: false });
        if (hit) return hit;

        if (isBaiduHost(resp.url) || isBaiduHost(cur)) {
          hit = extractBaiduFromBody(body);
          if (hit) return hit;
        }
      } catch (e) {}
    }
  } else {
    // 3. 如果既不是链接、也不是坐标，而是纯文本地名（如“台州市黄岩区高桥中心小学”），尝试通过后端搜索 API 兜底
    try {
      const searchRes = await fetch(`/api/search?q=${encodeURIComponent(text)}`);
      const result = await searchRes.json();
      if (result.success && result.data && result.data.length > 0) {
        const item = result.data[0];
        return {
          lat: parseFloat(item.lat),
          lon: parseFloat(item.lon),
          name: item.display_name ? item.display_name.split(',')[0] : text,
          src: "search"
        };
      }
    } catch (e) {}
  }

  // 4. 百度特定提示优化
  if (urlMatch && isBaiduHost(target)) {
    throw new Error(
      "该百度地图链接需浏览器脚本渲染后才能获取坐标。请在浏览器中打开该链接，待地址栏变为 map.baidu.com/poi/名称/@数字,数字 形式后，复制完整 URL 重新解析。"
    );
  }

  throw new Error("未能从提供的链接或文本中识别出有效的经纬度信息");
}

      const loc = resp.headers.get("location");
      if (loc) {
        hit = extractFromString(loc);
        if (hit) return hit;
        cur = new URL(loc, cur).toString();
        hit = extractFromString(cur);
        if (hit) return hit;
        continue;
      }

      hit = extractFromString(resp.url);
      if (hit) return hit;

      try {
        const body = await readCapped(resp);
        hit = extractFromString(body, { allowBare: false });
        if (hit) return hit;

        if (isBaiduHost(cur)) {
          hit = extractBaiduFromBody(body);
          if (hit) return hit;
        }
      } catch (e) {}
      break;
    }
  }

  // 3. 百度特定提示优化
  if (urlMatch && isBaiduHost(target)) {
    throw new Error(
      "该百度地图链接需浏览器脚本渲染后才能获取坐标。请在浏览器中打开该链接，待地址栏变为 map.baidu.com/poi/名称/@数字,数字 形式后，复制完整 URL 重新解析。"
    );
  }

  throw new Error("未能从提供的链接或文本中识别出有效的经纬度信息");
}

export function round6(n) {
  return Math.round(Number(n) * 1e6) / 1e6;
}

// ---- 百度: BD09MC(墨卡托米制) -> BD09(经纬度) ----
const MCBAND = [12890594.86, 8362377.87, 5591021, 3481989.83, 1678043.12, 0];
const MC2LL = [
  [1.410526172116255e-8, 8.98305509648872e-6, -1.9939833816331, 200.9824383106796, -187.2403703815547, 91.6087516669843, -23.38765649603339, 2.57121317296198, -0.03801003308653, 1.73379812e7],
  [-7.435856389565537e-9, 8.983055097726239e-6, -0.78625201886289, 96.32687599759846, -1.85204757529826, -59.36935905485877, 47.40033549296737, -16.50741931063887, 2.28786674699375, 1.026014486e7],
  [-3.030883460898826e-8, 8.98305509983578e-6, 0.30071316287616, 59.74293618442277, 7.357984074871, -25.38371002664745, 13.45380521110908, -3.29883767235584, 0.32710905363475, 6.85681737e6],
  [-1.981981304930552e-8, 8.983055099779535e-6, 0.03278182852591, 40.31678527705744, 0.65659298677277, -4.44255534477492, 0.85341911805263, 0.12923347998204, -0.04625736007561, 4.48277706e6],
  [3.09191371068437e-9, 8.983055096812155e-6, 6.995724062e-5, 23.10934304144901, -0.00023663490511, -0.6321817810242, -0.00663494467273, 0.03430082397953, -0.00466043876332, 2.5551644e6],
  [2.890871144776878e-9, 8.983055095805407e-6, -3.068298e-8, 7.47137025468032, -3.53937994e-6, -0.02145144861037, -1.234426596e-5, 0.00010322952773, -3.23890364e-6, 8.260885e5],
];

export function bd09mcToBd09(x, y) {
  const ax = Math.abs(x), ay = Math.abs(y);
  let f = null;
  for (let i = 0; i < MCBAND.length; i++) {
    if (ay >= MCBAND[i]) { f = MC2LL[i]; break; }
  }
  if (!f) return null;
  const c = ay / f[9];
  let lon = f[0] + f[1] * ax;
  let lat = f[2] + f[3] * c + f[4] * c ** 2 + f[5] * c ** 3 + f[6] * c ** 4 + f[7] * c ** 5 + f[8] * c ** 6;
  lon *= x < 0 ? -1 : 1;
  lat *= y < 0 ? -1 : 1;
  return { lat, lon };
}

// BD09 -> GCJ02
const X_PI = (Math.PI * 3000) / 180;
export function bd09ToGcj02(lat, lon) {
  const x = lon - 0.0065, y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
  const t = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
  return { lat: z * Math.sin(t), lon: z * Math.cos(t) };
}

// 港澳台坐标判定
const HK_POLY = [
  [113.8, 22.1],
  [113.8, 22.43],
  [113.9, 22.455],
  [113.98, 22.487],
  [114.05, 22.507],
  [114.11, 22.527],
  [114.17, 22.543],
  [114.24, 22.552],
  [114.32, 22.545],
  [114.5, 22.45],
  [114.5, 22.1],
];

function pointInPoly(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inMacau(lat, lon) {
  return lat >= 22.1 && lat <= 22.215 && lon >= 113.525 && lon <= 113.605;
}

function inTaiwan(lat, lon) {
  return lat >= 21.85 && lat <= 25.35 && lon >= 119.3 && lon <= 122.1;
}

export function usesWgs84Locally(lat, lon, src) {
  if (src !== "apple" && src !== "google") return false;
  return inMacau(lat, lon) || inTaiwan(lat, lon) || pointInPoly(lat, lon, HK_POLY);
}

export function toWgs84(lat, lon, src) {
  if (src === "baidu") {
    const g = bd09ToGcj02(lat, lon);
    return gcj02ToWgs84(g.lat, g.lon);
  }
  if (src === "amap" || src === "apple" || src === "google") {
    if (usesWgs84Locally(lat, lon, src)) return { lat, lon };
    return gcj02ToWgs84(lat, lon);
  }
  return { lat, lon };
}

// 百度页面正文提取：增加严格的 BD09MC 墨卡托坐标值域校验
export function extractBaiduFromBody(body) {
  const m = String(body).match(/"x"\s*:\s*"?(-?\d+(?:\.\d+)?)"?\s*,\s*"y"\s*:\s*"?(-?\d+(?:\.\d+)?)"?/);
  if (!m) return null;
  const x = +m[1], y = +m[2];

  // 严格值域校验：排除 1920x1080 像素、大数字 POI ID 等干扰项
  const absX = Math.abs(x), absY = Math.abs(y);
  if (absX < 7e6 || absX > 1.6e7 || absY < 1e6 || absY > 7e6) return null;

  const bd = bd09mcToBd09(x, y);
  if (!bd || !inRange(bd.lat, bd.lon)) return null;
  const nm = String(body).match(/<title>[^<]*?【([^】]{1,40})】/);
  return { lat: bd.lat, lon: bd.lon, name: nm ? nm[1] : "", src: "baidu" };
}

const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

function gcjOutOfChina(lng, la) {
  return lng < 72.004 || lng > 137.8347 || la < 0.8293 || la > 55.8271;
}

function gcjDeltaLat(x, y) {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  r += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return r;
}

function gcjDeltaLon(x, y) {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  r += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return r;
}

export function wgs84ToGcj02(lat, lon) {
  if (gcjOutOfChina(lon, lat)) return { lat, lon };
  let dLat = gcjDeltaLat(lon - 105.0, lat - 35.0);
  let dLon = gcjDeltaLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI);
  dLon = (dLon * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lon: lon + dLon };
}

export function gcj02ToWgs84(lat, lon) {
  if (gcjOutOfChina(lon, lat)) return { lat, lon };
  let wgsLat = lat;
  let wgsLon = lon;
  for (let i = 0; i < 6; i++) {
    const g = wgs84ToGcj02(wgsLat, wgsLon);
    const errLat = g.lat - lat;
    const errLon = g.lon - lon;
    if (Math.abs(errLat) < 1e-9 && Math.abs(errLon) < 1e-9) break;
    wgsLat -= errLat;
    wgsLon -= errLon;
  }
  return { lat: wgsLat, lon: wgsLon };
}
