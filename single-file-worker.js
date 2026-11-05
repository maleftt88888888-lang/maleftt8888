/**
 * iOS Location Spoofer — stateless picker, single-file Cloudflare Worker (AUTO-GENERATED).
 * DO NOT EDIT BY HAND. Source of truth: worker/src/*. Regenerate:
 *   cd worker && node scripts/build-single.mjs
 * Mirrors the Hono build (src/index.js) exactly: landing + /picker + /api/parse +
 * PWA manifest/icons + self-hosted module scripts & manifests. Stateless.
 */

/* ---- minimal Hono shim (so this single-file mirrors src/index.js one-to-one) ---- */
class Hono {
  constructor() { this._routes = []; this._err = null; }
  get(p, h) { this._routes.push(["GET", p, h]); return this; }
  post(p, h) { this._routes.push(["POST", p, h]); return this; }
  onError(fn) { this._err = fn; }
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const c = {
      env, executionCtx: ctx,
      req: {
        url: request.url,
        method: request.method,
        query: (k) => url.searchParams.get(k),
        header: (k) => request.headers.get(k),
        json: () => request.json(),
        raw: request,
      },
      _h: {},
      header(k, v) { this._h[k] = v; },
      html(s) { return new Response(s, { headers: { "Content-Type": "text/html;charset=utf-8", ...this._h } }); },
      json(o, status) { return new Response(JSON.stringify(o), { status: status || 200, headers: { "Content-Type": "application/json", ...this._h } }); },
      text(s, status) { return new Response(s, { status: status || 200, headers: { "Content-Type": "text/plain; charset=utf-8", ...this._h } }); },
      body(b, status, headers) { return new Response(b, { status: status || 200, headers: { ...this._h, ...(headers || {}) } }); },
    };
    try {
      for (const [m, p, h] of this._routes) { if (m === request.method && url.pathname === p) return await h(c); }
      return new Response("Not found", { status: 404 });
    } catch (e) { if (this._err) return this._err(e, c); throw e; }
  }
}

/* ==== inlined from src/parse.js ==== */

// 坐标解析: 接受地图链接(苹果地图 / 高德 / 百度, 含短链), 抠出经纬度+名称。
// 高德为 GCJ-02; 苹果地图在中国大陆同为 GCJ-02。两者都转 WGS84 再喂给 wloc;
// gcj02ToWgs84 内含 out_of_china 判断, 境外坐标原样返回(无操作)。
//
// 本文件与上游 Yu9191/wloc v1.1 (worker/src/parse.js) 保持同步：inRange 值域校验、
// 高德 position=/lnglat= 经纬度反序、港澳台(苹果/Google 直发 WGS84 不做 GCJ 反算)、
// 百度 BD09MC 正文解析、以及 fetch 的 SSRF/资源上限加固。

function safeDecode(s) {
  if (!s) return "";
  try {
    return decodeURIComponent(String(s).replace(/\+/g, " "));
  } catch (e) {
    return String(s);
  }
}

// 从一段字符串里提取经纬度+名称。兼容:
//  苹果地图 coordinate=/ll=/sll=纬度,经度  (名称在 name=...)
//  高德 ?p=POIID,纬度,经度,名称,城市  (逗号或 %2C)
//  高德 ?q=纬度,经度,名称           (新版分享链, 逗号或 %2C)
//  纯文本 纬度,经度
//  高德 URI ?lnglat=/?position=经度,纬度  (与上面几条顺序相反)
//  高德移动端拆分参数 lng=经度&lat=纬度 (surl.amap.com 重定向后常见)
// opts.allowBare=false 时不启用"两个裸小数"兜底。扫描页面正文必须关掉它:
// 正文里任何一对小数都会命中(百度页面的 "view_dir":"-0.8477,0.0000" 就是如此),
// 结果是静默返回一个错误坐标 —— 比解析失败危险得多。
function extractFromString(s, opts) {
  const hit = extractRaw(s, opts);
  // 值域是最后一道闸。上面的兜底规则不带语义, 匹配到什么就返回什么, 经纬颠倒
  // (lat=113.9)或纯粹的垃圾数字都能一路走到调用方。这里拦掉的是"解析成了错的",
  // 它比"解析失败"危险得多 —— 后者会提示用户, 前者会把设备定位挪到别处。
  return hit && inRange(hit.lat, hit.lon) ? hit : null;
}

// 纬度绝对值 <= 90, 经度 <= 180; NaN / Infinity 一并挡掉。
function inRange(lat, lon) {
  return (
    Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
  );
}

function extractRaw(s, opts) {
  if (!s) return null;
  const allowBare = !opts || opts.allowBare !== false;
  const str = String(s);
  let m;

  // 前缀 (?:^|[?&]) 是必需的: 无锚定时 "ll=" 会匹配任何以 ll 结尾的参数名,
  // 例如 scroll=1.5,2.5 / pull=... 都会被当成坐标。
  m = str.match(/(?:^|[?&])(?:coordinate|ll|sll)=(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)/i);
  if (m) return { lat: +m[1], lon: +m[2], name: queryName(str), src: "apple" };

  // Google: !3d<lat>!4d<lon> 是地点针脚的真实坐标, 必须优先于 @lat,lon —— 后者是
  // 相机视口中心, 与缩放级别绑定, 可以离目标十几公里。
  m = str.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (m) return { lat: +m[1], lon: +m[2], name: googleName(str), src: "google" };

  m = str.match(
    /[?&]p=[^,&%]*(?:,|%2C)(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)(?:(?:,|%2C)((?:(?!,|%2C|&).)+))?/i
  );
  if (m) return { lat: +m[1], lon: +m[2], name: m[3] ? safeDecode(m[3]) : "", src: "amap" };

  m = str.match(
    /[?&]q=(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)(?:(?:,|%2C|&sname=)([^&]+))?/i
  );
  if (m) return { lat: +m[1], lon: +m[2], name: m[3] ? safeDecode(m[3]) : queryName(str), src: "amap" };

  // 高德 URI API 的 lnglat= / position= 是「经度,纬度」序, 与上面所有规则相反。
  // 不要照搬旧页面里的 location=/center= 规则: 那条也按 lon,lat 解, 但百度的
  // location= 实际是 lat,lng, 搬过来会把百度链接解颠倒。宁可少认一种也不要认错。
  m = str.match(/(?:^|[?&])(?:lnglat|position)=(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)/i);
  if (m) return { lat: +m[2], lon: +m[1], name: queryName(str), src: "amap" };

  // 高德移动端/短链重定向独立参数: lng=经度&lat=纬度 或 lat=纬度&lng=经度
  const lngM = str.match(/[?&](?:lng|longitude)=(-?\d{1,3}\.\d+)/i);
  const latM = str.match(/[?&](?:lat|latitude)=(-?\d{1,3}\.\d+)/i);
  if (lngM && latM) {
    return {
      lat: +latM[1],
      lon: +lngM[1],
      name: queryName(str),
      src: "amap"
    };
  }

  // 百度网页版把 BD09MC 米制坐标写进路径: /poi/名称/@12709535.375,2529761.45,19z
  // 位数(6~9)本身就把它和经纬度形式的 @ 区分开了。
  // 这是港澳台百度链接在服务端唯一能拿到坐标的形式 —— 那些地区的分享短链展开后
  // 正文里没有坐标, 得由页面脚本带反爬令牌去查 detailConInfo, Worker 复现不了。
  m = str.match(/baidu\.com\/[^\s]*?@(-?\d{6,9}(?:\.\d+)?)(?:,|%2C)(-?\d{6,9}(?:\.\d+)?)/i);
  if (m) {
    const bd = bd09mcToBd09(+m[1], +m[2]);
    if (bd) return { lat: bd.lat, lon: bd.lon, name: baiduPathName(str), src: "baidu" };
  }

  // 只有在没有针脚坐标时才退而求其次用视口中心。
  m = str.match(/\/maps\/[^\s]*@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (m) return { lat: +m[1], lon: +m[2], name: googleName(str), src: "google" };

  if (allowBare) {
    m = str.match(/(-?\d{1,3}\.\d{4,})\s*(?:,|%2C)\s*(-?\d{1,3}\.\d{4,})/);
    if (m) return { lat: +m[1], lon: +m[2], name: "", src: "text" };
  }

  return null;
}

// 查询串里的 ?name=/ &name=/ &sname=/ &keywords= —— 兼容苹果、高德多种参数
function queryName(str) {
  const m = str.match(/[?&](?:name|sname|keywords)=([^&]+)/i);
  return m ? safeDecode(m[1]) : "";
}

// 百度网页版的地名在路径里: /poi/Apple台北101/@...
function baiduPathName(str) {
  const m = str.match(/\/poi\/([^/@?]+)/);
  return m ? safeDecode(m[1]).trim() : "";
}

// Google 的地名在路径里: /maps/place/Apple+Park/@...
function googleName(str) {
  const m = str.match(/\/maps\/place\/([^/@?]+)/);
  return m ? safeDecode(m[1]).replace(/\+/g, " ").trim() : "";
}

// /api/parse 会去 fetch 调用方给的任意 URL。Workers 出网到不了内网, 所以经典的
// SSRF(打内网/元数据服务)基本不成立, 剩下的风险是资源耗尽 —— 一个永不结束的响应
// 能把子请求挂死, 一个几百 MB 的响应能把 128 MB 的 Worker 内存打爆。下面两个常量
// 和 isFetchable() 挡的就是这个, 而不是"防止访问某些站点"。
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
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith("[")) return false; // IP 字面量
  return true;
}

// 只读前 MAX_BODY_BYTES, 读满就掐掉连接。坐标总在页面靠前的位置, 读全文没有收益。
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

// 接受原文(可能含中文地名+链接), 抠出 URL, 必要时跟随重定向展开短链, 提取坐标。
async function parseCoords(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("空输入");

  const urlMatch = text.match(/https?:\/\/[^\s'"<>]+/i);
  let target = urlMatch ? urlMatch[0] : text;

  let hit = extractFromString(target);
  if (hit) return hit;

  if (urlMatch) {
    let cur = target;
    for (let i = 0; i < 5; i++) {
      if (!isFetchable(cur)) break;
      let resp;
      try {
        resp = await fetch(cur, {
          redirect: "manual",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: {
            "user-agent":
              "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/24A5370h Safari/604.1",
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "zh-CN,zh-Hans;q=0.9",
          },
        });
      } catch (e) {
        break;
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
        // 百度分享链展开后 URL 里只有 uid, 坐标以 BD09MC 墨卡托米制藏在正文中。
        if (isBaiduHost(cur)) {
          hit = extractBaiduFromBody(body);
          if (hit) return hit;
        }
      } catch (e) {}
      break;
    }
  }
  // 百度对大陆 POI 会把坐标直出在移动版页面里, 港澳台的则不会 —— 那边要靠页面
  // 脚本带 auth/seckey 反爬令牌去查 detailConInfo, 服务端无法复现。与其只说一句
  // "解析不了", 不如告诉用户那条确实走得通的路。
  if (urlMatch && isBaiduHost(target)) {
    throw new Error(
      "百度这条链接的坐标要靠网页脚本才能取到(港澳台的 POI 多为此类)。" +
        "请在浏览器打开该链接, 等地址栏变成 map.baidu.com/poi/名称/@数字,数字,19z 之后, 复制整条地址再粘贴。"
    );
  }
  throw new Error("未能从链接中解析出经纬度");
}

function round6(n) {
  return Math.round(Number(n) * 1e6) / 1e6;
}

// ---- 百度: BD09MC(墨卡托米制) -> BD09(经纬度) ----
// 百度用的不是标准 Web 墨卡托, 而是按纬度分 6 段的高次多项式拟合。
// 用标准墨卡托逆算会差约 10 公里, 必须用下面这张系数表。
const MCBAND = [12890594.86, 8362377.87, 5591021, 3481989.83, 1678043.12, 0];
const MC2LL = [
  [1.410526172116255e-8, 8.98305509648872e-6, -1.9939833816331, 200.9824383106796, -187.2403703815547, 91.6087516669843, -23.38765649603339, 2.57121317296198, -0.03801003308653, 1.73379812e7],
  [-7.435856389565537e-9, 8.983055097726239e-6, -0.78625201886289, 96.32687599759846, -1.85204757529826, -59.36935905485877, 47.40033549296737, -16.50741931063887, 2.28786674699375, 1.026014486e7],
  [-3.030883460898826e-8, 8.98305509983578e-6, 0.30071316287616, 59.74293618442277, 7.357984074871, -25.38371002664745, 13.45380521110908, -3.29883767235584, 0.32710905363475, 6.85681737e6],
  [-1.981981304930552e-8, 8.983055099779535e-6, 0.03278182852591, 40.31678527705744, 0.65659298677277, -4.44255534477492, 0.85341911805263, 0.12923347998204, -0.04625736007561, 4.48277706e6],
  [3.09191371068437e-9, 8.983055096812155e-6, 6.995724062e-5, 23.10934304144901, -0.00023663490511, -0.6321817810242, -0.00663494467273, 0.03430082397953, -0.00466043876332, 2.5551644e6],
  [2.890871144776878e-9, 8.983055095805407e-6, -3.068298e-8, 7.47137025468032, -3.53937994e-6, -0.02145144861037, -1.234426596e-5, 0.00010322952773, -3.23890364e-6, 8.260885e5],
];

function bd09mcToBd09(x, y) {
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

// BD09 -> GCJ02 (百度在 GCJ 之上再加了一层自有偏移)
const X_PI = (Math.PI * 3000) / 180;
function bd09ToGcj02(lat, lon) {
  const x = lon - 0.0065, y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
  const t = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
  return { lat: z * Math.sin(t), lon: z * Math.cos(t) };
}

// ---- 港澳台: 苹果/Google 在这三地发的是 WGS84 ----
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

function usesWgs84Locally(lat, lon, src) {
  if (src !== "apple" && src !== "google") return false;
  return inMacau(lat, lon) || inTaiwan(lat, lon) || pointInPoly(lat, lon, HK_POLY);
}

function toWgs84(lat, lon, src) {
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

function extractBaiduFromBody(body) {
  const m = String(body).match(/"x"\s*:\s*"?(-?\d+(?:\.\d+)?)"?\s*,\s*"y"\s*:\s*"?(-?\d+(?:\.\d+)?)"?/);
  if (!m) return null;
  const x = +m[1], y = +m[2];
  if (!(Math.abs(x) > 1e5 && Math.abs(y) > 1e5)) return null;
  const bd = bd09mcToBd09(x, y);
  if (!bd || Math.abs(bd.lat) > 90 || Math.abs(bd.lon) > 180) return null;
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

function wgs84ToGcj02(lat, lon) {
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

function gcj02ToWgs84(lat, lon) {
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

/* ==== inlined from src/icons.js ==== */

// Auto-generated PWA app icons. Regenerate with scripts/gen_icons.py.
// Blue square + white location pin; apple-touch-icon (180) and web manifest (512).
const ICON_180_B64 = "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";
const ICON_512_B64 = "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6AAA0wklEQVR42u3debjdVXno8e9v733mk/mEgCCzoAyxiKVVsdUqDtVWRQq2Vzton9v2aeu99rm99yoUB5QgUofrUJBarRW1VkUDhJAECKgEZA4QIAlzmDKek+TMe7h/vPvH3hkIGc609+/7eR7upeFBzv6d9dvrXe9a77uS+ZdXKkiSpEzJ+QgkSTIAkCRJBgCSJMkAQJIkNYUCHgGUJMkMgCRJykAGwASAJElmACRJkgGAJEkyAJAkSQYAkiTJAECSJBkASJIkAwBJkoSdACVJkhkASZJkACBJkgwAJEmSAYAkSTIAkCRJBgCSJAmvA5YkSWYAJEmSjYAkSTIDIEmSDAAkSZIBgCRJMgCQJEkGAJIkyQBAkiQZAEiSJAMASZJkACBJkrAToCRJMgMgSZK8DVCSJJkBkCRJBgCSJMkAQJIkGQBIkiQDAEmSDAAkSZIBgCRJwk6AkiTJDIAkSTIAkCRJBgCSJMkAQJIkGQBIkiS8DVCSJJkBkCRJBgCSJAkbAUmSJDMAkiTJAECSJBkASJIkAwBJkmQAIEmSAYAkSTIAkCRJBgCSJMkAQJIkYSdASZLkbYCSJAm3ACRJkgGAJEkyAJAkSQYAkiTJAECSJBkASJIkAwBJkmQAIEmSsBOgJEkyAyBJkgwAJEkyAJAkSQYAkiQJbwOUJElmACRJkgGAJEkyAJAkSdgISJIkmQGQJEkGAJIkyQBAkiQZAEiSJAMASZJkACBJkgwAJEmSAYAkSTIAkCRJ2AlQkiSvA5YkSbgFIEmSDAAkSZIBgCRJMgCQJEkGAJIkyQBAkiQxlfoASGoKSbJTVJ9AUvfPy3tZ85ur+5cqL/w/UE7/zNphyQBA0iRM9NXJPqmbpMsVKJagVIGRYvzzYnnHybo1z44Rwe5UYKS0Y1BRyMX/TmsB8gnkcxEk1P/3KxXsKSbZCVDSWE72uSQm4kolJvjhEoyWYoJPkpiU2wswox26W+HIWVAqwwkHwbTWWLm35GD+wVBIYqJOdp33SYBiBVY+B6PlyCRsG4FV62PSf3wLbB+BviHoL8bPUqlEgNCSjwAjX/ezlg0KJDMAkvY+jZ+r/v/l6mp8uBgTcj6BaW1wxEw4bDoc1xN/f+zs+PPDZ0BbIYKBA/GGw3f/50PF+Fme7INtw7B2MzzRC6s3wrqt8Ow26B2KwKAlFz9Laz4CmEolAhG3D6Qp9H1z/Jd9JaXJVL/Cr5/w2/IwrxtOPChW76+aC8fOgUOnQ8ceJvl0r3/ntHyS7N3PU/+NkNSfLdjDvz9YhKe3wtpN8OCGyCI8sB6e3x4Zi/qAoD5DIMkAQMrcpJ9LYrU8NBqTfiEPB3fHRP/aQ+OvE+ZGan93k/wLb251Pz7ZzcG/sVSp/j+VnQ4HJsnug4O+IVi1Ae54Ov56cAM8tz3OKrQVoL0lshplgwHJAEBq+vR+dcIbrE76HS1w3JxY4b/9WDj1UJjZvutkX67UHf4bx0n+QIKDSqWWdcjtJijoHYI7n4br1kaGYPWmeA5thXgO6bPxG0maoO+k4wwApHGVT2p76IPF2KM/bg686Sh427HwGwfHIbtdJvy68wCNqH7ff+eAoFSGe56DJWth+WMRDAwVY2sjPcNQ8ptJMgCQGnW1X6nEgblyJU7nv/koOPOEXSf9dLLLTcHV/VhmCdJUf343wcBPV8GNj0W1Qa564DExKyAZAEiNMvHnk1jNDozGobffOTIm/TOOiTK9+olvqqb0J3LLoD4Q2j4CSx+JYODmx+NQZGdLZAVKBgKSAYDEFD3UN1SMSezwGZHeP/MEOPVlO670k5c4UZ9Fac+A+szAnc9EILBkbZQedrdGIOChQWmsAoAvGQBIB1rCNzASk//LZ8J/ezV88NXQ01m3F16BXC57K/392iYo154rwMYB+N69cMW98FRvBAGdrZYSSgYA0iR16MvnIs0/VIw9/T89Bc44tjbxu9of26zAxgFYuha+e3ecGWgvxPZAqWzHQckAQJoA+Vz02986DCfPg78+Dd77qmiHm+7t169gNQbVBHVnBUZL8LMH4dJfw33Pw/S2uKegVPZZSQYA0jiV85UqMfEfNj1S/R85NU6rO/FPfCCwbRi+dWdsDazbGoFA+juSZAAgMRb7/OmE09ECH/wN+LvfgjmdtYm//iS7xl/9M980AF+7Db53TzQWSgMyzwdIBgDSfivkql37StGp7+O/C6+YU7fi92DfpB8YTAOBNZtgwU3RabAtH8Fa0W0ByQBA2tdVfwXoHYwb9/7pzfDu42uH+xq5Q19Tbg1QOyx49cNwwY1xU+HMjgjQzAZIBgDSXq36+0ciAPjwa+DvXwezO2qTiKf6mbJVA+nvZ/MgfHUF/NtdEQB0tZoNkAwApJfY6988GFfwfvot8MYjaqv+vBN/Q6j/Xf3iCfjk9XE18ewOzwZIBgASu5b2DRej9exHToX/dXp0nvNkPw1fMbB9BC75ZVQMtObj9kFLBiVIXvFFAwCR+ZR/3xD0dMGCt8HvH1dbKZrup+G3BdLf4aLV8PElsLEfZrS7JSBZvKTM9+/f2A+vOxwWfjAm/2K5dqe9muMwZ7Ecv9uFH4zf9cb+Xa8olgwAJLKR8h8tRW3/R18P//mBOO1fKkdGwHmBpmrbXMjF7/aImfG7/ujr43c/WrKHgwwAJLKU8t82HCfDL38fnPemWAmWK04GzR70pVsC570pfvddrTEWCv7eZQAgNf/k3zsEx8yG759dS/l7aU+Gbm+ktiXw/bNjLPQOGQTIAEBq6sl/0wC8/nBY+CE4aV5MBH7xZ3MsFMsxBhZ+KMbEpgHHggwAJJru6t4E1vfDR14LP/oAzGiLdLBf+NkOAsqVGAs/+kCMjfX9MVZMBskAQGr0yT+pNff5m9PgwjNqrWFN+Ss9+5EQY+NvTouxgq2eZQAgNXgJWCUawXz5XXDBW6tXxVr+pZ07QFavEb7grTFWto/E2HGcyABAorGuictVV/nbh+FL74I/nl9rEet3uniRbaJSJcbKl94VY6dcHUtUfEZqPgUHtpo1rZuu/M8+ycN+2jv5JMbK2SfFpP8/r4mW0OmYkswASI0y+Z/s5K/9qxA4++TadoBnRtScGQCJ5knjOvlrrIMAqGUCEncDZAZAmnqTf5LAwKiTv8YnEzAwGmPMRICaZowbzYomafP6/Hb44u/HF/ZoGVqc/DUGQcBoNQgYGIV/WATzur1JUGYApCnzJb2hH/7mt+DPX+PKX+OTCfjz18QY29Dv+JIBgDRlJv8PnwqfO6Na6udtfmKMSwRzMbY+d0aMNYMAGQBIkzz5bx2G04+Az7y11tHNyV/jcsaEGGOfeWuMua3eIigDAIlJqdfuH4WDu+Hb74f2Ql1XN2m8OgYSY+3b74+x1z8aY1GyEZA0Qf39R0vQkYfvnAWzOmpd/qTxDgJKlRhz3zkLzroixmI+F62DJTMA0jh/CW8bhgVvh5OrV/o6+YsJ7hZ48rwYg9uGzTzJAEAady052Fi91vfMEz3xLya1MuDME2Msbuy37FQGANK41vr3DcNvHgbn/x6UXPlrkjMBpXKMxd88LMZm3m9UGQBIjMu+f3cLfOXd0NFS7cpmAKBJHJNJEmPxK++OsTlackzKAEAa84HaPwIL3gHH9cTKy31XTYlDgeUYkwveEWPUL1UZAEiM3X7r5kH4wPzavr+pVjGFtqbS8wAfmB9j1XMpMgCQxmCFNViEw2fCP73Fa1k1ta+h/qe3xFgdLDpOZQAgcaD7rEOj8NkzYE5H1Fr7xaqpGABUKjFGP3tGjFnPAsgAQNoPFSK1unkgbmJ7x3HVU/+OWDF1twJK5RirZ58cYzefw15rYupeB+zo1BTtvT5ShDmd8I9vjNWVKyo1QsaqUokxu3QtDBejXNCvWZkBkPax5v+8N8PLZ0LZPv9qlLMAxJg97832BpABgLRfrX5PPwLOmR+915381Wj3BZwzP8awrYJlACDtg2IFzn1TrZzK70/RQNtXEGP33DfFWJYMACReOvXfOwTnnAynvdxb/tTAbYIrMYbPOTnGtFsBMgCQ9qBUhmlt8A+nu/JXc2QC/uH0GNOlss9EBgASL9bxr3cIzjoJjpxlu181R5vgI2fFmO4dskOgDACk3Tf8KcLLZ1j2p+YsC3z5jBjjjmsZAEjsuGe6bRg+fCr0dHnyX81VEdDTFWN727BnWmQAIO2wVzpUhKNmwwdPiRWTX5KMeWfFSiX+Kr3IX+k/99D62Ae3lUqM7aNmV7MAPhZNAQXfdk2Fk/+bh+CvToNZHXGzmnulBz7Zlysx0SRJNZtSnXXye/G/Ua4LBnLVe++dtPZ/G6BYjrH9/hPhkpthblf8mTS5AYA0yUarX45nn1ybcLRv0gk7nexfmPSrBovRlnZwFB7bvOszLldiddrRAm0F6CjsWoKx839D7NtlQcQY/9btMeZ9hDIAUOZP/m8agA+/Fo6ZY93/Pq30K7XrketX+IOj8PBGuOtpWNcHD2+AJ3tj/7lUho0Dux5Eq1SgpzOyMdPa4krb4+fCYTPgNYfC8T0RHKT/jfr/tofa9v4swDFz4P0nwb/dEfdcmAXQZEqOudjrgDS5ShVY9pH4cix7+G+vV/v1jWXWbIS7noHr18IDz8NTfTAwWguyWvO1ybol9+KZmHRiHynVJqfOljjBfuI8eMux8JqXwSt6duzdYFZg735vuQQe2QRv/ZaBrqbCbYA+AzF5h6P6huGMV8DRs53892rirz43EtjYD9c/AgsfhFuegO3DMRG3F6C1AO0ttUMB5fRwQDXgerHfB9W/2uu2AMqVCCjWbIIrH4DuNnj9EfCHr4K3HBMn3NP/3cQtnD1fFFSJsf6GI2HpGpjR9uK/D8ktANHMx/9LlWiVmiQ2/mEPh/rK5dqK/+GN8KOV8PNV8NiWWNF3tcKszh0zBPs6sVTq/qa0wx/sGFCUypFpWLwajpoF7zkBzp4f2wTpP8/l3ON+sSCukIsxv3h1NcgyANBkfQUf7RaAJmk1NDAKx/XA4r+IFDWeNGd3rZHTiX/1Rvjmr2MV3jsYK/H2Qkwq5crE//5y1eZN24dhZge870T476fF73Tnn111QVZ1i+Ud347faWfLxP/+JPsAaFIDgOFiTBpthVr6WLVDdqXqPv/2EfjCzfDOb8N37ox/3tMFLfnYp5+MyaNcif92S762BfCdO+Nn/MLN8TPnc7X+Aqr1vChVYsy/78R4B8x6yQBAmVIsw7T22EfGfeNdJtckiT35hQ/C738bFiyPfzans/b8psLEWqnUDgumP9uC5fEzL3wwPkOSuMLdOfiFGPvT2q0EEDYCEplq/NM3BG97RZSbefiPXVL+fUPwievgv1bG/vvcaslYsTSFg7rqzza3Ex7dDH/5Y/ij+XDh22FGu1sCOx8GPHwmnH44LFlTez6SGQBlYqI786Tal6Figs/non7/3d+BH94be+sdhcZaJRbL8TPP7IjP8O7vxGfK51ztslNJ4JknOfHLAEBkpy3qSAkOnganH1lXfka2D4aVqqfDf3gvvOe70a2vpzMmh0YMkMqV+Nl7OuOzvOe78dkK6bkALIGFeAcOnhbvhA2VZACgph9wAyPwusOjH3o549f+phfw5BO44Hr42NVR1tfZ2hyr5WI5PktLLj7bBdfXLsfJ8uHA9FzE3K54FwZG/DKWAYAycAy6Arzz+NpKMdOtfKt7wp9YDJf8Arpbo4a+mdLCaV+A7tb4jJ9YXN36IdtBQDr233l8NSNiBkAGAGrmVc9oKcrGsp7+r1Dr6veJxfAvt8Eh3c27Mk4/1yHd8Vk/sbiaCSC72wH12wA9XfFuuA0gAwA17WAbLMIJB8UXXlbT/xVqXQ/Tyf+grmov/ib/3KPl+KxpEJCrdoCsZHgboKcr3onBol/IMgBQk2cA3nlctk//l8pxGO5zN8DXV8C8jN0NXyzHZ/76ingGhVx2T8Kn1QDvPM4MgAwA1OQTX1cr/PYRtYAgq5P/j1bCV1fAQd3ZLI0rluOzf3VFPIusBgHpO/DbR8S7YUmg8DZANWPzk6FiND85ZnY2o89ytbXvvc/Cx66JWvky2Ux/V6pn3joK8SyOnwuvPiR7TaHSd+CY2XDYDHiyt3a/g2QnQDVND/ShUZh/MHS0VPvcJ9k68Q/R4e9vfwaUoZDP9oqvUoFCAiPleCbX/AVMa4s/z0p2KKneiNnREu/G6g3QkcdGCXILQM134Om3Xr7jhJi1vd7zlsCq56Mkznvg4xl0t8YzOW9JNs+GpO/Cb73cvhgyAFCT7n13tsBrD83e5T9pD/xrH4Yf3ANzqif+FUbL8Ux+cE88o3zGzgOk78JrD413xHMAMgBQc139W4IjZsGxPbUtgays7pIEtg/DhTdCW97rcV/sObXl4xltH45nlpXnlL4Lx/bEOzJc8nIsGQCoib7ghktwXE/sdWYpzZmm/i/7Ndz3XKS7PeC1++fU3RrP6LJfZ2srIN0e62iJd2S4ZFNAGQCoib7giiU4YV622v+WK9EC99HN8LVbYHaHqX9eYitgdkc8q0c3x7PL0liBeEeK9gOQAYBoptPeOThpXrbq/9NSt3+5FbYOxTPQnhVy8az+5dZ4dpWM9QM4aV48A7eJZAAgmqXpy4x2eOXc7Oz/p6n/RzbBT+6Lz1909b/XY+Un98Wzy8pWQPpOvHKuY0UGAGqm9H8FZnVG57esBADp6v9fb4deV//7nAXoHYpnl5UsQPpOHNQd70rRckAZAKjhB1gFRopwxMzsHACsVFf/WwZh8cPVmn9XdOxL2WR3azy7LYPxLJs9JV5/EPCImfHO5NwGkJ0A1ehLm2IJjp1dvfktA+OtVO1wd93D8MQW6Ok0pbuv2ZP2fDy76x6GD/xGrIgLSfN/7nwS78qNa+v+UDIDoEZudXrI9Ox0AExXrD9aCa3W/e93FqU1H8+wkpH7AdJxcsj0eGfcApABgBr+S60lB4dOz0YFQHr477HNcM+ztXsPxD5nUTpa4hk+tjkbhwHTd+PQ6fHOGDgKbwNUQ0+I1S+2w2Zkq/HPTY/C5gGY22X6/0AOA27oj2d59Jzs3BR42IzqmQB3AGQGQI28/18qw7R26OnKRgVAOkH96gnruRmj/hG/eiIb90ekH6+nK96ZUhlbAsoAQI37hVaqxBWv6RmAJAOn/3sH4ddPVaseHAYcSPaooyWeZW8GqgHSd+OQ6fHOlCrO/zIAUDMEAuVsTFgAazZG6toDgGNzEHBDfzzT+mdMk5dBOvHLAEANP7iGi3Dc3FjRNHsPgHSyf3A9DBW90W2stlSGivFMm72KJO0FMK0t3pnhol/QMgBQg9c2F3LZKGlKP+I9z7qCG+vnes+zZKaLZJJUz4/4qxc2AlKDRwDFUrYudHmmLxq6VDzGfeDDpxzP8pm+bF0kVSxVx07FMSQzAGrgL/BZHc3f1KxS3d7oH4Gneqv7//76xySD1JqPZ9o/Es+4mbcB0o82q6MaQEoGAGrki4BOnJeNLoBJ9TNuG6meWHcIjMmEmEvimVYycCo+fUdOnOeFQDIAEM3R1S0LExXA89thYCTS1hob+SSe6fPbs9Me3+6RMgBQUx2Oy0IA8OxW6BuCvE2AxmxFnM/FM312a3YCAONHGQBINF77Wsv/xqccsOC3lWQAIE31TIB8tpIBgCRJwtsAlakVWxbLmC3fHp/nmdUx5DiSGQA1fGkTGbkO2MN/4zOGyhXfGclOgGqoZUwWDm+lH/Go2dDTCdtHvA6YMeolMVqKZ3rU7OysWgo5UwAyA6Am+ALfMpCd0qbuNif+8VgNF3LxbLNS/rdlwCZAMgBQo39xJ/DA8xno457Urq+dNw2KXuk6ZhNisRzP9IXrlZPmv0/igefj3TGQlAGAGr6GOwsTVQVoL8C87rjMxQBgjAKAUjzT9kI848R3RjIAUGMcA8jnsnMAEOCYOdUMgF/iY3OfRDmeaf0zbnZ5rwOWAYAaffJvycNzW2GoWL3JLQOfe/4h2fmsEzGGkiSeaVY+61Ax3pkWb5SUAYAa+QutkIPntsFwsZq6rTR/2vaVB0FXK5S9zvWAlcvxLF95UAZS49XbDoeL8c4UzALIAEANP8hy2bjdLJ2bjp4Dh82A4ZLbAAea/h8uxbM8ek52KklKlXhnJAMANXQVQGse1m+HRzZWV3RNPmGVytDZAq8/EgZHvRaYA7wGeHA0nmVnSzzbZg6o0nfjkY3xzrxQ9SAZAKhRb28pleOLPEsX1rzhiPg/KjZy2e8HmT67NxyRrcuABkfjnfEGJGEnQDV6hDlShPuehd85uvnruNMV/xuPhkOmwbZhKLiSY3+yKSPFeIZvPHrHZ9vU7X+TeFdGipBrq2YFHDsyA6BGNjCanYmrXIGDuuF1R8bn9iXbvy+mgdF4hgd1xzPNynmKrLwrMgAQ2WjjmnYDzEKDk3TB9ienZPc2u7G6/a/+GWal+c8Dz9tOWngdsGiKg02FHDzVG+VNrQWavp1brtrC9Q1HwQkHw5oN0NGSrdvsDvT5DYzGs3vDUfEsmz5wrGY4hovxrhRy8e44ZGQGQI3dDKgAz/TFDXlJBr7UEqKUq70AZ51c3QawGmCfA4CzTo5nWKo0f/lfGhNvH4l3paXg5C8DADXJFsCWAXg0A6WA1B0GrAAfOhWOnFXrhKiXPkMxVIxn9qFTq62kk2xkyiDekS0DbgHIAEDNVM9dhFXr6047Z+EwYBlmd8KHT4OtQ/YE2NuxsnUontnszniGWQic0ndi1fp4VxwrMgBQU02I9z2XnW5u9WcB/vRUeEVP1HebBdjzGBkcjWf1p6dmZO9/py6S9z3nGJEBgGiuW/JacvDQ+vj7zHypV0sCZ3fCuW+F/hFXdi+1+u8fiWc1uzNbpX+56lh5aH28Kx4YFTYCEk1ywKm9AGvWR4vTg6fF6i4LX+756j0I7zsJfng3XL8GZnXEFbeq+yKqnhN523HxrEqV7Fwjnb4Lz2+Ld6S9YAdJmQFQE33BteRgQz/c+0x2DgLWp3dzCXzybdHTvljOzjbI3j6fYvUOhU++LZ5VkrFSWYh3Y0N/vCsVJ38ZAKjZLsq57YnsHASsT++WynDSwfCPb4bNA9lZ3bKXWZLNA/FsTjo4nlWWyibTd+G2J5r/wiMZAIhsngNozcPt6+Lvs7YXns/Fl/tH3wh/eCJsGYy0N6b+2TIYz+Sjb4xnlLXgKF/d/799Xbwj7v/LAEDNdw6gBVavh+e3xyona2nOdGX3lffGHff9I9nOBORz8QwOmxHPpP4ZZWn1nyTxTqxeH++I878MANS05wDuy+A5gPqywJ4u+N6fRHvgkWI2uwTmqrf9dbTEs+jpylbZHzvt/9/n/r8MAJSFsrglq7N713l6HmD+y+CSP4iWt1mb+NJAaGA0nsH8l2Vv33/nm6OWrM5W2aMMAJQxpUqs+G5+NBq+5DO62snn4tT7++fDN86EbcPZ+fJPg8Btw/HZ3z8/nkUWt0Iq1VLHwdF4Jzpa4h2R8DZANeMXXmsBnuyNhienHBop0HxGD78Vy/CBU2IR+Lc/hWlttQmymVf+24bh62fGZy+Ws3sYMh37D62Pd6Kt4AFAmQFQBrq9LXowe+WALxYE/PEpMSH2DcFoqTlXw/lcfLa+ofisf5zxyb9+7C960C6RshOgsrDqKUNHHpathv/9ZijkLYNLg4DpbfCxhbC5H2Z0xITZDFry0DcIs7vgm2fBu05w8q8PipatjneiXLb7n8wAqMn7AXS0wqrn4f7nouNb1vc90yDgXSfAj/8Mju2Bjdvjzxv5XECSxGfYuD0+04//zMmfuvMwCfEOrHo+3gnT/zIAUDauBx51G2B3QcD8Q+C6v4JzTomysFKDTpaFauOjDf3xWa77q/hsTv67pv8HR03/ywBAGVr9dLXClffB9pGYEAwC4jmUKzCjHb75R9Ecp70AmwZigmiEMrlcEj/rpoH42b/y3vgsM9rjszn5x1gv5GLsX3lfvAue/pcBgDLzBdhegEc3Rf/zCtlrCvRSJ+XLFfjwabDkr+N8wNbhqJsv5KZmIJCrpvsHRuNn/eNT4mf/8GnxWbLY5Ic9nP6vEGP/0U11t/9JBgDKUiBwxV2xF+rcwA5752nDoKNnw6VnwX/9KZwwL1bWA9UeClMhbZxP4mcZGI2f7YR58bNeelb87GmDHxvc7Hj7YUKMfSd+MalVANIkHQbsboMb1sCajfCKnvgzV4k7nhJPD4b93ivgjUfDT1bCpSvi6thcEunjtKHSRB0iSyf0UjlW++UKvPpl8Nevi8Y+LXUX2njr4a7jPpfEmL9hTbwDHv6TGQBlrgNqSx429sMP7659OWrXyTZXbQ7Uko/mOUv/Cn7wQTjjuPjzzdWsQHqOID/G1QNJdZWf7t8PjMZ/s1yJn+EHH4yf6QOn1Cb/XIOcWZiMAABizG/sj+flsNdkSV7+GZNQmrxU90gRDp0BN/9dtELFfuh7DJrKO7XNfXgDXPUALLwfHt8CvYPxz9sK8VcuiXRzpW7bpbKn1HRS+/tKdcIaLsZfpTLM7IAjZ8EfngR/cCIcP7f275fKkMu5nbPHk//VCpjf+Ro83RedMf0GlgGAyGpJ4JZB+Ndz4Kz52bwPfn8Dgfq99VIZ1m6Cmx6BXz8RWwTremGoWCu9S88WtO1m0kmSmOTTA3vpv9NegMNmRor/tCPgd4+BY+fUfkfp1oMT/0tLx/aPV8Jf/ifM6vD0vyY7APi0AYCY1BR3/wiceHDUirfms3kvPAeQUk4vlak3OAoPr49V5kPr4++3DMYk/8jGXdPz5Qoc0xPBwawOOP4geOVBkZ05/qBqdmanySwxzb/Pdf8jJXj7ZfDAc3F+w20v4SFAZXkCm9YGd62DxQ/Be06qrj6dWPY6gCKJrEC6Gk+SmLB/49D4610n7Pjv9A5Wyw3rUv/lSqT399S7IS3lS88EaN96XxRyMcbvWgc9XTHOJW8DVObrovN5+P5dEQC4qmT/SsvqVuRpQJDu+ad/niQvPtFX6laq5UrtfzOpNvcxx3+AgRoxxvP5Wi8AySoAZX5vdHpbXIqy4vFaiZkOLCDI1Z3eT0/lJ/WBwU5/JXVVB2k1Qfrv6MDGd5LE2F62Osa641sGAFLdIbRyBb58c3XCcdYZ12e9u780ftFYQoztslUuMgCQdl0lzWiHpavhmlWRcnaVpKY4+Z/EmF66Osa441oGANJOKtX08+dviNPSSWKNtBr75H+SxFj+/A3Vg5eu/mUAIO2qXI6KgHueicY2aQc8qZHb/i68P8b0tLYY45IBgMTuy6U6W+CzS+vK1QwC1ICr/1wSY/izS2NM2/RHTLk+AA5KTbEvzo4CrN0Al98K//hm+wKocev+L781xvLcbuv+ZQZA2qsvz1md8JWb4r70Qs7UqWioraxCLsbuV26KsezqXwYA0l5mAfK5aBF87qJqu1sfixrproZKjN3+kdp1zZIBgLSX5VMzO+Cq++HKlfElagpVU12xeuHPlStj7M7ssOxPBgDSfm0FTGuHTy+Ju9OtChANcOp/Y3+M2Wntpv5lACCxv1sB7QV4bBOcf60VAWqMk//nXxtjtr3geJUBgMSBpFTndMEVd1Y7BOZMqYqp2fEvF2P0ijtjzLplJbwNUOKAU6vtLfB/r4bTj4rUasWe6ppiHf96B2OMtrd4cFVmAKQxCwA6WuGxzXDJcs8CaGru/V9+a5T+dbQ6PmUAII2ZYilOVH/rVnhkE+TsDaApUvOfy8WY/HJa81/yuQg7AUpjKZ+D7SNw/iK44kNQdgtATIELrIgxuX3Ysj+ZAZAYr4NW09th0Sq4+RGvDNbUuOr35kdiTHrVrwwApPGURCbgvEVxytorgzWZB/+K5RiL+VyMTckAQGL89ly72+CedXDFHR4I1OQe/LvijhiL3V71KwMAiYm5MrgNFlwPfYNmATQ5DX/6hmIMdrbZ8U8GANKEdgh8us+yQE3O6j9J4JIb4Jk+O/7JAECa8CzAjHa4fAXc96xlgZr4sr9v3RqHUl39ywBAmoQrgwdH4TPXxfmrioewNAFlfwlR9jcw6lW/MgCQJvXK4GUPw9WrLAvUBJb9PVhd/TveZAAgTcZyrHYg66JlMFLyQKAmqOwvqY1BCTsBSkzKnuy0alngZbfA37+xtlKTxvLgXz4H/3E73PMUzK6/7c/vUJkBkJi0A4HdbfD1X8D67bFSsypA41L2tww6LPuT1wFLU+cLuq0AT/XGVsAX31vdmzULoDFc/V9yA6zrgzmddat/yQyANLmK1QOBP7gLVloWqHEo+/vXFdV+/66aZAAgMeVuC+wfhgsWV8sCfSTCsj/JAEBkoiywE5Y+DNesii9ry7Q0FmV/1zxg2Z8MAKSp3yAoD59ZDFuHLAvUGJT9XeNtfzIAkGiEA1vT2uDeZ6JVay5xz1b7f9vf9+6Au7ztTwYAEg1zIHBWJ3ztF/D45kjjWhaofb3sZ/12WLAUuiz7EzYCkmiU9G1rHp7tgy8vhy+fWV29mcLVPtwzcdFSWNcLPd1QLPlcZAZAaowsQAnmdMH3bodbn/BAoPat7G/lM1FSOrPDyV8GAFLDSRIYLcMXlpnC1b6V/V2wOEpK835DygBAomFvC1z8IPxspVkA7V3Z39UPRCnpzE7HiwwAJBr5QFdHK1xyvWWBeumyv5FS7P3ncjaSkgGA1PABQHcb3P20ZYF66bK/y34VY2WaZX8yAJBonrLAm+GJLbEVYFmgdlf29/VfRMBokCi8DVCiKdK7LXl4dhtcuAQuO6caACQ+G9XK/hYshSd7oafL2/5kBkBqqizAnK4o7VrxuAcCtYeyP1dFMgCQmnOl9+lr47CXBwKVlv19pr7szzEh7AQoNd89Aa2wfG2UBZ59Sq30S2Sz7C9XLft7KFb/JZv+yAyA1KRf+pW41vWCxbBlME5+mwXIdtnfAsv+ZAAgZeOLv70AazfC5bfEJGBFAJkt+7v0V3D3Osv+ZAAgZSYLMKsTvnQjPLapWhbol382y/5utuxPBgBSprIAhRxsG4aLllX/zMeSqd9/LonU/1O9kRFyG0gGABLZKQuc2QHfv8OywMyW/d1ZLfvz9y4DACljEijk4VPXxiRgWWBGy/4kAwApe6vBaW1w81r43u2RFvZAINm47e8hb/uTDACU+QOB09pjP7jPskDL/iQDACkjE0M5DoGt64Uv3GBZIFm47e+patmfTX+Ucckh57rekSrVVeKvPgZH90RgkDM8bp6yP+CJzfDmr8LgCOTzZnokbwOUiMNgfYNw3jXwgz+Dsu2Bm6vsLwdfWg7PboW506Do6l9yC0CCOAw2vR2ueQBuWhuHxTwg1jz9/m99HL57e9wI6eQvGQBI7FwWmE/g3KstC2y2IODzy2LiT8zsSAYAErspC+xug7vWwX9YFtg0q/8rV8LiVdXb/szqSAYA0ouVBXa1woIlcSbALAANXfa3dQi+cD10tBrMSQYA0l7cFriuNyYOswCNG8jlEvjXFXHbX3ebv0fJAEDai8ljRgdcdgusfDpOkHtbIA1V9pdP4PFN8NWb4+ZH+/1LBgDSXmUB8rmoF//04qghr3h4rOHS/19aDs/2Qas1/9JuFeyHKe0mC1CKQ2NLH4Kr74d3n1Q7VKYGKfv7NczptOxPMgMg7Ud3wFwCFy6JHvIeCLTsTzIAkMjObYF3r4NLf+mBwIYq+3vAsj/JAEA6wAOB3W3wtZth/TYvC6IRyv6WWfYnGQBIY1QW+NSW6jWybgNM7bK/Wyz7kwwApDFSLEc6+ft3wMpnLAvEsj8JbwOUsvKi5KBvAD51Lfz0I+D8wpS77e+Ly+GZPpjbbQAgmQGQxjALMKsTljwIVz8Qh808YMbUKvu7rXrbn78XyQBAGuuVZiEPn1oUh80sC2RK3OBYrsBFy2C0bNmfZAAgMT57zdNa4d6n4fJb4tBZyQBgclf/Cfz4nij7m2XZn7Rv8fO8j7uGkfb6hUlikulsheUfhSNm1xoGiQnNxgD0DsLpX4LntkJrwYyMZAZAGseJpzUfPea/eKPbAExiNiZJ4Ju/grUboKPF34NkACAx/gcC53TFobNbH/dA4GR0aMzn4LFN8MUb4nCmWzGSAYDERG0FjJbhoiU2nGES7mgAWLAEtg1Hiaarf8kAQGKiDqDN6oBrV8FP7zELMNFlfysegyvuiAZNlv1JBgASE70P3dkKFy+zLHAi+/2PFOGTi2Llj4cvJQMAaTICgO7qbYGWBU7M884l8LOVsHxN3NRoS2bJAEBiMjsEfnU5PLE50tOeCRindr8JbBmAT18L09oNtiQDAGkKlAU+tw0+d11kpN0GmICyP2v+JQMAaUqUBXbCFbfH4TQPBI5T2d/GatmfHf8kxuY2QKNoaUxK0/I5OP8auOav486A9NCaxqjsb2kctpztdb+SGQBpqihV4lDa8jVw5crYr/YswNiW/X3vdsv+JAMAaaoGAe3w6UVxWC1nWeCYlf2df00EApb9SQYA0pScsDoKsGYDXParmLzMAnDAZX9XVsv+plv2JxkASFM5CzC7Mw6rPbqxWhbopHVgZX+LLPuTDACkBpi4Crk4rHbR0h0PsWnfy/4u+1VkVCz7kwwAJBqiOVBHHFqzLHD/yv5yucigfPGGyKi4+pcMAKTGkNTKAkeK3hPAPpb9JUQGZduQt/1JBgBSg61ip1fLAn9mWSD7WvZ30xrL/qTxVnCDUhq/yWxaG3zqGnjbq2B6u82B9qbsr1iGjy+EQoKHKCQzAFLjlgWu3QgXLzULwF6W/f3HbXDXk972JxkASA2sWIkDgZdXL7HJWRa4x7K/3kH43GLobPPgn2QAIDX4ibZ8DvpH4LyrqrcFugXwomV/Fy+FdX2W/UkGABLNcRZgRjtcfX8cbssnlgXuruzvkQ2RKZlh0x/JAEBqmtvskkhxf3xhHHKzLLDu+SSRGfnEVZEpyec8KyExIdcB+wykCckCdLfBHU/Cd2+DD7+uWvKW+FzyuSiXvOr+qJRIy/78bpLMAEhNc09Adxt8dnEcdsv6bYE7l/3lE7ztTzIAkJpzwmsvxCG3i5d6W2Ba9vfd2+DOpyz7kwwAJJr7noAZ7XDZL7NdFlhf9vfZxdDd4sE/CTsBSk3+0uWgdwTOXQj/+REoJ9lc/edzcPESWLcFerps+SuZAZBo/oNvMzvg5/fBwvuyVxaYlv2t3RDX/c7oiIZJkgwAJLJQGtiSi653I6VslQWmZX/nLoSBkciImImUDACkzKyCp7XBXU/BN27Ozj0BaeljWvY3oz1b2Q/JAEASpUoEAV9dDuu3NX9VwA5lfz+37E8yAJDIdlngk1tiK6DZ+wLsUPbnbX+SAYBExssCZ3XAFbfDvU83b1lguvrvHYTPXhsNkSz7kwwApEzL52D7MHzq6ua9LTBd/V+8FNb1RuajmbMdkgGAJPbmYNysTrjuQbiqCcsC07K/lU/Dpb+IEkhX/5IBgKRKrTPeZ69tvrLAtOzv/Kuj7C+fg0rZX7vEpN8GaCQuTYkswLS26In/LzfB//i95rgtML3tb+FKuG5VrP6LJbzuTzIDIKm+LHB6O1y8DB7b1Pi9AdKDfyOlyGzkc875kgGApN1OmG15eG4r/POyxt8GSA/+feMmuGudZX+SAYAk9lQW2NMF/34rrHgsVs2NeCCwXF39r98G/295TP4e/JMMACTtQZLAaBkWLG7cSbP+UOOTWyz7kwwAJLFXZYEdsOgB+OndjZcFqC/7u+L2+Cxe9SsZAEjayxR6ZytctAS2DjXWeYAXyv6uigZHeb9lJAMASXsfAHRXbwv85i8jnd4I2wFp6eLCldHYaFZnczU1kgwAJDERBwJnd8JXboyywPwULwu07E9qLAXfUGnqTqiteXimN8oCv3ZOtYwumbpZi3yuWvb3FMztqmv6I8kMgKR9yAKUoizwOyvg1ilcFrhD2d+Nlv1JBgCSGIuywHIFzv05jBSn5oHAHcr+Nlv2JxkASGIsDtbNaIcb18CV90y9FsEvlP2tgyt+HQf/LPuTDAAkjeE9AZ+8GrYMTK0sQP1tf5b9STTQbYA+A4lGOBDYXoDVG+DSX8DH3z41bgusv+1v8SqY6epfMgMgaWwVK1EWeMkyeHRjTLyTeblOWvY3WoILLPuTDAAkjdeMC4VcdAb83OIX/ojJvu3va9WyP2/7kwwAJI1nc6AO+I/b4JZHJ68sMJ38LfuTDAAkTVwigEIezrtq8soC0/T/BYss+5OwE6CkiVp9T2+FGx+KssBzXjuxBwLTg38rHoV/uwXmdNrxTzIDIGlCywLPvwr6Bic+C1Auw4WLY+JPEn8fkgGAJCYqBd/RAms3wILrJq45ULr6//HdsOh+b/uTDAAkMRllgbM64bKbIxDIjXNZYLrvv3UQLroOOlun9u2EkgwApKY9DZjPwcAIfPxn0Y2vkozvtkMugct+CXc/Cd1tBgCSAYAkJu2egA64aiUsXx0HAccjJV+uxP/2YxvhKzfArC47/kkGAJImVxKZgP9zZUzK43EgME3/X7IMnumFVsv+JAMASUz6bXzT2uDOJ+HfV4z9gcD6sr9/XwE93Zb9SQYAkpgqZYHdrdGTv28wgoDKGAcBFy6Ovv+W/Uk0yW2ApvEkmqEssK0F1m2GBYvhoveNTXOgdPX/ozvhmvtgrqt/yQyApKmlWILpHXDpGJUFpvv+fYMRVHS2eOpfMgCQNCUV0rLAKw+8LDAt+/vmL+CeJ6G73QBAMgCQxFQtC5zZCT+7Fxau3P+ywPqyvy/fADMt+5MMACQx5W8LbMnDBdfASGn/ygJfKPtbatmfZAAgiUYrC/z68n0vC6wv+/uOZX+SAYAkGqoscFp7dO1bvy1W8/saBFx4rWV/kgGAJBqtLLC9AE9uhgsW7X1fgGJ19f+Tu+Fqb/uTDAAkNZ5iOSbw790G96576bLASvXU/7ahKPvr8rY/yQBAUmPK52D7EJy/8KXLAsvVAOCrN8I9TxkASM2ugC+41LRKpcgCLH4AFt4Lf/jq2iG/nQ8O5nPw6Ea4ZAnM7qyW/fn9IJkBkETDlgXmkz2XBab/5+cWwdahaCjk5C8ZAEiiwcsC26Ms8BvLdy0LTDMCtzwC3721bvUvyQBAEg1fFji9HS6+Lrr7pUFA2vBnpATn/by68rfsTzIAkNQkWYDqbYHP9kV3v3QbIO33/9O74MaHI0hw9S9lQzLrYxV3+qSsRPxJXBa07GPw+qMjMOgbhNMWwHNbbfkrmQGQ1JwRfxLd/S5cFCv9XALfuAnWroeOFid/yQBAEs16W+CsTrjmPlh0P2zuh88vhllddvyTyFwfAElk8TzAPy+Fn9wFQ6Mwo8UAQMIzAJKysBUwUoxtADv+SXYClER2LgtqzUNbfs/3A0hyC0BSEwYBxv8SHgKUJEkGAJIkyQBAkiQZAEiSJAMASZJkACBJkgwAJEnSVFOwD6AkSWYAJEmSAYAkSTIAkCRJBgCSJMkAQJIkGQBIkiQDAEmSZAAgSZIMACRJ0gQqYCdASZLMAEiSJAMASZJkACBJkmiK2wB9BpIkmQGQJEkGAJIkyQBAkiQZAEiSJAMASZKEnQAlSZIZAEmSZAAgSZIMACRJkgGAJEkyAJAkSQYAkiTJAECSJOFtgJIkyUZAkiQJtwAkSTIAkCRJBgCSJMkAQJIkGQBIkiQDAEmSZAAgSZIMACRJkgGAJEnCToCSJMkMgCRJMgCQJEl4G6AkSTIDIEmSDAAkSZIBgCRJMgCQJEkGAJIkGQD4CCRJwk6AkiTJDIAkSTIAkCRJBgCSJMkAQJIkGQBIkiQDAEmSZAAgSZLwOmBJkmQjIEmShFsAkiTJAECSJBkASJIkAwBJkmQAIEmSDAAkSTIA8BFIkmQAIEmSDAAkSRJ2ApQkSWYAJEmSAYAkScLbACVJkhkASZJkACBJkgwAJEmSAYAkSTIAkCRJBgCSJAk7AUqSJDMAkiTJAECSJBkASJJkAOAjkCTJAECSJBkASJIkvA1QkiSZAZAkSTYCkiRJZgAkSZIBgCRJMgCQJEkGAJIkaeL8f91cYtReFH5RAAAAAElFTkSuQmCC";

// Inline vector icon (favicon + manifest 'any' purpose).
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2E9BFF"/><stop offset="1" stop-color="#0A66FF"/></linearGradient></defs><rect width="512" height="512" rx="112" fill="url(#g)"/><path fill="#fff" d="M256 120a96 96 0 0 0-96 96c0 66 96 176 96 176s96-110 96-176a96 96 0 0 0-96-96z"/><circle cx="256" cy="216" r="40" fill="#0A66FF"/></svg>`;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ==== inlined from src/modules.js ==== */

// Auto-generated: the on-device module scripts, base64 (UTF-8 bytes). DO NOT EDIT BY HAND.
// Regenerate with: cd stateless-picker/worker && node scripts/gen-modules.mjs
// The worker serves these at /location-spoofer.js, /location-settings.js and
// /location-spoofer-qx.js so the whole stateless setup runs from the worker (no GitHub dep).
const LOCATION_SPOOFER_B64 = "Lyogd2xvYy5qcyAtIEJ1aWxkIDIwMjYtMDgtMDggMjE6MzE6NTggKi8KY29uc3QgZT0oKCk9Pntjb25zdCBlPWU9PmUgaW4gZ2xvYmFsVGhpcztzd2l0Y2goITApe2Nhc2UgZSgiJHRhc2siKTpyZXR1cm4iUXVhbnR1bXVsdCBYIjtjYXNlIGUoIiRsb29uIik6cmV0dXJuIkxvb24iO2Nhc2UgZSgiJHJvY2tldCIpOnJldHVybiJTaGFkb3dyb2NrZXQiO2Nhc2UgZSgiRWdlcm4iKTpyZXR1cm4iRWdlcm4iO2Nhc2UgQm9vbGVhbihnbG9iYWxUaGlzLiRlbnZpcm9ubWVudD8uWyJzdXJnZS12ZXJzaW9uIl0pOnJldHVybiJTdXJnZSI7Y2FzZSBCb29sZWFuKGdsb2JhbFRoaXMuJGVudmlyb25tZW50Py5bInN0YXNoLXZlcnNpb24iXSk6cmV0dXJuIlN0YXNoIjtjYXNlIGUoIkNsb3VkZmxhcmUiKTpyZXR1cm4iV29ya2VyIjtjYXNlIEJvb2xlYW4oZ2xvYmFsVGhpcy5wcm9jZXNzPy52ZXJzaW9ucz8ubm9kZSk6cmV0dXJuIk5vZGUuanMiO2RlZmF1bHQ6cmV0dXJufX0pKCk7Y2xhc3MgdHtzdGF0aWMjZT1uZXcgTWFwKFtdKTtzdGF0aWMjdD1bXTtzdGF0aWMjYT1uZXcgTWFwKFtdKTtzdGF0aWMgY2xlYXI9KCk9Pnt9O3N0YXRpYyBjb3VudD0oZT0iZGVmYXVsdCIpPT57c3dpdGNoKHQuI2UuaGFzKGUpKXtjYXNlITA6dC4jZS5zZXQoZSx0LiNlLmdldChlKSsxKTticmVhaztjYXNlITE6dC4jZS5zZXQoZSwwKX10LmxvZyhgJHtlfTogJHt0LiNlLmdldChlKX1gKX07c3RhdGljIGNvdW50UmVzZXQ9KGU9ImRlZmF1bHQiKT0+e3N3aXRjaCh0LiNlLmhhcyhlKSl7Y2FzZSEwOnQuI2Uuc2V0KGUsMCksdC5sb2coYCR7ZX06ICR7dC4jZS5nZXQoZSl9YCk7YnJlYWs7Y2FzZSExOnQud2FybihgQ291bnRlciAiJHtlfSIgZG9lc27igJl0IGV4aXN0YCl9fTtzdGF0aWMgZGVidWc9KC4uLmUpPT57dC4jcjw0fHwoZT1lLm1hcChlPT5gICR7ZX1gKSx0LmxvZyguLi5lKSl9O3N0YXRpYyBlcnJvciguLi5hKXtpZighKHQuI3I8MSkpe3N3aXRjaChlKXtjYXNlIlN1cmdlIjpjYXNlIkxvb24iOmNhc2UiU3Rhc2giOmNhc2UiRWdlcm4iOmNhc2UiU2hhZG93cm9ja2V0IjpjYXNlIlF1YW50dW11bHQgWCI6ZGVmYXVsdDphPWEubWFwKGU9PmAgJHtlfWApO2JyZWFrO2Nhc2UiV29ya2VyIjpjYXNlIk5vZGUuanMiOmE9YS5tYXAoZT0+YCAke2U/LnN0YWNrPz9lfWApfXQubG9nKC4uLmEpfX1zdGF0aWMgZXhjZXB0aW9uPSguLi5lKT0+dC5lcnJvciguLi5lKTtzdGF0aWMgZ3JvdXA9ZT0+dC4jdC51bnNoaWZ0KGUpO3N0YXRpYyBncm91cEVuZD0oKT0+dC4jdC5zaGlmdCgpO3N0YXRpYyBpbmZvKC4uLmUpe3QuI3I8M3x8KGU9ZS5tYXAoZT0+YCAke2V9YCksdC5sb2coLi4uZSkpfXN0YXRpYyNyPTM7c3RhdGljIGdldCBsb2dMZXZlbCgpe3N3aXRjaCh0LiNyKXtjYXNlIDA6cmV0dXJuIk9GRiI7Y2FzZSAxOnJldHVybiJFUlJPUiI7Y2FzZSAyOnJldHVybiJXQVJOIjtjYXNlIDM6ZGVmYXVsdDpyZXR1cm4iSU5GTyI7Y2FzZSA0OnJldHVybiJERUJVRyI7Y2FzZSA1OnJldHVybiJBTEwifX1zdGF0aWMgc2V0IGxvZ0xldmVsKGUpe3N3aXRjaCh0eXBlb2YgZSl7Y2FzZSJzdHJpbmciOmU9ZS50b0xvd2VyQ2FzZSgpO2JyZWFrO2Nhc2UibnVtYmVyIjpicmVhaztkZWZhdWx0OmU9Indhcm4ifXN3aXRjaChlKXtjYXNlIDA6Y2FzZSJvZmYiOnQuI3I9MDticmVhaztjYXNlIDE6Y2FzZSJlcnJvciI6dC4jcj0xO2JyZWFrO2Nhc2UgMjpjYXNlIndhcm4iOmNhc2Uid2FybmluZyI6ZGVmYXVsdDp0LiNyPTI7YnJlYWs7Y2FzZSAzOmNhc2UiaW5mbyI6dC4jcj0zO2JyZWFrO2Nhc2UgNDpjYXNlImRlYnVnIjp0LiNyPTQ7YnJlYWs7Y2FzZSA1OmNhc2UiYWxsIjp0LiNyPTV9fXN0YXRpYyBsb2c9KC4uLmUpPT57MCE9PXQuI3ImJihlPWUuZmxhdE1hcChlPT57c3dpdGNoKHR5cGVvZiBlKXtjYXNlIm9iamVjdCI6cmV0dXJuW0pTT04uc3RyaW5naWZ5KGUpXTtjYXNlImJpZ2ludCI6Y2FzZSJudW1iZXIiOmNhc2UiYm9vbGVhbiI6cmV0dXJuW2UudG9TdHJpbmcoKV07Y2FzZSJzdHJpbmciOnJldHVybiBlLnNwbGl0KC9ccj9cbi91KTtkZWZhdWx0OnJldHVybltlXX19KSx0LiN0LmZvckVhY2godD0+eyhlPWUubWFwKGU9PmAgICR7ZX1gKSkudW5zaGlmdChgICR7dH06YCl9KSxlPVsiIiwuLi5lXSxjb25zb2xlLmxvZyhlLmpvaW4oIlxuIikpKX07c3RhdGljIHRpbWU9KGU9ImRlZmF1bHQiKT0+dC4jYS5zZXQoZSxEYXRlLm5vdygpKTtzdGF0aWMgdGltZUVuZD0oZT0iZGVmYXVsdCIpPT50LiNhLmRlbGV0ZShlKTtzdGF0aWMgdGltZUxvZz0oZT0iZGVmYXVsdCIpPT57Y29uc3QgYT10LiNhLmdldChlKTthP3QubG9nKGAke2V9OiAke0RhdGUubm93KCktYX1tc2ApOnQud2FybihgVGltZXIgIiR7ZX0iIGRvZXNu4oCZdCBleGlzdGApfTtzdGF0aWMgd2FybiguLi5lKXt0LiNyPDJ8fChlPWUubWFwKGU9PmAgJHtlfWApLHQubG9nKC4uLmUpKX19Y2xhc3MgYXtzdGF0aWMgZXNjYXBlKGUpe2NvbnN0IHQ9eyImIjoiJmFtcDsiLCI8IjoiJmx0OyIsIj4iOiImZ3Q7IiwnIic6IiZxdW90OyIsIiciOiImIzM5OyJ9O3JldHVybiBlLnJlcGxhY2UoL1smPD4iJ10vZyxlPT50W2VdKX1zdGF0aWMgZ2V0KGU9e30sdD0iIixyPXZvaWQgMCl7QXJyYXkuaXNBcnJheSh0KXx8KHQ9YS50b1BhdGgodCkpO2NvbnN0IG49dC5yZWR1Y2UoKGUsdCk9Pk9iamVjdChlKVt0XSxlKTtyZXR1cm4gdm9pZCAwPT09bj9yOm59c3RhdGljIG1lcmdlKGUsLi4udCl7aWYobnVsbD09ZSlyZXR1cm4gZTtmb3IoY29uc3QgciBvZiB0KWlmKG51bGwhPXIpZm9yKGNvbnN0IHQgb2YgT2JqZWN0LmtleXMocikpe2NvbnN0IG49clt0XSxpPWVbdF07c3dpdGNoKCEwKXtjYXNlIGEuI24obikmJmEuI24oaSk6ZVt0XT1hLm1lcmdlKGksbik7YnJlYWs7Y2FzZSBuIGluc3RhbmNlb2YgTWFwJiZpIGluc3RhbmNlb2YgTWFwOmlmKG4uc2l6ZT4wKWZvcihjb25zdFtlLHRdb2YgbilpLnNldChlLHQpO2JyZWFrO2Nhc2UgbiBpbnN0YW5jZW9mIFNldCYmaSBpbnN0YW5jZW9mIFNldDppZihuLnNpemU+MClmb3IoY29uc3QgZSBvZiBuKWkuYWRkKGUpO2JyZWFrO2Nhc2UgQXJyYXkuaXNBcnJheShuKSYmMD09PW4ubGVuZ3RoJiZ2b2lkIDAhPT1pOmNhc2UgbiBpbnN0YW5jZW9mIE1hcCYmMD09PW4uc2l6ZSYmdm9pZCAwIT09aTpjYXNlIG4gaW5zdGFuY2VvZiBTZXQmJjA9PT1uLnNpemUmJnZvaWQgMCE9PWk6YnJlYWs7Y2FzZSB2b2lkIDAhPT1uOmVbdF09bn19cmV0dXJuIGV9c3RhdGljI24oZSl7aWYobnVsbD09PWV8fCJvYmplY3QiIT10eXBlb2YgZSlyZXR1cm4hMTtjb25zdCB0PU9iamVjdC5nZXRQcm90b3R5cGVPZihlKTtyZXR1cm4gbnVsbD09PXR8fHQ9PT1PYmplY3QucHJvdG90eXBlfXN0YXRpYyBvbWl0KGU9e30sdD1bXSl7cmV0dXJuIEFycmF5LmlzQXJyYXkodCl8fCh0PVt0LnRvU3RyaW5nKCldKSx0LmZvckVhY2godD0+YS51bnNldChlLHQpKSxlfXN0YXRpYyBwaWNrKGU9e30sdD1bXSl7QXJyYXkuaXNBcnJheSh0KXx8KHQ9W3QudG9TdHJpbmcoKV0pO2NvbnN0IGE9T2JqZWN0LmVudHJpZXMoZSkuZmlsdGVyKChbZSxhXSk9PnQuaW5jbHVkZXMoZSkpO3JldHVybiBPYmplY3QuZnJvbUVudHJpZXMoYSl9c3RhdGljIHNldChlLHQscil7cmV0dXJuIEFycmF5LmlzQXJyYXkodCl8fCh0PWEudG9QYXRoKHQpKSx0LnNsaWNlKDAsLTEpLnJlZHVjZSgoZSxhLHIpPT5PYmplY3QoZVthXSk9PT1lW2FdP2VbYV06ZVthXT0vXlxkKyQvLnRlc3QodFtyKzFdKT9bXTp7fSxlKVt0W3QubGVuZ3RoLTFdXT1yLGV9c3RhdGljIHRvUGF0aChlKXtyZXR1cm4gZS5yZXBsYWNlKC9cWyhcZCspXF0vZywiLiQxIikuc3BsaXQoIi4iKS5maWx0ZXIoQm9vbGVhbil9c3RhdGljIHVuZXNjYXBlKGUpe2NvbnN0IHQ9eyImYW1wOyI6IiYiLCImbHQ7IjoiPCIsIiZndDsiOiI+IiwiJnF1b3Q7IjonIicsIiYjMzk7IjoiJyJ9O3JldHVybiBlLnJlcGxhY2UoLyZhbXA7fCZsdDt8Jmd0O3wmcXVvdDt8JiMzOTsvZyxlPT50W2VdKX1zdGF0aWMgdW5zZXQoZT17fSx0PSIiKXtBcnJheS5pc0FycmF5KHQpfHwodD1hLnRvUGF0aCh0KSk7cmV0dXJuIHQucmVkdWNlKChlLGEscik9PnI9PT10Lmxlbmd0aC0xPyhkZWxldGUgZVthXSwhMCk6T2JqZWN0KGUpW2FdLGUpfX1jbGFzcyBye3N0YXRpYyBwYXJzZShlKXtsZXQgdD17fTtzd2l0Y2godHlwZW9mIGUpe2Nhc2Uic3RyaW5nIjp7Y29uc3Qgbj1lLnJlcGxhY2UoL15cPy8sIiIpO2lmKCFuKWJyZWFrO2NvbnN0IGk9T2JqZWN0LmZyb21FbnRyaWVzKG4uc3BsaXQoIiYiKS5maWx0ZXIoQm9vbGVhbikubWFwKGU9Pntjb25zdFt0PSIiLGE9IiJdPWUuc3BsaXQoIj0iLDIpO3JldHVybltyLiNpKHQpLnJlcGxhY2UoL1xbKFteXFtcXV0rKVxdL2csIi4kMSIpLHIuI2koYSkucmVwbGFjZSgvXCIvZywiIildfSkpO09iamVjdC5rZXlzKGkpLmZvckVhY2goZT0+YS5zZXQodCxlLGlbZV0pKTticmVha31jYXNlIm9iamVjdCI6c3dpdGNoKGUpe2Nhc2UgbnVsbDpicmVhaztkZWZhdWx0Ontjb25zdCByPXt9O09iamVjdC5rZXlzKGUpLmZvckVhY2godD0+YS5zZXQocix0LGVbdF0pKSx0PXI7YnJlYWt9fWJyZWFrO2Nhc2UidW5kZWZpbmVkIjp0PXt9fXJldHVybiB0fXN0YXRpYyBzdHJpbmdpZnkoZT17fSl7aWYoIWV8fCJvYmplY3QiIT10eXBlb2YgZSlyZXR1cm4iIjtjb25zdCB0PVtdO3JldHVybiBPYmplY3Qua2V5cyhlKS5mb3JFYWNoKGE9PnIuI28oZSxhLHQpKSwwPT09dC5sZW5ndGg/IiI6dC5tYXAoKFtlLHRdKT0+YCR7ci4jcyhyLiNsKGUpKX09JHtyLiNzKHQpfWApLmpvaW4oIiYiKX1zdGF0aWMjbyhlLHQsbil7Y29uc3QgaT1hLmdldChlLHQpO3ZvaWQgMCE9PWkmJihudWxsIT09aT9BcnJheS5pc0FycmF5KGkpP2kuZm9yRWFjaCgoYSxpKT0+e3ZvaWQgMCE9PWEmJnIuI28oZSxgJHt0fVske2l9XWAsbil9KTpyLiNuKGkpP09iamVjdC5rZXlzKGkpLmZvckVhY2goYT0+ci4jbyhlLGAke3R9LiR7YX1gLG4pKTpuLnB1c2goW3QsU3RyaW5nKGkpXSk6bi5wdXNoKFt0LCIiXSkpfXN0YXRpYyNsKGUpe2NvbnN0W3QsLi4ucl09YS50b1BhdGgoZSk7cmV0dXJuIHIucmVkdWNlKChlLHQpPT4vXlxkKyQvLnRlc3QodCk/YCR7ZX1bJHt0fV1gOmAke2V9LiR7dH1gLHQpfXN0YXRpYyNuKGUpe2lmKG51bGw9PT1lfHwib2JqZWN0IiE9dHlwZW9mIGV8fEFycmF5LmlzQXJyYXkoZSkpcmV0dXJuITE7Y29uc3QgdD1PYmplY3QuZ2V0UHJvdG90eXBlT2YoZSk7cmV0dXJuIG51bGw9PT10fHx0PT09T2JqZWN0LnByb3RvdHlwZX1zdGF0aWMjcyhlKXtyZXR1cm4gZW5jb2RlVVJJQ29tcG9uZW50KGUpfXN0YXRpYyNpKGUpe3JldHVybiBkZWNvZGVVUklDb21wb25lbnQoZS5yZXBsYWNlKC9cKy9nLCIgIikpfX10LmRlYnVnKCIgJGFyZ3VtZW50IiksZ2xvYmFsVGhpcy4kYXJndW1lbnQ9ci5wYXJzZShnbG9iYWxUaGlzLiRhcmd1bWVudCksZ2xvYmFsVGhpcy4kYXJndW1lbnQuTG9nTGV2ZWwmJih0LmxvZ0xldmVsPWdsb2JhbFRoaXMuJGFyZ3VtZW50LkxvZ0xldmVsKSx0LmRlYnVnKCIgJGFyZ3VtZW50IixgJGFyZ3VtZW50OiAke0pTT04uc3RyaW5naWZ5KGdsb2JhbFRoaXMuJGFyZ3VtZW50KX1gKTtjb25zdCBuPXsxMDA6IkNvbnRpbnVlIiwxMDE6IlN3aXRjaGluZyBQcm90b2NvbHMiLDEwMjoiUHJvY2Vzc2luZyIsMTAzOiJFYXJseSBIaW50cyIsMjAwOiJPSyIsMjAxOiJDcmVhdGVkIiwyMDI6IkFjY2VwdGVkIiwyMDM6Ik5vbi1BdXRob3JpdGF0aXZlIEluZm9ybWF0aW9uIiwyMDQ6Ik5vIENvbnRlbnQiLDIwNToiUmVzZXQgQ29udGVudCIsMjA2OiJQYXJ0aWFsIENvbnRlbnQiLDIwNzoiTXVsdGktU3RhdHVzIiwyMDg6IkFscmVhZHkgUmVwb3J0ZWQiLDIyNjoiSU0gVXNlZCIsMzAwOiJNdWx0aXBsZSBDaG9pY2VzIiwzMDE6Ik1vdmVkIFBlcm1hbmVudGx5IiwzMDI6IkZvdW5kIiwzMDQ6Ik5vdCBNb2RpZmllZCIsMzA3OiJUZW1wb3JhcnkgUmVkaXJlY3QiLDMwODoiUGVybWFuZW50IFJlZGlyZWN0Iiw0MDA6IkJhZCBSZXF1ZXN0Iiw0MDE6IlVuYXV0aG9yaXplZCIsNDAyOiJQYXltZW50IFJlcXVpcmVkIiw0MDM6IkZvcmJpZGRlbiIsNDA0OiJOb3QgRm91bmQiLDQwNToiTWV0aG9kIE5vdCBBbGxvd2VkIiw0MDY6Ik5vdCBBY2NlcHRhYmxlIiw0MDc6IlByb3h5IEF1dGhlbnRpY2F0aW9uIFJlcXVpcmVkIiw0MDg6IlJlcXVlc3QgVGltZW91dCIsNDA5OiJDb25mbGljdCIsNDEwOiJHb25lIiw0MTE6Ikxlbmd0aCBSZXF1aXJlZCIsNDEyOiJQcmVjb25kaXRpb24gRmFpbGVkIiw0MTM6IkNvbnRlbnQgVG9vIExhcmdlIiw0MTQ6IlVSSSBUb28gTG9uZyIsNDE1OiJVbnN1cHBvcnRlZCBNZWRpYSBUeXBlIiw0MTY6IlJhbmdlIE5vdCBTYXRpc2ZpYWJsZSIsNDE3OiJFeHBlY3RhdGlvbiBGYWlsZWQiLDQxODoiSSdtIGEgdGVhcG90Iiw0MjE6Ik1pc2RpcmVjdGVkIFJlcXVlc3QiLDQyMjoiVW5wcm9jZXNzYWJsZSBFbnRpdHkiLDQyMzoiTG9ja2VkIiw0MjQ6IkZhaWxlZCBEZXBlbmRlbmN5Iiw0MjU6IlRvbyBFYXJseSIsNDI2OiJVcGdyYWRlIFJlcXVpcmVkIiw0Mjg6IlByZWNvbmRpdGlvbiBSZXF1aXJlZCIsNDI5OiJUb28gTWFueSBSZXF1ZXN0cyIsNDMxOiJSZXF1ZXN0IEhlYWRlciBGaWVsZHMgVG9vIExhcmdlIiw0NTE6IlVuYXZhaWxhYmxlIEZvciBMZWdhbCBSZWFzb25zIiw1MDA6IkludGVybmFsIFNlcnZlciBFcnJvciIsNTAxOiJOb3QgSW1wbGVtZW50ZWQiLDUwMjoiQmFkIEdhdGV3YXkiLDUwMzoiU2VydmljZSBVbmF2YWlsYWJsZSIsNTA0OiJHYXRld2F5IFRpbWVvdXQiLDUwNToiSFRUUCBWZXJzaW9uIE5vdCBTdXBwb3J0ZWQiLDUwNjoiVmFyaWFudCBBbHNvIE5lZ290aWF0ZXMiLDUwNzoiSW5zdWZmaWNpZW50IFN0b3JhZ2UiLDUwODoiTG9vcCBEZXRlY3RlZCIsNTEwOiJOb3QgRXh0ZW5kZWQiLDUxMToiTmV0d29yayBBdXRoZW50aWNhdGlvbiBSZXF1aXJlZCJ9O2Z1bmN0aW9uIGkocj17fSl7c3dpdGNoKGUpe2Nhc2UiU3VyZ2UiOnIucG9saWN5JiZhLnNldChyLCJoZWFkZXJzLlgtU3VyZ2UtUG9saWN5IixyLnBvbGljeSksdC5sb2coIiDmiafooYznu5PmnZ8hIixgICR7KG5ldyBEYXRlKS5nZXRUaW1lKCkvMWUzLSRzY3JpcHQuc3RhcnRUaW1lfSDnp5JgKSwkZG9uZShyKTticmVhaztjYXNlIkxvb24iOnIucG9saWN5JiYoci5ub2RlPXIucG9saWN5KSx0LmxvZygiIOaJp+ihjOe7k+adnyEiLGAgJHsobmV3IERhdGUtJHNjcmlwdC5zdGFydFRpbWUpLzFlM30g56eSYCksJGRvbmUocik7YnJlYWs7Y2FzZSJTdGFzaCI6ci5wb2xpY3kmJmEuc2V0KHIsImhlYWRlcnMuWC1TdGFzaC1TZWxlY3RlZC1Qcm94eSIsZW5jb2RlVVJJKHIucG9saWN5KSksdC5sb2coIiDmiafooYznu5PmnZ8hIixgICR7KG5ldyBEYXRlLSRzY3JpcHQuc3RhcnRUaW1lKS8xZTN9IOenkmApLCRkb25lKHIpO2JyZWFrO2Nhc2UiRWdlcm4iOmNhc2UiU2hhZG93cm9ja2V0Ijp0LmxvZygiIOaJp+ihjOe7k+adnyEiKSwkZG9uZShyKTticmVhaztjYXNlIlF1YW50dW11bHQgWCI6c3dpdGNoKHIucG9saWN5JiZhLnNldChyLCJvcHRzLnBvbGljeSIsci5wb2xpY3kpLHR5cGVvZihyPWEucGljayhyLFsic3RhdHVzIiwidXJsIiwiaGVhZGVycyIsImJvZHkiLCJib2R5Qnl0ZXMiXSkpLnN0YXR1cyl7Y2FzZSJudW1iZXIiOnIuc3RhdHVzPWBIVFRQLzEuMSAke3Iuc3RhdHVzfSAke25bci5zdGF0dXNdfWA7YnJlYWs7Y2FzZSJzdHJpbmciOmNhc2UidW5kZWZpbmVkIjpicmVhaztkZWZhdWx0OnRocm93IG5ldyBUeXBlRXJyb3IoYCR7RnVuY3Rpb24ubmFtZX06IOWPguaVsOexu+Wei+mUmeivrywgc3RhdHVzIOW/hemhu+S4uuaVsOWtl+aIluWtl+espuS4smApfXIuYm9keSBpbnN0YW5jZW9mIEFycmF5QnVmZmVyPyhyLmJvZHlCeXRlcz1yLmJvZHksci5ib2R5PXZvaWQgMCk6QXJyYXlCdWZmZXIuaXNWaWV3KHIuYm9keSk/KHIuYm9keUJ5dGVzPXIuYm9keS5idWZmZXIuc2xpY2Uoci5ib2R5LmJ5dGVPZmZzZXQsci5ib2R5LmJ5dGVMZW5ndGgrci5ib2R5LmJ5dGVPZmZzZXQpLHIuYm9keT12b2lkIDApOnIuYm9keSYmKHIuYm9keUJ5dGVzPXZvaWQgMCksdC5sb2coIiDmiafooYznu5PmnZ8hIiksJGRvbmUocik7YnJlYWs7Y2FzZSJXb3JrZXIiOmRlZmF1bHQ6dC5sb2coIiDmiafooYznu5PmnZ8hIik7YnJlYWs7Y2FzZSJOb2RlLmpzIjp0LmxvZygiIOaJp+ihjOe7k+adnyEiKSxwcm9jZXNzLmV4aXQoMSl9fWNsYXNzIG97c3RhdGljIGRhdGE9bnVsbDtzdGF0aWMgZGF0YUZpbGU9ImJveC5kYXQiO3N0YXRpYyNjPS9eQCg/PGtleT5bXi5dKykoPzpcLig/PHBhdGg+LiopKT8kLztzdGF0aWMgZ2V0SXRlbSh0LHI9bnVsbCl7bGV0IG49cjtzd2l0Y2godC5zdGFydHNXaXRoKCJAIikpe2Nhc2UhMDp7Y29uc3R7a2V5OmUscGF0aDpyfT10Lm1hdGNoKG8uI2MpPy5ncm91cHM7dD1lO2xldCBpPW8uZ2V0SXRlbSh0LHt9KTsib2JqZWN0IiE9dHlwZW9mIGkmJihpPXt9KSxuPWEuZ2V0KGkscik7dHJ5e249SlNPTi5wYXJzZShuKX1jYXRjaHt9YnJlYWt9ZGVmYXVsdDpzd2l0Y2goZSl7Y2FzZSJTdXJnZSI6Y2FzZSJMb29uIjpjYXNlIlN0YXNoIjpjYXNlIkVnZXJuIjpjYXNlIlNoYWRvd3JvY2tldCI6bj0kcGVyc2lzdGVudFN0b3JlLnJlYWQodCk7YnJlYWs7Y2FzZSJRdWFudHVtdWx0IFgiOm49JHByZWZzLnZhbHVlRm9yS2V5KHQpO2JyZWFrO2Nhc2UiV29ya2VyIjpvLmRhdGE9by5kYXRhPz97fSxuPW8uZGF0YVt0XTticmVhaztjYXNlIk5vZGUuanMiOm8uZGF0YT1vLiNkKG8uZGF0YUZpbGUpLG49by5kYXRhPy5bdF07YnJlYWs7ZGVmYXVsdDpuPW8uZGF0YT8uW3RdfHxudWxsfXRyeXtuPUpTT04ucGFyc2Uobil9Y2F0Y2h7fX1yZXR1cm4gbj8/cn1zdGF0aWMgc2V0SXRlbSh0PW5ldyBTdHJpbmcscj1uZXcgU3RyaW5nKXtsZXQgbj0hMTtpZigib2JqZWN0Ij09dHlwZW9mIHIpcj1KU09OLnN0cmluZ2lmeShyKTtlbHNlIHI9U3RyaW5nKHIpO3N3aXRjaCh0LnN0YXJ0c1dpdGgoIkAiKSl7Y2FzZSEwOntjb25zdHtrZXk6ZSxwYXRoOml9PXQubWF0Y2goby4jYyk/Lmdyb3Vwczt0PWU7bGV0IHM9by5nZXRJdGVtKHQse30pOyJvYmplY3QiIT10eXBlb2YgcyYmKHM9e30pLGEuc2V0KHMsaSxyKSxuPW8uc2V0SXRlbSh0LHMpO2JyZWFrfWRlZmF1bHQ6c3dpdGNoKGUpe2Nhc2UiU3VyZ2UiOmNhc2UiTG9vbiI6Y2FzZSJTdGFzaCI6Y2FzZSJFZ2VybiI6Y2FzZSJTaGFkb3dyb2NrZXQiOm49JHBlcnNpc3RlbnRTdG9yZS53cml0ZShyLHQpO2JyZWFrO2Nhc2UiUXVhbnR1bXVsdCBYIjpuPSRwcmVmcy5zZXRWYWx1ZUZvcktleShyLHQpO2JyZWFrO2Nhc2UiV29ya2VyIjpvLmRhdGE9by5kYXRhPz97fSxvLmRhdGFbdF09cixuPSEwO2JyZWFrO2Nhc2UiTm9kZS5qcyI6by5kYXRhPW8uI2Qoby5kYXRhRmlsZSksby5kYXRhW3RdPXIsby4jdShvLmRhdGFGaWxlKSxuPSEwO2JyZWFrO2RlZmF1bHQ6bj1vLmRhdGE/Llt0XXx8bnVsbH19cmV0dXJuIG59c3RhdGljIHJlbW92ZUl0ZW0odCl7bGV0IHI9ITE7c3dpdGNoKHQuc3RhcnRzV2l0aCgiQCIpKXtjYXNlITA6e2NvbnN0e2tleTplLHBhdGg6bn09dC5tYXRjaChvLiNjKT8uZ3JvdXBzO3Q9ZTtsZXQgaT1vLmdldEl0ZW0odCk7Im9iamVjdCIhPXR5cGVvZiBpJiYoaT17fSksYS51bnNldChpLG4pLHI9by5zZXRJdGVtKHQsaSk7YnJlYWt9ZGVmYXVsdDpzd2l0Y2goZSl7Y2FzZSJTdXJnZSI6cj0kcGVyc2lzdGVudFN0b3JlLndyaXRlKG51bGwsdCk7YnJlYWs7Y2FzZSJMb29uIjpjYXNlIlN0YXNoIjpjYXNlIkVnZXJuIjpjYXNlIlNoYWRvd3JvY2tldCI6ZGVmYXVsdDpyPSExO2JyZWFrO2Nhc2UiUXVhbnR1bXVsdCBYIjpyPSRwcmVmcy5yZW1vdmVWYWx1ZUZvcktleSh0KTticmVhaztjYXNlIldvcmtlciI6by5kYXRhPW8uZGF0YT8/e30sZGVsZXRlIG8uZGF0YVt0XSxyPSEwO2JyZWFrO2Nhc2UiTm9kZS5qcyI6by5kYXRhPW8uI2Qoby5kYXRhRmlsZSksZGVsZXRlIG8uZGF0YVt0XSxvLiN1KG8uZGF0YUZpbGUpLHI9ITB9fXJldHVybiByfXN0YXRpYyBjbGVhcigpe2xldCB0PSExO3N3aXRjaChlKXtjYXNlIlN1cmdlIjpjYXNlIkxvb24iOmNhc2UiU3Rhc2giOmNhc2UiRWdlcm4iOmNhc2UiU2hhZG93cm9ja2V0IjpkZWZhdWx0OnQ9ITE7YnJlYWs7Y2FzZSJRdWFudHVtdWx0IFgiOnQ9JHByZWZzLnJlbW92ZUFsbFZhbHVlcygpO2JyZWFrO2Nhc2UiV29ya2VyIjpvLmRhdGE9e30sdD0hMDticmVhaztjYXNlIk5vZGUuanMiOm8uZGF0YT1vLiNkKG8uZGF0YUZpbGUpLG8uZGF0YT17fSxvLiN1KG8uZGF0YUZpbGUpLHQ9ITB9cmV0dXJuIHR9c3RhdGljI2Q9dD0+e2lmKCJOb2RlLmpzIiE9PWUpcmV0dXJue307e3RoaXMuZnM9dGhpcy5mcz90aGlzLmZzOnJlcXVpcmUoImZzIiksdGhpcy5wYXRoPXRoaXMucGF0aD90aGlzLnBhdGg6cmVxdWlyZSgicGF0aCIpO2NvbnN0IGU9dGhpcy5wYXRoLnJlc29sdmUodCksYT10aGlzLnBhdGgucmVzb2x2ZShwcm9jZXNzLmN3ZCgpLHQpLHI9dGhpcy5mcy5leGlzdHNTeW5jKGUpLG49IXImJnRoaXMuZnMuZXhpc3RzU3luYyhhKTtpZighciYmIW4pcmV0dXJue307e2NvbnN0IHQ9cj9lOmE7dHJ5e3JldHVybiBKU09OLnBhcnNlKHRoaXMuZnMucmVhZEZpbGVTeW5jKHQpKX1jYXRjaChlKXtyZXR1cm57fX19fX07c3RhdGljI3U9KHQ9dGhpcy5kYXRhRmlsZSk9PntpZigiTm9kZS5qcyI9PT1lKXt0aGlzLmZzPXRoaXMuZnM/dGhpcy5mczpyZXF1aXJlKCJmcyIpLHRoaXMucGF0aD10aGlzLnBhdGg/dGhpcy5wYXRoOnJlcXVpcmUoInBhdGgiKTtjb25zdCBlPXRoaXMucGF0aC5yZXNvbHZlKHQpLGE9dGhpcy5wYXRoLnJlc29sdmUocHJvY2Vzcy5jd2QoKSx0KSxyPXRoaXMuZnMuZXhpc3RzU3luYyhlKSxuPSFyJiZ0aGlzLmZzLmV4aXN0c1N5bmMoYSksaT1KU09OLnN0cmluZ2lmeSh0aGlzLmRhdGEpO3I/dGhpcy5mcy53cml0ZUZpbGVTeW5jKGUsaSk6bj90aGlzLmZzLndyaXRlRmlsZVN5bmMoYSxpKTp0aGlzLmZzLndyaXRlRmlsZVN5bmMoZSxpKX19fWZ1bmN0aW9uIHMoZSl7bGV0IHQ9ZS5sZW5ndGg7Zm9yKDstLXQ+PTA7KWVbdF09MH1zKG5ldyBBcnJheSg1NzYpKTtzKG5ldyBBcnJheSg2MCkpO3MobmV3IEFycmF5KDUxMikpO3MobmV3IEFycmF5KDI1NikpO3MobmV3IEFycmF5KDI5KSk7cyhuZXcgQXJyYXkoMzApKTt2YXIgbD0oZSx0LGEscik9PntsZXQgbj02NTUzNSZlLGk9ZT4+PjE2JjY1NTM1LG89MDtmb3IoOzAhPT1hOyl7bz1hPjJlMz8yZTM6YSxhLT1vO2Rve249bit0W3IrK118MCxpPWkrbnwwfXdoaWxlKC0tbyk7biU9NjU1MjEsaSU9NjU1MjF9cmV0dXJuIG58aTw8MTZ9O2NvbnN0IGM9bmV3IFVpbnQzMkFycmF5KCgoKT0+e2xldCBlLHQ9W107Zm9yKHZhciBhPTA7YTwyNTY7YSsrKXtlPWE7Zm9yKHZhciByPTA7cjw4O3IrKyllPTEmZT8zOTg4MjkyMzg0XmU+Pj4xOmU+Pj4xO3RbYV09ZX1yZXR1cm4gdH0pKCkpO3ZhciBkPShlLHQsYSxyKT0+e2NvbnN0IG49YyxpPXIrYTtlXj0tMTtmb3IobGV0IGE9cjthPGk7YSsrKWU9ZT4+PjheblsyNTUmKGVedFthXSldO3JldHVybi0xXmV9LHU9ezI6Im5lZWQgZGljdGlvbmFyeSIsMToic3RyZWFtIGVuZCIsMDoiIiwiLTEiOiJmaWxlIGVycm9yIiwiLTIiOiJzdHJlYW0gZXJyb3IiLCItMyI6ImRhdGEgZXJyb3IiLCItNCI6Imluc3VmZmljaWVudCBtZW1vcnkiLCItNSI6ImJ1ZmZlciBlcnJvciIsIi02IjoiaW5jb21wYXRpYmxlIHZlcnNpb24ifSxmPXtaX05PX0ZMVVNIOjAsWl9GSU5JU0g6NCxaX0JMT0NLOjUsWl9UUkVFUzo2LFpfT0s6MCxaX1NUUkVBTV9FTkQ6MSxaX05FRURfRElDVDoyLFpfU1RSRUFNX0VSUk9SOi0yLFpfREFUQV9FUlJPUjotMyxaX01FTV9FUlJPUjotNCxaX0JVRl9FUlJPUjotNSxaX0RFRkxBVEVEOjh9O2NvbnN0IGg9KGUsdCk9Pk9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChlLHQpO3ZhciB3PWZ1bmN0aW9uKGUpe2NvbnN0IHQ9QXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzLDEpO2Zvcig7dC5sZW5ndGg7KXtjb25zdCBhPXQuc2hpZnQoKTtpZihhKXtpZigib2JqZWN0IiE9dHlwZW9mIGEpdGhyb3cgbmV3IFR5cGVFcnJvcihhKyJtdXN0IGJlIG5vbi1vYmplY3QiKTtmb3IoY29uc3QgdCBpbiBhKWgoYSx0KSYmKGVbdF09YVt0XSl9fXJldHVybiBlfSxnPWU9PntsZXQgdD0wO2ZvcihsZXQgYT0wLHI9ZS5sZW5ndGg7YTxyO2ErKyl0Kz1lW2FdLmxlbmd0aDtjb25zdCBhPW5ldyBVaW50OEFycmF5KHQpO2ZvcihsZXQgdD0wLHI9MCxuPWUubGVuZ3RoO3Q8bjt0Kyspe2xldCBuPWVbdF07YS5zZXQobixyKSxyKz1uLmxlbmd0aH1yZXR1cm4gYX07bGV0IHA9ITA7dHJ5e1N0cmluZy5mcm9tQ2hhckNvZGUuYXBwbHkobnVsbCxuZXcgVWludDhBcnJheSgxKSl9Y2F0Y2goZSl7cD0hMX1jb25zdCBiPW5ldyBVaW50OEFycmF5KDI1Nik7Zm9yKGxldCBlPTA7ZTwyNTY7ZSsrKWJbZV09ZT49MjUyPzY6ZT49MjQ4PzU6ZT49MjQwPzQ6ZT49MjI0PzM6ZT49MTkyPzI6MTtiWzI1NF09YlsyNTVdPTE7dmFyIG09ZT0+e2lmKCJmdW5jdGlvbiI9PXR5cGVvZiBUZXh0RW5jb2RlciYmVGV4dEVuY29kZXIucHJvdG90eXBlLmVuY29kZSlyZXR1cm4obmV3IFRleHRFbmNvZGVyKS5lbmNvZGUoZSk7bGV0IHQsYSxyLG4saSxvPWUubGVuZ3RoLHM9MDtmb3Iobj0wO248bztuKyspYT1lLmNoYXJDb2RlQXQobiksNTUyOTY9PSg2NDUxMiZhKSYmbisxPG8mJihyPWUuY2hhckNvZGVBdChuKzEpLDU2MzIwPT0oNjQ1MTImcikmJihhPTY1NTM2KyhhLTU1Mjk2PDwxMCkrKHItNTYzMjApLG4rKykpLHMrPWE8MTI4PzE6YTwyMDQ4PzI6YTw2NTUzNj8zOjQ7Zm9yKHQ9bmV3IFVpbnQ4QXJyYXkocyksaT0wLG49MDtpPHM7bisrKWE9ZS5jaGFyQ29kZUF0KG4pLDU1Mjk2PT0oNjQ1MTImYSkmJm4rMTxvJiYocj1lLmNoYXJDb2RlQXQobisxKSw1NjMyMD09KDY0NTEyJnIpJiYoYT02NTUzNisoYS01NTI5Njw8MTApKyhyLTU2MzIwKSxuKyspKSxhPDEyOD90W2krK109YTphPDIwNDg/KHRbaSsrXT0xOTJ8YT4+PjYsdFtpKytdPTEyOHw2MyZhKTphPDY1NTM2Pyh0W2krK109MjI0fGE+Pj4xMix0W2krK109MTI4fGE+Pj42JjYzLHRbaSsrXT0xMjh8NjMmYSk6KHRbaSsrXT0yNDB8YT4+PjE4LHRbaSsrXT0xMjh8YT4+PjEyJjYzLHRbaSsrXT0xMjh8YT4+PjYmNjMsdFtpKytdPTEyOHw2MyZhKTtyZXR1cm4gdH0seT0oZSx0KT0+e2NvbnN0IGE9dHx8ZS5sZW5ndGg7aWYoImZ1bmN0aW9uIj09dHlwZW9mIFRleHREZWNvZGVyJiZUZXh0RGVjb2Rlci5wcm90b3R5cGUuZGVjb2RlKXJldHVybihuZXcgVGV4dERlY29kZXIpLmRlY29kZShlLnN1YmFycmF5KDAsdCkpO2xldCByLG47Y29uc3QgaT1uZXcgQXJyYXkoMiphKTtmb3Iobj0wLHI9MDtyPGE7KXtsZXQgdD1lW3IrK107aWYodDwxMjgpe2lbbisrXT10O2NvbnRpbnVlfWxldCBvPWJbdF07aWYobz40KWlbbisrXT02NTUzMyxyKz1vLTE7ZWxzZXtmb3IodCY9Mj09PW8/MzE6Mz09PW8/MTU6NztvPjEmJnI8YTspdD10PDw2fDYzJmVbcisrXSxvLS07bz4xP2lbbisrXT02NTUzMzp0PDY1NTM2P2lbbisrXT10Oih0LT02NTUzNixpW24rK109NTUyOTZ8dD4+MTAmMTAyMyxpW24rK109NTYzMjB8MTAyMyZ0KX19cmV0dXJuKChlLHQpPT57aWYodDw2NTUzNCYmZS5zdWJhcnJheSYmcClyZXR1cm4gU3RyaW5nLmZyb21DaGFyQ29kZS5hcHBseShudWxsLGUubGVuZ3RoPT09dD9lOmUuc3ViYXJyYXkoMCx0KSk7bGV0IGE9IiI7Zm9yKGxldCByPTA7cjx0O3IrKylhKz1TdHJpbmcuZnJvbUNoYXJDb2RlKGVbcl0pO3JldHVybiBhfSkoaSxuKX0saz0oZSx0KT0+eyh0PXR8fGUubGVuZ3RoKT5lLmxlbmd0aCYmKHQ9ZS5sZW5ndGgpO2xldCBhPXQtMTtmb3IoO2E+PTAmJjEyOD09KDE5MiZlW2FdKTspYS0tO3JldHVybiBhPDB8fDA9PT1hP3Q6YStiW2VbYV1dPnQ/YTp0fTt2YXIgdj1mdW5jdGlvbigpe3RoaXMuaW5wdXQ9bnVsbCx0aGlzLm5leHRfaW49MCx0aGlzLmF2YWlsX2luPTAsdGhpcy50b3RhbF9pbj0wLHRoaXMub3V0cHV0PW51bGwsdGhpcy5uZXh0X291dD0wLHRoaXMuYXZhaWxfb3V0PTAsdGhpcy50b3RhbF9vdXQ9MCx0aGlzLm1zZz0iIix0aGlzLnN0YXRlPW51bGwsdGhpcy5kYXRhX3R5cGU9Mix0aGlzLmFkbGVyPTB9O2NvbnN0IF89MTYyMDk7dmFyIHg9ZnVuY3Rpb24oZSx0KXtsZXQgYSxyLG4saSxvLHMsbCxjLGQsdSxmLGgsdyxnLHAsYixtLHksayx2LHgsRSxBLCQ7Y29uc3QgUj1lLnN0YXRlO2E9ZS5uZXh0X2luLEE9ZS5pbnB1dCxyPWErKGUuYXZhaWxfaW4tNSksbj1lLm5leHRfb3V0LCQ9ZS5vdXRwdXQsaT1uLSh0LWUuYXZhaWxfb3V0KSxvPW4rKGUuYXZhaWxfb3V0LTI1Nykscz1SLmRtYXgsbD1SLndzaXplLGM9Ui53aGF2ZSxkPVIud25leHQsdT1SLndpbmRvdyxmPVIuaG9sZCxoPVIuYml0cyx3PVIubGVuY29kZSxnPVIuZGlzdGNvZGUscD0oMTw8Ui5sZW5iaXRzKS0xLGI9KDE8PFIuZGlzdGJpdHMpLTE7ZTpkb3toPDE1JiYoZis9QVthKytdPDxoLGgrPTgsZis9QVthKytdPDxoLGgrPTgpLG09d1tmJnBdO3Q6Zm9yKDs7KXtpZih5PW0+Pj4yNCxmPj4+PXksaC09eSx5PW0+Pj4xNiYyNTUsMD09PXkpJFtuKytdPTY1NTM1Jm07ZWxzZXtpZighKDE2JnkpKXtpZig2NCZ5KXtpZigzMiZ5KXtSLm1vZGU9MTYxOTE7YnJlYWsgZX1lLm1zZz0iaW52YWxpZCBsaXRlcmFsL2xlbmd0aCBjb2RlIixSLm1vZGU9XzticmVhayBlfW09d1soNjU1MzUmbSkrKGYmKDE8PHkpLTEpXTtjb250aW51ZSB0fWZvcihrPTY1NTM1Jm0seSY9MTUseSYmKGg8eSYmKGYrPUFbYSsrXTw8aCxoKz04KSxrKz1mJigxPDx5KS0xLGY+Pj49eSxoLT15KSxoPDE1JiYoZis9QVthKytdPDxoLGgrPTgsZis9QVthKytdPDxoLGgrPTgpLG09Z1tmJmJdOzspe2lmKHk9bT4+PjI0LGY+Pj49eSxoLT15LHk9bT4+PjE2JjI1NSwxNiZ5KXtpZih2PTY1NTM1Jm0seSY9MTUsaDx5JiYoZis9QVthKytdPDxoLGgrPTgsaDx5JiYoZis9QVthKytdPDxoLGgrPTgpKSx2Kz1mJigxPDx5KS0xLHY+cyl7ZS5tc2c9ImludmFsaWQgZGlzdGFuY2UgdG9vIGZhciBiYWNrIixSLm1vZGU9XzticmVhayBlfWlmKGY+Pj49eSxoLT15LHk9bi1pLHY+eSl7aWYoeT12LXkseT5jJiZSLnNhbmUpe2UubXNnPSJpbnZhbGlkIGRpc3RhbmNlIHRvbyBmYXIgYmFjayIsUi5tb2RlPV87YnJlYWsgZX1pZih4PTAsRT11LDA9PT1kKXtpZih4Kz1sLXkseTxrKXtrLT15O2RveyRbbisrXT11W3grK119d2hpbGUoLS15KTt4PW4tdixFPSR9fWVsc2UgaWYoZDx5KXtpZih4Kz1sK2QteSx5LT1kLHk8ayl7ay09eTtkb3skW24rK109dVt4KytdfXdoaWxlKC0teSk7aWYoeD0wLGQ8ayl7eT1kLGstPXk7ZG97JFtuKytdPXVbeCsrXX13aGlsZSgtLXkpO3g9bi12LEU9JH19fWVsc2UgaWYoeCs9ZC15LHk8ayl7ay09eTtkb3skW24rK109dVt4KytdfXdoaWxlKC0teSk7eD1uLXYsRT0kfWZvcig7az4yOykkW24rK109RVt4KytdLCRbbisrXT1FW3grK10sJFtuKytdPUVbeCsrXSxrLT0zO2smJigkW24rK109RVt4KytdLGs+MSYmKCRbbisrXT1FW3grK10pKX1lbHNle3g9bi12O2RveyRbbisrXT0kW3grK10sJFtuKytdPSRbeCsrXSwkW24rK109JFt4KytdLGstPTN9d2hpbGUoaz4yKTtrJiYoJFtuKytdPSRbeCsrXSxrPjEmJigkW24rK109JFt4KytdKSl9YnJlYWt9aWYoNjQmeSl7ZS5tc2c9ImludmFsaWQgZGlzdGFuY2UgY29kZSIsUi5tb2RlPV87YnJlYWsgZX1tPWdbKDY1NTM1Jm0pKyhmJigxPDx5KS0xKV19fWJyZWFrfX13aGlsZShhPHImJm48byk7az1oPj4zLGEtPWssaC09azw8MyxmJj0oMTw8aCktMSxlLm5leHRfaW49YSxlLm5leHRfb3V0PW4sZS5hdmFpbF9pbj1hPHI/ci1hKzU6NS0oYS1yKSxlLmF2YWlsX291dD1uPG8/by1uKzI1NzoyNTctKG4tbyksUi5ob2xkPWYsUi5iaXRzPWh9O2NvbnN0IEU9MTUsQT1uZXcgVWludDE2QXJyYXkoWzMsNCw1LDYsNyw4LDksMTAsMTEsMTMsMTUsMTcsMTksMjMsMjcsMzEsMzUsNDMsNTEsNTksNjcsODMsOTksMTE1LDEzMSwxNjMsMTk1LDIyNywyNTgsMCwwXSksJD1uZXcgVWludDhBcnJheShbMTYsMTYsMTYsMTYsMTYsMTYsMTYsMTYsMTcsMTcsMTcsMTcsMTgsMTgsMTgsMTgsMTksMTksMTksMTksMjAsMjAsMjAsMjAsMjEsMjEsMjEsMjEsMTYsMTk5LDc1XSksUj1uZXcgVWludDE2QXJyYXkoWzEsMiwzLDQsNSw3LDksMTMsMTcsMjUsMzMsNDksNjUsOTcsMTI5LDE5MywyNTcsMzg1LDUxMyw3NjksMTAyNSwxNTM3LDIwNDksMzA3Myw0MDk3LDYxNDUsODE5MywxMjI4OSwxNjM4NSwyNDU3NywwLDBdKSxTPW5ldyBVaW50OEFycmF5KFsxNiwxNiwxNiwxNiwxNywxNywxOCwxOCwxOSwxOSwyMCwyMCwyMSwyMSwyMiwyMiwyMywyMywyNCwyNCwyNSwyNSwyNiwyNiwyNywyNywyOCwyOCwyOSwyOSw2NCw2NF0pO3ZhciBUPShlLHQsYSxyLG4saSxvLHMpPT57Y29uc3QgbD1zLmJpdHM7bGV0IGMsZCx1LGYsaCx3LGc9MCxwPTAsYj0wLG09MCx5PTAsaz0wLHY9MCxfPTAseD0wLFQ9MCxOPW51bGw7Y29uc3QgTT1uZXcgVWludDE2QXJyYXkoMTYpLE89bmV3IFVpbnQxNkFycmF5KDE2KTtsZXQgaixGLEksTD1udWxsO2ZvcihnPTA7Zzw9RTtnKyspTVtnXT0wO2ZvcihwPTA7cDxyO3ArKylNW3RbYStwXV0rKztmb3IoeT1sLG09RTttPj0xJiYwPT09TVttXTttLS0pO2lmKHk+bSYmKHk9bSksMD09PW0pcmV0dXJuIG5baSsrXT0yMDk3MTUyMCxuW2krK109MjA5NzE1MjAscy5iaXRzPTEsMDtmb3IoYj0xO2I8bSYmMD09PU1bYl07YisrKTtmb3IoeTxiJiYoeT1iKSxfPTEsZz0xO2c8PUU7ZysrKWlmKF88PD0xLF8tPU1bZ10sXzwwKXJldHVybi0xO2lmKF8+MCYmKDA9PT1lfHwxIT09bSkpcmV0dXJuLTE7Zm9yKE9bMV09MCxnPTE7ZzxFO2crKylPW2crMV09T1tnXStNW2ddO2ZvcihwPTA7cDxyO3ArKykwIT09dFthK3BdJiYob1tPW3RbYStwXV0rK109cCk7aWYoMD09PWU/KE49TD1vLHc9MjApOjE9PT1lPyhOPUEsTD0kLHc9MjU3KTooTj1SLEw9Uyx3PTApLFQ9MCxwPTAsZz1iLGg9aSxrPXksdj0wLHU9LTEseD0xPDx5LGY9eC0xLDE9PT1lJiZ4Pjg1Mnx8Mj09PWUmJng+NTkyKXJldHVybiAxO2Zvcig7Oyl7aj1nLXYsb1twXSsxPHc/KEY9MCxJPW9bcF0pOm9bcF0+PXc/KEY9TFtvW3BdLXddLEk9TltvW3BdLXddKTooRj05NixJPTApLGM9MTw8Zy12LGQ9MTw8ayxiPWQ7ZG97ZC09YyxuW2grKFQ+PnYpK2RdPWo8PDI0fEY8PDE2fEl9d2hpbGUoMCE9PWQpO2ZvcihjPTE8PGctMTtUJmM7KWM+Pj0xO2lmKDAhPT1jPyhUJj1jLTEsVCs9Yyk6VD0wLHArKywwPT09LS1NW2ddKXtpZihnPT09bSlicmVhaztnPXRbYStvW3BdXX1pZihnPnkmJihUJmYpIT09dSl7Zm9yKDA9PT12JiYodj15KSxoKz1iLGs9Zy12LF89MTw8aztrK3Y8bSYmKF8tPU1bayt2XSwhKF88PTApKTspaysrLF88PD0xO2lmKHgrPTE8PGssMT09PWUmJng+ODUyfHwyPT09ZSYmeD41OTIpcmV0dXJuIDE7dT1UJmYsblt1XT15PDwyNHxrPDwxNnxoLWl9fXJldHVybiAwIT09VCYmKG5baCtUXT1nLXY8PDI0fDY0PDwxNikscy5iaXRzPXksMH07Y29uc3R7Wl9GSU5JU0g6TixaX0JMT0NLOk0sWl9UUkVFUzpPLFpfT0s6aixaX1NUUkVBTV9FTkQ6RixaX05FRURfRElDVDpJLFpfU1RSRUFNX0VSUk9SOkwsWl9EQVRBX0VSUk9SOkIsWl9NRU1fRVJST1I6QyxaX0JVRl9FUlJPUjpVLFpfREVGTEFURUQ6UH09ZixEPTE2MTgwLFo9MTYxOTAsej0xNjE5MSxxPTE2MTkyLEg9MTYxOTQsVz0xNjE5OSxLPTE2MjAwLFg9MTYyMDYsUT0xNjIwOSxWPWU9PihlPj4+MjQmMjU1KSsoZT4+PjgmNjUyODApKygoNjUyODAmZSk8PDgpKygoMjU1JmUpPDwyNCk7ZnVuY3Rpb24gSigpe3RoaXMuc3RybT1udWxsLHRoaXMubW9kZT0wLHRoaXMubGFzdD0hMSx0aGlzLndyYXA9MCx0aGlzLmhhdmVkaWN0PSExLHRoaXMuZmxhZ3M9MCx0aGlzLmRtYXg9MCx0aGlzLmNoZWNrPTAsdGhpcy50b3RhbD0wLHRoaXMuaGVhZD1udWxsLHRoaXMud2JpdHM9MCx0aGlzLndzaXplPTAsdGhpcy53aGF2ZT0wLHRoaXMud25leHQ9MCx0aGlzLndpbmRvdz1udWxsLHRoaXMuaG9sZD0wLHRoaXMuYml0cz0wLHRoaXMubGVuZ3RoPTAsdGhpcy5vZmZzZXQ9MCx0aGlzLmV4dHJhPTAsdGhpcy5sZW5jb2RlPW51bGwsdGhpcy5kaXN0Y29kZT1udWxsLHRoaXMubGVuYml0cz0wLHRoaXMuZGlzdGJpdHM9MCx0aGlzLm5jb2RlPTAsdGhpcy5ubGVuPTAsdGhpcy5uZGlzdD0wLHRoaXMuaGF2ZT0wLHRoaXMubmV4dD1udWxsLHRoaXMubGVucz1uZXcgVWludDE2QXJyYXkoMzIwKSx0aGlzLndvcms9bmV3IFVpbnQxNkFycmF5KDI4OCksdGhpcy5sZW5keW49bnVsbCx0aGlzLmRpc3RkeW49bnVsbCx0aGlzLnNhbmU9MCx0aGlzLmJhY2s9MCx0aGlzLndhcz0wfWNvbnN0IEc9ZT0+e2lmKCFlKXJldHVybiAxO2NvbnN0IHQ9ZS5zdGF0ZTtyZXR1cm4hdHx8dC5zdHJtIT09ZXx8dC5tb2RlPER8fHQubW9kZT4xNjIxMT8xOjB9LFk9ZT0+e2lmKEcoZSkpcmV0dXJuIEw7Y29uc3QgdD1lLnN0YXRlO3JldHVybiBlLnRvdGFsX2luPWUudG90YWxfb3V0PXQudG90YWw9MCxlLm1zZz0iIix0LndyYXAmJihlLmFkbGVyPTEmdC53cmFwKSx0Lm1vZGU9RCx0Lmxhc3Q9MCx0LmhhdmVkaWN0PTAsdC5mbGFncz0tMSx0LmRtYXg9MzI3NjgsdC5oZWFkPW51bGwsdC5ob2xkPTAsdC5iaXRzPTAsdC5sZW5jb2RlPXQubGVuZHluPW5ldyBJbnQzMkFycmF5KDg1MiksdC5kaXN0Y29kZT10LmRpc3RkeW49bmV3IEludDMyQXJyYXkoNTkyKSx0LnNhbmU9MSx0LmJhY2s9LTEsan0sZWU9ZT0+e2lmKEcoZSkpcmV0dXJuIEw7Y29uc3QgdD1lLnN0YXRlO3JldHVybiB0LndzaXplPTAsdC53aGF2ZT0wLHQud25leHQ9MCxZKGUpfSx0ZT0oZSx0KT0+e2xldCBhO2lmKEcoZSkpcmV0dXJuIEw7Y29uc3Qgcj1lLnN0YXRlO3JldHVybiB0PDA/KGE9MCx0PS10KTooYT01Kyh0Pj40KSx0PDQ4JiYodCY9MTUpKSx0JiYodDw4fHx0PjE1KT9MOihudWxsIT09ci53aW5kb3cmJnIud2JpdHMhPT10JiYoci53aW5kb3c9bnVsbCksci53cmFwPWEsci53Yml0cz10LGVlKGUpKX0sYWU9KGUsdCk9PntpZighZSlyZXR1cm4gTDtjb25zdCBhPW5ldyBKO2Uuc3RhdGU9YSxhLnN0cm09ZSxhLndpbmRvdz1udWxsLGEubW9kZT1EO2NvbnN0IHI9dGUoZSx0KTtyZXR1cm4gciE9PWomJihlLnN0YXRlPW51bGwpLHJ9O2xldCByZSxuZSxpZT0hMDtjb25zdCBvZT1lPT57aWYoaWUpe3JlPW5ldyBJbnQzMkFycmF5KDUxMiksbmU9bmV3IEludDMyQXJyYXkoMzIpO2xldCB0PTA7Zm9yKDt0PDE0NDspZS5sZW5zW3QrK109ODtmb3IoO3Q8MjU2OyllLmxlbnNbdCsrXT05O2Zvcig7dDwyODA7KWUubGVuc1t0KytdPTc7Zm9yKDt0PDI4ODspZS5sZW5zW3QrK109ODtmb3IoVCgxLGUubGVucywwLDI4OCxyZSwwLGUud29yayx7Yml0czo5fSksdD0wO3Q8MzI7KWUubGVuc1t0KytdPTU7VCgyLGUubGVucywwLDMyLG5lLDAsZS53b3JrLHtiaXRzOjV9KSxpZT0hMX1lLmxlbmNvZGU9cmUsZS5sZW5iaXRzPTksZS5kaXN0Y29kZT1uZSxlLmRpc3RiaXRzPTV9LHNlPShlLHQsYSxyKT0+e2xldCBuO2NvbnN0IGk9ZS5zdGF0ZTtyZXR1cm4gbnVsbD09PWkud2luZG93JiYoaS53aW5kb3c9bmV3IFVpbnQ4QXJyYXkoMTw8aS53Yml0cykpLDA9PT1pLndzaXplJiYoaS53c2l6ZT0xPDxpLndiaXRzLGkud25leHQ9MCxpLndoYXZlPTApLHI+PWkud3NpemU/KGkud2luZG93LnNldCh0LnN1YmFycmF5KGEtaS53c2l6ZSxhKSwwKSxpLnduZXh0PTAsaS53aGF2ZT1pLndzaXplKToobj1pLndzaXplLWkud25leHQsbj5yJiYobj1yKSxpLndpbmRvdy5zZXQodC5zdWJhcnJheShhLXIsYS1yK24pLGkud25leHQpLChyLT1uKT8oaS53aW5kb3cuc2V0KHQuc3ViYXJyYXkoYS1yLGEpLDApLGkud25leHQ9cixpLndoYXZlPWkud3NpemUpOihpLnduZXh0Kz1uLGkud25leHQ9PT1pLndzaXplJiYoaS53bmV4dD0wKSxpLndoYXZlPGkud3NpemUmJihpLndoYXZlKz1uKSkpLDB9O3ZhciBsZT17aW5mbGF0ZVJlc2V0OmVlLGluZmxhdGVSZXNldDI6dGUsaW5mbGF0ZVJlc2V0S2VlcDpZLGluZmxhdGVJbml0OmU9PmFlKGUsMTUpLGluZmxhdGVJbml0MjphZSxpbmZsYXRlOihlLHQpPT57bGV0IGEscixuLGksbyxzLGMsdSxmLGgsdyxnLHAsYixtLHksayx2LF8sRSxBLCQsUj0wO2NvbnN0IFM9bmV3IFVpbnQ4QXJyYXkoNCk7bGV0IEosWTtjb25zdCBlZT1uZXcgVWludDhBcnJheShbMTYsMTcsMTgsMCw4LDcsOSw2LDEwLDUsMTEsNCwxMiwzLDEzLDIsMTQsMSwxNV0pO2lmKEcoZSl8fCFlLm91dHB1dHx8IWUuaW5wdXQmJjAhPT1lLmF2YWlsX2luKXJldHVybiBMO2E9ZS5zdGF0ZSxhLm1vZGU9PT16JiYoYS5tb2RlPXEpLG89ZS5uZXh0X291dCxuPWUub3V0cHV0LGM9ZS5hdmFpbF9vdXQsaT1lLm5leHRfaW4scj1lLmlucHV0LHM9ZS5hdmFpbF9pbix1PWEuaG9sZCxmPWEuYml0cyxoPXMsdz1jLCQ9ajtlOmZvcig7Oylzd2l0Y2goYS5tb2RlKXtjYXNlIEQ6aWYoMD09PWEud3JhcCl7YS5tb2RlPXE7YnJlYWt9Zm9yKDtmPDE2Oyl7aWYoMD09PXMpYnJlYWsgZTtzLS0sdSs9cltpKytdPDxmLGYrPTh9aWYoMiZhLndyYXAmJjM1NjE1PT09dSl7MD09PWEud2JpdHMmJihhLndiaXRzPTE1KSxhLmNoZWNrPTAsU1swXT0yNTUmdSxTWzFdPXU+Pj44JjI1NSxhLmNoZWNrPWQoYS5jaGVjayxTLDIsMCksdT0wLGY9MCxhLm1vZGU9MTYxODE7YnJlYWt9aWYoYS5oZWFkJiYoYS5oZWFkLmRvbmU9ITEpLCEoMSZhLndyYXApfHwoKCgyNTUmdSk8PDgpKyh1Pj44KSklMzEpe2UubXNnPSJpbmNvcnJlY3QgaGVhZGVyIGNoZWNrIixhLm1vZGU9UTticmVha31pZigoMTUmdSkhPT1QKXtlLm1zZz0idW5rbm93biBjb21wcmVzc2lvbiBtZXRob2QiLGEubW9kZT1RO2JyZWFrfWlmKHU+Pj49NCxmLT00LEE9OCsoMTUmdSksMD09PWEud2JpdHMmJihhLndiaXRzPUEpLEE+MTV8fEE+YS53Yml0cyl7ZS5tc2c9ImludmFsaWQgd2luZG93IHNpemUiLGEubW9kZT1RO2JyZWFrfWEuZG1heD0xPDxhLndiaXRzLGEuZmxhZ3M9MCxlLmFkbGVyPWEuY2hlY2s9MSxhLm1vZGU9NTEyJnU/MTYxODk6eix1PTAsZj0wO2JyZWFrO2Nhc2UgMTYxODE6Zm9yKDtmPDE2Oyl7aWYoMD09PXMpYnJlYWsgZTtzLS0sdSs9cltpKytdPDxmLGYrPTh9aWYoYS5mbGFncz11LCgyNTUmYS5mbGFncykhPT1QKXtlLm1zZz0idW5rbm93biBjb21wcmVzc2lvbiBtZXRob2QiLGEubW9kZT1RO2JyZWFrfWlmKDU3MzQ0JmEuZmxhZ3Mpe2UubXNnPSJ1bmtub3duIGhlYWRlciBmbGFncyBzZXQiLGEubW9kZT1RO2JyZWFrfWEuaGVhZCYmKGEuaGVhZC50ZXh0PXU+PjgmMSksNTEyJmEuZmxhZ3MmJjQmYS53cmFwJiYoU1swXT0yNTUmdSxTWzFdPXU+Pj44JjI1NSxhLmNoZWNrPWQoYS5jaGVjayxTLDIsMCkpLHU9MCxmPTAsYS5tb2RlPTE2MTgyO2Nhc2UgMTYxODI6Zm9yKDtmPDMyOyl7aWYoMD09PXMpYnJlYWsgZTtzLS0sdSs9cltpKytdPDxmLGYrPTh9YS5oZWFkJiYoYS5oZWFkLnRpbWU9dSksNTEyJmEuZmxhZ3MmJjQmYS53cmFwJiYoU1swXT0yNTUmdSxTWzFdPXU+Pj44JjI1NSxTWzJdPXU+Pj4xNiYyNTUsU1szXT11Pj4+MjQmMjU1LGEuY2hlY2s9ZChhLmNoZWNrLFMsNCwwKSksdT0wLGY9MCxhLm1vZGU9MTYxODM7Y2FzZSAxNjE4Mzpmb3IoO2Y8MTY7KXtpZigwPT09cylicmVhayBlO3MtLSx1Kz1yW2krK108PGYsZis9OH1hLmhlYWQmJihhLmhlYWQueGZsYWdzPTI1NSZ1LGEuaGVhZC5vcz11Pj44KSw1MTImYS5mbGFncyYmNCZhLndyYXAmJihTWzBdPTI1NSZ1LFNbMV09dT4+PjgmMjU1LGEuY2hlY2s9ZChhLmNoZWNrLFMsMiwwKSksdT0wLGY9MCxhLm1vZGU9MTYxODQ7Y2FzZSAxNjE4NDppZigxMDI0JmEuZmxhZ3Mpe2Zvcig7ZjwxNjspe2lmKDA9PT1zKWJyZWFrIGU7cy0tLHUrPXJbaSsrXTw8ZixmKz04fWEubGVuZ3RoPXUsYS5oZWFkJiYoYS5oZWFkLmV4dHJhX2xlbj11KSw1MTImYS5mbGFncyYmNCZhLndyYXAmJihTWzBdPTI1NSZ1LFNbMV09dT4+PjgmMjU1LGEuY2hlY2s9ZChhLmNoZWNrLFMsMiwwKSksdT0wLGY9MH1lbHNlIGEuaGVhZCYmKGEuaGVhZC5leHRyYT1udWxsKTthLm1vZGU9MTYxODU7Y2FzZSAxNjE4NTppZigxMDI0JmEuZmxhZ3MmJihnPWEubGVuZ3RoLGc+cyYmKGc9cyksZyYmKGEuaGVhZCYmKEE9YS5oZWFkLmV4dHJhX2xlbi1hLmxlbmd0aCxhLmhlYWQuZXh0cmF8fChhLmhlYWQuZXh0cmE9bmV3IFVpbnQ4QXJyYXkoYS5oZWFkLmV4dHJhX2xlbikpLGEuaGVhZC5leHRyYS5zZXQoci5zdWJhcnJheShpLGkrZyksQSkpLDUxMiZhLmZsYWdzJiY0JmEud3JhcCYmKGEuY2hlY2s9ZChhLmNoZWNrLHIsZyxpKSkscy09ZyxpKz1nLGEubGVuZ3RoLT1nKSxhLmxlbmd0aCkpYnJlYWsgZTthLmxlbmd0aD0wLGEubW9kZT0xNjE4NjtjYXNlIDE2MTg2OmlmKDIwNDgmYS5mbGFncyl7aWYoMD09PXMpYnJlYWsgZTtnPTA7ZG97QT1yW2krZysrXSxhLmhlYWQmJkEmJmEubGVuZ3RoPDY1NTM2JiYoYS5oZWFkLm5hbWUrPVN0cmluZy5mcm9tQ2hhckNvZGUoQSkpfXdoaWxlKEEmJmc8cyk7aWYoNTEyJmEuZmxhZ3MmJjQmYS53cmFwJiYoYS5jaGVjaz1kKGEuY2hlY2sscixnLGkpKSxzLT1nLGkrPWcsQSlicmVhayBlfWVsc2UgYS5oZWFkJiYoYS5oZWFkLm5hbWU9bnVsbCk7YS5sZW5ndGg9MCxhLm1vZGU9MTYxODc7Y2FzZSAxNjE4NzppZig0MDk2JmEuZmxhZ3Mpe2lmKDA9PT1zKWJyZWFrIGU7Zz0wO2Rve0E9cltpK2crK10sYS5oZWFkJiZBJiZhLmxlbmd0aDw2NTUzNiYmKGEuaGVhZC5jb21tZW50Kz1TdHJpbmcuZnJvbUNoYXJDb2RlKEEpKX13aGlsZShBJiZnPHMpO2lmKDUxMiZhLmZsYWdzJiY0JmEud3JhcCYmKGEuY2hlY2s9ZChhLmNoZWNrLHIsZyxpKSkscy09ZyxpKz1nLEEpYnJlYWsgZX1lbHNlIGEuaGVhZCYmKGEuaGVhZC5jb21tZW50PW51bGwpO2EubW9kZT0xNjE4ODtjYXNlIDE2MTg4OmlmKDUxMiZhLmZsYWdzKXtmb3IoO2Y8MTY7KXtpZigwPT09cylicmVhayBlO3MtLSx1Kz1yW2krK108PGYsZis9OH1pZig0JmEud3JhcCYmdSE9PSg2NTUzNSZhLmNoZWNrKSl7ZS5tc2c9ImhlYWRlciBjcmMgbWlzbWF0Y2giLGEubW9kZT1RO2JyZWFrfXU9MCxmPTB9YS5oZWFkJiYoYS5oZWFkLmhjcmM9YS5mbGFncz4+OSYxLGEuaGVhZC5kb25lPSEwKSxlLmFkbGVyPWEuY2hlY2s9MCxhLm1vZGU9ejticmVhaztjYXNlIDE2MTg5OmZvcig7ZjwzMjspe2lmKDA9PT1zKWJyZWFrIGU7cy0tLHUrPXJbaSsrXTw8ZixmKz04fWUuYWRsZXI9YS5jaGVjaz1WKHUpLHU9MCxmPTAsYS5tb2RlPVo7Y2FzZSBaOmlmKDA9PT1hLmhhdmVkaWN0KXJldHVybiBlLm5leHRfb3V0PW8sZS5hdmFpbF9vdXQ9YyxlLm5leHRfaW49aSxlLmF2YWlsX2luPXMsYS5ob2xkPXUsYS5iaXRzPWYsSTtlLmFkbGVyPWEuY2hlY2s9MSxhLm1vZGU9ejtjYXNlIHo6aWYodD09PU18fHQ9PT1PKWJyZWFrIGU7Y2FzZSBxOmlmKGEubGFzdCl7dT4+Pj03JmYsZi09NyZmLGEubW9kZT1YO2JyZWFrfWZvcig7ZjwzOyl7aWYoMD09PXMpYnJlYWsgZTtzLS0sdSs9cltpKytdPDxmLGYrPTh9c3dpdGNoKGEubGFzdD0xJnUsdT4+Pj0xLGYtPTEsMyZ1KXtjYXNlIDA6YS5tb2RlPTE2MTkzO2JyZWFrO2Nhc2UgMTppZihvZShhKSxhLm1vZGU9Vyx0PT09Tyl7dT4+Pj0yLGYtPTI7YnJlYWsgZX1icmVhaztjYXNlIDI6YS5tb2RlPTE2MTk2O2JyZWFrO2Nhc2UgMzplLm1zZz0iaW52YWxpZCBibG9jayB0eXBlIixhLm1vZGU9UX11Pj4+PTIsZi09MjticmVhaztjYXNlIDE2MTkzOmZvcih1Pj4+PTcmZixmLT03JmY7ZjwzMjspe2lmKDA9PT1zKWJyZWFrIGU7cy0tLHUrPXJbaSsrXTw8ZixmKz04fWlmKCg2NTUzNSZ1KSE9KHU+Pj4xNl42NTUzNSkpe2UubXNnPSJpbnZhbGlkIHN0b3JlZCBibG9jayBsZW5ndGhzIixhLm1vZGU9UTticmVha31pZihhLmxlbmd0aD02NTUzNSZ1LHU9MCxmPTAsYS5tb2RlPUgsdD09PU8pYnJlYWsgZTtjYXNlIEg6YS5tb2RlPTE2MTk1O2Nhc2UgMTYxOTU6aWYoZz1hLmxlbmd0aCxnKXtpZihnPnMmJihnPXMpLGc+YyYmKGc9YyksMD09PWcpYnJlYWsgZTtuLnNldChyLnN1YmFycmF5KGksaStnKSxvKSxzLT1nLGkrPWcsYy09ZyxvKz1nLGEubGVuZ3RoLT1nO2JyZWFrfWEubW9kZT16O2JyZWFrO2Nhc2UgMTYxOTY6Zm9yKDtmPDE0Oyl7aWYoMD09PXMpYnJlYWsgZTtzLS0sdSs9cltpKytdPDxmLGYrPTh9aWYoYS5ubGVuPTI1NysoMzEmdSksdT4+Pj01LGYtPTUsYS5uZGlzdD0xKygzMSZ1KSx1Pj4+PTUsZi09NSxhLm5jb2RlPTQrKDE1JnUpLHU+Pj49NCxmLT00LGEubmxlbj4yODZ8fGEubmRpc3Q+MzApe2UubXNnPSJ0b28gbWFueSBsZW5ndGggb3IgZGlzdGFuY2Ugc3ltYm9scyIsYS5tb2RlPVE7YnJlYWt9YS5oYXZlPTAsYS5tb2RlPTE2MTk3O2Nhc2UgMTYxOTc6Zm9yKDthLmhhdmU8YS5uY29kZTspe2Zvcig7ZjwzOyl7aWYoMD09PXMpYnJlYWsgZTtzLS0sdSs9cltpKytdPDxmLGYrPTh9YS5sZW5zW2VlW2EuaGF2ZSsrXV09NyZ1LHU+Pj49MyxmLT0zfWZvcig7YS5oYXZlPDE5OylhLmxlbnNbZWVbYS5oYXZlKytdXT0wO2lmKGEubGVuY29kZT1hLmxlbmR5bixhLmxlbmJpdHM9NyxKPXtiaXRzOmEubGVuYml0c30sJD1UKDAsYS5sZW5zLDAsMTksYS5sZW5jb2RlLDAsYS53b3JrLEopLGEubGVuYml0cz1KLmJpdHMsJCl7ZS5tc2c9ImludmFsaWQgY29kZSBsZW5ndGhzIHNldCIsYS5tb2RlPVE7YnJlYWt9YS5oYXZlPTAsYS5tb2RlPTE2MTk4O2Nhc2UgMTYxOTg6Zm9yKDthLmhhdmU8YS5ubGVuK2EubmRpc3Q7KXtmb3IoO1I9YS5sZW5jb2RlW3UmKDE8PGEubGVuYml0cyktMV0sbT1SPj4+MjQseT1SPj4+MTYmMjU1LGs9NjU1MzUmUiwhKG08PWYpOyl7aWYoMD09PXMpYnJlYWsgZTtzLS0sdSs9cltpKytdPDxmLGYrPTh9aWYoazwxNil1Pj4+PW0sZi09bSxhLmxlbnNbYS5oYXZlKytdPWs7ZWxzZXtpZigxNj09PWspe2ZvcihZPW0rMjtmPFk7KXtpZigwPT09cylicmVhayBlO3MtLSx1Kz1yW2krK108PGYsZis9OH1pZih1Pj4+PW0sZi09bSwwPT09YS5oYXZlKXtlLm1zZz0iaW52YWxpZCBiaXQgbGVuZ3RoIHJlcGVhdCIsYS5tb2RlPVE7YnJlYWt9QT1hLmxlbnNbYS5oYXZlLTFdLGc9MysoMyZ1KSx1Pj4+PTIsZi09Mn1lbHNlIGlmKDE3PT09ayl7Zm9yKFk9bSszO2Y8WTspe2lmKDA9PT1zKWJyZWFrIGU7cy0tLHUrPXJbaSsrXTw8ZixmKz04fXU+Pj49bSxmLT1tLEE9MCxnPTMrKDcmdSksdT4+Pj0zLGYtPTN9ZWxzZXtmb3IoWT1tKzc7ZjxZOyl7aWYoMD09PXMpYnJlYWsgZTtzLS0sdSs9cltpKytdPDxmLGYrPTh9dT4+Pj1tLGYtPW0sQT0wLGc9MTErKDEyNyZ1KSx1Pj4+PTcsZi09N31pZihhLmhhdmUrZz5hLm5sZW4rYS5uZGlzdCl7ZS5tc2c9ImludmFsaWQgYml0IGxlbmd0aCByZXBlYXQiLGEubW9kZT1RO2JyZWFrfWZvcig7Zy0tOylhLmxlbnNbYS5oYXZlKytdPUF9fWlmKGEubW9kZT09PVEpYnJlYWs7aWYoMD09PWEubGVuc1syNTZdKXtlLm1zZz0iaW52YWxpZCBjb2RlIC0tIG1pc3NpbmcgZW5kLW9mLWJsb2NrIixhLm1vZGU9UTticmVha31pZihhLmxlbmJpdHM9OSxKPXtiaXRzOmEubGVuYml0c30sJD1UKDEsYS5sZW5zLDAsYS5ubGVuLGEubGVuY29kZSwwLGEud29yayxKKSxhLmxlbmJpdHM9Si5iaXRzLCQpe2UubXNnPSJpbnZhbGlkIGxpdGVyYWwvbGVuZ3RocyBzZXQiLGEubW9kZT1RO2JyZWFrfWlmKGEuZGlzdGJpdHM9NixhLmRpc3Rjb2RlPWEuZGlzdGR5bixKPXtiaXRzOmEuZGlzdGJpdHN9LCQ9VCgyLGEubGVucyxhLm5sZW4sYS5uZGlzdCxhLmRpc3Rjb2RlLDAsYS53b3JrLEopLGEuZGlzdGJpdHM9Si5iaXRzLCQpe2UubXNnPSJpbnZhbGlkIGRpc3RhbmNlcyBzZXQiLGEubW9kZT1RO2JyZWFrfWlmKGEubW9kZT1XLHQ9PT1PKWJyZWFrIGU7Y2FzZSBXOmEubW9kZT1LO2Nhc2UgSzppZihzPj02JiZjPj0yNTgpe2UubmV4dF9vdXQ9byxlLmF2YWlsX291dD1jLGUubmV4dF9pbj1pLGUuYXZhaWxfaW49cyxhLmhvbGQ9dSxhLmJpdHM9Zix4KGUsdyksbz1lLm5leHRfb3V0LG49ZS5vdXRwdXQsYz1lLmF2YWlsX291dCxpPWUubmV4dF9pbixyPWUuaW5wdXQscz1lLmF2YWlsX2luLHU9YS5ob2xkLGY9YS5iaXRzLGEubW9kZT09PXomJihhLmJhY2s9LTEpO2JyZWFrfWZvcihhLmJhY2s9MDtSPWEubGVuY29kZVt1JigxPDxhLmxlbmJpdHMpLTFdLG09Uj4+PjI0LHk9Uj4+PjE2JjI1NSxrPTY1NTM1JlIsIShtPD1mKTspe2lmKDA9PT1zKWJyZWFrIGU7cy0tLHUrPXJbaSsrXTw8ZixmKz04fWlmKHkmJiEoMjQwJnkpKXtmb3Iodj1tLF89eSxFPWs7Uj1hLmxlbmNvZGVbRSsoKHUmKDE8PHYrXyktMSk+PnYpXSxtPVI+Pj4yNCx5PVI+Pj4xNiYyNTUsaz02NTUzNSZSLCEodittPD1mKTspe2lmKDA9PT1zKWJyZWFrIGU7cy0tLHUrPXJbaSsrXTw8ZixmKz04fXU+Pj49dixmLT12LGEuYmFjays9dn1pZih1Pj4+PW0sZi09bSxhLmJhY2srPW0sYS5sZW5ndGg9aywwPT09eSl7YS5tb2RlPTE2MjA1O2JyZWFrfWlmKDMyJnkpe2EuYmFjaz0tMSxhLm1vZGU9ejticmVha31pZig2NCZ5KXtlLm1zZz0iaW52YWxpZCBsaXRlcmFsL2xlbmd0aCBjb2RlIixhLm1vZGU9UTticmVha31hLmV4dHJhPTE1JnksYS5tb2RlPTE2MjAxO2Nhc2UgMTYyMDE6aWYoYS5leHRyYSl7Zm9yKFk9YS5leHRyYTtmPFk7KXtpZigwPT09cylicmVhayBlO3MtLSx1Kz1yW2krK108PGYsZis9OH1hLmxlbmd0aCs9dSYoMTw8YS5leHRyYSktMSx1Pj4+PWEuZXh0cmEsZi09YS5leHRyYSxhLmJhY2srPWEuZXh0cmF9YS53YXM9YS5sZW5ndGgsYS5tb2RlPTE2MjAyO2Nhc2UgMTYyMDI6Zm9yKDtSPWEuZGlzdGNvZGVbdSYoMTw8YS5kaXN0Yml0cyktMV0sbT1SPj4+MjQseT1SPj4+MTYmMjU1LGs9NjU1MzUmUiwhKG08PWYpOyl7aWYoMD09PXMpYnJlYWsgZTtzLS0sdSs9cltpKytdPDxmLGYrPTh9aWYoISgyNDAmeSkpe2Zvcih2PW0sXz15LEU9aztSPWEuZGlzdGNvZGVbRSsoKHUmKDE8PHYrXyktMSk+PnYpXSxtPVI+Pj4yNCx5PVI+Pj4xNiYyNTUsaz02NTUzNSZSLCEodittPD1mKTspe2lmKDA9PT1zKWJyZWFrIGU7cy0tLHUrPXJbaSsrXTw8ZixmKz04fXU+Pj49dixmLT12LGEuYmFjays9dn1pZih1Pj4+PW0sZi09bSxhLmJhY2srPW0sNjQmeSl7ZS5tc2c9ImludmFsaWQgZGlzdGFuY2UgY29kZSIsYS5tb2RlPVE7YnJlYWt9YS5vZmZzZXQ9ayxhLmV4dHJhPTE1JnksYS5tb2RlPTE2MjAzO2Nhc2UgMTYyMDM6aWYoYS5leHRyYSl7Zm9yKFk9YS5leHRyYTtmPFk7KXtpZigwPT09cylicmVhayBlO3MtLSx1Kz1yW2krK108PGYsZis9OH1hLm9mZnNldCs9dSYoMTw8YS5leHRyYSktMSx1Pj4+PWEuZXh0cmEsZi09YS5leHRyYSxhLmJhY2srPWEuZXh0cmF9aWYoYS5vZmZzZXQ+YS5kbWF4KXtlLm1zZz0iaW52YWxpZCBkaXN0YW5jZSB0b28gZmFyIGJhY2siLGEubW9kZT1RO2JyZWFrfWEubW9kZT0xNjIwNDtjYXNlIDE2MjA0OmlmKDA9PT1jKWJyZWFrIGU7aWYoZz13LWMsYS5vZmZzZXQ+Zyl7aWYoZz1hLm9mZnNldC1nLGc+YS53aGF2ZSYmYS5zYW5lKXtlLm1zZz0iaW52YWxpZCBkaXN0YW5jZSB0b28gZmFyIGJhY2siLGEubW9kZT1RO2JyZWFrfWc+YS53bmV4dD8oZy09YS53bmV4dCxwPWEud3NpemUtZyk6cD1hLnduZXh0LWcsZz5hLmxlbmd0aCYmKGc9YS5sZW5ndGgpLGI9YS53aW5kb3d9ZWxzZSBiPW4scD1vLWEub2Zmc2V0LGc9YS5sZW5ndGg7Zz5jJiYoZz1jKSxjLT1nLGEubGVuZ3RoLT1nO2Rve25bbysrXT1iW3ArK119d2hpbGUoLS1nKTswPT09YS5sZW5ndGgmJihhLm1vZGU9Syk7YnJlYWs7Y2FzZSAxNjIwNTppZigwPT09YylicmVhayBlO25bbysrXT1hLmxlbmd0aCxjLS0sYS5tb2RlPUs7YnJlYWs7Y2FzZSBYOmlmKGEud3JhcCl7Zm9yKDtmPDMyOyl7aWYoMD09PXMpYnJlYWsgZTtzLS0sdXw9cltpKytdPDxmLGYrPTh9aWYody09YyxlLnRvdGFsX291dCs9dyxhLnRvdGFsKz13LDQmYS53cmFwJiZ3JiYoZS5hZGxlcj1hLmNoZWNrPWEuZmxhZ3M/ZChhLmNoZWNrLG4sdyxvLXcpOmwoYS5jaGVjayxuLHcsby13KSksdz1jLDQmYS53cmFwJiYoYS5mbGFncz91OlYodSkpIT09YS5jaGVjayl7ZS5tc2c9ImluY29ycmVjdCBkYXRhIGNoZWNrIixhLm1vZGU9UTticmVha311PTAsZj0wfWEubW9kZT0xNjIwNztjYXNlIDE2MjA3OmlmKGEud3JhcCYmYS5mbGFncyl7Zm9yKDtmPDMyOyl7aWYoMD09PXMpYnJlYWsgZTtzLS0sdSs9cltpKytdPDxmLGYrPTh9aWYoNCZhLndyYXAmJnUhPT0oNDI5NDk2NzI5NSZhLnRvdGFsKSl7ZS5tc2c9ImluY29ycmVjdCBsZW5ndGggY2hlY2siLGEubW9kZT1RO2JyZWFrfXU9MCxmPTB9YS5tb2RlPTE2MjA4O2Nhc2UgMTYyMDg6JD1GO2JyZWFrIGU7Y2FzZSBROiQ9QjticmVhayBlO2Nhc2UgMTYyMTA6cmV0dXJuIEM7ZGVmYXVsdDpyZXR1cm4gTH1yZXR1cm4gZS5uZXh0X291dD1vLGUuYXZhaWxfb3V0PWMsZS5uZXh0X2luPWksZS5hdmFpbF9pbj1zLGEuaG9sZD11LGEuYml0cz1mLChhLndzaXplfHx3IT09ZS5hdmFpbF9vdXQmJmEubW9kZTxRJiYoYS5tb2RlPFh8fHQhPT1OKSkmJnNlKGUsZS5vdXRwdXQsZS5uZXh0X291dCx3LWUuYXZhaWxfb3V0KSxoLT1lLmF2YWlsX2luLHctPWUuYXZhaWxfb3V0LGUudG90YWxfaW4rPWgsZS50b3RhbF9vdXQrPXcsYS50b3RhbCs9dyw0JmEud3JhcCYmdyYmKGUuYWRsZXI9YS5jaGVjaz1hLmZsYWdzP2QoYS5jaGVjayxuLHcsZS5uZXh0X291dC13KTpsKGEuY2hlY2ssbix3LGUubmV4dF9vdXQtdykpLGUuZGF0YV90eXBlPWEuYml0cysoYS5sYXN0PzY0OjApKyhhLm1vZGU9PT16PzEyODowKSsoYS5tb2RlPT09V3x8YS5tb2RlPT09SD8yNTY6MCksKDA9PT1oJiYwPT09d3x8dD09PU4pJiYkPT09aiYmKCQ9VSksJH0saW5mbGF0ZUVuZDplPT57aWYoRyhlKSlyZXR1cm4gTDtsZXQgdD1lLnN0YXRlO3JldHVybiB0LndpbmRvdyYmKHQud2luZG93PW51bGwpLGUuc3RhdGU9bnVsbCxqfSxpbmZsYXRlR2V0SGVhZGVyOihlLHQpPT57aWYoRyhlKSlyZXR1cm4gTDtjb25zdCBhPWUuc3RhdGU7cmV0dXJuIDImYS53cmFwPyhhLmhlYWQ9dCx0LmRvbmU9ITEsaik6TH0saW5mbGF0ZVNldERpY3Rpb25hcnk6KGUsdCk9Pntjb25zdCBhPXQubGVuZ3RoO2xldCByLG4saTtyZXR1cm4gRyhlKT9MOihyPWUuc3RhdGUsMCE9PXIud3JhcCYmci5tb2RlIT09Wj9MOnIubW9kZT09PVomJihuPTEsbj1sKG4sdCxhLDApLG4hPT1yLmNoZWNrKT9COihpPXNlKGUsdCxhLGEpLGk/KHIubW9kZT0xNjIxMCxDKTooci5oYXZlZGljdD0xLGopKSl9LGluZmxhdGVJbmZvOiJwYWtvIGluZmxhdGUgKGZyb20gTm9kZWNhIHByb2plY3QpIn07dmFyIGNlPWZ1bmN0aW9uKCl7dGhpcy50ZXh0PTAsdGhpcy50aW1lPTAsdGhpcy54ZmxhZ3M9MCx0aGlzLm9zPTAsdGhpcy5leHRyYT1udWxsLHRoaXMuZXh0cmFfbGVuPTAsdGhpcy5uYW1lPSIiLHRoaXMuY29tbWVudD0iIix0aGlzLmhjcmM9MCx0aGlzLmRvbmU9ITF9O2NvbnN0IGRlPU9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcse1pfTk9fRkxVU0g6dWUsWl9GSU5JU0g6ZmUsWl9PSzpoZSxaX1NUUkVBTV9FTkQ6d2UsWl9ORUVEX0RJQ1Q6Z2UsWl9TVFJFQU1fRVJST1I6cGUsWl9EQVRBX0VSUk9SOmJlLFpfTUVNX0VSUk9SOm1lLFpfQlVGX0VSUk9SOnllfT1mLGtlPXtjaHVua1NpemU6NjU1MzYsd2luZG93Qml0czoxNSx0bzoiIn07ZnVuY3Rpb24gdmUoZSl7dGhpcy5vcHRpb25zPXcoe30sa2UsZXx8e30pO2NvbnN0IHQ9dGhpcy5vcHRpb25zO3QucmF3JiZ0LndpbmRvd0JpdHM+PTAmJnQud2luZG93Qml0czwxNiYmKHQud2luZG93Qml0cz0tdC53aW5kb3dCaXRzLDA9PT10LndpbmRvd0JpdHMmJih0LndpbmRvd0JpdHM9LTE1KSksISh0LndpbmRvd0JpdHM+PTAmJnQud2luZG93Qml0czwxNil8fGUmJmUud2luZG93Qml0c3x8KHQud2luZG93Qml0cys9MzIpLHQud2luZG93Qml0cz4xNSYmdC53aW5kb3dCaXRzPDQ4JiYoMTUmdC53aW5kb3dCaXRzfHwodC53aW5kb3dCaXRzfD0xNSkpLHRoaXMuZXJyPTAsdGhpcy5tc2c9IiIsdGhpcy5lbmRlZD0hMSx0aGlzLmNodW5rcz1bXSx0aGlzLnN0cm09bmV3IHYsdGhpcy5zdHJtLmF2YWlsX291dD0wO2xldCBhPWxlLmluZmxhdGVJbml0Mih0aGlzLnN0cm0sdC53aW5kb3dCaXRzKTtpZihhIT09aGUpdGhyb3cgbmV3IEVycm9yKHVbYV0pO2lmKHRoaXMuaGVhZGVyPW5ldyBjZSxsZS5pbmZsYXRlR2V0SGVhZGVyKHRoaXMuc3RybSx0aGlzLmhlYWRlciksdC5kaWN0aW9uYXJ5JiYoInN0cmluZyI9PXR5cGVvZiB0LmRpY3Rpb25hcnk/dC5kaWN0aW9uYXJ5PW0odC5kaWN0aW9uYXJ5KToiW29iamVjdCBBcnJheUJ1ZmZlcl0iPT09ZGUuY2FsbCh0LmRpY3Rpb25hcnkpJiYodC5kaWN0aW9uYXJ5PW5ldyBVaW50OEFycmF5KHQuZGljdGlvbmFyeSkpLHQucmF3JiYoYT1sZS5pbmZsYXRlU2V0RGljdGlvbmFyeSh0aGlzLnN0cm0sdC5kaWN0aW9uYXJ5KSxhIT09aGUpKSl0aHJvdyBuZXcgRXJyb3IodVthXSl9dmUucHJvdG90eXBlLnB1c2g9ZnVuY3Rpb24oZSx0KXtjb25zdCBhPXRoaXMuc3RybSxyPXRoaXMub3B0aW9ucy5jaHVua1NpemUsbj10aGlzLm9wdGlvbnMuZGljdGlvbmFyeTtsZXQgaSxvLHM7aWYodGhpcy5lbmRlZClyZXR1cm4hMTtmb3Iobz10PT09fn50P3Q6ITA9PT10P2ZlOnVlLCJbb2JqZWN0IEFycmF5QnVmZmVyXSI9PT1kZS5jYWxsKGUpP2EuaW5wdXQ9bmV3IFVpbnQ4QXJyYXkoZSk6YS5pbnB1dD1lLGEubmV4dF9pbj0wLGEuYXZhaWxfaW49YS5pbnB1dC5sZW5ndGg7Oyl7Zm9yKDA9PT1hLmF2YWlsX291dCYmKGEub3V0cHV0PW5ldyBVaW50OEFycmF5KHIpLGEubmV4dF9vdXQ9MCxhLmF2YWlsX291dD1yKSxpPWxlLmluZmxhdGUoYSxvKSxpPT09Z2UmJm4mJihpPWxlLmluZmxhdGVTZXREaWN0aW9uYXJ5KGEsbiksaT09PWhlP2k9bGUuaW5mbGF0ZShhLG8pOmk9PT1iZSYmKGk9Z2UpKTthLmF2YWlsX2luPjAmJmk9PT13ZSYmMiZhLnN0YXRlLndyYXAmJjAhPT1hLnN0YXRlLmZsYWdzJiYwIT09YS5pbnB1dFthLm5leHRfaW5dOylsZS5pbmZsYXRlUmVzZXQoYSksaT1sZS5pbmZsYXRlKGEsbyk7c3dpdGNoKGkpe2Nhc2UgcGU6Y2FzZSBiZTpjYXNlIGdlOmNhc2UgbWU6cmV0dXJuIHRoaXMub25FbmQoaSksdGhpcy5lbmRlZD0hMCwhMX1pZihzPWEuYXZhaWxfb3V0LGEubmV4dF9vdXQmJigwPT09YS5hdmFpbF9vdXR8fGk9PT13ZXx8bz4wKSlpZigic3RyaW5nIj09PXRoaXMub3B0aW9ucy50byl7bGV0IGU9ayhhLm91dHB1dCxhLm5leHRfb3V0KSx0PWEubmV4dF9vdXQtZSxuPXkoYS5vdXRwdXQsZSk7YS5uZXh0X291dD10LGEuYXZhaWxfb3V0PXItdCx0JiZhLm91dHB1dC5zZXQoYS5vdXRwdXQuc3ViYXJyYXkoZSxlK3QpLDApLHRoaXMub25EYXRhKG4pfWVsc2UgdGhpcy5vbkRhdGEoYS5vdXRwdXQubGVuZ3RoPT09YS5uZXh0X291dD9hLm91dHB1dDphLm91dHB1dC5zdWJhcnJheSgwLGEubmV4dF9vdXQpKSxhLmF2YWlsX291dD0wLGEubmV4dF9vdXQ9MDtpZihpIT09aGUmJmkhPT15ZXx8MCE9PXMpe2lmKGk9PT13ZSlyZXR1cm4gaT1sZS5pbmZsYXRlRW5kKHRoaXMuc3RybSksdGhpcy5vbkVuZChpKSx0aGlzLmVuZGVkPSEwLCEwO2lmKDA9PT1hLmF2YWlsX2luKXtpZihvPT09ZmUpcmV0dXJuIGk9bGUuaW5mbGF0ZUVuZCh0aGlzLnN0cm0pLHRoaXMub25FbmQoaT09PWhlP3llOmkpLHRoaXMuZW5kZWQ9ITAsITE7YnJlYWt9fX1yZXR1cm4hMH0sdmUucHJvdG90eXBlLm9uRGF0YT1mdW5jdGlvbihlKXt0aGlzLmNodW5rcy5wdXNoKGUpfSx2ZS5wcm90b3R5cGUub25FbmQ9ZnVuY3Rpb24oZSl7ZT09PWhlJiYoInN0cmluZyI9PT10aGlzLm9wdGlvbnMudG8/dGhpcy5yZXN1bHQ9dGhpcy5jaHVua3Muam9pbigiIik6dGhpcy5yZXN1bHQ9Zyh0aGlzLmNodW5rcykpLHRoaXMuY2h1bmtzPVtdLHRoaXMuZXJyPWUsdGhpcy5tc2c9dGhpcy5zdHJtLm1zZ307dmFyIF9lPXt1bmd6aXA6ZnVuY3Rpb24oZSx0KXtjb25zdCBhPW5ldyB2ZSh0KTtpZihhLnB1c2goZSwhMCksYS5lcnIpdGhyb3cgYS5tc2d8fHVbYS5lcnJdO3JldHVybiBhLnJlc3VsdH19O2NvbnN0e3VuZ3ppcDp4ZX09X2U7dmFyIEVlPXhlO2Z1bmN0aW9uIEFlKGUsdCl7bGV0IGE9MCxyPTEsbj0wO2Zvcig7dDxlLmxlbmd0aDspe2NvbnN0IGk9MjU1JmVbdCsrXTtpZihuPDU2JiYoYSs9KDEyNyZpKSpyKSwhKDEyOCZpKSlyZXR1cm5bYSx0XTtpZihyKj0xMjgsbis9NyxuPj03MCl0aHJvdyBuZXcgRXJyb3IoInZhcmludCB0b28gbG9uZyBhdCAiK3QpfXRocm93IG5ldyBFcnJvcigidHJ1bmNhdGVkIHZhcmludCIpfWZ1bmN0aW9uICRlKGUpe2xldCB0PU1hdGguZmxvb3IoZSk7aWYodD49MCl7Y29uc3QgZT1bXTtmb3IoO3Q+PTEyODspZS5wdXNoKHQlMTI4fDEyOCksdD1NYXRoLmZsb29yKHQvMTI4KTtyZXR1cm4gZS5wdXNoKHQpLGV9Y29uc3QgYT1bMCwwLDAsMCwwLDAsMCwwXTtsZXQgcj0tdDtmb3IobGV0IGU9MDtlPDg7ZSsrKWFbZV09MjU1JnIscj1NYXRoLmZsb29yKHIvMjU2KTtsZXQgbj0xO2ZvcihsZXQgZT0wO2U8ODtlKyspe2NvbnN0IHQ9KDI1NSZ+YVtlXSkrbjthW2VdPTI1NSZ0LG49dD4+OH1jb25zdCBpPVtdO2ZvcihsZXQgZT0wO2U8MTA7ZSsrKXtsZXQgdD0wO2ZvcihsZXQgcj0wO3I8NztyKyspe2NvbnN0IG49NyplK3I7bjw2NCYmKHR8PShhW24+PjNdPj4oNyZuKSYxKTw8cil9ZTw5JiYodHw9MTI4KSxpLnB1c2godCl9cmV0dXJuIGl9ZnVuY3Rpb24gUmUoZSl7Y29uc3QgdD1bXTtmb3IobGV0IGE9MDthPGUubGVuZ3RoO2ErKylmb3IobGV0IHI9MDtyPGVbYV0ubGVuZ3RoO3IrKyl0LnB1c2goMjU1JmVbYV1bcl0pO3JldHVybiB0fWZ1bmN0aW9uIFNlKGUpe2NvbnN0IHQ9W107bGV0IGE9MDtmb3IoO2E8ZS5sZW5ndGg7KXtjb25zdCByPWEsW24saV09QWUoZSxhKTthPWk7Y29uc3Qgbz1NYXRoLmZsb29yKG4vOCkscz03Jm47aWYoMD09PW8pdGhyb3cgbmV3IEVycm9yKCJpbnZhbGlkIHByb3RvYnVmIGZpZWxkIDAgYXQgIityKTtsZXQgbDtpZigwPT09cyl7Y29uc3RbdCxyXT1BZShlLGEpO2w9dCxhPXJ9ZWxzZSBpZigxPT09cylsPWUuc2xpY2UoYSxhKzgpLGErPTg7ZWxzZSBpZigyPT09cyl7Y29uc3RbdCxyXT1BZShlLGEpO2E9cixsPWUuc2xpY2UoYSxhK3QpLGErPXR9ZWxzZXtpZig1IT09cyl0aHJvdyBuZXcgRXJyb3IoInVuc3VwcG9ydGVkIHdpcmUgdHlwZSAiK3MpO2w9ZS5zbGljZShhLGErNCksYSs9NH10LnB1c2goe2ZpZWxkTm86byx3aXJlVHlwZTpzLHZhbHVlOmwscmF3OmUuc2xpY2UocixhKX0pfXJldHVybiB0fWZ1bmN0aW9uIFRlKGUsdCxhKXtjb25zdCByPSRlKDgqZSt0KTtpZigwPT09dClyZXR1cm4gUmUoW3IsJGUoYSldKTtpZigxPT09dHx8NT09PXQpcmV0dXJuIFJlKFtyLGFdKTtpZigyPT09dClyZXR1cm4gUmUoW3IsJGUoYS5sZW5ndGgpLGFdKTt0aHJvdyBuZXcgRXJyb3IoImNhbm5vdCBlbmNvZGUgd2lyZSB0eXBlICIrdCl9ZnVuY3Rpb24gTmUoZSx0LGEpe2NvbnN0IHI9U2UoZSk7bGV0IG49ITEsaT0hMTtmb3IoY29uc3QgZSBvZiByKTE9PT1lLmZpZWxkTm8mJjA9PT1lLndpcmVUeXBlJiYobj0hMCksMj09PWUuZmllbGRObyYmMD09PWUud2lyZVR5cGUmJihpPSEwKTtpZighbnx8IWkpcmV0dXJuIGU7Y29uc3Qgbz1bXTtmb3IoY29uc3QgZSBvZiByKTE9PT1lLmZpZWxkTm8mJjA9PT1lLndpcmVUeXBlP28ucHVzaChUZSgxLDAsTWF0aC5yb3VuZCgxZTgqdC5sYXRpdHVkZSkpKToyPT09ZS5maWVsZE5vJiYwPT09ZS53aXJlVHlwZT9vLnB1c2goVGUoMiwwLE1hdGgucm91bmQoMWU4KnQubG9uZ2l0dWRlKSkpOjM9PT1lLmZpZWxkTm8mJjA9PT1lLndpcmVUeXBlP28ucHVzaChUZSgzLDAsdC5hY2N1cmFjeSkpOm8ucHVzaChlLnJhdyk7cmV0dXJuIGEubG9jYXRpb25zKyssUmUobyl9ZnVuY3Rpb24gTWUoZSx0LGEpe2NvbnN0IHI9U2UoZSk7bGV0IG49ITE7Zm9yKGNvbnN0IGUgb2YgcilpZigxPT09ZS5maWVsZE5vJiYyPT09ZS53aXJlVHlwZSl7Y29uc3QgdD1BcnJheS5mcm9tKGUudmFsdWUpLm1hcChlPT5TdHJpbmcuZnJvbUNoYXJDb2RlKDI1NSZlKSkuam9pbigiIik7bj0vXlswLTlhLWZBLUZdezEsMn0oOlswLTlhLWZBLUZdezEsMn0pezV9JC8udGVzdCh0KX1pZighbilyZXR1cm4gZTtsZXQgaT0hMTtjb25zdCBvPVtdO2Zvcihjb25zdCBlIG9mIHIpaWYoMj09PWUuZmllbGRObyYmMj09PWUud2lyZVR5cGUpdHJ5e2NvbnN0IHI9TmUoZS52YWx1ZSx0LGEpO3IubGVuZ3RoPT09ZS52YWx1ZS5sZW5ndGgmJnIuam9pbigiLCIpPT09ZS52YWx1ZS5qb2luKCIsIil8fChpPSEwKSxvLnB1c2goVGUoZS5maWVsZE5vLGUud2lyZVR5cGUscikpfWNhdGNoe2Euc2tpcHBlZCsrLG8ucHVzaChlLnJhdyl9ZWxzZSBvLnB1c2goZS5yYXcpO3JldHVybiBpJiZhLndpZmkrKyxSZShvKX1mdW5jdGlvbiBPZShlLHQsYSl7Y29uc3Qgcj1TZShlKTtsZXQgbj0hMTtjb25zdCBpPVtdO2Zvcihjb25zdCBlIG9mIHIpaWYoNT09PWUuZmllbGRObyYmMj09PWUud2lyZVR5cGUpdHJ5e2NvbnN0IHI9TmUoZS52YWx1ZSx0LGEpO3IubGVuZ3RoPT09ZS52YWx1ZS5sZW5ndGgmJnIuam9pbigiLCIpPT09ZS52YWx1ZS5qb2luKCIsIil8fChuPSEwKSxpLnB1c2goVGUoZS5maWVsZE5vLGUud2lyZVR5cGUscikpfWNhdGNoe2Euc2tpcHBlZCsrLGkucHVzaChlLnJhdyl9ZWxzZSBpLnB1c2goZS5yYXcpO3JldHVybiBuJiZhLmNlbGwrKyxSZShpKX1mdW5jdGlvbiBqZShlLHQsYSl7Y29uc3Qgcj1TZShlKSxuPVtdO2Zvcihjb25zdCBlIG9mIHIpMj09PWUud2lyZVR5cGUmJjI9PT1lLmZpZWxkTm8/bi5wdXNoKFRlKGUuZmllbGRObyxlLndpcmVUeXBlLE1lKGUudmFsdWUsdCxhKSkpOjIhPT1lLndpcmVUeXBlfHwyMiE9PWUuZmllbGRObyYmMjQhPT1lLmZpZWxkTm8/bi5wdXNoKGUucmF3KTpuLnB1c2goVGUoZS5maWVsZE5vLGUud2lyZVR5cGUsT2UoZS52YWx1ZSx0LGEpKSk7cmV0dXJuIFJlKG4pfWZ1bmN0aW9uIEZlKGUpe3JldHVybnt3aWZpOmUud2lmaXx8MCxjZWxsOmUuY2VsbHx8MCxsb2NhdGlvbnM6ZS5sb2NhdGlvbnN8fDAsc2tpcHBlZDplLnNraXBwZWR8fDB9fWZ1bmN0aW9uIEllKGUsdCl7ZS53aWZpPXQud2lmaSxlLmNlbGw9dC5jZWxsLGUubG9jYXRpb25zPXQubG9jYXRpb25zLGUuc2tpcHBlZD10LnNraXBwZWR9ZnVuY3Rpb24gTGUoZSx0KXtpZihlLmxlbmd0aCE9PXQubGVuZ3RoKXJldHVybiExO2ZvcihsZXQgYT0wO2E8ZS5sZW5ndGg7YSsrKWlmKGVbYV0hPT10W2FdKXJldHVybiExO3JldHVybiEwfWZ1bmN0aW9uIEJlKGUsdCxhLHIpe2lmKGUubGVuZ3RoPHQrMTApdGhyb3cgbmV3IEVycm9yKCJib2R5IHRvbyBzaG9ydDogIitlLmxlbmd0aCsiLCBiYXNlPSIrdCk7Y29uc3Qgbj0oMjU1JmVbdCs4XSk8PDh8MjU1JmVbdCs5XTtpZihuPD0wKXRocm93IG5ldyBFcnJvcigiaW52YWxpZCBlbXB0eSBmcmFtZSBsZW5ndGggYXQgIit0KTtpZihuK3QrMTA+ZS5sZW5ndGgpdGhyb3cgbmV3IEVycm9yKCJpbnZhbGlkIGZyYW1lIGxlbmd0aCAiK24rIiBhdCAiK3QrIiBmb3IgIitlLmxlbmd0aCk7Y29uc3QgaT1lLnNsaWNlKDAsdCs4KSxvPWUuc2xpY2UodCsxMCx0KzEwK24pLHM9ZS5zbGljZSh0KzEwK24pLGw9RmUociksYz1qZShvLGEsciksZD1yLmxvY2F0aW9ucy1sLmxvY2F0aW9ucysoci53aWZpLWwud2lmaSkrKHIuY2VsbC1sLmNlbGwpO2lmKGMubGVuZ3RoPjY1NTM1KXRocm93IG5ldyBFcnJvcigicGF0Y2hlZCBwYXlsb2FkIHRvbyBsYXJnZTogIitjLmxlbmd0aCk7aWYoZDw9MHx8TGUobyxjKSl0aHJvdyBJZShyLGwpLG5ldyBFcnJvcigiZnJhbWUgcGFyc2VkIGJ1dCBubyBwYXRjaGFibGUgd2xvYyBwYXlsb2FkIGF0ICIrdCk7cmV0dXJuIFJlKFtpLFtjLmxlbmd0aD4+OCYyNTUsMjU1JmMubGVuZ3RoXSxjLHNdKX1mdW5jdGlvbiBDZShlLGEpe2NvbnN0IHI9e3dpZmk6MCxjZWxsOjAsbG9jYXRpb25zOjAsc2tpcHBlZDowfTtpZihlLmxlbmd0aDwxMCl0aHJvdyBuZXcgRXJyb3IoImJvZHkgdG9vIHNob3J0OiAiK2UubGVuZ3RoKTtjb25zdCBuPVtdLGk9WzAsMiw0LDYsOCwxMCwxMiwxNCwxNl0sbz1NYXRoLm1pbig5NixNYXRoLm1heCgwLGUubGVuZ3RoLTEwKSk7Zm9yKGxldCBlPTA7ZTw9bztlKyspaS5pbmRleE9mKGUpPDAmJmkucHVzaChlKTtmb3IobGV0IG89MDtvPGkubGVuZ3RoO28rKyl7Y29uc3Qgcz1pW29dLGw9RmUocik7dHJ5e2NvbnN0IG49QmUoZSxzLGEscik7cmV0dXJuIHQuaW5mbyhgW3dsb2NdIHBhdGNoZWQgYXQgb2Zmc2V0PSR7c30gbG9jYXRpb25zPSR7ci5sb2NhdGlvbnN9IHdpZmk9JHtyLndpZml9IGNlbGw9JHtyLmNlbGx9IHNraXBwZWQ9JHtyLnNraXBwZWR9YCkse2RhdGE6bixzdGF0czpyfX1jYXRjaChlKXtJZShyLGwpLG4ubGVuZ3RoPDYmJm4ucHVzaCgiQCIrcysiOiIrKGUmJmUubWVzc2FnZT9lLm1lc3NhZ2U6U3RyaW5nKGUpKSl9fXRyeXtjb25zdCBuPWZ1bmN0aW9uKGUsdCxhKXtjb25zdCByPVtdLG49TWF0aC5taW4oMjU2LGUubGVuZ3RoKTtmb3IobGV0IGk9MDtpPD1uO2krKyl7Y29uc3Qgbj1GZShhKTt0cnl7Y29uc3Qgcj1lLnNsaWNlKGkpLG89amUocix0LGEpO2lmKGEubG9jYXRpb25zLW4ubG9jYXRpb25zKyhhLndpZmktbi53aWZpKSsoYS5jZWxsLW4uY2VsbCk+MCYmIUxlKHIsbykpcmV0dXJuIFJlKFtlLnNsaWNlKDAsaSksb10pO0llKGEsbil9Y2F0Y2goZSl7SWUoYSxuKSxyLmxlbmd0aDw2JiZyLnB1c2goInJhd0AiK2krIjoiKyhlJiZlLm1lc3NhZ2U/ZS5tZXNzYWdlOlN0cmluZyhlKSkpfX10aHJvdyBuZXcgRXJyb3IoInJhdyBwcm90b2J1ZiBzY2FuIGZhaWxlZDsgIityLmpvaW4oIiB8ICIpKX0oZSxhLHIpO3JldHVybiB0LmluZm8oYFt3bG9jXSBwYXRjaGVkIHZpYSByYXcgZmFsbGJhY2sgbG9jYXRpb25zPSR7ci5sb2NhdGlvbnN9IHdpZmk9JHtyLndpZml9IGNlbGw9JHtyLmNlbGx9IHNraXBwZWQ9JHtyLnNraXBwZWR9YCkse2RhdGE6bixzdGF0czpyfX1jYXRjaChlKXtuLnB1c2goInJhdzoiKyhlJiZlLm1lc3NhZ2U/ZS5tZXNzYWdlOlN0cmluZyhlKSkpfXRocm93IG5ldyBFcnJvcigibm8gcGF0Y2hhYmxlIHdsb2MgcGF5bG9hZCBmb3VuZDsgIituLmpvaW4oIiB8ICIpKX1mdW5jdGlvbiBVZShlKXtyZXR1cm4gZS5sZW5ndGg+PTImJjMxPT09ZVswXSYmMTM5PT09ZVsxXX1hc3luYyBmdW5jdGlvbiBQZShlLGEscil7Y29uc3Qgbj1lLnVybHx8IiI7dC5ncm91cChgW3dsb2NdIFJlc3BvbnNlICR7bn1gKTt0cnl7bGV0IGU9ZnVuY3Rpb24oZSl7aWYoIWUpcmV0dXJuW107aWYoInVuZGVmaW5lZCIhPXR5cGVvZiBBcnJheUJ1ZmZlcil7aWYoZSBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKXJldHVybiBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChuZXcgVWludDhBcnJheShlKSk7aWYoQXJyYXlCdWZmZXIuaXNWaWV3JiZBcnJheUJ1ZmZlci5pc1ZpZXcoZSkpcmV0dXJuIEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKG5ldyBVaW50OEFycmF5KGUuYnVmZmVyLGUuYnl0ZU9mZnNldCxlLmJ5dGVMZW5ndGgpKX1pZigibnVtYmVyIj09dHlwZW9mIGUubGVuZ3RoJiYic3RyaW5nIiE9dHlwZW9mIGUpe2NvbnN0IHQ9W107Zm9yKGxldCBhPTA7YTxlLmxlbmd0aDthKyspdC5wdXNoKDI1NSZlW2FdKTtyZXR1cm4gdH1pZigic3RyaW5nIj09dHlwZW9mIGUpe2NvbnN0IHQ9W107Zm9yKGxldCBhPTA7YTxlLmxlbmd0aDthKyspdC5wdXNoKDI1NSZlLmNoYXJDb2RlQXQoYSkpO3JldHVybiB0fXJldHVybltdfShhLmJvZHlCeXRlc3x8YS5yYXdCb2R5fHxhLmJvZHkpO2lmKCFlLmxlbmd0aClyZXR1cm4gdC53YXJuKCJbd2xvY10g5peg5LqM6L+b5Yi2IGJvZHnvvIzot7Pov4ciKSxhO3QuZGVidWcoYFt3bG9jXSBpbnB1dCBsZW5ndGg9JHtlLmxlbmd0aH0gZ3ppcD0ke1VlKGUpfWApO2xldCBuPWU7VWUoZSkmJihuPUFycmF5LmZyb20oRWUobmV3IFVpbnQ4QXJyYXkoZSkpKSk7aWYobnVsbD09ci5sb25naXR1ZGV8fG51bGw9PXIubGF0aXR1ZGUpe3QuaW5mbygiW3dsb2NdIOmAj+S8oOaooeW8j++8muacquiuvue9ruWdkOagh++8jOS4jeS/ruaUueWTjeW6lO+8iOaBouWkjeecn+WunuWumuS9je+8iSIpO2NvbnN0IGw9bmV3IFVpbnQ4QXJyYXkobik7cmV0dXJuIGEuYm9keT1sLGEuYm9keUJ5dGVzPWwsYS5yYXdCb2R5PWwsYS5oZWFkZXJzJiYoZGVsZXRlIGEuaGVhZGVyc1siQ29udGVudC1FbmNvZGluZyJdLGRlbGV0ZSBhLmhlYWRlcnNbImNvbnRlbnQtZW5jb2RpbmciXSxkZWxldGUgYS5oZWFkZXJzWyJUcmFuc2Zlci1FbmNvZGluZyJdLGRlbGV0ZSBhLmhlYWRlcnNbInRyYW5zZmVyLWVuY29kaW5nIl0sYS5oZWFkZXJzWyJDb250ZW50LUxlbmd0aCJdPVN0cmluZyhsLmxlbmd0aCkpLGEuc3RhdHVzPTIwMCxhLnN0YXR1c0NvZGU9MjAwLGF9Y29uc3QgaT1mdW5jdGlvbihlKXtjb25zdCB0PU51bWJlcihlLnJhbmRvbVJhZGl1cyk7aWYoIU51bWJlci5pc0Zpbml0ZSh0KXx8dDw9MClyZXR1cm4gZTtjb25zdCBhPU1hdGguc3FydChNYXRoLnJhbmRvbSgpKSp0LHI9MipNYXRoLnJhbmRvbSgpKk1hdGguUEksbj1hLzYzNzgxMzcsaT1lLmxhdGl0dWRlKk1hdGguUEkvMTgwLG89ZS5sb25naXR1ZGUqTWF0aC5QSS8xODAscz1NYXRoLmFzaW4oTWF0aC5zaW4oaSkqTWF0aC5jb3MobikrTWF0aC5jb3MoaSkqTWF0aC5zaW4obikqTWF0aC5jb3MocikpLGw9KG8rTWF0aC5hdGFuMihNYXRoLnNpbihyKSpNYXRoLnNpbihuKSpNYXRoLmNvcyhpKSxNYXRoLmNvcyhuKS1NYXRoLnNpbihpKSpNYXRoLnNpbihzKSkrMypNYXRoLlBJKSUoMipNYXRoLlBJKS1NYXRoLlBJO3JldHVybnsuLi5lLGxvbmdpdHVkZTpOdW1iZXIoKDE4MCpsL01hdGguUEkpLnRvRml4ZWQoOCkpLGxhdGl0dWRlOk51bWJlcigoMTgwKnMvTWF0aC5QSSkudG9GaXhlZCg4KSkscmFuZG9tRGlzdGFuY2U6YX19KHIpLHtkYXRhOm8sc3RhdHM6c309Q2UobixpKSxsPW5ldyBVaW50OEFycmF5KG8pO3JldHVybiBhLmJvZHk9bCxhLmJvZHlCeXRlcz1sLGEucmF3Qm9keT1sLGEuaGVhZGVycyYmKGRlbGV0ZSBhLmhlYWRlcnNbIkNvbnRlbnQtRW5jb2RpbmciXSxkZWxldGUgYS5oZWFkZXJzWyJjb250ZW50LWVuY29kaW5nIl0sZGVsZXRlIGEuaGVhZGVyc1siVHJhbnNmZXItRW5jb2RpbmciXSxkZWxldGUgYS5oZWFkZXJzWyJ0cmFuc2Zlci1lbmNvZGluZyJdLGEuaGVhZGVyc1siQ29udGVudC1MZW5ndGgiXT1TdHJpbmcobC5sZW5ndGgpKSxhLnN0YXR1cz0yMDAsYS5zdGF0dXNDb2RlPTIwMCx0LmluZm8oYFt3bG9jXSDnm67moIflnZDmoIc6ICR7aS5sb25naXR1ZGV9LCR7aS5sYXRpdHVkZX0g57K+5bqmPSR7aS5hY2N1cmFjeX0g5omw5YqoPSR7aS5yYW5kb21EaXN0YW5jZT8udG9GaXhlZCgxKXx8MH1tIHBhdGNoZWQ9JHtzLmxvY2F0aW9uc31gKSxhfWNhdGNoKGUpe3JldHVybiB0LmVycm9yKGBbd2xvY10gJHtlLm1lc3NhZ2V8fGV9YCksYX1maW5hbGx5e3QuZ3JvdXBFbmQoKX19Y29uc3QgRGU9e2xvbmdpdHVkZTpudWxsLGxhdGl0dWRlOm51bGwsYWNjdXJhY3k6MjUscmFuZG9tUmFkaXVzOjAsbG9nTGV2ZWw6ImluZm8ifTtmdW5jdGlvbiBaZSgpe2NvbnN0IGU9Z2xvYmFsVGhpcy4kYXJndW1lbnR8fHt9LGE9ZnVuY3Rpb24oKXt0cnl7Y29uc3QgZT1vLmdldEl0ZW0oIndsb2Nfc2V0dGluZ3MiKTtpZihlJiYib2JqZWN0Ij09dHlwZW9mIGUpcmV0dXJuIGV9Y2F0Y2goZSl7dC5kZWJ1ZyhgW3NldHRpbmdzXSDmjIHkuYXljJbmlbDmja7or7vlj5blpLHotKU6ICR7ZS5tZXNzYWdlfWApfXJldHVybiBudWxsfSgpLHI9ey4uLkRlfTtpZihlLmxvbmdpdHVkZSYmKHIubG9uZ2l0dWRlPXBhcnNlRmxvYXQoZS5sb25naXR1ZGUpKSxlLmxhdGl0dWRlJiYoci5sYXRpdHVkZT1wYXJzZUZsb2F0KGUubGF0aXR1ZGUpKSxlLmFjY3VyYWN5JiYoci5hY2N1cmFjeT1wYXJzZUludChlLmFjY3VyYWN5LDEwKSksdm9pZCAwIT09ZS5yYW5kb21SYWRpdXMmJihyLnJhbmRvbVJhZGl1cz1wYXJzZUZsb2F0KGUucmFuZG9tUmFkaXVzKSksZS5sb2dMZXZlbCYmKHIubG9nTGV2ZWw9ZS5sb2dMZXZlbCksZS5Mb2dMZXZlbCYmKHIubG9nTGV2ZWw9ZS5Mb2dMZXZlbCksYSlhLmxvbmdpdHVkZSYmKHIubG9uZ2l0dWRlPXBhcnNlRmxvYXQoYS5sb25naXR1ZGUpKSxhLmxhdGl0dWRlJiYoci5sYXRpdHVkZT1wYXJzZUZsb2F0KGEubGF0aXR1ZGUpKSxhLmFjY3VyYWN5JiYoci5hY2N1cmFjeT1wYXJzZUludChhLmFjY3VyYWN5LDEwKSksdm9pZCAwIT09YS5yYW5kb21SYWRpdXMmJihyLnJhbmRvbVJhZGl1cz1wYXJzZUZsb2F0KGEucmFuZG9tUmFkaXVzKSksdC5pbmZvKGBbc2V0dGluZ3NdIOS9v+eUqOW3suS/neWtmOWdkOaghzogJHtyLmxvbmdpdHVkZX0sJHtyLmxhdGl0dWRlfWApO2Vsc2UgaWYoMTEzLjk0MTE0PT09ci5sb25naXR1ZGUmJjIyLjU0NDU3Nz09PXIubGF0aXR1ZGUpcmV0dXJuIHIubG9uZ2l0dWRlPW51bGwsci5sYXRpdHVkZT1udWxsLHQuaW5mbygiW3NldHRpbmdzXSDpgI/kvKDmqKHlvI/vvJrmjIHkuYXljJbmlbDmja7kuLrnqbrkuJTkuLrpu5jorqTlj4LmlbDvvIzkuI3kv67mlLnlrprkvY0iKSxyO3JldHVybiBudWxsPT1yLmxvbmdpdHVkZXx8bnVsbD09ci5sYXRpdHVkZT90LmluZm8oIltzZXR0aW5nc10g6YCP5Lyg5qih5byP77ya5pyq6K6+572u5Z2Q5qCH77yM5bCG5LiN5L+u5pS55a6a5L2N5ZON5bqUIik6dC5kZWJ1ZyhgW3NldHRpbmdzXSBsb249JHtyLmxvbmdpdHVkZX0gbGF0PSR7ci5sYXRpdHVkZX0gYWNjPSR7ci5hY2N1cmFjeX0gcmFuZG9tUmFkaXVzPSR7ci5yYW5kb21SYWRpdXN9YCkscn1sZXQgemU7KGFzeW5jKCk9Pntjb25zdCBlPWZ1bmN0aW9uKCl7dHJ5e3JldHVybiJ1bmRlZmluZWQiIT10eXBlb2YgJHJlc3BvbnNlPyRyZXNwb25zZTp2b2lkIDB9Y2F0Y2h7cmV0dXJufX0oKTtpZighZSlyZXR1cm4gdm9pZCB0Lndhcm4oIlt3bG9jXSDpnZ7lk43lupTmqKHlvI/vvIzot7Pov4ciKTtjb25zdCBhPVplKCk7dC5sb2dMZXZlbD1hLmxvZ0xldmVsLHplPWF3YWl0IFBlKCRyZXF1ZXN0LGUsYSl9KSgpLmNhdGNoKGU9PnQuZXJyb3IoZSkpLmZpbmFsbHkoKCk9Pntzd2l0Y2godHlwZW9mIHplKXtjYXNlIm9iamVjdCI6emUuaGVhZGVycz8uWyJDb250ZW50LUVuY29kaW5nIl0mJih6ZS5oZWFkZXJzWyJDb250ZW50LUVuY29kaW5nIl09ImlkZW50aXR5IiksemUuaGVhZGVycz8uWyJjb250ZW50LWVuY29kaW5nIl0mJih6ZS5oZWFkZXJzWyJjb250ZW50LWVuY29kaW5nIl09ImlkZW50aXR5IiksIlF1YW50dW11bHQgWCI9PT1lPyh6ZS5zdGF0dXN8fCh6ZS5zdGF0dXM9MjAwKSxkZWxldGUgemUuaGVhZGVycz8uWyJDb250ZW50LUxlbmd0aCJdLGRlbGV0ZSB6ZS5oZWFkZXJzPy5bImNvbnRlbnQtbGVuZ3RoIl0sZGVsZXRlIHplLmhlYWRlcnM/LlsiVHJhbnNmZXItRW5jb2RpbmciXSxpKHplKSk6aSgiU3Rhc2giPT09ZT96ZTp7cmVzcG9uc2U6emV9KTticmVhaztjYXNlInVuZGVmaW5lZCI6aSh7fSk7YnJlYWs7ZGVmYXVsdDp0LmVycm9yKCJbd2xvY10g5LiN5ZCI5rOV55qEIHJlc3BvbnNlIOexu+WeizogIit0eXBlb2YgemUpLGkoe30pfX0pOwo=";
const LOCATION_SETTINGS_B64 = "Lyogd2xvYy1zZXR0aW5ncy5qcyAtIEJ1aWxkIDIwMjYtMDgtMTYgMTY6NTY6MjkgKi8KY29uc3QgZT0oKCk9Pntjb25zdCBlPWU9PmUgaW4gZ2xvYmFsVGhpcztzd2l0Y2goITApe2Nhc2UgZSgiJHRhc2siKTpyZXR1cm4iUXVhbnR1bXVsdCBYIjtjYXNlIGUoIiRsb29uIik6cmV0dXJuIkxvb24iO2Nhc2UgZSgiJHJvY2tldCIpOnJldHVybiJTaGFkb3dyb2NrZXQiO2Nhc2UgZSgiRWdlcm4iKTpyZXR1cm4iRWdlcm4iO2Nhc2UgQm9vbGVhbihnbG9iYWxUaGlzLiRlbnZpcm9ubWVudD8uWyJzdXJnZS12ZXJzaW9uIl0pOnJldHVybiJTdXJnZSI7Y2FzZSBCb29sZWFuKGdsb2JhbFRoaXMuJGVudmlyb25tZW50Py5bInN0YXNoLXZlcnNpb24iXSk6cmV0dXJuIlN0YXNoIjtjYXNlIGUoIkNsb3VkZmxhcmUiKTpyZXR1cm4iV29ya2VyIjtjYXNlIEJvb2xlYW4oZ2xvYmFsVGhpcy5wcm9jZXNzPy52ZXJzaW9ucz8ubm9kZSk6cmV0dXJuIk5vZGUuanMiO2RlZmF1bHQ6cmV0dXJufX0pKCk7Y2xhc3MgdHtzdGF0aWMjZT1uZXcgTWFwKFtdKTtzdGF0aWMjdD1bXTtzdGF0aWMjYT1uZXcgTWFwKFtdKTtzdGF0aWMgY2xlYXI9KCk9Pnt9O3N0YXRpYyBjb3VudD0oZT0iZGVmYXVsdCIpPT57c3dpdGNoKHQuI2UuaGFzKGUpKXtjYXNlITA6dC4jZS5zZXQoZSx0LiNlLmdldChlKSsxKTticmVhaztjYXNlITE6dC4jZS5zZXQoZSwwKX10LmxvZyhgJHtlfTogJHt0LiNlLmdldChlKX1gKX07c3RhdGljIGNvdW50UmVzZXQ9KGU9ImRlZmF1bHQiKT0+e3N3aXRjaCh0LiNlLmhhcyhlKSl7Y2FzZSEwOnQuI2Uuc2V0KGUsMCksdC5sb2coYCR7ZX06ICR7dC4jZS5nZXQoZSl9YCk7YnJlYWs7Y2FzZSExOnQud2FybihgQ291bnRlciAiJHtlfSIgZG9lc27igJl0IGV4aXN0YCl9fTtzdGF0aWMgZGVidWc9KC4uLmUpPT57dC4jczw0fHwoZT1lLm1hcChlPT5gICR7ZX1gKSx0LmxvZyguLi5lKSl9O3N0YXRpYyBlcnJvciguLi5hKXtpZighKHQuI3M8MSkpe3N3aXRjaChlKXtjYXNlIlN1cmdlIjpjYXNlIkxvb24iOmNhc2UiU3Rhc2giOmNhc2UiRWdlcm4iOmNhc2UiU2hhZG93cm9ja2V0IjpjYXNlIlF1YW50dW11bHQgWCI6ZGVmYXVsdDphPWEubWFwKGU9PmAgJHtlfWApO2JyZWFrO2Nhc2UiV29ya2VyIjpjYXNlIk5vZGUuanMiOmE9YS5tYXAoZT0+YCAke2U/LnN0YWNrPz9lfWApfXQubG9nKC4uLmEpfX1zdGF0aWMgZXhjZXB0aW9uPSguLi5lKT0+dC5lcnJvciguLi5lKTtzdGF0aWMgZ3JvdXA9ZT0+dC4jdC51bnNoaWZ0KGUpO3N0YXRpYyBncm91cEVuZD0oKT0+dC4jdC5zaGlmdCgpO3N0YXRpYyBpbmZvKC4uLmUpe3QuI3M8M3x8KGU9ZS5tYXAoZT0+YCAke2V9YCksdC5sb2coLi4uZSkpfXN0YXRpYyNzPTM7c3RhdGljIGdldCBsb2dMZXZlbCgpe3N3aXRjaCh0LiNzKXtjYXNlIDA6cmV0dXJuIk9GRiI7Y2FzZSAxOnJldHVybiJFUlJPUiI7Y2FzZSAyOnJldHVybiJXQVJOIjtjYXNlIDM6ZGVmYXVsdDpyZXR1cm4iSU5GTyI7Y2FzZSA0OnJldHVybiJERUJVRyI7Y2FzZSA1OnJldHVybiJBTEwifX1zdGF0aWMgc2V0IGxvZ0xldmVsKGUpe3N3aXRjaCh0eXBlb2YgZSl7Y2FzZSJzdHJpbmciOmU9ZS50b0xvd2VyQ2FzZSgpO2JyZWFrO2Nhc2UibnVtYmVyIjpicmVhaztkZWZhdWx0OmU9Indhcm4ifXN3aXRjaChlKXtjYXNlIDA6Y2FzZSJvZmYiOnQuI3M9MDticmVhaztjYXNlIDE6Y2FzZSJlcnJvciI6dC4jcz0xO2JyZWFrO2Nhc2UgMjpjYXNlIndhcm4iOmNhc2Uid2FybmluZyI6ZGVmYXVsdDp0LiNzPTI7YnJlYWs7Y2FzZSAzOmNhc2UiaW5mbyI6dC4jcz0zO2JyZWFrO2Nhc2UgNDpjYXNlImRlYnVnIjp0LiNzPTQ7YnJlYWs7Y2FzZSA1OmNhc2UiYWxsIjp0LiNzPTV9fXN0YXRpYyBsb2c9KC4uLmUpPT57MCE9PXQuI3MmJihlPWUuZmxhdE1hcChlPT57c3dpdGNoKHR5cGVvZiBlKXtjYXNlIm9iamVjdCI6cmV0dXJuW0pTT04uc3RyaW5naWZ5KGUpXTtjYXNlImJpZ2ludCI6Y2FzZSJudW1iZXIiOmNhc2UiYm9vbGVhbiI6cmV0dXJuW2UudG9TdHJpbmcoKV07Y2FzZSJzdHJpbmciOnJldHVybiBlLnNwbGl0KC9ccj9cbi91KTtkZWZhdWx0OnJldHVybltlXX19KSx0LiN0LmZvckVhY2godD0+eyhlPWUubWFwKGU9PmAgICR7ZX1gKSkudW5zaGlmdChgICR7dH06YCl9KSxlPVsiIiwuLi5lXSxjb25zb2xlLmxvZyhlLmpvaW4oIlxuIikpKX07c3RhdGljIHRpbWU9KGU9ImRlZmF1bHQiKT0+dC4jYS5zZXQoZSxEYXRlLm5vdygpKTtzdGF0aWMgdGltZUVuZD0oZT0iZGVmYXVsdCIpPT50LiNhLmRlbGV0ZShlKTtzdGF0aWMgdGltZUxvZz0oZT0iZGVmYXVsdCIpPT57Y29uc3QgYT10LiNhLmdldChlKTthP3QubG9nKGAke2V9OiAke0RhdGUubm93KCktYX1tc2ApOnQud2FybihgVGltZXIgIiR7ZX0iIGRvZXNu4oCZdCBleGlzdGApfTtzdGF0aWMgd2FybiguLi5lKXt0LiNzPDJ8fChlPWUubWFwKGU9PmAgJHtlfWApLHQubG9nKC4uLmUpKX19Y2xhc3MgYXtzdGF0aWMgZXNjYXBlKGUpe2NvbnN0IHQ9eyImIjoiJmFtcDsiLCI8IjoiJmx0OyIsIj4iOiImZ3Q7IiwnIic6IiZxdW90OyIsIiciOiImIzM5OyJ9O3JldHVybiBlLnJlcGxhY2UoL1smPD4iJ10vZyxlPT50W2VdKX1zdGF0aWMgZ2V0KGU9e30sdD0iIixzPXZvaWQgMCl7QXJyYXkuaXNBcnJheSh0KXx8KHQ9YS50b1BhdGgodCkpO2NvbnN0IHI9dC5yZWR1Y2UoKGUsdCk9Pk9iamVjdChlKVt0XSxlKTtyZXR1cm4gdm9pZCAwPT09cj9zOnJ9c3RhdGljIG1lcmdlKGUsLi4udCl7aWYobnVsbD09ZSlyZXR1cm4gZTtmb3IoY29uc3QgcyBvZiB0KWlmKG51bGwhPXMpZm9yKGNvbnN0IHQgb2YgT2JqZWN0LmtleXMocykpe2NvbnN0IHI9c1t0XSxvPWVbdF07c3dpdGNoKCEwKXtjYXNlIGEuI3IocikmJmEuI3Iobyk6ZVt0XT1hLm1lcmdlKG8scik7YnJlYWs7Y2FzZSByIGluc3RhbmNlb2YgTWFwJiZvIGluc3RhbmNlb2YgTWFwOmlmKHIuc2l6ZT4wKWZvcihjb25zdFtlLHRdb2YgcilvLnNldChlLHQpO2JyZWFrO2Nhc2UgciBpbnN0YW5jZW9mIFNldCYmbyBpbnN0YW5jZW9mIFNldDppZihyLnNpemU+MClmb3IoY29uc3QgZSBvZiByKW8uYWRkKGUpO2JyZWFrO2Nhc2UgQXJyYXkuaXNBcnJheShyKSYmMD09PXIubGVuZ3RoJiZ2b2lkIDAhPT1vOmNhc2UgciBpbnN0YW5jZW9mIE1hcCYmMD09PXIuc2l6ZSYmdm9pZCAwIT09bzpjYXNlIHIgaW5zdGFuY2VvZiBTZXQmJjA9PT1yLnNpemUmJnZvaWQgMCE9PW86YnJlYWs7Y2FzZSB2b2lkIDAhPT1yOmVbdF09cn19cmV0dXJuIGV9c3RhdGljI3IoZSl7aWYobnVsbD09PWV8fCJvYmplY3QiIT10eXBlb2YgZSlyZXR1cm4hMTtjb25zdCB0PU9iamVjdC5nZXRQcm90b3R5cGVPZihlKTtyZXR1cm4gbnVsbD09PXR8fHQ9PT1PYmplY3QucHJvdG90eXBlfXN0YXRpYyBvbWl0KGU9e30sdD1bXSl7cmV0dXJuIEFycmF5LmlzQXJyYXkodCl8fCh0PVt0LnRvU3RyaW5nKCldKSx0LmZvckVhY2godD0+YS51bnNldChlLHQpKSxlfXN0YXRpYyBwaWNrKGU9e30sdD1bXSl7QXJyYXkuaXNBcnJheSh0KXx8KHQ9W3QudG9TdHJpbmcoKV0pO2NvbnN0IGE9T2JqZWN0LmVudHJpZXMoZSkuZmlsdGVyKChbZSxhXSk9PnQuaW5jbHVkZXMoZSkpO3JldHVybiBPYmplY3QuZnJvbUVudHJpZXMoYSl9c3RhdGljIHNldChlLHQscyl7cmV0dXJuIEFycmF5LmlzQXJyYXkodCl8fCh0PWEudG9QYXRoKHQpKSx0LnNsaWNlKDAsLTEpLnJlZHVjZSgoZSxhLHMpPT5PYmplY3QoZVthXSk9PT1lW2FdP2VbYV06ZVthXT0vXlxkKyQvLnRlc3QodFtzKzFdKT9bXTp7fSxlKVt0W3QubGVuZ3RoLTFdXT1zLGV9c3RhdGljIHRvUGF0aChlKXtyZXR1cm4gZS5yZXBsYWNlKC9cWyhcZCspXF0vZywiLiQxIikuc3BsaXQoIi4iKS5maWx0ZXIoQm9vbGVhbil9c3RhdGljIHVuZXNjYXBlKGUpe2NvbnN0IHQ9eyImYW1wOyI6IiYiLCImbHQ7IjoiPCIsIiZndDsiOiI+IiwiJnF1b3Q7IjonIicsIiYjMzk7IjoiJyJ9O3JldHVybiBlLnJlcGxhY2UoLyZhbXA7fCZsdDt8Jmd0O3wmcXVvdDt8JiMzOTsvZyxlPT50W2VdKX1zdGF0aWMgdW5zZXQoZT17fSx0PSIiKXtBcnJheS5pc0FycmF5KHQpfHwodD1hLnRvUGF0aCh0KSk7cmV0dXJuIHQucmVkdWNlKChlLGEscyk9PnM9PT10Lmxlbmd0aC0xPyhkZWxldGUgZVthXSwhMCk6T2JqZWN0KGUpW2FdLGUpfX1jbGFzcyBze3N0YXRpYyBwYXJzZShlKXtsZXQgdD17fTtzd2l0Y2godHlwZW9mIGUpe2Nhc2Uic3RyaW5nIjp7Y29uc3Qgcj1lLnJlcGxhY2UoL15cPy8sIiIpO2lmKCFyKWJyZWFrO2NvbnN0IG89T2JqZWN0LmZyb21FbnRyaWVzKHIuc3BsaXQoIiYiKS5maWx0ZXIoQm9vbGVhbikubWFwKGU9Pntjb25zdFt0PSIiLGE9IiJdPWUuc3BsaXQoIj0iLDIpO3JldHVybltzLiNvKHQpLnJlcGxhY2UoL1xbKFteXFtcXV0rKVxdL2csIi4kMSIpLHMuI28oYSkucmVwbGFjZSgvXCIvZywiIildfSkpO09iamVjdC5rZXlzKG8pLmZvckVhY2goZT0+YS5zZXQodCxlLG9bZV0pKTticmVha31jYXNlIm9iamVjdCI6c3dpdGNoKGUpe2Nhc2UgbnVsbDpicmVhaztkZWZhdWx0Ontjb25zdCBzPXt9O09iamVjdC5rZXlzKGUpLmZvckVhY2godD0+YS5zZXQocyx0LGVbdF0pKSx0PXM7YnJlYWt9fWJyZWFrO2Nhc2UidW5kZWZpbmVkIjp0PXt9fXJldHVybiB0fXN0YXRpYyBzdHJpbmdpZnkoZT17fSl7aWYoIWV8fCJvYmplY3QiIT10eXBlb2YgZSlyZXR1cm4iIjtjb25zdCB0PVtdO3JldHVybiBPYmplY3Qua2V5cyhlKS5mb3JFYWNoKGE9PnMuI2MoZSxhLHQpKSwwPT09dC5sZW5ndGg/IiI6dC5tYXAoKFtlLHRdKT0+YCR7cy4jbihzLiNpKGUpKX09JHtzLiNuKHQpfWApLmpvaW4oIiYiKX1zdGF0aWMjYyhlLHQscil7Y29uc3Qgbz1hLmdldChlLHQpO3ZvaWQgMCE9PW8mJihudWxsIT09bz9BcnJheS5pc0FycmF5KG8pP28uZm9yRWFjaCgoYSxvKT0+e3ZvaWQgMCE9PWEmJnMuI2MoZSxgJHt0fVske299XWAscil9KTpzLiNyKG8pP09iamVjdC5rZXlzKG8pLmZvckVhY2goYT0+cy4jYyhlLGAke3R9LiR7YX1gLHIpKTpyLnB1c2goW3QsU3RyaW5nKG8pXSk6ci5wdXNoKFt0LCIiXSkpfXN0YXRpYyNpKGUpe2NvbnN0W3QsLi4uc109YS50b1BhdGgoZSk7cmV0dXJuIHMucmVkdWNlKChlLHQpPT4vXlxkKyQvLnRlc3QodCk/YCR7ZX1bJHt0fV1gOmAke2V9LiR7dH1gLHQpfXN0YXRpYyNyKGUpe2lmKG51bGw9PT1lfHwib2JqZWN0IiE9dHlwZW9mIGV8fEFycmF5LmlzQXJyYXkoZSkpcmV0dXJuITE7Y29uc3QgdD1PYmplY3QuZ2V0UHJvdG90eXBlT2YoZSk7cmV0dXJuIG51bGw9PT10fHx0PT09T2JqZWN0LnByb3RvdHlwZX1zdGF0aWMjbihlKXtyZXR1cm4gZW5jb2RlVVJJQ29tcG9uZW50KGUpfXN0YXRpYyNvKGUpe3JldHVybiBkZWNvZGVVUklDb21wb25lbnQoZS5yZXBsYWNlKC9cKy9nLCIgIikpfX10LmRlYnVnKCIgJGFyZ3VtZW50IiksZ2xvYmFsVGhpcy4kYXJndW1lbnQ9cy5wYXJzZShnbG9iYWxUaGlzLiRhcmd1bWVudCksZ2xvYmFsVGhpcy4kYXJndW1lbnQuTG9nTGV2ZWwmJih0LmxvZ0xldmVsPWdsb2JhbFRoaXMuJGFyZ3VtZW50LkxvZ0xldmVsKSx0LmRlYnVnKCIgJGFyZ3VtZW50IixgJGFyZ3VtZW50OiAke0pTT04uc3RyaW5naWZ5KGdsb2JhbFRoaXMuJGFyZ3VtZW50KX1gKTtjb25zdCByPXsxMDA6IkNvbnRpbnVlIiwxMDE6IlN3aXRjaGluZyBQcm90b2NvbHMiLDEwMjoiUHJvY2Vzc2luZyIsMTAzOiJFYXJseSBIaW50cyIsMjAwOiJPSyIsMjAxOiJDcmVhdGVkIiwyMDI6IkFjY2VwdGVkIiwyMDM6Ik5vbi1BdXRob3JpdGF0aXZlIEluZm9ybWF0aW9uIiwyMDQ6Ik5vIENvbnRlbnQiLDIwNToiUmVzZXQgQ29udGVudCIsMjA2OiJQYXJ0aWFsIENvbnRlbnQiLDIwNzoiTXVsdGktU3RhdHVzIiwyMDg6IkFscmVhZHkgUmVwb3J0ZWQiLDIyNjoiSU0gVXNlZCIsMzAwOiJNdWx0aXBsZSBDaG9pY2VzIiwzMDE6Ik1vdmVkIFBlcm1hbmVudGx5IiwzMDI6IkZvdW5kIiwzMDQ6Ik5vdCBNb2RpZmllZCIsMzA3OiJUZW1wb3JhcnkgUmVkaXJlY3QiLDMwODoiUGVybWFuZW50IFJlZGlyZWN0Iiw0MDA6IkJhZCBSZXF1ZXN0Iiw0MDE6IlVuYXV0aG9yaXplZCIsNDAyOiJQYXltZW50IFJlcXVpcmVkIiw0MDM6IkZvcmJpZGRlbiIsNDA0OiJOb3QgRm91bmQiLDQwNToiTWV0aG9kIE5vdCBBbGxvd2VkIiw0MDY6Ik5vdCBBY2NlcHRhYmxlIiw0MDc6IlByb3h5IEF1dGhlbnRpY2F0aW9uIFJlcXVpcmVkIiw0MDg6IlJlcXVlc3QgVGltZW91dCIsNDA5OiJDb25mbGljdCIsNDEwOiJHb25lIiw0MTE6Ikxlbmd0aCBSZXF1aXJlZCIsNDEyOiJQcmVjb25kaXRpb24gRmFpbGVkIiw0MTM6IkNvbnRlbnQgVG9vIExhcmdlIiw0MTQ6IlVSSSBUb28gTG9uZyIsNDE1OiJVbnN1cHBvcnRlZCBNZWRpYSBUeXBlIiw0MTY6IlJhbmdlIE5vdCBTYXRpc2ZpYWJsZSIsNDE3OiJFeHBlY3RhdGlvbiBGYWlsZWQiLDQxODoiSSdtIGEgdGVhcG90Iiw0MjE6Ik1pc2RpcmVjdGVkIFJlcXVlc3QiLDQyMjoiVW5wcm9jZXNzYWJsZSBFbnRpdHkiLDQyMzoiTG9ja2VkIiw0MjQ6IkZhaWxlZCBEZXBlbmRlbmN5Iiw0MjU6IlRvbyBFYXJseSIsNDI2OiJVcGdyYWRlIFJlcXVpcmVkIiw0Mjg6IlByZWNvbmRpdGlvbiBSZXF1aXJlZCIsNDI5OiJUb28gTWFueSBSZXF1ZXN0cyIsNDMxOiJSZXF1ZXN0IEhlYWRlciBGaWVsZHMgVG9vIExhcmdlIiw0NTE6IlVuYXZhaWxhYmxlIEZvciBMZWdhbCBSZWFzb25zIiw1MDA6IkludGVybmFsIFNlcnZlciBFcnJvciIsNTAxOiJOb3QgSW1wbGVtZW50ZWQiLDUwMjoiQmFkIEdhdGV3YXkiLDUwMzoiU2VydmljZSBVbmF2YWlsYWJsZSIsNTA0OiJHYXRld2F5IFRpbWVvdXQiLDUwNToiSFRUUCBWZXJzaW9uIE5vdCBTdXBwb3J0ZWQiLDUwNjoiVmFyaWFudCBBbHNvIE5lZ290aWF0ZXMiLDUwNzoiSW5zdWZmaWNpZW50IFN0b3JhZ2UiLDUwODoiTG9vcCBEZXRlY3RlZCIsNTEwOiJOb3QgRXh0ZW5kZWQiLDUxMToiTmV0d29yayBBdXRoZW50aWNhdGlvbiBSZXF1aXJlZCJ9O2Z1bmN0aW9uIG8ocz17fSl7c3dpdGNoKGUpe2Nhc2UiU3VyZ2UiOnMucG9saWN5JiZhLnNldChzLCJoZWFkZXJzLlgtU3VyZ2UtUG9saWN5IixzLnBvbGljeSksdC5sb2coIiDmiafooYznu5PmnZ8hIixgICR7KG5ldyBEYXRlKS5nZXRUaW1lKCkvMWUzLSRzY3JpcHQuc3RhcnRUaW1lfSDnp5JgKSwkZG9uZShzKTticmVhaztjYXNlIkxvb24iOnMucG9saWN5JiYocy5ub2RlPXMucG9saWN5KSx0LmxvZygiIOaJp+ihjOe7k+adnyEiLGAgJHsobmV3IERhdGUtJHNjcmlwdC5zdGFydFRpbWUpLzFlM30g56eSYCksJGRvbmUocyk7YnJlYWs7Y2FzZSJTdGFzaCI6cy5wb2xpY3kmJmEuc2V0KHMsImhlYWRlcnMuWC1TdGFzaC1TZWxlY3RlZC1Qcm94eSIsZW5jb2RlVVJJKHMucG9saWN5KSksdC5sb2coIiDmiafooYznu5PmnZ8hIixgICR7KG5ldyBEYXRlLSRzY3JpcHQuc3RhcnRUaW1lKS8xZTN9IOenkmApLCRkb25lKHMpO2JyZWFrO2Nhc2UiRWdlcm4iOmNhc2UiU2hhZG93cm9ja2V0Ijp0LmxvZygiIOaJp+ihjOe7k+adnyEiKSwkZG9uZShzKTticmVhaztjYXNlIlF1YW50dW11bHQgWCI6c3dpdGNoKHMucG9saWN5JiZhLnNldChzLCJvcHRzLnBvbGljeSIscy5wb2xpY3kpLHR5cGVvZihzPWEucGljayhzLFsic3RhdHVzIiwidXJsIiwiaGVhZGVycyIsImJvZHkiLCJib2R5Qnl0ZXMiXSkpLnN0YXR1cyl7Y2FzZSJudW1iZXIiOnMuc3RhdHVzPWBIVFRQLzEuMSAke3Muc3RhdHVzfSAke3Jbcy5zdGF0dXNdfWA7YnJlYWs7Y2FzZSJzdHJpbmciOmNhc2UidW5kZWZpbmVkIjpicmVhaztkZWZhdWx0OnRocm93IG5ldyBUeXBlRXJyb3IoYCR7RnVuY3Rpb24ubmFtZX06IOWPguaVsOexu+Wei+mUmeivrywgc3RhdHVzIOW/hemhu+S4uuaVsOWtl+aIluWtl+espuS4smApfXMuYm9keSBpbnN0YW5jZW9mIEFycmF5QnVmZmVyPyhzLmJvZHlCeXRlcz1zLmJvZHkscy5ib2R5PXZvaWQgMCk6QXJyYXlCdWZmZXIuaXNWaWV3KHMuYm9keSk/KHMuYm9keUJ5dGVzPXMuYm9keS5idWZmZXIuc2xpY2Uocy5ib2R5LmJ5dGVPZmZzZXQscy5ib2R5LmJ5dGVMZW5ndGgrcy5ib2R5LmJ5dGVPZmZzZXQpLHMuYm9keT12b2lkIDApOnMuYm9keSYmKHMuYm9keUJ5dGVzPXZvaWQgMCksdC5sb2coIiDmiafooYznu5PmnZ8hIiksJGRvbmUocyk7YnJlYWs7Y2FzZSJXb3JrZXIiOmRlZmF1bHQ6dC5sb2coIiDmiafooYznu5PmnZ8hIik7YnJlYWs7Y2FzZSJOb2RlLmpzIjp0LmxvZygiIOaJp+ihjOe7k+adnyEiKSxwcm9jZXNzLmV4aXQoMSl9fWNsYXNzIGN7c3RhdGljIGRhdGE9bnVsbDtzdGF0aWMgZGF0YUZpbGU9ImJveC5kYXQiO3N0YXRpYyNsPS9eQCg/PGtleT5bXi5dKykoPzpcLig/PHBhdGg+LiopKT8kLztzdGF0aWMgZ2V0SXRlbSh0LHM9bnVsbCl7bGV0IHI9cztzd2l0Y2godC5zdGFydHNXaXRoKCJAIikpe2Nhc2UhMDp7Y29uc3R7a2V5OmUscGF0aDpzfT10Lm1hdGNoKGMuI2wpPy5ncm91cHM7dD1lO2xldCBvPWMuZ2V0SXRlbSh0LHt9KTsib2JqZWN0IiE9dHlwZW9mIG8mJihvPXt9KSxyPWEuZ2V0KG8scyk7dHJ5e3I9SlNPTi5wYXJzZShyKX1jYXRjaHt9YnJlYWt9ZGVmYXVsdDpzd2l0Y2goZSl7Y2FzZSJTdXJnZSI6Y2FzZSJMb29uIjpjYXNlIlN0YXNoIjpjYXNlIkVnZXJuIjpjYXNlIlNoYWRvd3JvY2tldCI6cj0kcGVyc2lzdGVudFN0b3JlLnJlYWQodCk7YnJlYWs7Y2FzZSJRdWFudHVtdWx0IFgiOnI9JHByZWZzLnZhbHVlRm9yS2V5KHQpO2JyZWFrO2Nhc2UiV29ya2VyIjpjLmRhdGE9Yy5kYXRhPz97fSxyPWMuZGF0YVt0XTticmVhaztjYXNlIk5vZGUuanMiOmMuZGF0YT1jLiN1KGMuZGF0YUZpbGUpLHI9Yy5kYXRhPy5bdF07YnJlYWs7ZGVmYXVsdDpyPWMuZGF0YT8uW3RdfHxudWxsfXRyeXtyPUpTT04ucGFyc2Uocil9Y2F0Y2h7fX1yZXR1cm4gcj8/c31zdGF0aWMgc2V0SXRlbSh0PW5ldyBTdHJpbmcscz1uZXcgU3RyaW5nKXtsZXQgcj0hMTtpZigib2JqZWN0Ij09dHlwZW9mIHMpcz1KU09OLnN0cmluZ2lmeShzKTtlbHNlIHM9U3RyaW5nKHMpO3N3aXRjaCh0LnN0YXJ0c1dpdGgoIkAiKSl7Y2FzZSEwOntjb25zdHtrZXk6ZSxwYXRoOm99PXQubWF0Y2goYy4jbCk/Lmdyb3Vwczt0PWU7bGV0IG49Yy5nZXRJdGVtKHQse30pOyJvYmplY3QiIT10eXBlb2YgbiYmKG49e30pLGEuc2V0KG4sbyxzKSxyPWMuc2V0SXRlbSh0LG4pO2JyZWFrfWRlZmF1bHQ6c3dpdGNoKGUpe2Nhc2UiU3VyZ2UiOmNhc2UiTG9vbiI6Y2FzZSJTdGFzaCI6Y2FzZSJFZ2VybiI6Y2FzZSJTaGFkb3dyb2NrZXQiOnI9JHBlcnNpc3RlbnRTdG9yZS53cml0ZShzLHQpO2JyZWFrO2Nhc2UiUXVhbnR1bXVsdCBYIjpyPSRwcmVmcy5zZXRWYWx1ZUZvcktleShzLHQpO2JyZWFrO2Nhc2UiV29ya2VyIjpjLmRhdGE9Yy5kYXRhPz97fSxjLmRhdGFbdF09cyxyPSEwO2JyZWFrO2Nhc2UiTm9kZS5qcyI6Yy5kYXRhPWMuI3UoYy5kYXRhRmlsZSksYy5kYXRhW3RdPXMsYy4jZChjLmRhdGFGaWxlKSxyPSEwO2JyZWFrO2RlZmF1bHQ6cj1jLmRhdGE/Llt0XXx8bnVsbH19cmV0dXJuIHJ9c3RhdGljIHJlbW92ZUl0ZW0odCl7bGV0IHM9ITE7c3dpdGNoKHQuc3RhcnRzV2l0aCgiQCIpKXtjYXNlITA6e2NvbnN0e2tleTplLHBhdGg6cn09dC5tYXRjaChjLiNsKT8uZ3JvdXBzO3Q9ZTtsZXQgbz1jLmdldEl0ZW0odCk7Im9iamVjdCIhPXR5cGVvZiBvJiYobz17fSksYS51bnNldChvLHIpLHM9Yy5zZXRJdGVtKHQsbyk7YnJlYWt9ZGVmYXVsdDpzd2l0Y2goZSl7Y2FzZSJTdXJnZSI6cz0kcGVyc2lzdGVudFN0b3JlLndyaXRlKG51bGwsdCk7YnJlYWs7Y2FzZSJMb29uIjpjYXNlIlN0YXNoIjpjYXNlIkVnZXJuIjpjYXNlIlNoYWRvd3JvY2tldCI6ZGVmYXVsdDpzPSExO2JyZWFrO2Nhc2UiUXVhbnR1bXVsdCBYIjpzPSRwcmVmcy5yZW1vdmVWYWx1ZUZvcktleSh0KTticmVhaztjYXNlIldvcmtlciI6Yy5kYXRhPWMuZGF0YT8/e30sZGVsZXRlIGMuZGF0YVt0XSxzPSEwO2JyZWFrO2Nhc2UiTm9kZS5qcyI6Yy5kYXRhPWMuI3UoYy5kYXRhRmlsZSksZGVsZXRlIGMuZGF0YVt0XSxjLiNkKGMuZGF0YUZpbGUpLHM9ITB9fXJldHVybiBzfXN0YXRpYyBjbGVhcigpe2xldCB0PSExO3N3aXRjaChlKXtjYXNlIlN1cmdlIjpjYXNlIkxvb24iOmNhc2UiU3Rhc2giOmNhc2UiRWdlcm4iOmNhc2UiU2hhZG93cm9ja2V0IjpkZWZhdWx0OnQ9ITE7YnJlYWs7Y2FzZSJRdWFudHVtdWx0IFgiOnQ9JHByZWZzLnJlbW92ZUFsbFZhbHVlcygpO2JyZWFrO2Nhc2UiV29ya2VyIjpjLmRhdGE9e30sdD0hMDticmVhaztjYXNlIk5vZGUuanMiOmMuZGF0YT1jLiN1KGMuZGF0YUZpbGUpLGMuZGF0YT17fSxjLiNkKGMuZGF0YUZpbGUpLHQ9ITB9cmV0dXJuIHR9c3RhdGljI3U9dD0+e2lmKCJOb2RlLmpzIiE9PWUpcmV0dXJue307e3RoaXMuZnM9dGhpcy5mcz90aGlzLmZzOnJlcXVpcmUoImZzIiksdGhpcy5wYXRoPXRoaXMucGF0aD90aGlzLnBhdGg6cmVxdWlyZSgicGF0aCIpO2NvbnN0IGU9dGhpcy5wYXRoLnJlc29sdmUodCksYT10aGlzLnBhdGgucmVzb2x2ZShwcm9jZXNzLmN3ZCgpLHQpLHM9dGhpcy5mcy5leGlzdHNTeW5jKGUpLHI9IXMmJnRoaXMuZnMuZXhpc3RzU3luYyhhKTtpZighcyYmIXIpcmV0dXJue307e2NvbnN0IHQ9cz9lOmE7dHJ5e3JldHVybiBKU09OLnBhcnNlKHRoaXMuZnMucmVhZEZpbGVTeW5jKHQpKX1jYXRjaChlKXtyZXR1cm57fX19fX07c3RhdGljI2Q9KHQ9dGhpcy5kYXRhRmlsZSk9PntpZigiTm9kZS5qcyI9PT1lKXt0aGlzLmZzPXRoaXMuZnM/dGhpcy5mczpyZXF1aXJlKCJmcyIpLHRoaXMucGF0aD10aGlzLnBhdGg/dGhpcy5wYXRoOnJlcXVpcmUoInBhdGgiKTtjb25zdCBlPXRoaXMucGF0aC5yZXNvbHZlKHQpLGE9dGhpcy5wYXRoLnJlc29sdmUocHJvY2Vzcy5jd2QoKSx0KSxzPXRoaXMuZnMuZXhpc3RzU3luYyhlKSxyPSFzJiZ0aGlzLmZzLmV4aXN0c1N5bmMoYSksbz1KU09OLnN0cmluZ2lmeSh0aGlzLmRhdGEpO3M/dGhpcy5mcy53cml0ZUZpbGVTeW5jKGUsbyk6cj90aGlzLmZzLndyaXRlRmlsZVN5bmMoYSxvKTp0aGlzLmZzLndyaXRlRmlsZVN5bmMoZSxvKX19fWNvbnN0IG49Indsb2Nfc2V0dGluZ3MiLGk9JHJlcXVlc3QudXJsfHwiIjtmdW5jdGlvbiBsKGUpe3JldHVybiBwYXJzZUZsb2F0KFN0cmluZyhlfHwiMCIpLnJlcGxhY2UoIiwiLCIuIikpfWNvbnN0IHU9ZnVuY3Rpb24oZSl7Y29uc3QgdD1lLnNwbGl0KCI/IilbMV18fCIiLGE9bmV3IE1hcDtmb3IoY29uc3QgZSBvZiB0LnNwbGl0KCImIikpe2lmKCFlKWNvbnRpbnVlO2NvbnN0IHQ9ZS5pbmRleE9mKCI9Iikscz0tMT09PXQ/ZTplLnNsaWNlKDAsdCkscj0tMT09PXQ/IiI6ZS5zbGljZSh0KzEpO2xldCBvLGM7dHJ5e289ZGVjb2RlVVJJQ29tcG9uZW50KHMucmVwbGFjZSgvXCsvZywiICIpKX1jYXRjaHtvPXN9dHJ5e2M9ZGVjb2RlVVJJQ29tcG9uZW50KHIucmVwbGFjZSgvXCsvZywiICIpKX1jYXRjaHtjPXJ9YS5oYXMobyl8fGEuc2V0KG8sYyl9cmV0dXJuIGF9KGkpLGQ9dS5nZXQoImFjdGlvbiIpfHwic2F2ZSI7bGV0IGc7aWYodC5kZWJ1ZyhgW3dsb2Mtc2V0dGluZ3NdIHVybD0ke2l9LCBhY3Rpb249JHtkfWApLCJxdWVyeSI9PT1kKXRyeXtjb25zdCBlPWMuZ2V0SXRlbShuKTtlJiYib2JqZWN0Ij09dHlwZW9mIGUmJmUubG9uZ2l0dWRlJiZlLmxhdGl0dWRlPyhnPXtzdWNjZXNzOiEwLGxvbmdpdHVkZTplLmxvbmdpdHVkZSxsYXRpdHVkZTplLmxhdGl0dWRlLGFjY3VyYWN5OmUuYWNjdXJhY3l8fDI1LHJhbmRvbVJhZGl1czplLnJhbmRvbVJhZGl1cz8/MCx1cGRhdGVkQXQ6ZS51cGRhdGVkQXR8fG51bGx9LHQuZGVidWcoYFt3bG9jLXNldHRpbmdzXSDmn6Xor6I6ICR7ZS5sb25naXR1ZGV9LCAke2UubGF0aXR1ZGV9YCkpOmc9e3N1Y2Nlc3M6ITEsZXJyb3I6IuaXoOW3suS/neWtmOeahOWdkOaghyJ9fWNhdGNoKGUpe2c9e3N1Y2Nlc3M6ITEsZXJyb3I6ZS5tZXNzYWdlfHwi6K+75Y+W5aSx6LSlIn19ZWxzZSBpZigiY2xlYXIiPT09ZCl0cnl7Yy5zZXRJdGVtKG4sbnVsbCksZz17c3VjY2VzczohMH0sdC5pbmZvKCJbd2xvYy1zZXR0aW5nc10g5bey5riF6Zmk5Z2Q5qCH5pWw5o2uIil9Y2F0Y2goZSl7Zz17c3VjY2VzczohMSxlcnJvcjplLm1lc3NhZ2V8fCLmuIXpmaTlpLHotKUifSx0LmVycm9yKGBbd2xvYy1zZXR0aW5nc10g5riF6Zmk5aSx6LSlOiAke2UubWVzc2FnZX1gKX1lbHNle2NvbnN0IGU9bCh1LmdldCgibG9uIil8fHUuZ2V0KCJsb25naXR1ZGUiKSksYT1sKHUuZ2V0KCJsYXQiKXx8dS5nZXQoImxhdGl0dWRlIikpLHM9cGFyc2VJbnQodS5nZXQoImFjYyIpfHx1LmdldCgiYWNjdXJhY3kiKXx8dS5nZXQoImhhY2MiKXx8IjI1IiwxMCk7aWYoIU51bWJlci5pc0Zpbml0ZShlKXx8IU51bWJlci5pc0Zpbml0ZShhKXx8TWF0aC5hYnMoYSk+OTB8fE1hdGguYWJzKGUpPjE4MClnPXtzdWNjZXNzOiExLGVycm9yOiLnvLrlsJEgbG9uL2xhdCDlj4LmlbAifTtlbHNle2xldCByPXt9O3RyeXtjb25zdCBlPWMuZ2V0SXRlbShuKTtlJiYib2JqZWN0Ij09dHlwZW9mIGUmJihyPWUpfWNhdGNoe31jb25zdCBvPXsuLi5yLGxvbmdpdHVkZTplLGxhdGl0dWRlOmEsYWNjdXJhY3k6cyx1cGRhdGVkQXQ6bmV3IERhdGUoRGF0ZS5ub3coKSsyODhlNSkudG9JU09TdHJpbmcoKS5yZXBsYWNlKCJaIiwiKzA4OjAwIil9LGk9dS5nZXQoInJhbmRvbVJhZGl1cyIpO251bGwhPWkmJiIiIT09aSYmKG8ucmFuZG9tUmFkaXVzPWwoaSkpO3RyeXtjLnNldEl0ZW0obixvKT8oZz17c3VjY2VzczohMCxsb25naXR1ZGU6ZSxsYXRpdHVkZTphLGFjY3VyYWN5OnMscmFuZG9tUmFkaXVzOm8ucmFuZG9tUmFkaXVzPz8wfSx0LmluZm8oYFt3bG9jLXNldHRpbmdzXSDlt7Lkv53lrZg6ICR7ZX0sICR7YX1gKSk6KGc9e3N1Y2Nlc3M6ITEsZXJyb3I6IlN0b3JhZ2Uuc2V0SXRlbSDov5Tlm54gZmFsc2UifSx0LmVycm9yKCJbd2xvYy1zZXR0aW5nc10gc2V0SXRlbSDov5Tlm54gZmFsc2UiKSl9Y2F0Y2goZSl7Zz17c3VjY2VzczohMSxlcnJvcjplLm1lc3NhZ2V8fCLlhpnlhaXlpLHotKUifSx0LmVycm9yKGBbd2xvYy1zZXR0aW5nc10gJHtlLm1lc3NhZ2V9YCl9fX1jb25zdCBwPXtzdGF0dXM6MjAwLGhlYWRlcnM6eyJDb250ZW50LVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIiwiQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luIjoiKiIsIkFjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHMiOiJHRVQsIFBPU1QsIE9QVElPTlMiLCJBY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzIjoiKiIsIkNhY2hlLUNvbnRyb2wiOiJuby1zdG9yZSJ9LGJvZHk6SlNPTi5zdHJpbmdpZnkoZyl9O28oIlF1YW50dW11bHQgWCI9PT1lP3A6e3Jlc3BvbnNlOnB9KTsK";
const LOCATION_SPOOFER_QX_B64 = "LyoKICogUVgg55qEICRyZXNwb25zZS5ib2R5IOe7meeahOaYryBiYXNlNjQg5a2X56ym5Liy77yI5LiN5pivIFVpbnQ4QXJyYXnvvInvvIwKICog5omA5Lul6L+Z54mI5aSa5LqG5LiA5q2lIGJhc2U2NCDihpQgYnl0ZXMg55qE6L2s5o2i77yM5YW25LuW6YC76L6R5ZKM5Li754mI5LiA5qC344CCCiAqLwooZnVuY3Rpb24gKCkgewogICJ1c2Ugc3RyaWN0IjsKCiAgdmFyIERFRkFVTFRfQ09ORklHID0gewogICAgLy8gU3RhdGVsZXNzIGRlZmF1bHQ6IE9GRiB1bnRpbCB0aGUgcGlja2VyIHdyaXRlcyBjb29yZGluYXRlcyB0byB0aGlzIGRldmljZSdzIG93bgogICAgLy8gJHByZWZzLiAiTm90aGluZyBwaWNrZWQgeWV0IiB0aGVuIGZhbGxzIHRocm91Z2ggdG8gdGhlIHJlYWwgbG9jYXRpb24uCiAgICBlbmFibGVkOiBmYWxzZSwKICAgIGxhdGl0dWRlOiAzNy4zMzQ5LAogICAgbG9uZ2l0dWRlOiAtMTIyLjAwOTAyLAogICAgaG9yaXpvbnRhbEFjY3VyYWN5OiAzOSwKICAgIHZlcnRpY2FsQWNjdXJhY3k6IDEwMDAsCiAgICAvLyBSYW5kb20gcGVydHVyYmF0aW9uIHJhZGl1cyBpbiBtZXRyZXMgKFl1OTE5MSB2MS4xICLmibDliqjljYrlvoQiKS4gMCA9IG9mZi4gV3JpdHRlbgogICAgLy8gcGVyLWRldmljZSBieSB0aGUgcGlja2VyIHZpYSBsb2NhdGlvbi1zZXR0aW5ncy5qcyAoJHByZWZzKS4KICAgIHJhbmRvbVJhZGl1czogMCwKICAgIGFsdGl0dWRlOiA1MzAsCiAgICB1bmtub3duVmFsdWU0OiAzLAogICAgbW90aW9uQWN0aXZpdHlUeXBlOiA2MywKICAgIG1vdGlvbkFjdGl2aXR5Q29uZmlkZW5jZTogNDY3LAogICAgZmFpbE9wZW46IHRydWUsCiAgICBkZWJ1ZzogZmFsc2UKICB9OwoKICB2YXIgQVBQTEVfV0xPQ19QUkVGSVggPSBuZXcgVWludDhBcnJheShbMHgwMCwgMHgwMSwgMHgwMCwgMHgwMCwgMHgwMCwgMHgwMSwgMHgwMCwgMHgwMF0pOwogIHZhciBBUFBMRV9XTE9DX01BUktFUiA9IG5ldyBVaW50OEFycmF5KFsweDAwLCAweDAwLCAweDAwLCAweDAxLCAweDAwLCAweDAwXSk7CiAgdmFyIFJPT1RfRFJPUF9GSUVMRFMgPSB7IDM6IHRydWUsIDQ6IHRydWUsIDMzOiB0cnVlIH07CiAgdmFyIENFTExfUkVTUE9OU0VfRklFTERTID0geyAyMjogdHJ1ZSwgMjQ6IHRydWUgfTsKICB2YXIgTE9DQVRJT05fUkVQTEFDRURfRklFTERTID0geyAxOiB0cnVlLCAyOiB0cnVlLCAzOiB0cnVlLCA0OiB0cnVlLCA1OiB0cnVlLCA2OiB0cnVlLCAxMTogdHJ1ZSwgMTI6IHRydWUgfTsKCiAgLy8gPT09PT09PT09PSBCeXRlIFV0aWxpdGllcyA9PT09PT09PT09CgogIGZ1bmN0aW9uIGNvbmNhdEJ5dGVzKHBhcnRzKSB7CiAgICB2YXIgdG90YWwgPSAwLCBpOwogICAgZm9yIChpID0gMDsgaSA8IHBhcnRzLmxlbmd0aDsgaSsrKSB0b3RhbCArPSBwYXJ0c1tpXS5sZW5ndGg7CiAgICB2YXIgb3V0ID0gbmV3IFVpbnQ4QXJyYXkodG90YWwpLCBvZmZzZXQgPSAwOwogICAgZm9yIChpID0gMDsgaSA8IHBhcnRzLmxlbmd0aDsgaSsrKSB7IG91dC5zZXQocGFydHNbaV0sIG9mZnNldCk7IG9mZnNldCArPSBwYXJ0c1tpXS5sZW5ndGg7IH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICBmdW5jdGlvbiBmaW5kQnl0ZXMoYnl0ZXMsIG1hcmtlcikgewogICAgaWYgKCFieXRlcyB8fCAhbWFya2VyIHx8IG1hcmtlci5sZW5ndGggPT09IDApIHJldHVybiAtMTsKICAgIGZvciAodmFyIGkgPSAwOyBpIDw9IGJ5dGVzLmxlbmd0aCAtIG1hcmtlci5sZW5ndGg7IGkrKykgewogICAgICB2YXIgb2sgPSB0cnVlOwogICAgICBmb3IgKHZhciBqID0gMDsgaiA8IG1hcmtlci5sZW5ndGg7IGorKykgeyBpZiAoYnl0ZXNbaSArIGpdICE9PSBtYXJrZXJbal0pIHsgb2sgPSBmYWxzZTsgYnJlYWs7IH0gfQogICAgICBpZiAob2spIHJldHVybiBpOwogICAgfQogICAgcmV0dXJuIC0xOwogIH0KCiAgZnVuY3Rpb24gaGV4UHJldmlldyhieXRlcywgbGltaXQpIHsKICAgIGlmICghYnl0ZXMpIHJldHVybiAiPG5vbmU+IjsKICAgIHZhciBvdXQgPSBbXSwgbWF4ID0gTWF0aC5taW4oYnl0ZXMubGVuZ3RoLCBsaW1pdCB8fCAxNik7CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IG1heDsgaSsrKSBvdXQucHVzaCgoIjAiICsgYnl0ZXNbaV0udG9TdHJpbmcoMTYpKS5zbGljZSgtMikpOwogICAgcmV0dXJuIG91dC5qb2luKCIiKTsKICB9CgogIC8vID09PT09PT09PT0gQmFzZTY0IChRWCDkuJPnlKgpID09PT09PT09PT0KCiAgZnVuY3Rpb24gYmFzZTY0VG9CeXRlcyhiNjQpIHsKICAgIHZhciBhbHBoYWJldCA9ICJBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWmFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MDEyMzQ1Njc4OSsvIjsKICAgIHZhciBsb29rdXAgPSB7fSwgaTsKICAgIGZvciAoaSA9IDA7IGkgPCBhbHBoYWJldC5sZW5ndGg7IGkrKykgbG9va3VwW2FscGhhYmV0W2ldXSA9IGk7CiAgICBiNjQgPSBiNjQucmVwbGFjZSgvW15BLVphLXowLTlcK1wvXS9nLCAiIik7CiAgICB2YXIgbGVuID0gYjY0Lmxlbmd0aCwgb3V0ID0gW10sIHBhZGRpbmcgPSAwOwogICAgaWYgKGxlbiA+IDAgJiYgYjY0W2xlbiAtIDFdID09PSAiPSIpIHBhZGRpbmcrKzsKICAgIGlmIChsZW4gPiAxICYmIGI2NFtsZW4gLSAyXSA9PT0gIj0iKSBwYWRkaW5nKys7CiAgICB2YXIgYnVmTGVuID0gKGxlbiAvIDQpICogMyAtIHBhZGRpbmc7CiAgICB2YXIgYnVmID0gbmV3IFVpbnQ4QXJyYXkoYnVmTGVuKSwgcG9zID0gMDsKICAgIGZvciAoaSA9IDA7IGkgPCBsZW47IGkgKz0gNCkgewogICAgICB2YXIgZW5jMSA9IGxvb2t1cFtiNjRbaV1dLCBlbmMyID0gbG9va3VwW2I2NFtpICsgMV1dLCBlbmMzID0gbG9va3VwW2I2NFtpICsgMl1dLCBlbmM0ID0gbG9va3VwW2I2NFtpICsgM11dOwogICAgICB2YXIgY2hyMSA9IChlbmMxIDw8IDIpIHwgKGVuYzIgPj4gNCk7CiAgICAgIHZhciBjaHIyID0gKChlbmMyICYgMTUpIDw8IDQpIHwgKGVuYzMgPj4gMik7CiAgICAgIHZhciBjaHIzID0gKChlbmMzICYgMykgPDwgNikgfCBlbmM0OwogICAgICBidWZbcG9zKytdID0gY2hyMTsKICAgICAgaWYgKGVuYzMgIT09IDY0KSBidWZbcG9zKytdID0gY2hyMjsKICAgICAgaWYgKGVuYzQgIT09IDY0KSBidWZbcG9zKytdID0gY2hyMzsKICAgIH0KICAgIHJldHVybiBidWY7CiAgfQoKICBmdW5jdGlvbiBieXRlc1RvQmFzZTY0KGJ5dGVzKSB7CiAgICB2YXIgYWxwaGFiZXQgPSAiQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODkrLyI7CiAgICB2YXIgb3V0ID0gIiI7CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAzKSB7CiAgICAgIHZhciBiMCA9IGJ5dGVzW2ldLCBiMSA9IGkgKyAxIDwgYnl0ZXMubGVuZ3RoID8gYnl0ZXNbaSArIDFdIDogMCwgYjIgPSBpICsgMiA8IGJ5dGVzLmxlbmd0aCA/IGJ5dGVzW2kgKyAyXSA6IDA7CiAgICAgIHZhciB0cmlwbGV0ID0gKGIwIDw8IDE2KSB8IChiMSA8PCA4KSB8IGIyOwogICAgICBvdXQgKz0gYWxwaGFiZXRbKHRyaXBsZXQgPj4gMTgpICYgMHgzZl0gKyBhbHBoYWJldFsodHJpcGxldCA+PiAxMikgJiAweDNmXTsKICAgICAgb3V0ICs9IGkgKyAxIDwgYnl0ZXMubGVuZ3RoID8gYWxwaGFiZXRbKHRyaXBsZXQgPj4gNikgJiAweDNmXSA6ICI9IjsKICAgICAgb3V0ICs9IGkgKyAyIDwgYnl0ZXMubGVuZ3RoID8gYWxwaGFiZXRbdHJpcGxldCAmIDB4M2ZdIDogIj0iOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIC8vID09PT09PT09PT0gVmFyaW50IC8gUHJvdG9idWYgPT09PT09PT09PQoKICBmdW5jdGlvbiBlbmNvZGVWYXJpbnRVbnNpZ25lZCh2YWx1ZSkgewogICAgdmFyIHYgPSB0eXBlb2YgdmFsdWUgPT09ICJiaWdpbnQiID8gdmFsdWUgOiBCaWdJbnQodmFsdWUpOwogICAgaWYgKHYgPCAwbikgdGhyb3cgbmV3IEVycm9yKCJuZWdhdGl2ZSB1bnNpZ25lZCB2YXJpbnQiKTsKICAgIHZhciBvdXQgPSBbXTsKICAgIHdoaWxlICh2ID49IDB4ODBuKSB7IG91dC5wdXNoKE51bWJlcigodiAmIDB4N2ZuKSB8IDB4ODBuKSk7IHYgPj49IDduOyB9CiAgICBvdXQucHVzaChOdW1iZXIodikpOwogICAgcmV0dXJuIG5ldyBVaW50OEFycmF5KG91dCk7CiAgfQoKICBmdW5jdGlvbiBlbmNvZGVWYXJpbnRTaWduZWRJbnQ2NCh2YWx1ZSkgewogICAgdmFyIHYgPSB0eXBlb2YgdmFsdWUgPT09ICJiaWdpbnQiID8gdmFsdWUgOiBCaWdJbnQoTWF0aC50cnVuYyh2YWx1ZSkpOwogICAgaWYgKHYgPCAwbikgdiA9IEJpZ0ludC5hc1VpbnROKDY0LCB2KTsKICAgIHJldHVybiBlbmNvZGVWYXJpbnRVbnNpZ25lZCh2KTsKICB9CgogIGZ1bmN0aW9uIGRlY29kZVZhcmludChieXRlcywgb2Zmc2V0KSB7CiAgICB2YXIgcmVzdWx0ID0gMG4sIHNoaWZ0ID0gMG4sIGN1cnJlbnQgPSBvZmZzZXQ7CiAgICB3aGlsZSAoY3VycmVudCA8IGJ5dGVzLmxlbmd0aCkgewogICAgICB2YXIgYiA9IGJ5dGVzW2N1cnJlbnRdOyBjdXJyZW50ICs9IDE7CiAgICAgIHJlc3VsdCB8PSBCaWdJbnQoYiAmIDB4N2YpIDw8IHNoaWZ0OwogICAgICBpZiAoKGIgJiAweDgwKSA9PT0gMCkgcmV0dXJuIHsgdmFsdWU6IHJlc3VsdCwgb2Zmc2V0OiBjdXJyZW50IH07CiAgICAgIHNoaWZ0ICs9IDduOwogICAgICBpZiAoc2hpZnQgPiA3MG4pIHRocm93IG5ldyBFcnJvcigidmFyaW50IHRvbyBsb25nIik7CiAgICB9CiAgICB0aHJvdyBuZXcgRXJyb3IoInVudGVybWluYXRlZCB2YXJpbnQiKTsKICB9CgogIGZ1bmN0aW9uIG1ha2VLZXkoZmllbGROdW1iZXIsIHdpcmVUeXBlKSB7CiAgICByZXR1cm4gZW5jb2RlVmFyaW50VW5zaWduZWQoKEJpZ0ludChmaWVsZE51bWJlcikgPDwgM24pIHwgQmlnSW50KHdpcmVUeXBlKSk7CiAgfQoKICBmdW5jdGlvbiBtYWtlVmFyaW50RmllbGQoZmllbGROdW1iZXIsIHZhbHVlKSB7CiAgICByZXR1cm4gY29uY2F0Qnl0ZXMoW21ha2VLZXkoZmllbGROdW1iZXIsIDApLCBlbmNvZGVWYXJpbnRTaWduZWRJbnQ2NCh2YWx1ZSldKTsKICB9CgogIGZ1bmN0aW9uIG1ha2VMZW5ndGhEZWxpbWl0ZWRGaWVsZChmaWVsZE51bWJlciwgcGF5bG9hZCkgewogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKFttYWtlS2V5KGZpZWxkTnVtYmVyLCAyKSwgZW5jb2RlVmFyaW50VW5zaWduZWQocGF5bG9hZC5sZW5ndGgpLCBwYXlsb2FkXSk7CiAgfQoKICBmdW5jdGlvbiBwYXJzZUZpZWxkcyhieXRlcykgewogICAgdmFyIGZpZWxkcyA9IFtdLCBvZmZzZXQgPSAwOwogICAgd2hpbGUgKG9mZnNldCA8IGJ5dGVzLmxlbmd0aCkgewogICAgICB2YXIga2V5U3RhcnQgPSBvZmZzZXQ7CiAgICAgIHZhciBrZXkgPSBkZWNvZGVWYXJpbnQoYnl0ZXMsIG9mZnNldCk7CiAgICAgIG9mZnNldCA9IGtleS5vZmZzZXQ7CiAgICAgIHZhciBmaWVsZE51bWJlciA9IE51bWJlcihrZXkudmFsdWUgPj4gM24pLCB3aXJlVHlwZSA9IE51bWJlcihrZXkudmFsdWUgJiAweDduKTsKICAgICAgaWYgKGZpZWxkTnVtYmVyID09PSAwKSB0aHJvdyBuZXcgRXJyb3IoInByb3RvYnVmIGZpZWxkIG51bWJlciAwIik7CiAgICAgIHZhciB2YWx1ZVN0YXJ0ID0gb2Zmc2V0LCB2YWx1ZUVuZDsKICAgICAgaWYgKHdpcmVUeXBlID09PSAwKSB7IHZhbHVlRW5kID0gZGVjb2RlVmFyaW50KGJ5dGVzLCBvZmZzZXQpLm9mZnNldDsgfQogICAgICBlbHNlIGlmICh3aXJlVHlwZSA9PT0gMSkgeyB2YWx1ZUVuZCA9IG9mZnNldCArIDg7IH0KICAgICAgZWxzZSBpZiAod2lyZVR5cGUgPT09IDIpIHsgdmFyIGxlbkluZm8gPSBkZWNvZGVWYXJpbnQoYnl0ZXMsIG9mZnNldCk7IHZhbHVlU3RhcnQgPSBsZW5JbmZvLm9mZnNldDsgdmFsdWVFbmQgPSB2YWx1ZVN0YXJ0ICsgTnVtYmVyKGxlbkluZm8udmFsdWUpOyB9CiAgICAgIGVsc2UgaWYgKHdpcmVUeXBlID09PSA1KSB7IHZhbHVlRW5kID0gb2Zmc2V0ICsgNDsgfQogICAgICBlbHNlIHRocm93IG5ldyBFcnJvcigidW5zdXBwb3J0ZWQgd2lyZSB0eXBlOiAiICsgd2lyZVR5cGUpOwogICAgICBpZiAodmFsdWVFbmQgPiBieXRlcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcigiZmllbGQgZXhjZWVkcyBidWZmZXIiKTsKICAgICAgZmllbGRzLnB1c2goeyBmaWVsZE51bWJlcjogZmllbGROdW1iZXIsIHdpcmVUeXBlOiB3aXJlVHlwZSwga2V5U3RhcnQ6IGtleVN0YXJ0LCB2YWx1ZVN0YXJ0OiB2YWx1ZVN0YXJ0LCB2YWx1ZUVuZDogdmFsdWVFbmQsIHJhdzogYnl0ZXMuc2xpY2Uoa2V5U3RhcnQsIHZhbHVlRW5kKSwgdmFsdWVCeXRlczogYnl0ZXMuc2xpY2UodmFsdWVTdGFydCwgdmFsdWVFbmQpIH0pOwogICAgICBvZmZzZXQgPSB2YWx1ZUVuZDsKICAgIH0KICAgIHJldHVybiBmaWVsZHM7CiAgfQoKICBmdW5jdGlvbiBmaXJzdEZpZWxkQnlOdW1iZXIoZmllbGRzLCBmaWVsZE51bWJlcikgewogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBmaWVsZHMubGVuZ3RoOyBpKyspIHsgaWYgKGZpZWxkc1tpXS5maWVsZE51bWJlciA9PT0gZmllbGROdW1iZXIpIHJldHVybiBmaWVsZHNbaV07IH0KICAgIHJldHVybiBudWxsOwogIH0KCiAgZnVuY3Rpb24gc2lnbmVkVmFyaW50RmllbGRWYWx1ZShmaWVsZCkgewogICAgaWYgKCFmaWVsZCB8fCBmaWVsZC53aXJlVHlwZSAhPT0gMCkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gQmlnSW50LmFzSW50Tig2NCwgZGVjb2RlVmFyaW50KGZpZWxkLnZhbHVlQnl0ZXMsIDApLnZhbHVlKTsKICB9CgogIGZ1bmN0aW9uIHRyeVBhcnNlRmllbGRzKGJ5dGVzKSB7CiAgICB0cnkgeyBpZiAoIWJ5dGVzIHx8IGJ5dGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7IHZhciBmID0gcGFyc2VGaWVsZHMoYnl0ZXMpOyByZXR1cm4gZi5sZW5ndGggPiAwID8gZiA6IG51bGw7IH0KICAgIGNhdGNoIChlKSB7IHJldHVybiBudWxsOyB9CiAgfQoKICBmdW5jdGlvbiBpc0NlbGxSZXNwb25zZUZpZWxkKGZpZWxkTnVtYmVyKSB7IHJldHVybiBDRUxMX1JFU1BPTlNFX0ZJRUxEU1tmaWVsZE51bWJlcl0gPT09IHRydWU7IH0KCiAgLy8gPT09PT09PT09PSBBUlBDID09PT09PT09PT0KCiAgZnVuY3Rpb24gcmVhZFVJbnQxNkJFKGJ5dGVzLCBvZmZzZXQpIHsgcmV0dXJuIChieXRlc1tvZmZzZXRdIDw8IDgpIHwgYnl0ZXNbb2Zmc2V0ICsgMV07IH0KICBmdW5jdGlvbiByZWFkVUludDMyQkUoYnl0ZXMsIG9mZnNldCkgeyByZXR1cm4gKChieXRlc1tvZmZzZXRdICogMHgxMDAwMDAwKSArICgoYnl0ZXNbb2Zmc2V0ICsgMV0gPDwgMTYpIHwgKGJ5dGVzW29mZnNldCArIDJdIDw8IDgpIHwgYnl0ZXNbb2Zmc2V0ICsgM10pKSA+Pj4gMDsgfQogIGZ1bmN0aW9uIHdyaXRlVUludDE2QkUodmFsdWUpIHsgcmV0dXJuIG5ldyBVaW50OEFycmF5KFsodmFsdWUgPj4gOCkgJiAweGZmLCB2YWx1ZSAmIDB4ZmZdKTsgfQogIGZ1bmN0aW9uIHdyaXRlVUludDMyQkUodmFsdWUpIHsgcmV0dXJuIG5ldyBVaW50OEFycmF5KFsodmFsdWUgPj4+IDI0KSAmIDB4ZmYsICh2YWx1ZSA+Pj4gMTYpICYgMHhmZiwgKHZhbHVlID4+PiA4KSAmIDB4ZmYsIHZhbHVlICYgMHhmZl0pOyB9CgogIGZ1bmN0aW9uIGFzY2lpQnl0ZXModmFsdWUpIHsKICAgIHZhciBvdXQgPSBuZXcgVWludDhBcnJheSh2YWx1ZS5sZW5ndGgpOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCB2YWx1ZS5sZW5ndGg7IGkrKykgb3V0W2ldID0gdmFsdWUuY2hhckNvZGVBdChpKSAmIDB4N2Y7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgZnVuY3Rpb24gcmVhZFBhc2NhbFN0cmluZyhieXRlcywgc3RhdGUpIHsKICAgIHZhciBsZW5ndGggPSByZWFkVUludDE2QkUoYnl0ZXMsIHN0YXRlLm9mZnNldCk7IHN0YXRlLm9mZnNldCArPSAyOwogICAgdmFyIGNoYXJzID0gW107CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbmd0aDsgaSsrKSBjaGFycy5wdXNoKFN0cmluZy5mcm9tQ2hhckNvZGUoYnl0ZXNbc3RhdGUub2Zmc2V0ICsgaV0pKTsKICAgIHN0YXRlLm9mZnNldCArPSBsZW5ndGg7CiAgICByZXR1cm4gY2hhcnMuam9pbigiIik7CiAgfQoKICBmdW5jdGlvbiB3cml0ZVBhc2NhbFN0cmluZyh2YWx1ZSkgeyByZXR1cm4gY29uY2F0Qnl0ZXMoW3dyaXRlVUludDE2QkUodmFsdWUubGVuZ3RoKSwgYXNjaWlCeXRlcyh2YWx1ZSldKTsgfQoKICBmdW5jdGlvbiBwYXJzZUFycGMoYnl0ZXMpIHsKICAgIHZhciBzdGF0ZSA9IHsgb2Zmc2V0OiAwIH07CiAgICB2YXIgdmVyc2lvbiA9IHJlYWRVSW50MTZCRShieXRlcywgc3RhdGUub2Zmc2V0KTsgc3RhdGUub2Zmc2V0ICs9IDI7CiAgICB2YXIgbG9jYWxlID0gcmVhZFBhc2NhbFN0cmluZyhieXRlcywgc3RhdGUpOwogICAgdmFyIGFwcElkZW50aWZpZXIgPSByZWFkUGFzY2FsU3RyaW5nKGJ5dGVzLCBzdGF0ZSk7CiAgICB2YXIgb3NWZXJzaW9uID0gcmVhZFBhc2NhbFN0cmluZyhieXRlcywgc3RhdGUpOwogICAgdmFyIGZ1bmN0aW9uSWQgPSByZWFkVUludDMyQkUoYnl0ZXMsIHN0YXRlLm9mZnNldCk7IHN0YXRlLm9mZnNldCArPSA0OwogICAgdmFyIHBheWxvYWRMZW5ndGggPSByZWFkVUludDMyQkUoYnl0ZXMsIHN0YXRlLm9mZnNldCk7IHN0YXRlLm9mZnNldCArPSA0OwogICAgaWYgKHN0YXRlLm9mZnNldCArIHBheWxvYWRMZW5ndGggPiBieXRlcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcigiQVJQQyBwYXlsb2FkIGV4Y2VlZHMgYnVmZmVyIik7CiAgICByZXR1cm4geyB2ZXJzaW9uOiB2ZXJzaW9uLCBsb2NhbGU6IGxvY2FsZSwgYXBwSWRlbnRpZmllcjogYXBwSWRlbnRpZmllciwgb3NWZXJzaW9uOiBvc1ZlcnNpb24sIGZ1bmN0aW9uSWQ6IGZ1bmN0aW9uSWQsIHBheWxvYWQ6IGJ5dGVzLnNsaWNlKHN0YXRlLm9mZnNldCwgc3RhdGUub2Zmc2V0ICsgcGF5bG9hZExlbmd0aCkgfTsKICB9CgogIGZ1bmN0aW9uIHNlcmlhbGl6ZUFycGMoYXJwYykgewogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKFt3cml0ZVVJbnQxNkJFKGFycGMudmVyc2lvbiksIHdyaXRlUGFzY2FsU3RyaW5nKGFycGMubG9jYWxlKSwgd3JpdGVQYXNjYWxTdHJpbmcoYXJwYy5hcHBJZGVudGlmaWVyKSwgd3JpdGVQYXNjYWxTdHJpbmcoYXJwYy5vc1ZlcnNpb24pLCB3cml0ZVVJbnQzMkJFKGFycGMuZnVuY3Rpb25JZCksIHdyaXRlVUludDMyQkUoYXJwYy5wYXlsb2FkLmxlbmd0aCksIGFycGMucGF5bG9hZF0pOwogIH0KCiAgLy8gPT09PT09PT09PSBMb2NhdGlvbiBQYXRjaGluZyA9PT09PT09PT09CgogIGZ1bmN0aW9uIGNvb3JkVG9JbnQodmFsdWUpIHsgcmV0dXJuIE1hdGgudHJ1bmMoTnVtYmVyKHZhbHVlKSAqIDEwMDAwMDAwMCk7IH0KCiAgZnVuY3Rpb24gcGF0Y2hMb2NhdGlvbihsb2NhdGlvblBheWxvYWQsIGNvbmZpZykgewogICAgdmFyIHBhcnRzID0gW10sIGZpZWxkcyA9IGxvY2F0aW9uUGF5bG9hZC5sZW5ndGggPyBwYXJzZUZpZWxkcyhsb2NhdGlvblBheWxvYWQpIDogW107CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZpZWxkcy5sZW5ndGg7IGkrKykgeyBpZiAoIUxPQ0FUSU9OX1JFUExBQ0VEX0ZJRUxEU1tmaWVsZHNbaV0uZmllbGROdW1iZXJdKSBwYXJ0cy5wdXNoKGZpZWxkc1tpXS5yYXcpOyB9CiAgICBwYXJ0cy5wdXNoKG1ha2VWYXJpbnRGaWVsZCgxLCBjb29yZFRvSW50KGNvbmZpZy5sYXRpdHVkZSkpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDIsIGNvb3JkVG9JbnQoY29uZmlnLmxvbmdpdHVkZSkpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDMsIGNvbmZpZy5ob3Jpem9udGFsQWNjdXJhY3kpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDQsIGNvbmZpZy51bmtub3duVmFsdWU0KSk7CiAgICBwYXJ0cy5wdXNoKG1ha2VWYXJpbnRGaWVsZCg1LCBjb25maWcuYWx0aXR1ZGUpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDYsIGNvbmZpZy52ZXJ0aWNhbEFjY3VyYWN5KSk7CiAgICBwYXJ0cy5wdXNoKG1ha2VWYXJpbnRGaWVsZCgxMSwgY29uZmlnLm1vdGlvbkFjdGl2aXR5VHlwZSkpOwogICAgcGFydHMucHVzaChtYWtlVmFyaW50RmllbGQoMTIsIGNvbmZpZy5tb3Rpb25BY3Rpdml0eUNvbmZpZGVuY2UpKTsKICAgIHJldHVybiBjb25jYXRCeXRlcyhwYXJ0cyk7CiAgfQoKICBmdW5jdGlvbiBwYXRjaFdpZmlEZXZpY2Uod2lmaVBheWxvYWQsIGNvbmZpZykgewogICAgdmFyIGZpZWxkcyA9IHBhcnNlRmllbGRzKHdpZmlQYXlsb2FkKSwgcGFydHMgPSBbXSwgcGF0Y2hlZExvY2F0aW9uID0gZmFsc2U7CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZpZWxkcy5sZW5ndGg7IGkrKykgewogICAgICBpZiAoZmllbGRzW2ldLmZpZWxkTnVtYmVyID09PSAyICYmIGZpZWxkc1tpXS53aXJlVHlwZSA9PT0gMikgewogICAgICAgIHBhcnRzLnB1c2gobWFrZUxlbmd0aERlbGltaXRlZEZpZWxkKDIsIHBhdGNoTG9jYXRpb24oZmllbGRzW2ldLnZhbHVlQnl0ZXMsIGNvbmZpZykpKTsgcGF0Y2hlZExvY2F0aW9uID0gdHJ1ZTsKICAgICAgfSBlbHNlIHBhcnRzLnB1c2goZmllbGRzW2ldLnJhdyk7CiAgICB9CiAgICBpZiAoIXBhdGNoZWRMb2NhdGlvbikgcGFydHMucHVzaChtYWtlTGVuZ3RoRGVsaW1pdGVkRmllbGQoMiwgcGF0Y2hMb2NhdGlvbihuZXcgVWludDhBcnJheShbXSksIGNvbmZpZykpKTsKICAgIHJldHVybiBjb25jYXRCeXRlcyhwYXJ0cyk7CiAgfQoKICBmdW5jdGlvbiBwYXRjaENlbGxUb3dlcihjZWxsUGF5bG9hZCwgY29uZmlnKSB7CiAgICB2YXIgZmllbGRzID0gcGFyc2VGaWVsZHMoY2VsbFBheWxvYWQpLCBwYXJ0cyA9IFtdLCBwYXRjaGVkTG9jYXRpb24gPSBmYWxzZTsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZmllbGRzLmxlbmd0aDsgaSsrKSB7CiAgICAgIGlmIChmaWVsZHNbaV0uZmllbGROdW1iZXIgPT09IDUgJiYgZmllbGRzW2ldLndpcmVUeXBlID09PSAyKSB7CiAgICAgICAgcGFydHMucHVzaChtYWtlTGVuZ3RoRGVsaW1pdGVkRmllbGQoNSwgcGF0Y2hMb2NhdGlvbihmaWVsZHNbaV0udmFsdWVCeXRlcywgY29uZmlnKSkpOyBwYXRjaGVkTG9jYXRpb24gPSB0cnVlOwogICAgICB9IGVsc2UgcGFydHMucHVzaChmaWVsZHNbaV0ucmF3KTsKICAgIH0KICAgIGlmICghcGF0Y2hlZExvY2F0aW9uKSBwYXJ0cy5wdXNoKG1ha2VMZW5ndGhEZWxpbWl0ZWRGaWVsZCg1LCBwYXRjaExvY2F0aW9uKG5ldyBVaW50OEFycmF5KFtdKSwgY29uZmlnKSkpOwogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKHBhcnRzKTsKICB9CgogIGZ1bmN0aW9uIHBhdGNoQXBwbGVXTG9jUGF5bG9hZChwYXlsb2FkLCBjb25maWcpIHsKICAgIHZhciBmaWVsZHMgPSBwYXJzZUZpZWxkcyhwYXlsb2FkKSwgcGFydHMgPSBbXSwgd2lmaUNvdW50ID0gMCwgY2VsbENvdW50ID0gMDsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZmllbGRzLmxlbmd0aDsgaSsrKSB7CiAgICAgIHZhciBmaWVsZCA9IGZpZWxkc1tpXTsKICAgICAgaWYgKGZpZWxkLmZpZWxkTnVtYmVyID09PSAyICYmIGZpZWxkLndpcmVUeXBlID09PSAyKSB7IHBhcnRzLnB1c2gobWFrZUxlbmd0aERlbGltaXRlZEZpZWxkKDIsIHBhdGNoV2lmaURldmljZShmaWVsZC52YWx1ZUJ5dGVzLCBjb25maWcpKSk7IHdpZmlDb3VudCArPSAxOyB9CiAgICAgIGVsc2UgaWYgKGlzQ2VsbFJlc3BvbnNlRmllbGQoZmllbGQuZmllbGROdW1iZXIpICYmIGZpZWxkLndpcmVUeXBlID09PSAyKSB7IHBhcnRzLnB1c2gobWFrZUxlbmd0aERlbGltaXRlZEZpZWxkKGZpZWxkLmZpZWxkTnVtYmVyLCBwYXRjaENlbGxUb3dlcihmaWVsZC52YWx1ZUJ5dGVzLCBjb25maWcpKSk7IGNlbGxDb3VudCArPSAxOyB9CiAgICAgIGVsc2UgaWYgKCFST09UX0RST1BfRklFTERTW2ZpZWxkLmZpZWxkTnVtYmVyXSkgcGFydHMucHVzaChmaWVsZC5yYXcpOwogICAgfQogICAgcmV0dXJuIHsgcGF5bG9hZDogY29uY2F0Qnl0ZXMocGFydHMpLCB3aWZpQ291bnQ6IHdpZmlDb3VudCwgY2VsbENvdW50OiBjZWxsQ291bnQgfTsKICB9CgogIC8vID09PT09PT09PT0gUmVzcG9uc2UgRXh0cmFjdGlvbiA9PT09PT09PT09CgogIGZ1bmN0aW9uIGV4dHJhY3RQcmVmaXhlZEFwcGxlV0xvY1BheWxvYWQocmVzcG9uc2VCeXRlcykgewogICAgaWYgKCFyZXNwb25zZUJ5dGVzIHx8IHJlc3BvbnNlQnl0ZXMubGVuZ3RoIDwgMTApIHJldHVybiBudWxsOwogICAgaWYgKHJlc3BvbnNlQnl0ZXNbMF0gIT09IDB4MDAgfHwgcmVzcG9uc2VCeXRlc1sxXSAhPT0gMHgwMSkgcmV0dXJuIG51bGw7CiAgICBpZiAocmVzcG9uc2VCeXRlc1s2XSAhPT0gMHgwMCB8fCByZXNwb25zZUJ5dGVzWzddICE9PSAweDAwKSByZXR1cm4gbnVsbDsKICAgIHZhciBwYXlsb2FkTGVuZ3RoID0gcmVhZFVJbnQxNkJFKHJlc3BvbnNlQnl0ZXMsIDgpLCBwYXlsb2FkT2Zmc2V0ID0gMTA7CiAgICBpZiAocGF5bG9hZExlbmd0aCA8PSAwIHx8IHBheWxvYWRPZmZzZXQgKyBwYXlsb2FkTGVuZ3RoID4gcmVzcG9uc2VCeXRlcy5sZW5ndGgpIHJldHVybiBudWxsOwogICAgdmFyIHBheWxvYWQgPSByZXNwb25zZUJ5dGVzLnNsaWNlKHBheWxvYWRPZmZzZXQsIHBheWxvYWRPZmZzZXQgKyBwYXlsb2FkTGVuZ3RoKTsKICAgIGlmICh0cnlQYXJzZUZpZWxkcyhwYXlsb2FkKSA9PT0gbnVsbCkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4geyBraW5kOiAic3ludGhldGljIiwgcGF5bG9hZDogcGF5bG9hZCwgcHJlZml4OiByZXNwb25zZUJ5dGVzLnNsaWNlKDAsIDgpLCBzdWZmaXg6IHJlc3BvbnNlQnl0ZXMuc2xpY2UocGF5bG9hZE9mZnNldCArIHBheWxvYWRMZW5ndGgpIH07CiAgfQoKICBmdW5jdGlvbiBleHRyYWN0QXBwbGVXTG9jUGF5bG9hZChyZXNwb25zZUJ5dGVzKSB7CiAgICBpZiAoIXJlc3BvbnNlQnl0ZXMgfHwgcmVzcG9uc2VCeXRlcy5sZW5ndGggPCAyKSB0aHJvdyBuZXcgRXJyb3IoIkFwcGxlIFdMb2MgcmVzcG9uc2UgdG9vIHNob3J0Iik7CiAgICB2YXIgcHJlZml4ZWQgPSBleHRyYWN0UHJlZml4ZWRBcHBsZVdMb2NQYXlsb2FkKHJlc3BvbnNlQnl0ZXMpOwogICAgaWYgKHByZWZpeGVkKSByZXR1cm4gcHJlZml4ZWQ7CiAgICB0cnkgewogICAgICB2YXIgYXJwYyA9IHBhcnNlQXJwYyhyZXNwb25zZUJ5dGVzKTsKICAgICAgaWYgKGFycGMucGF5bG9hZC5sZW5ndGggPiAwICYmIHRyeVBhcnNlRmllbGRzKGFycGMucGF5bG9hZCkgIT09IG51bGwpIHJldHVybiB7IGtpbmQ6ICJhcnBjIiwgcGF5bG9hZDogYXJwYy5wYXlsb2FkLCBhcnBjOiBhcnBjIH07CiAgICB9IGNhdGNoIChlKSB7fQogICAgdmFyIG1hcmtlcklkeCA9IGZpbmRCeXRlcyhyZXNwb25zZUJ5dGVzLCBBUFBMRV9XTE9DX01BUktFUik7CiAgICBpZiAobWFya2VySWR4ID49IDApIHsKICAgICAgdmFyIGxlbk9mZnNldCA9IG1hcmtlcklkeCArIEFQUExFX1dMT0NfTUFSS0VSLmxlbmd0aDsKICAgICAgaWYgKGxlbk9mZnNldCArIDIgPD0gcmVzcG9uc2VCeXRlcy5sZW5ndGgpIHsKICAgICAgICB2YXIgcmVhbExlbiA9IHJlYWRVSW50MTZCRShyZXNwb25zZUJ5dGVzLCBsZW5PZmZzZXQpLCByZWFsUGF5bG9hZE9mZnNldCA9IGxlbk9mZnNldCArIDI7CiAgICAgICAgaWYgKHJlYWxMZW4gPiAwICYmIHJlYWxQYXlsb2FkT2Zmc2V0ICsgcmVhbExlbiA8PSByZXNwb25zZUJ5dGVzLmxlbmd0aCkgewogICAgICAgICAgdmFyIGNhbmRpZGF0ZVBheWxvYWQgPSByZXNwb25zZUJ5dGVzLnNsaWNlKHJlYWxQYXlsb2FkT2Zmc2V0LCByZWFsUGF5bG9hZE9mZnNldCArIHJlYWxMZW4pOwogICAgICAgICAgaWYgKHRyeVBhcnNlRmllbGRzKGNhbmRpZGF0ZVBheWxvYWQpICE9PSBudWxsKSByZXR1cm4geyBraW5kOiAibWFya2VyIiwgcGF5bG9hZDogY2FuZGlkYXRlUGF5bG9hZCwgcHJlZml4OiByZXNwb25zZUJ5dGVzLnNsaWNlKDAsIG1hcmtlcklkeCksIG1hcmtlckFuZExlbjogcmVzcG9uc2VCeXRlcy5zbGljZShtYXJrZXJJZHgsIHJlYWxQYXlsb2FkT2Zmc2V0KSwgc3VmZml4OiByZXNwb25zZUJ5dGVzLnNsaWNlKHJlYWxQYXlsb2FkT2Zmc2V0ICsgcmVhbExlbikgfTsKICAgICAgICB9CiAgICAgIH0KICAgIH0KICAgIGlmIChyZXNwb25zZUJ5dGVzLmxlbmd0aCA+IDApIHsgdmFyIHRhZyA9IHJlc3BvbnNlQnl0ZXNbMF07IHZhciBmbiA9IHRhZyA+PiAzLCB3dCA9IHRhZyAmIDB4NzsgaWYgKGZuID4gMCAmJiAod3QgPT09IDAgfHwgd3QgPT09IDIpKSByZXR1cm4geyBraW5kOiAiYmFyZSIsIHBheWxvYWQ6IHJlc3BvbnNlQnl0ZXMgfTsgfQogICAgdGhyb3cgbmV3IEVycm9yKCJtaXNzaW5nIEFwcGxlIFdMb2MgcmVzcG9uc2UgcHJlZml4Iik7CiAgfQoKICBmdW5jdGlvbiBidWlsZEFwcGxlV0xvY1Jlc3BvbnNlKHBheWxvYWQsIHByZWZpeCkgewogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKFtwcmVmaXggfHwgQVBQTEVfV0xPQ19QUkVGSVgsIHdyaXRlVUludDE2QkUocGF5bG9hZC5sZW5ndGgpLCBwYXlsb2FkXSk7CiAgfQoKICBmdW5jdGlvbiBzcG9vZkFwcGxlUmVzcG9uc2UocmVzcG9uc2VCeXRlcywgY29uZmlnKSB7CiAgICB2YXIgZXh0cmFjdGlvbiA9IGV4dHJhY3RBcHBsZVdMb2NQYXlsb2FkKHJlc3BvbnNlQnl0ZXMpOwogICAgdmFyIHBhdGNoZWQgPSBwYXRjaEFwcGxlV0xvY1BheWxvYWQoZXh0cmFjdGlvbi5wYXlsb2FkLCBjb25maWcpOwogICAgdmFyIHJlc3BvbnNlOwogICAgaWYgKGV4dHJhY3Rpb24ua2luZCA9PT0gImFycGMiKSB7CiAgICAgIHJlc3BvbnNlID0gc2VyaWFsaXplQXJwYyh7IHZlcnNpb246IGV4dHJhY3Rpb24uYXJwYy52ZXJzaW9uLCBsb2NhbGU6IGV4dHJhY3Rpb24uYXJwYy5sb2NhbGUsIGFwcElkZW50aWZpZXI6IGV4dHJhY3Rpb24uYXJwYy5hcHBJZGVudGlmaWVyLCBvc1ZlcnNpb246IGV4dHJhY3Rpb24uYXJwYy5vc1ZlcnNpb24sIGZ1bmN0aW9uSWQ6IGV4dHJhY3Rpb24uYXJwYy5mdW5jdGlvbklkLCBwYXlsb2FkOiBwYXRjaGVkLnBheWxvYWQgfSk7CiAgICB9IGVsc2UgaWYgKGV4dHJhY3Rpb24ua2luZCA9PT0gIm1hcmtlciIpIHsKICAgICAgdmFyIG5ld0xlbkJ5dGVzID0gd3JpdGVVSW50MTZCRShwYXRjaGVkLnBheWxvYWQubGVuZ3RoKTsKICAgICAgcmVzcG9uc2UgPSBjb25jYXRCeXRlcyhbZXh0cmFjdGlvbi5wcmVmaXgsIGV4dHJhY3Rpb24ubWFya2VyQW5kTGVuLnNsaWNlKDAsIEFQUExFX1dMT0NfTUFSS0VSLmxlbmd0aCksIG5ld0xlbkJ5dGVzLCBwYXRjaGVkLnBheWxvYWQsIGV4dHJhY3Rpb24uc3VmZml4XSk7CiAgICB9IGVsc2UgewogICAgICByZXNwb25zZSA9IGJ1aWxkQXBwbGVXTG9jUmVzcG9uc2UocGF0Y2hlZC5wYXlsb2FkLCBleHRyYWN0aW9uLnByZWZpeCk7CiAgICB9CiAgICByZXR1cm4geyByZXNwb25zZTogcmVzcG9uc2UsIHBheWxvYWQ6IHBhdGNoZWQucGF5bG9hZCwgd2lmaUNvdW50OiBwYXRjaGVkLndpZmlDb3VudCwgY2VsbENvdW50OiBwYXRjaGVkLmNlbGxDb3VudCwga2luZDogZXh0cmFjdGlvbi5raW5kIH07CiAgfQoKICBmdW5jdGlvbiBwYXRjaGVkUGF5bG9hZFN1bW1hcnkocGF5bG9hZCkgewogICAgdHJ5IHsKICAgICAgdmFyIHJvb3RGaWVsZHMgPSBwYXJzZUZpZWxkcyhwYXlsb2FkKSwgcGFydHMgPSBbXTsKICAgICAgdmFyIHdpZmkgPSBmaXJzdEZpZWxkQnlOdW1iZXIocm9vdEZpZWxkcywgMik7CiAgICAgIGlmICh3aWZpICYmIHdpZmkud2lyZVR5cGUgPT09IDIpIHsKICAgICAgICB2YXIgd2lmaUxvYyA9IGZpcnN0RmllbGRCeU51bWJlcihwYXJzZUZpZWxkcyh3aWZpLnZhbHVlQnl0ZXMpLCAyKTsKICAgICAgICBwYXJ0cy5wdXNoKCJmaXJzdFdpZmk9IiArICh3aWZpTG9jID8gKE51bWJlcihzaWduZWRWYXJpbnRGaWVsZFZhbHVlKGZpcnN0RmllbGRCeU51bWJlcihwYXJzZUZpZWxkcyh3aWZpTG9jLnZhbHVlQnl0ZXMpLCAxKSkpIC8gMTAwMDAwMDAwKS50b0ZpeGVkKDgpICsgIiwiICsgKE51bWJlcihzaWduZWRWYXJpbnRGaWVsZFZhbHVlKGZpcnN0RmllbGRCeU51bWJlcihwYXJzZUZpZWxkcyh3aWZpTG9jLnZhbHVlQnl0ZXMpLCAyKSkpIC8gMTAwMDAwMDAwKS50b0ZpeGVkKDgpIDogIjxtaXNzaW5nPiIpKTsKICAgICAgfQogICAgICByZXR1cm4gcGFydHMubGVuZ3RoID8gcGFydHMuam9pbigiLCAiKSA6ICJubyBsb2NhdGlvbiBmaWVsZHMiOwogICAgfSBjYXRjaCAoZXJyKSB7IHJldHVybiAic3VtbWFyeSBmYWlsZWQ6ICIgKyBlcnIubWVzc2FnZTsgfQogIH0KCiAgLy8gPT09PT09PT09PSBDb25maWcgPT09PT09PT09PQoKICBmdW5jdGlvbiBub3JtYWxpemVDb25maWcoaW5wdXQpIHsKICAgIHZhciBjZmcgPSB7fSwga2V5OwogICAgZm9yIChrZXkgaW4gREVGQVVMVF9DT05GSUcpIHsgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChERUZBVUxUX0NPTkZJRywga2V5KSkgY2ZnW2tleV0gPSBERUZBVUxUX0NPTkZJR1trZXldOyB9CiAgICBpbnB1dCA9IGlucHV0IHx8IHt9OwogICAgZm9yIChrZXkgaW4gaW5wdXQpIHsgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChpbnB1dCwga2V5KSkgY2ZnW2tleV0gPSBpbnB1dFtrZXldOyB9CiAgICBjZmcuZW5hYmxlZCA9ICEoY2ZnLmVuYWJsZWQgPT09IGZhbHNlIHx8IGNmZy5lbmFibGVkID09PSAiZmFsc2UiIHx8IGNmZy5lbmFibGVkID09PSAiMCIgfHwgY2ZnLmVuYWJsZWQgPT09ICJvZmYiIHx8IGNmZy5lbmFibGVkID09PSAibm8iIHx8IGNmZy5lbmFibGVkID09PSAwKTsKICAgIGNmZy5sYXRpdHVkZSA9IE51bWJlcihjZmcubGF0aXR1ZGUpOyBjZmcubG9uZ2l0dWRlID0gTnVtYmVyKGNmZy5sb25naXR1ZGUpOwogICAgY2ZnLmhvcml6b250YWxBY2N1cmFjeSA9IE1hdGgudHJ1bmMoTnVtYmVyKGNmZy5ob3Jpem9udGFsQWNjdXJhY3kpKTsKICAgIGNmZy52ZXJ0aWNhbEFjY3VyYWN5ID0gTWF0aC50cnVuYyhOdW1iZXIoY2ZnLnZlcnRpY2FsQWNjdXJhY3kpKTsKICAgIGNmZy5hbHRpdHVkZSA9IE1hdGgudHJ1bmMoTnVtYmVyKGNmZy5hbHRpdHVkZSkpOwogICAgY2ZnLnVua25vd25WYWx1ZTQgPSBNYXRoLnRydW5jKE51bWJlcihjZmcudW5rbm93blZhbHVlNCkpOwogICAgY2ZnLm1vdGlvbkFjdGl2aXR5VHlwZSA9IE1hdGgudHJ1bmMoTnVtYmVyKGNmZy5tb3Rpb25BY3Rpdml0eVR5cGUpKTsKICAgIGNmZy5tb3Rpb25BY3Rpdml0eUNvbmZpZGVuY2UgPSBNYXRoLnRydW5jKE51bWJlcihjZmcubW90aW9uQWN0aXZpdHlDb25maWRlbmNlKSk7CiAgICBjZmcuZmFpbE9wZW4gPSBjZmcuZmFpbE9wZW4gIT09IGZhbHNlOwogICAgY2ZnLmRlYnVnID0gY2ZnLmRlYnVnID09PSB0cnVlIHx8IFN0cmluZyhjZmcuZGVidWcpLnRvTG93ZXJDYXNlKCkgPT09ICJ0cnVlIjsKICAgIGNmZy5yYW5kb21SYWRpdXMgPSBOdW1iZXIoY2ZnLnJhbmRvbVJhZGl1cyk7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjZmcucmFuZG9tUmFkaXVzKSB8fCBjZmcucmFuZG9tUmFkaXVzIDwgMCkgY2ZnLnJhbmRvbVJhZGl1cyA9IDA7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjZmcubGF0aXR1ZGUpIHx8IGNmZy5sYXRpdHVkZSA8IC05MCB8fCBjZmcubGF0aXR1ZGUgPiA5MCkgdGhyb3cgbmV3IEVycm9yKCJpbnZhbGlkIGxhdGl0dWRlIik7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjZmcubG9uZ2l0dWRlKSB8fCBjZmcubG9uZ2l0dWRlIDwgLTE4MCB8fCBjZmcubG9uZ2l0dWRlID4gMTgwKSB0aHJvdyBuZXcgRXJyb3IoImludmFsaWQgbG9uZ2l0dWRlIik7CiAgICBpZiAoY2ZnLnJhbmRvbVJhZGl1cyA+IDApIHsKICAgICAgdmFyIGppdHRlcmVkID0gYXBwbHlSYW5kb21SYWRpdXMoY2ZnLmxhdGl0dWRlLCBjZmcubG9uZ2l0dWRlLCBjZmcucmFuZG9tUmFkaXVzKTsKICAgICAgY2ZnLmxhdGl0dWRlID0gaml0dGVyZWQubGF0aXR1ZGU7CiAgICAgIGNmZy5sb25naXR1ZGUgPSBqaXR0ZXJlZC5sb25naXR1ZGU7CiAgICAgIGNmZy5yYW5kb21EaXN0YW5jZSA9IGppdHRlcmVkLmRpc3RhbmNlOwogICAgfQogICAgcmV0dXJuIGNmZzsKICB9CgogIC8vIFJhbmRvbSBwZXJ0dXJiYXRpb24gKFl1OTE5MSB2MS4xICLmibDliqjljYrlvoQiKSDigJQgc2VlIGxvY2F0aW9uLXNwb29mZXIuanMgZm9yIGRldGFpbHMuCiAgZnVuY3Rpb24gYXBwbHlSYW5kb21SYWRpdXMobGF0LCBsb24sIHJhZGl1c01ldGVycykgewogICAgdmFyIHIgPSBOdW1iZXIocmFkaXVzTWV0ZXJzKTsKICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHIpIHx8IHIgPD0gMCkgcmV0dXJuIHsgbGF0aXR1ZGU6IGxhdCwgbG9uZ2l0dWRlOiBsb24sIGRpc3RhbmNlOiAwIH07CiAgICB2YXIgZGlzdGFuY2UgPSBNYXRoLnNxcnQoTWF0aC5yYW5kb20oKSkgKiByOwogICAgdmFyIGJlYXJpbmcgPSAyICogTWF0aC5yYW5kb20oKSAqIE1hdGguUEk7CiAgICB2YXIgYW5ndWxhciA9IGRpc3RhbmNlIC8gNjM3ODEzNzsKICAgIHZhciBsYXRSYWQgPSAobGF0ICogTWF0aC5QSSkgLyAxODA7CiAgICB2YXIgbG9uUmFkID0gKGxvbiAqIE1hdGguUEkpIC8gMTgwOwogICAgdmFyIG5ld0xhdCA9IE1hdGguYXNpbihNYXRoLnNpbihsYXRSYWQpICogTWF0aC5jb3MoYW5ndWxhcikgKyBNYXRoLmNvcyhsYXRSYWQpICogTWF0aC5zaW4oYW5ndWxhcikgKiBNYXRoLmNvcyhiZWFyaW5nKSk7CiAgICB2YXIgbmV3TG9uID0gKChsb25SYWQgKyBNYXRoLmF0YW4yKE1hdGguc2luKGJlYXJpbmcpICogTWF0aC5zaW4oYW5ndWxhcikgKiBNYXRoLmNvcyhsYXRSYWQpLCBNYXRoLmNvcyhhbmd1bGFyKSAtIE1hdGguc2luKGxhdFJhZCkgKiBNYXRoLnNpbihuZXdMYXQpKSArIDMgKiBNYXRoLlBJKSAlICgyICogTWF0aC5QSSkpIC0gTWF0aC5QSTsKICAgIHJldHVybiB7CiAgICAgIGxhdGl0dWRlOiBOdW1iZXIoKChuZXdMYXQgKiAxODApIC8gTWF0aC5QSSkudG9GaXhlZCg4KSksCiAgICAgIGxvbmdpdHVkZTogTnVtYmVyKCgobmV3TG9uICogMTgwKSAvIE1hdGguUEkpLnRvRml4ZWQoOCkpLAogICAgICBkaXN0YW5jZTogZGlzdGFuY2UKICAgIH07CiAgfQoKICBmdW5jdGlvbiBsb2FkQ29uZmlnKCkgewogICAgLy8g5peg54q25oCB77ya5LuO5pys5py6ICRwcmVmcyDor7vlj5bpgInngrnpobXlhpnlhaXnmoTlnZDmoIfvvIjkuI3lj5Hotbfku7vkvZXlpJbpg6jnvZHnu5zor7fmsYLvvInjgIIKICAgIC8vIOmUruS4jiBsb2NhdGlvbi1zZXR0aW5ncy5qcyDlhpnlhaXnmoTkuIDoh7TvvJplbmFibGVkL2xhdGl0dWRlL2xvbmdpdHVkZS9hbHRpdHVkZS9ob3Jpem9udGFsQWNjdXJhY3kvdmVydGljYWxBY2N1cmFjeeOAggogICAgdmFyIGNmZyA9IHt9OwogICAgZm9yICh2YXIgayBpbiBERUZBVUxUX0NPTkZJRykgeyBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKERFRkFVTFRfQ09ORklHLCBrKSkgY2ZnW2tdID0gREVGQVVMVF9DT05GSUdba107IH0KICAgIHZhciBrZXlzID0gWyJlbmFibGVkIiwgImxhdGl0dWRlIiwgImxvbmdpdHVkZSIsICJhbHRpdHVkZSIsICJob3Jpem9udGFsQWNjdXJhY3kiLCAidmVydGljYWxBY2N1cmFjeSIsICJyYW5kb21SYWRpdXMiXTsKICAgIGlmICh0eXBlb2YgJHByZWZzICE9PSAidW5kZWZpbmVkIiAmJiAkcHJlZnMudmFsdWVGb3JLZXkpIHsKICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBrZXlzLmxlbmd0aDsgaSsrKSB7CiAgICAgICAgdmFyIHYgPSAkcHJlZnMudmFsdWVGb3JLZXkoa2V5c1tpXSk7CiAgICAgICAgaWYgKHYgIT0gbnVsbCAmJiB2ICE9PSAiIikgY2ZnW2tleXNbaV1dID0gdjsKICAgICAgfQogICAgfQogICAgcmV0dXJuIG5vcm1hbGl6ZUNvbmZpZyhjZmcpOwogIH0KCiAgZnVuY3Rpb24gbWVyZ2VDb25maWcoYmFzZSwgZXh0cmEpIHsKICAgIHZhciBvdXQgPSB7fSwga2V5OwogICAgZm9yIChrZXkgaW4gYmFzZSkgeyBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGJhc2UsIGtleSkpIG91dFtrZXldID0gYmFzZVtrZXldOyB9CiAgICBleHRyYSA9IGV4dHJhIHx8IHt9OwogICAgZm9yIChrZXkgaW4gZXh0cmEpIHsgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChleHRyYSwga2V5KSkgb3V0W2tleV0gPSBleHRyYVtrZXldOyB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8gPT09PT09PT09PSBRWCBFbnRyeSBQb2ludCA9PT09PT09PT09CgogIGZ1bmN0aW9uIHJ1blFYKCkgewogICAgdmFyIGhhc1Jlc3BvbnNlID0gdHlwZW9mICRyZXNwb25zZSAhPT0gInVuZGVmaW5lZCI7CgogICAgaWYgKGhhc1Jlc3BvbnNlKSB7CiAgICAgIHZhciBjb25maWcgPSBsb2FkQ29uZmlnKCk7CiAgICAgIHRyeSB7CiAgICAgICAgaWYgKCFjb25maWcuZW5hYmxlZCkgeyAkZG9uZSh7fSk7IHJldHVybjsgfQogICAgICAgIC8vIFFYIHYxLjAuMTkrIOi1t+S6jOi/m+WItuWTjeW6lOi1sCAkcmVzcG9uc2UuYm9keUJ5dGVzKEFycmF5QnVmZmVyKe+8jAogICAgICAgIC8vICRyZXNwb25zZS5ib2R5IOWvueS6jOi/m+WItuaYr+epui/kubHnoIHmlofmnKzjgILor6bop4EgY3Jvc3N1dGlsaXR5L1F1YW50dW11bHQtWAogICAgICAgIC8vIOeahCBzYW1wbGUtYnl0ZXMtcmV3cml0ZS5qc+OAggogICAgICAgIHZhciByYXdCdWYgPSAkcmVzcG9uc2UuYm9keUJ5dGVzOwogICAgICAgIGlmICghcmF3QnVmIHx8IChyYXdCdWYuYnl0ZUxlbmd0aCAhPT0gdW5kZWZpbmVkICYmIHJhd0J1Zi5ieXRlTGVuZ3RoID09PSAwKSkgewogICAgICAgICAgJGRvbmUoe30pOwogICAgICAgICAgcmV0dXJuOwogICAgICAgIH0KICAgICAgICB2YXIgcmVzcG9uc2VCeXRlcyA9IHJhd0J1ZiBpbnN0YW5jZW9mIFVpbnQ4QXJyYXkgPyByYXdCdWYgOiBuZXcgVWludDhBcnJheShyYXdCdWYpOwogICAgICAgIGlmIChyZXNwb25zZUJ5dGVzLmxlbmd0aCA8IDIpIHsgJGRvbmUoe30pOyByZXR1cm47IH0KICAgICAgICBpZiAoY29uZmlnLmRlYnVnKSBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBRWCByZXNwb25zZTogIiArIHJlc3BvbnNlQnl0ZXMubGVuZ3RoICsgIiBieXRlcywgaGVhZD0iICsgaGV4UHJldmlldyhyZXNwb25zZUJ5dGVzLCAzMikpOwogICAgICAgIHZhciByZXN1bHQgPSBzcG9vZkFwcGxlUmVzcG9uc2UocmVzcG9uc2VCeXRlcywgY29uZmlnKTsKICAgICAgICBpZiAoY29uZmlnLmRlYnVnKSBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBwYXRjaGVkICIgKyByZXN1bHQud2lmaUNvdW50ICsgIiB3aWZpLCAiICsgcmVzdWx0LmNlbGxDb3VudCArICIgY2VsbCwga2luZD0iICsgcmVzdWx0LmtpbmQgKyAiLCByZXNwb25zZT0iICsgcmVzdWx0LnJlc3BvbnNlLmxlbmd0aCArICIgYnl0ZXMiKTsKICAgICAgICBpZiAoY29uZmlnLmRlYnVnKSBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBsb2NhdGlvbnM6ICIgKyBwYXRjaGVkUGF5bG9hZFN1bW1hcnkocmVzdWx0LnBheWxvYWQpKTsKICAgICAgICAvLyBRWDog5LqM6L+b5Yi25pS55ZCO5ZON5bqU5b+F6aG755SoICRkb25lKHtib2R5Qnl0ZXM6IEFycmF5QnVmZmVyfSkg5Zue5YaZCiAgICAgICAgJGRvbmUoewogICAgICAgICAgYm9keUJ5dGVzOiByZXN1bHQucmVzcG9uc2UuYnVmZmVyLnNsaWNlKAogICAgICAgICAgICByZXN1bHQucmVzcG9uc2UuYnl0ZU9mZnNldCwKICAgICAgICAgICAgcmVzdWx0LnJlc3BvbnNlLmJ5dGVPZmZzZXQgKyByZXN1bHQucmVzcG9uc2UuYnl0ZUxlbmd0aAogICAgICAgICAgKQogICAgICAgIH0pOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICBpZiAoY29uZmlnLmRlYnVnKSBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBmYWlsZWQ6ICIgKyBlcnIubWVzc2FnZSk7CiAgICAgICAgJGRvbmUoe30pOwogICAgICB9CiAgICB9IGVsc2UgewogICAgICAkZG9uZSh7fSk7CiAgICB9CiAgfQoKICB2YXIgYXBpID0gewogICAgREVGQVVMVF9DT05GSUc6IERFRkFVTFRfQ09ORklHLAogICAgYmFzZTY0VG9CeXRlczogYmFzZTY0VG9CeXRlcywKICAgIGJ5dGVzVG9CYXNlNjQ6IGJ5dGVzVG9CYXNlNjQsCiAgICBwYXRjaEFwcGxlV0xvY1BheWxvYWQ6IHBhdGNoQXBwbGVXTG9jUGF5bG9hZCwKICAgIHNwb29mQXBwbGVSZXNwb25zZTogc3Bvb2ZBcHBsZVJlc3BvbnNlLAogICAgZXh0cmFjdEFwcGxlV0xvY1BheWxvYWQ6IGV4dHJhY3RBcHBsZVdMb2NQYXlsb2FkLAogICAgcGFyc2VBcnBjOiBwYXJzZUFycGMsCiAgICBjb29yZFRvSW50OiBjb29yZFRvSW50LAogICAgbm9ybWFsaXplQ29uZmlnOiBub3JtYWxpemVDb25maWcsCiAgICBsb2FkQ29uZmlnOiBsb2FkQ29uZmlnCiAgfTsKCiAgaWYgKHR5cGVvZiBtb2R1bGUgIT09ICJ1bmRlZmluZWQiICYmIG1vZHVsZS5leHBvcnRzKSB7CiAgICBtb2R1bGUuZXhwb3J0cyA9IGFwaTsKICB9IGVsc2UgewogICAgcnVuUVgoKTsKICB9Cn0oKSk7Cg==";

/* ==== inlined from src/page.js ==== */

function getPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>iOS Location Spoofer</title>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="iOSLoc">
<meta name="theme-color" content="#0a0c11">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>
:root {
  --bg:#0a0c11; --card:#12161d; --card2:#191e28; --line:#242b38; --inset:rgba(255,255,255,.045);
  --cyan:#17c3cf; --cyan2:#0e97a1; --green:#22c55e; --red:#ff5b60; --orange:#f5a623;
  --txt:#eef2f8; --muted:#8a93a5; --mono:#7fe3ea;
  --blue:#17c3cf; --gray:#8a93a5;
}
* { margin:0; padding:0; box-sizing:border-box; }
body {
  font-family:-apple-system,system-ui,"SF Pro","Helvetica Neue",sans-serif;
  color:var(--txt);
  background:
    radial-gradient(900px 380px at 50% -120px, rgba(23,195,207,.14), transparent 70%),
    radial-gradient(600px 300px at 92% 6%, rgba(34,197,94,.07), transparent 65%),
    var(--bg);
  background-attachment:fixed;
}
::placeholder { color:#5d6675; }
::-webkit-scrollbar { width:6px; height:6px; }
::-webkit-scrollbar-thumb { background:#2b3342; border-radius:3px; }

/* ---- top bar: sticky glass ---- */
.topbar { position:sticky; top:0; z-index:1200; display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 14px; background:rgba(10,12,17,.88); -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px); border-bottom:1px solid var(--line); font-size:11px; color:var(--muted); }
.topbar .back { flex:none; color:var(--cyan); font-weight:700; text-decoration:none; font-size:12.5px; }

/* ---- info box: cyan/dark themed and fused with page style ---- */
.redbox { margin:12px 12px 0; padding:13px 15px; background:linear-gradient(180deg,rgba(23,195,207,.12),rgba(23,195,207,.04)); border:1px solid rgba(23,195,207,.35); border-left:5px solid var(--cyan); border-radius:12px; box-shadow:0 6px 20px rgba(0,0,0,.35); }
.redbox .rb { color:var(--txt); font-size:13px; font-weight:600; line-height:1.6; }
.wechat-pill { display:inline-flex; align-items:center; gap:6px; background:rgba(23,195,207,.18); border:1px solid rgba(23,195,207,.4); padding:2px 8px; border-radius:6px; font-family:"SF Mono",ui-monospace,monospace; color:var(--mono); font-weight:700; margin:0 4px; }

/* ---- map + its glass controls ---- */
#map { height:50vh; width:100%; min-height:250px; background:#0a0c11; border-bottom:1px solid var(--line); }
.leaflet-container { background:#0a0c11; }
.leaflet-control-zoom a { background:rgba(18,22,29,.9)!important; color:var(--txt)!important; border-color:var(--line)!important; -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px); }
.leaflet-control-zoom a:hover { background:var(--card2)!important; }
.leaflet-bar { border:1px solid var(--line)!important; box-shadow:0 4px 18px rgba(0,0,0,.5)!important; }
.leaflet-control-attribution { background:rgba(10,12,17,.7)!important; color:#6b7484!important; }
.leaflet-control-attribution a { color:#8a93a5!important; }

.panel { padding:16px; max-width:600px; margin:0 auto; padding-bottom:calc(16px + env(safe-area-inset-bottom)); }

/* ---- glass cards ---- */
.card { background:linear-gradient(180deg,rgba(25,30,40,.72),rgba(18,22,29,.72)); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); border:1px solid var(--line); border-radius:16px; padding:16px; margin-bottom:12px; box-shadow:0 8px 28px rgba(0,0,0,.34); }
.card h3 { font-size:15px; font-weight:700; margin-bottom:12px; color:var(--txt); display:flex; align-items:center; gap:8px; }
.card h3::before { content:""; width:3px; height:14px; border-radius:2px; background:linear-gradient(180deg,var(--cyan),var(--green)); flex:none; }

.coords { font-family:"SF Mono",ui-monospace,monospace; font-size:13.5px; color:var(--muted); padding:10px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; word-break:break-all; }
.crow { display:flex; align-items:center; gap:8px; padding:8px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; margin-bottom:6px; }
.crow .ck { font-size:11px; font-weight:700; letter-spacing:.6px; text-transform:uppercase; color:var(--cyan); width:34px; flex:none; }
.crow .cv { flex:1; min-width:0; font-family:"SF Mono",ui-monospace,monospace; font-size:14px; color:var(--mono); word-break:break-all; }
.copybtn { flex:none; }

/* ---- buttons ---- */
.row { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
.btn { flex:1; min-width:100px; padding:12px 16px; border:none; border-radius:11px; font-size:14px; font-weight:700; cursor:pointer; transition:all .15s; }
.btn-primary { background:linear-gradient(135deg,var(--cyan),var(--cyan2)); color:#022a2d; box-shadow:0 6px 18px rgba(23,195,207,.28); }
.btn-primary:active { filter:brightness(1.12); transform:scale(.97); }
.btn-secondary { background:var(--card2); color:#c3ccdb; border:1px solid var(--line); font-weight:600; }
.btn-secondary:active { background:#2a3140; transform:scale(.97); }
.btn-danger { background:transparent; color:#ff6b70; border:1px solid rgba(255,91,96,.55); }
.btn-danger:active { background:rgba(255,91,96,.12); transform:scale(.97); }
.btn.success { background:linear-gradient(135deg,#2ee06a,#129a44); color:#04240f; border:none; box-shadow:0 6px 18px rgba(34,197,94,.3); }
.btn-sm { flex:none; min-width:auto; padding:6px 12px; font-size:12px; border-radius:8px; }

/* ---- inputs ---- */
.input-row { display:flex; gap:8px; margin-top:10px; }
.input-row input { flex:1; padding:10px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; font-size:14px; color:var(--txt); outline:none; min-width:0; -webkit-appearance:none; transition:border-color .15s,box-shadow .15s; }
.cvi { flex:1; min-width:0; width:100%; font-family:"SF Mono",ui-monospace,monospace; font-size:14px; color:var(--mono); padding:6px 10px; background:var(--inset); border:1px solid var(--line); border-radius:8px; outline:none; -webkit-appearance:none; transition:border-color .15s,box-shadow .15s; }
.accfield input { width:100%; padding:8px 10px; background:var(--inset); border:1px solid var(--line); border-radius:8px; font-size:14px; color:var(--txt); outline:none; -webkit-appearance:none; transition:border-color .15s,box-shadow .15s; }
.input-row input:focus, .cvi:focus, .accfield input:focus, .modal input:focus { border-color:var(--cyan); box-shadow:0 0 0 3px rgba(23,195,207,.16); }
.acc-row { display:flex; gap:8px; margin-bottom:6px; }
.accfield { flex:1; min-width:0; display:flex; flex-direction:column; gap:4px; }
.acclbl { font-size:11px; color:var(--muted); }

.status { font-size:12px; color:var(--muted); margin-top:8px; text-align:center; }
.hint { font-size:11px; color:#6b7484; margin-top:8px; line-height:1.6; }
.accnote { margin-top:10px; padding:11px 13px; background:var(--inset); border:1px solid var(--line); border-left:3px solid var(--cyan); border-radius:9px; font-size:11.5px; color:#a8b1c0; line-height:1.85; }
.accnote b { display:block; color:var(--cyan); font-weight:800; font-size:12px; margin-bottom:6px; letter-spacing:.3px; }
.accnote code { font-family:"SF Mono",ui-monospace,monospace; color:var(--mono); font-size:11px; }
.accnote em { color:var(--txt); font-style:normal; font-weight:800; }
.accnote .src { display:block; margin-top:7px; color:#5d6675; font-size:10.5px; }

/* ---- lists ---- */
.search-results { margin-top:8px; max-height:260px; overflow-y:auto; }
.search-item { padding:10px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; margin-bottom:6px; cursor:pointer; transition:all .15s; }
.search-item:active { background:#232a37; border-color:var(--cyan); }
.search-item .si-name { font-size:14px; color:var(--txt); font-weight:600; }
.search-item .si-sub { font-size:11px; color:var(--muted); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

.error-banner { background:linear-gradient(180deg,rgba(255,91,96,.18),rgba(255,91,96,.08)); border:1px solid rgba(255,91,96,.5); border-left:4px solid var(--red); color:#ffdcdc; padding:14px 16px; border-radius:12px; margin-bottom:12px; font-size:13.5px; line-height:1.6; display:none; }
.error-banner b { display:block; margin-bottom:4px; color:#ff6b70; font-size:14.5px; }
.diag-box { background:linear-gradient(180deg,rgba(23,195,207,.12),rgba(18,22,29,.88)); border:1px solid rgba(23,195,207,.45); border-radius:12px; padding:13px 14px; margin-top:10px; font-size:12.5px; line-height:1.65; color:var(--txt); display:none; }
.diag-box.show { display:block; }
.diag-item { padding:6px 0; border-bottom:1px dashed rgba(255,255,255,.08); }
.diag-item:last-child { border-bottom:none; padding-bottom:0; }
.diag-item b { color:var(--mono); }

.toast { position:fixed; top:60px; left:50%; transform:translateX(-50%); background:rgba(8,10,14,.92); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); border:1px solid var(--line); color:#fff; padding:11px 20px; border-radius:22px; font-size:14px; opacity:0; transition:opacity .3s; pointer-events:none; z-index:9999; max-width:90vw; text-align:center; box-shadow:0 8px 28px rgba(0,0,0,.5); }
.toast.show { opacity:1; }

.active-loc { background:var(--inset); border:1px solid var(--line); border-radius:10px; padding:11px 12px; font-size:13px; color:var(--txt); }
.active-loc .label { font-size:11px; color:var(--muted); margin-bottom:5px; }
.active-loc .value { font-family:"SF Mono",ui-monospace,monospace; font-size:13px; color:var(--mono); }

.fav-list { max-height:240px; overflow-y:auto; }
.fav-item { display:flex; align-items:center; gap:8px; padding:10px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; margin-bottom:6px; cursor:pointer; transition:all .15s; }
.fav-item:active { background:#232a37; border-color:var(--cyan); }
.fav-item .fav-info { flex:1; min-width:0; }
.fav-item .fav-name { font-size:14px; font-weight:600; color:var(--txt); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.fav-item .fav-coords { font-size:11px; color:var(--muted); font-family:"SF Mono",ui-monospace,monospace; margin-top:2px; }
.fav-item .fav-active { font-size:10px; color:var(--green); font-weight:700; margin-top:2px; }
.fav-item .fav-del { flex:none; width:28px; height:28px; border:none; border-radius:50%; background:transparent; color:var(--red); font-size:16px; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:background .15s; }
.fav-item .fav-del:hover { background:rgba(255,91,96,.14); }
.fav-empty { text-align:center; color:var(--muted); font-size:13px; padding:16px 0; }
.fav-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
.fav-header h3 { margin-bottom:0; }

/* ---- modal ---- */
.modal-overlay { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(4,6,10,.66); -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px); z-index:10000; display:none; align-items:center; justify-content:center; padding:20px; }
.modal-overlay.show { display:flex; }
.modal { background:linear-gradient(180deg,#1a1f29,#12161d); border:1px solid var(--line); border-radius:18px; padding:20px; width:100%; max-width:340px; box-shadow:0 20px 60px rgba(0,0,0,.6); }
.modal h3 { font-size:17px; font-weight:700; margin-bottom:16px; text-align:center; color:var(--txt); }
.modal input { width:100%; padding:12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; font-size:15px; color:var(--txt); outline:none; margin-bottom:12px; -webkit-appearance:none; transition:border-color .15s,box-shadow .15s; }
.modal .modal-btns { display:flex; gap:8px; }
.modal .modal-btns .btn { padding:12px; }

/* ---- map overlay switches: dark glass pills ---- */
.layer-switch { position:absolute; top:10px; right:10px; z-index:1000; display:flex; gap:4px; background:rgba(10,12,17,.74); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); border:1px solid var(--line); border-radius:10px; padding:4px; box-shadow:0 4px 18px rgba(0,0,0,.45); }
.layer-btn { border:none; background:transparent; padding:6px 10px; border-radius:7px; font-size:12px; font-weight:600; color:#a8b1c0; cursor:pointer; transition:all .15s; white-space:nowrap; }
.layer-btn.active { background:linear-gradient(135deg,var(--cyan),var(--cyan2)); color:#022a2d; font-weight:700; }
.layer-btn:active { transform:scale(.95); }
.lang-switch { position:absolute; top:10px; left:10px; z-index:1000; display:flex; gap:2px; background:rgba(10,12,17,.74); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); border:1px solid var(--line); border-radius:10px; padding:4px; box-shadow:0 4px 18px rgba(0,0,0,.45); }
.lang-btn { border:none; background:transparent; padding:6px 11px; border-radius:7px; font-size:12px; font-weight:700; color:#a8b1c0; cursor:pointer; transition:all .15s; }
.lang-btn.active { background:linear-gradient(135deg,var(--cyan),var(--cyan2)); color:#022a2d; }
.lang-btn:active { transform:scale(.95); }

@media(max-width:480px) { #map { height:44vh; } .panel { padding:12px; } .layer-btn { padding:5px 7px; font-size:11px; } }
</style>
</head>
<body>
<div class="topbar">
  <a class="back" href="/">← 主页</a>
</div>

<div class="redbox">
  <div class="rb">
    中国大陆微信技术售后：<span class="wechat-pill">LLME-love</span>
    <button class="btn btn-sm btn-secondary" style="padding:2px 8px;font-size:11px;" onclick="copyText('LLME-love').then(()=>toast('已复制微信号: LLME-love'))">复制微信</button>
    <div style="margin-top:6px;font-size:12.5px;color:var(--muted);opacity:.95;">仅供学习研究，禁止违法用途，后果自负、与作者无关，与 Apple 无关。</div>
  </div>
</div>

<div style="position:relative">
<div id="map"></div>
<div class="lang-switch">
  <button class="lang-btn" data-lang="zh" onclick="setLang('zh')">中</button>
  <button class="lang-btn" data-lang="en" onclick="setLang('en')">EN</button>
</div>
<div class="layer-switch">
  <button class="layer-btn active" data-layer="satellite" data-i18n="layer_satellite" onclick="switchLayer('satellite')">Satellite</button>
  <button class="layer-btn" data-layer="wgs84" onclick="switchLayer('wgs84')">WGS84</button>
  <button class="layer-btn" data-layer="amap" data-i18n="layer_amap" onclick="switchLayer('amap')">Amap</button>
  <button class="layer-btn" data-layer="voyager" data-i18n="layer_color" onclick="switchLayer('voyager')">Color</button>
  <button class="layer-btn" data-layer="standard" data-i18n="layer_standard" onclick="switchLayer('standard')">Standard</button>
  <button class="layer-btn" data-layer="dark" data-i18n="layer_dark" onclick="switchLayer('dark')">Dark</button>
</div>
</div>
<div class="panel">
  <div class="error-banner" id="errorBanner" data-i18n-html="err_html"></div>
  <div class="card">
    <h3 data-i18n="choose_title">Choose target location</h3>
    <div class="coords" id="coords" data-i18n="coords_hint">Tap the map or use the tools below to pick a location</div>
    <div id="coordGrid" style="display:none">
      <div class="crow"><span class="ck" data-i18n="lat">Lat</span><span class="cv" id="cvLat"></span><button class="btn btn-sm btn-secondary copybtn" data-i18n="copy" onclick="copyField('lat',this)">Copy</button></div>
      <div class="crow"><span class="ck" data-i18n="lon">Lon</span><span class="cv" id="cvLon"></span><button class="btn btn-sm btn-secondary copybtn" data-i18n="copy" onclick="copyField('lon',this)">Copy</button></div>
      <div class="crow"><span class="ck" data-i18n="alt">Alt</span><input class="cvi" id="altInput" type="number" inputmode="decimal" step="1" /><button class="btn btn-sm btn-secondary copybtn" data-i18n="copy" onclick="copyField('alt',this)">Copy</button></div>
      <div class="acc-row">
        <div class="accfield"><span class="acclbl" data-i18n="hacc">H. accuracy</span><input id="haccInput" type="number" inputmode="numeric" step="1" min="1" value="39" /></div>
        <div class="accfield"><span class="acclbl" data-i18n="vacc">V. accuracy</span><input id="vaccInput" type="number" inputmode="numeric" step="1" min="1" value="1000" /></div>
        <div class="accfield"><span class="acclbl" data-i18n="jitter">Jitter radius</span><input id="jitterInput" type="number" inputmode="numeric" step="1" min="0" value="0" /></div>
      </div>
    </div>
    <div class="row">
      <button class="btn btn-primary" id="saveBtn" data-i18n="save" onclick="save()">Save to Device</button>
      <button class="btn btn-secondary" data-i18n="restore" onclick="restoreReal()">Restore real</button>
    </div>
    <div class="row">
      <button class="btn btn-secondary" data-i18n="copy_params" onclick="copyParams(this)">Copy module params</button>
      <button class="btn btn-secondary" data-i18n="add_fav" onclick="addFav()">Add Favorite</button>
      <button class="btn btn-secondary" data-i18n="locate" onclick="locateMe()">Current Location</button>
    </div>
    <div class="hint" data-i18n="alt_hint">Altitude is auto-filled from Open-Meteo (WGS-84) and editable. It is written to the device on Save and applied by the module.</div>
    <div class="accnote" data-i18n-html="acc_note_html"></div>
  </div>
  <div class="card">
    <div class="fav-header">
      <h3 data-i18n="fav_title">Favorites</h3>
      <button class="btn btn-sm btn-secondary" data-i18n="clear_all" onclick="clearAllFav()" id="clearAllBtn" style="display:none">Clear All</button>
    </div>
    <div id="favList" class="fav-list"></div>
  </div>
  <div class="card">
    <h3 data-i18n="active_title">Active coordinates</h3>
    <div class="active-loc" id="activeLoc">
      <div class="label" data-i18n="active_label">On-device coordinates (latitude/longitude/altitude)</div>
      <div class="value" id="activeValue">Querying...</div>
    </div>
    <div class="row">
      <button class="btn btn-sm btn-secondary" data-i18n="refresh" onclick="queryActive()">Refresh</button>
      <button class="btn btn-sm btn-primary" data-i18n="diag_btn" onclick="runDiag()">🔍 一键检测环境</button>
      <button class="btn btn-sm btn-danger" data-i18n="clear_data" onclick="clearActive()">Clear Data</button>
    </div>
    <div class="diag-box" id="diagBox"></div>
  </div>
  <div class="card">
    <h3 data-i18n="paste_title">Paste map link</h3>
    <div class="input-row">
      <input id="urlInput" data-i18n-ph="paste_ph" placeholder="Apple/Google/Amap/Baidu map link or coordinates" />
      <button class="btn btn-secondary" style="flex:none;min-width:56px" data-i18n="parse" onclick="parseUrl()">Parse</button>
    </div>
    <div style="font-size:11px;color:var(--gray);margin-top:6px" data-i18n="paste_hint">Supports Apple Maps · Google Maps · Amap · Baidu · coordinate text (auto-converted to WGS-84)</div>
  </div>
  <div class="card">
    <h3 data-i18n="search_title">Search place</h3>
    <div class="input-row">
      <input id="searchInput" data-i18n-ph="search_ph" placeholder="Search a place, Enter to list candidates (preview only)" />
      <button class="btn btn-secondary" style="flex:none;min-width:56px" data-i18n="search" onclick="searchPlace()">Search</button>
    </div>
    <div id="searchResults" class="search-results"></div>
  </div>
  <div class="status" id="status">Pick a location, then tap "Save to Device" to write it to your proxy tool</div>
</div>
<div class="toast" id="toast"></div>
<div class="modal-overlay" id="favModal">
  <div class="modal">
    <h3 data-i18n="modal_title">Add this location to favorites</h3>
    <input id="favNameInput" data-i18n-ph="modal_ph" placeholder="Enter a label (e.g. Office, Home)" maxlength="30" />
    <div style="font-size:12px;color:var(--gray);margin-bottom:12px;text-align:center" id="favModalCoords"></div>
    <div class="modal-btns">
      <button class="btn btn-secondary" data-i18n="cancel" onclick="closeFavModal()">Cancel</button>
      <button class="btn btn-primary" data-i18n="save_short" onclick="confirmFav()">Save</button>
    </div>
  </div>
</div>
<script>
const SAVE_API = 'https://gs-loc.apple.com/wloc-settings/save';
const PARSE_API = '/api/parse';
const ELEV_API = 'https://api.open-meteo.com/v1/elevation';
const FAV_KEY = 'ils_favorites';
const LANG_KEY = 'ils_lang';
let lat = 0, lon = 0;
let didInitialCenter = false;
let selected = false;
let elev = null, elevState = 'idle';
let elevSeq = 0, elevTimer = null;
const elevCache = new Map();
let activeLon = null, activeLat = null, activeAcc = null, activeAlt = null, activeStatus = 'querying';
let savedLon = null, savedLat = null, savedTimeStr = '';

/* ---- i18n ---- */
const I18N = {
  zh: {
    title: 'iOS 虚拟定位',
    layer_satellite: '卫星', layer_amap: '高德', layer_color: '彩色', layer_standard: '标准', layer_dark: '暗色',
    err_html: '<b>模块未生效</b>请检查以下配置：<br>1. 已安装并启用 iOS Location Spoofer 模块<br>2. MITM 已开启，且证书已在「设置→通用→关于本机→证书信任设置」中打开完全信任（Safari 里点“继续访问”不算信任）<br>3. MITM 主机名包含 gs-loc.apple.com<br>4. 当前网络已走代理（请用 Safari 打开本页）<br><button class="btn btn-sm btn-primary" style="margin-top:8px" onclick="runDiag()">🔍 一键检测哪一步未生效</button>',
    choose_title: '选择目标位置',
    coords_hint: '点击地图或使用下方工具选择位置',
    save: '储存到设备', add_fav: '收藏位置', locate: '当前位置',
    copy: '复制', copy_params: '复制模块参数',
    lat: '纬度', lon: '经度', alt: '海拔',
    alt_querying: '海拔查询中…', alt_na: '海拔不可用',
    alt_hint: '海拔由 Open-Meteo 自动查询（WGS-84），储存到设备时随经纬度一并写入，由 iOS Location Spoofer 模块生效。',
    acc_note_html: '<b>精度参数怎么填</b>' +
      '<code>horizontalAccuracy</code> 水平精度（米），默认 <em>39</em>，越小越「精准」—— 想更像 GPS 可设 <em>5~15</em>；保持 <em>39</em> 也正常。<br>' +
      '<code>verticalAccuracy</code> 垂直精度（米），默认 <em>1000</em> —— 本页已自动填入目标点真实海拔，可调小到 <em>10~30</em>，让海拔显得更可信。<br>' +
      '<code>扰动半径</code>（米），默认 <em>0</em>（关闭）—— 设为 <em>N</em> 后，每次定位在目标点周围 <em>N</em> 米内随机偏移，避免每次结果一模一样。想固定在精确坐标就留 <em>0</em>。' +
      '<span class="src">参数建议来自上游项目 mekos2772 / ios-location-spoofer</span>',
    fav_title: '收藏的位置', clear_all: '清空全部',
    active_title: '当前生效坐标', active_label: '设备本地坐标 (latitude/longitude/altitude)',
    refresh: '刷新', diag_btn: '🔍 一键检测环境', clear_data: '清除数据',
    paste_title: '粘贴地图链接', paste_ph: 'Apple/Google/高德/百度地图链接 或 经纬度', parse: '解析',
    paste_hint: '支持 Apple Maps · Google Maps · 高德 · 百度 · 坐标文本（自动换算为 WGS-84）',
    search_title: '搜索地点', search_ph: '搜地名，回车列出候选（只预览，不改定位）', search: '搜索',
    status_hint: '选好位置后点击「储存到设备」写入代理工具',
    modal_title: '收藏此位置', modal_ph: '输入备注名称（如: 公司、家）', cancel: '取消', save_short: '保存',
    acc: '精度', restore: '恢复真实定位', restored: '✓ 虚拟定位已清除，定位服务开关关闭后，关掉代理开关，等待至少 10 秒钟，再次开启生效', hacc: '水平精度', vacc: '垂直精度', jitter: '扰动半径(米)',
    querying: '查询中...', no_saved: '无已保存的坐标', query_failed: '查询失败 (需要代理模块支持)', cleared: '已清除',
    fav_empty: '暂无收藏，选好位置后点击「收藏位置」',
    active_now: '✓ 当前生效', del: '删除',
    pick_first: '请先在地图上选择一个位置',
    enter_label: '请输入备注名称',
    added: function(n){ return '已收藏: ' + n; },
    deleted: function(n){ return '已删除: ' + n; },
    clear_fav_confirm: '确定清空所有收藏？', all_cleared: '已清空所有收藏',
    clear_confirm: '确定清除设备上已保存的坐标？清除后将使用模块默认参数或停止修改定位。',
    dev_cleared: '已清除设备坐标',
    clear_failed: function(e){ return '清除失败: ' + e; },
    clear_failed_cfg: '清除失败 - 请检查模块配置',
    saving: '储存中...', saved: '✓ 已储存',
    written: function(lo, la, ts){ return '✓ 已写入: ' + lo.toFixed(6) + ', ' + la.toFixed(6) + ' · ' + ts; },
    saved_toast: '✓ 坐标已成功写入模块，定位服务关闭开关，等待至少 10 秒钟，再次开启生效',
    video_btn: '',
    save_failed: '✗ 储存失败 - 请检查模块配置', write_failed: '写入失败',
    no_geo: '浏览器不支持定位', getting_loc: '获取位置中...', got_loc: '已获取当前位置',
    loc_failed: function(m){ return '定位失败: ' + m; },
    paste_first: '请粘贴地图链接或坐标', parse_failed: '无法解析坐标，请检查链接格式', parsing: '解析中...',
    parsed: function(lo, la){ return '已解析: ' + lo.toFixed(4) + ', ' + la.toFixed(4); },
    enter_place: '请输入地名', searching: '搜索中...',
    not_found: function(q){ return '未找到: ' + q; }, search_failed: '搜索失败',
    copied: function(x){ return '已复制: ' + x; }, copy_failed: '复制失败，请手动选择',
    alt_unknown_copy: '海拔尚未获取，仅复制经纬度'
  },
  en: {
    title: 'iOS Location Spoofer',
    layer_satellite: 'Satellite', layer_amap: 'Amap', layer_color: 'Color', layer_standard: 'Standard', layer_dark: 'Dark',
    err_html: '<b>Module not active</b>Please check the following:<br>1. The iOS Location Spoofer module is installed and enabled<br>2. MITM is on and the certificate is fully trusted in Settings > General > About > Certificate Trust Settings (tapping "visit this website" in Safari does not count)<br>3. The MITM hostname list includes gs-loc.apple.com<br>4. The current network is routed through the proxy (open this page in Safari)<br><button class="btn btn-sm btn-primary" style="margin-top:8px" onclick="runDiag()">🔍 Run Setup Diagnostics</button>',
    choose_title: 'Choose target location',
    coords_hint: 'Tap the map or use the tools below to pick a location',
    save: 'Save to Device', add_fav: 'Add Favorite', locate: 'Current Location',
    copy: 'Copy', copy_params: 'Copy module params',
    lat: 'Lat', lon: 'Lon', alt: 'Alt',
    alt_querying: 'querying altitude…', alt_na: 'altitude unavailable',
    alt_hint: 'Altitude is auto-filled from Open-Meteo (WGS-84), written to the device on Save, and applied by the iOS Location Spoofer module.',
    acc_note_html: '<b>Choosing the accuracy values</b>' +
      '<code>horizontalAccuracy</code> in metres, default <em>39</em> — the smaller, the more "precise" it looks. Set <em>5–15</em> to look more like GPS; <em>39</em> is perfectly fine too.<br>' +
      '<code>verticalAccuracy</code> in metres, default <em>1000</em> — this page already fills in the target\\'s real altitude, so lowering it to <em>10–30</em> makes that altitude look more credible.<br>' +
      '<code>Jitter radius</code> in metres, default <em>0</em> (off) — set to <em>N</em> and each positioning is randomly offset within <em>N</em> m of the target, so results are never identical. Leave <em>0</em> to stay pinned to the exact point.' +
      '<span class="src">Guidance from the upstream project mekos2772 / ios-location-spoofer</span>',
    fav_title: 'Favorites', clear_all: 'Clear All',
    active_title: 'Active coordinates', active_label: 'On-device coordinates (latitude/longitude/altitude)',
    refresh: 'Refresh', diag_btn: '🔍 Check Setup', clear_data: 'Clear Data',
    paste_title: 'Paste map link', paste_ph: 'Apple / Google / Amap / Baidu map link or coordinates', parse: 'Parse',
    paste_hint: 'Supports Apple Maps · Google Maps · Amap · Baidu · coordinate text (auto-converted to WGS-84)',
    search_title: 'Search place', search_ph: 'Search a place, Enter to list candidates (preview only)', search: 'Search',
    status_hint: 'Pick a location, then tap "Save to Device" to write it to your proxy tool',
    modal_title: 'Add this location to favorites', modal_ph: 'Enter a label (e.g. Office, Home)', cancel: 'Cancel', save_short: 'Save',
    acc: 'Accuracy', restore: 'Restore real location', restored: '✓ Spoofed location cleared. Turn Location Services OFF, switch your proxy off, wait at least 10 seconds, then turn it back ON to take effect.', hacc: 'H. accuracy', vacc: 'V. accuracy', jitter: 'Jitter radius(m)',
    querying: 'Querying...', no_saved: 'No saved coordinates', query_failed: 'Query failed (requires the proxy module)', cleared: 'Cleared',
    fav_empty: 'No favorites yet. Pick a location and tap "Add Favorite".',
    active_now: '✓ Active now', del: 'Delete',
    pick_first: 'Please pick a location on the map first',
    enter_label: 'Please enter a label',
    added: function(n){ return 'Added: ' + n; },
    deleted: function(n){ return 'Deleted: ' + n; },
    clear_fav_confirm: 'Clear all favorites?', all_cleared: 'All favorites cleared',
    clear_confirm: 'Clear the coordinates saved on the device? After clearing, the module default parameters will be used or location spoofing will stop.',
    dev_cleared: 'Device coordinates cleared',
    clear_failed: function(e){ return 'Clear failed: ' + e; },
    clear_failed_cfg: 'Clear failed - please check the module configuration',
    saving: 'Saving...', saved: '✓ Saved',
    written: function(lo, la, ts){ return '✓ Written: ' + lo.toFixed(6) + ', ' + la.toFixed(6) + ' · ' + ts; },
    saved_toast: '✓ Coordinates written to the module. Turn Location Services OFF, wait at least 10 seconds, then turn it back ON to take effect.',
    video_btn: '▶️ Video tutorial (YouTube)',
    save_failed: '✗ Save failed - please check the module configuration', write_failed: 'Write failed',
    no_geo: 'Browser does not support geolocation', getting_loc: 'Getting location...', got_loc: 'Current location acquired',
    loc_failed: function(m){ return 'Location failed: ' + m; },
    paste_first: 'Please paste a map link or coordinates', parse_failed: 'Could not parse coordinates, please check the link format', parsing: 'Parsing...',
    parsed: function(lo, la){ return 'Parsed: ' + lo.toFixed(4) + ', ' + la.toFixed(4); },
    enter_place: 'Please enter a place name', searching: 'Searching...',
    not_found: function(q){ return 'Not found: ' + q; }, search_failed: 'Search failed',
    copied: function(x){ return 'Copied: ' + x; }, copy_failed: 'Copy failed, please select manually',
    alt_unknown_copy: 'Altitude not ready, copied lat/lon only'
  }
};

function detectLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch(e) {}
  return 'zh';
}
let lang = detectLang();

function t(key) {
  const v = I18N[lang][key];
  if (typeof v === 'function') return v.apply(null, Array.prototype.slice.call(arguments, 1));
  return v === undefined ? key : v;
}

function applyI18n() {
  document.documentElement.lang = (lang === 'zh' ? 'zh-CN' : 'en');
  document.title = t('title');
  document.querySelectorAll('[data-i18n]').forEach(function(el){ el.textContent = t(el.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-ph]').forEach(function(el){ el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
  document.querySelectorAll('[data-i18n-html]').forEach(function(el){ el.innerHTML = t(el.getAttribute('data-i18n-html')); });
  document.querySelectorAll('.lang-btn').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-lang') === lang); });
  updateCoords();
  updateStatus();
  renderActive();
  renderFavs();
}

function setLang(l) {
  lang = l;
  try { localStorage.setItem(LANG_KEY, l); } catch(e) {}
  applyI18n();
}

const map = L.map('map').setView([20, 0], 2);
const tiles = {
  satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {maxZoom:19, attribution:'ArcGIS'}),
  wgs84: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {maxZoom:19, attribution:'ArcGIS WGS84'}),
  standard: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'\\u00a9 OSM'}),
  dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {maxZoom:19, attribution:'\\u00a9 Carto'}),
  amap: L.tileLayer('https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}', {maxZoom:18, subdomains:'1234', attribution:'\\u00a9 Amap'}),
  voyager: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {maxZoom:19, attribution:'\\u00a9 Carto'})
};
let currentLayer = tiles.satellite;
currentLayer.addTo(map);
function switchLayer(name) {
  map.removeLayer(currentLayer);
  currentLayer = tiles[name];
  currentLayer.addTo(map);
  document.querySelectorAll('.layer-btn').forEach(b => b.classList.toggle('active', b.dataset.layer === name));
}
let marker = L.marker([lat, lon], {draggable:true});
let markerShown = false;
function showMarker() { if (!markerShown) { marker.addTo(map); markerShown = true; } }

marker.on('dragend', e => { const p=e.target.getLatLng(); setPos(p.lat, p.lng); });
map.on('click', e => { setPos(e.latlng.lat, e.latlng.lng); });

function currentAlt() {
  const el = document.getElementById('altInput');
  if (!el) return null;
  const n = parseFloat(el.value);
  return isFinite(n) ? Math.round(n) : null;
}
function haccVal() { const n = parseInt((document.getElementById('haccInput')||{}).value, 10); return isFinite(n) && n > 0 ? n : 39; }
function vaccVal() { const n = parseInt((document.getElementById('vaccInput')||{}).value, 10); return isFinite(n) && n > 0 ? n : 1000; }
function jitterVal() { const n = parseInt((document.getElementById('jitterInput')||{}).value, 10); return isFinite(n) && n > 0 ? n : 0; }
function setAltInput(v) {
  const el = document.getElementById('altInput');
  if (!el) return;
  if (v === null) { el.value = ''; el.placeholder = t('alt_na'); }
  else { el.value = v; el.placeholder = ''; }
}

function updateCoords() {
  const grid = document.getElementById('coordGrid');
  const coords = document.getElementById('coords');
  if (!selected) {
    grid.style.display = 'none';
    coords.style.display = '';
    coords.textContent = t('coords_hint');
    return;
  }
  coords.style.display = 'none';
  grid.style.display = '';
  document.getElementById('cvLat').textContent = lat.toFixed(6);
  document.getElementById('cvLon').textContent = lon.toFixed(6);
}

function updateStatus() {
  document.getElementById('status').textContent = (savedLon !== null)
    ? t('written', savedLon, savedLat, savedTimeStr)
    : t('status_hint');
}

function setPos(newLat, newLon, knownAlt) {
  lat = newLat; lon = newLon; selected = true;
  showMarker();
  marker.setLatLng([lat, lon]);
  if (typeof knownAlt === 'number') { elev = Math.round(knownAlt); elevState = 'ok'; elevCache.set(elevKey(lat, lon), elev); }
  updateCoords();
  fetchElevation(lat, lon);
}

function moveTo(newLat, newLon, zoom, knownAlt) {
  setPos(newLat, newLon, knownAlt);
  map.setView([lat, lon], zoom || 15);
}

function elevKey(la, lo) { return la.toFixed(4) + ',' + lo.toFixed(4); }
function fetchElevation(la, lo) {
  const key = elevKey(la, lo);
  if (elevCache.has(key)) { elev = elevCache.get(key); elevState = (elev === null ? 'fail' : 'ok'); setAltInput(elev); return; }
  elevState = 'loading'; elev = null;
  const el = document.getElementById('altInput'); if (el) { el.value = ''; el.placeholder = t('alt_querying'); }
  const seq = ++elevSeq;
  clearTimeout(elevTimer);
  elevTimer = setTimeout(function(){
    fetch(ELEV_API + '?latitude=' + la + '&longitude=' + lo, { cache:'no-store' })
      .then(r => r.json())
      .then(d => {
        const e = (d && d.elevation && d.elevation.length && d.elevation[0] !== null) ? Math.round(d.elevation[0]) : null;
        elevCache.set(key, e);
        if (seq === elevSeq) { elev = e; elevState = (e === null ? 'fail' : 'ok'); setAltInput(e); }
      })
      .catch(() => { if (seq === elevSeq) { elev = null; elevState = 'fail'; setAltInput(null); } });
  }, 500);
}

let toastTimer = null;
function toast(msg, ms) {
  const t2 = document.getElementById('toast');
  t2.textContent = msg; t2.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t2.classList.remove('show'), ms || 2500);
}

function showError(show) {
  document.getElementById('errorBanner').style.display = show ? 'block' : 'none';
}

function copyText(str) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(str);
  }
  return new Promise(function(resolve, reject){
    try {
      const ta = document.createElement('textarea');
      ta.value = str; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('execCommand failed'));
    } catch(e) { reject(e); }
  });
}

function copyField(which, btn) {
  if (!selected) { toast(t('pick_first')); return; }
  let val;
  if (which === 'lat') val = lat.toFixed(6);
  else if (which === 'lon') val = lon.toFixed(6);
  else { const a = currentAlt(); if (a === null) { toast(t('alt_na')); return; } val = String(a); }
  copyText(val).then(() => {
    toast(t('copied', val));
    if (btn) { const o = btn.textContent; btn.classList.add('success'); btn.textContent = '✓'; setTimeout(() => { btn.textContent = o; btn.classList.remove('success'); }, 1200); }
  }).catch(() => toast(t('copy_failed'), 3000));
}

function moduleParamString() {
  let s = 'latitude=' + lat.toFixed(6) + '&longitude=' + lon.toFixed(6);
  const a = currentAlt(); if (a !== null) s += '&altitude=' + a;
  s += '&horizontalAccuracy=' + haccVal() + '&verticalAccuracy=' + vaccVal();
  const j = jitterVal(); if (j > 0) s += '&randomRadius=' + j;
  return s;
}

function copyParams(btn) {
  if (!selected) { toast(t('pick_first')); return; }
  const s = moduleParamString();
  copyText(s).then(() => {
    toast(t('copied', s));
    if (currentAlt() === null) toast(t('alt_unknown_copy'), 3000);
    if (btn) { const o = btn.textContent; btn.classList.add('success'); btn.textContent = t('saved'); setTimeout(() => { btn.textContent = o; btn.classList.remove('success'); }, 1200); }
  }).catch(() => toast(t('copy_failed'), 3000));
}

function getFavs() {
  try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch(e) { return []; }
}
function saveFavs(favs) {
  localStorage.setItem(FAV_KEY, JSON.stringify(favs));
}

function renderFavs() {
  const favs = getFavs();
  const el = document.getElementById('favList');
  const clearBtn = document.getElementById('clearAllBtn');
  clearBtn.style.display = favs.length ? '' : 'none';
  if (!favs.length) {
    el.innerHTML = '<div class="fav-empty">' + escHtml(t('fav_empty')) + '<\\/div>';
    return;
  }
  el.innerHTML = favs.map((f, i) => {
    const isActive = activeLon !== null && Math.abs(f.lon - activeLon) < 0.000001 && Math.abs(f.lat - activeLat) < 0.000001;
    const altStr = (typeof f.alt === 'number') ? ('  ·  ' + f.alt + ' m') : '';
    return '<div class="fav-item" onclick="loadFav(' + i + ')">' +
      '<div class="fav-info">' +
        '<div class="fav-name">' + escHtml(f.name) + '<\\/div>' +
        '<div class="fav-coords">' + f.lon.toFixed(6) + ', ' + f.lat.toFixed(6) + altStr + '<\\/div>' +
        (isActive ? '<div class="fav-active">' + escHtml(t('active_now')) + '<\\/div>' : '') +
      '<\\/div>' +
      '<button class="fav-del" onclick="event.stopPropagation();delFav(' + i + ')" title="' + escHtml(t('del')) + '">\\u00d7<\\/button>' +
    '<\\/div>';
  }).join('');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function addFav() {
  if (!selected) { toast(t('pick_first')); return; }
  var _fa = currentAlt();
  document.getElementById('favModalCoords').textContent = lon.toFixed(6) + ', ' + lat.toFixed(6) + (_fa !== null ? ('  ·  ' + _fa + ' m') : '');
  document.getElementById('favNameInput').value = '';
  document.getElementById('favModal').classList.add('show');
  setTimeout(() => document.getElementById('favNameInput').focus(), 100);
}

function closeFavModal() {
  document.getElementById('favModal').classList.remove('show');
}

function confirmFav() {
  const name = document.getElementById('favNameInput').value.trim();
  if (!name) { toast(t('enter_label')); return; }
  const favs = getFavs();
  const rec = { name, lon, lat, time: new Date().toISOString() };
  const _ca = currentAlt(); if (_ca !== null) rec.alt = _ca;
  favs.push(rec);
  saveFavs(favs);
  closeFavModal();
  renderFavs();
  toast(t('added', name));
}

function loadFav(i) {
  const favs = getFavs();
  if (!favs[i]) return;
  moveTo(favs[i].lat, favs[i].lon, 15, typeof favs[i].alt === 'number' ? favs[i].alt : undefined);
  toast(favs[i].name + ' (' + favs[i].lon.toFixed(4) + ', ' + favs[i].lat.toFixed(4) + ')');
}

function delFav(i) {
  const favs = getFavs();
  if (!favs[i]) return;
  const name = favs[i].name;
  favs.splice(i, 1);
  saveFavs(favs);
  renderFavs();
  toast(t('deleted', name));
}

function clearAllFav() {
  if (!confirm(t('clear_fav_confirm'))) return;
  saveFavs([]);
  renderFavs();
  toast(t('all_cleared'));
}

function renderActive() {
  const el = document.getElementById('activeValue');
  if (activeStatus === 'ok') {
    el.textContent = t('lon') + ' ' + activeLon.toFixed(6) + '  ' + t('lat') + ' ' + activeLat.toFixed(6)
      + (activeAcc ? ('  ' + t('acc') + ' ' + activeAcc + 'm') : '')
      + (activeAlt !== null && activeAlt !== undefined ? ('  ' + t('alt') + ' ' + activeAlt + 'm') : '');
  } else if (activeStatus === 'none') {
    el.textContent = t('no_saved');
  } else if (activeStatus === 'failed') {
    el.textContent = t('query_failed');
  } else if (activeStatus === 'cleared') {
    el.textContent = t('cleared');
  } else {
    el.textContent = t('querying');
  }
}

function queryActive() {
  activeStatus = 'querying';
  renderActive();
  fetch(SAVE_API + '?action=query', { method:'GET', mode:'cors', cache:'no-store' })
    .then(r => r.json())
    .then(d => {
      if (d.success && d.longitude && d.latitude) {
        activeLon = parseFloat(d.longitude);
        activeLat = parseFloat(d.latitude);
        activeAcc = (d.horizontalAccuracy != null ? d.horizontalAccuracy : (d.accuracy || null));
        activeAlt = (d.altitude !== undefined && d.altitude !== null) ? d.altitude : null;
        if (d.randomRadius != null) { const ji = document.getElementById('jitterInput'); if (ji) ji.value = d.randomRadius; }
        activeStatus = 'ok';
        if (!didInitialCenter && !selected) {
          didInitialCenter = true;
          moveTo(activeLat, activeLon, 15, (activeAlt !== null && activeAlt !== undefined) ? activeAlt : undefined);
        }
      } else {
        activeLon = null; activeLat = null; activeAcc = null; activeAlt = null;
        activeStatus = 'none';
      }
      renderActive();
      renderFavs();
    })
    .catch(() => { activeStatus = 'failed'; renderActive(); showError(true); });
}

function clearActive() {
  if (!confirm(t('clear_confirm'))) return;
  fetch(SAVE_API + '?action=clear', { method:'GET', mode:'cors', cache:'no-store' })
    .then(r => r.json())
    .then(d => {
      if (d.success) {
        activeLon = null; activeLat = null; activeAcc = null; activeAlt = null;
        activeStatus = 'cleared';
        renderActive();
        renderFavs();
        toast(t('dev_cleared'));
      } else { toast(t('clear_failed', d.error || ''), 3000); }
    })
    .catch(() => { toast(t('clear_failed_cfg'), 3000); });
}

async function save() {
  if (!selected) { toast(t('pick_first')); return; }
  const btn = document.getElementById('saveBtn');
  btn.textContent = t('saving'); btn.disabled = true;
  showError(false);
  try {
    let url = SAVE_API + '?lon=' + lon + '&lat=' + lat;
    const a = currentAlt(); if (a !== null) url += '&alt=' + a;
    url += '&hacc=' + haccVal() + '&vacc=' + vaccVal() + '&randomRadius=' + jitterVal();
    const r = await fetch(url, { method: 'GET', mode: 'cors', cache: 'no-store' });
    const d = await r.json();
    if (d.success) {
      activeLon = lon; activeLat = lat; activeAcc = haccVal();
      activeAlt = currentAlt();
      activeStatus = 'ok';
      savedLon = lon; savedLat = lat; savedTimeStr = new Date().toLocaleTimeString();
      btn.textContent = t('saved'); btn.className = 'btn btn-primary success';
      updateStatus();
      renderActive();
      renderFavs();
      toast(t('saved_toast'), 30000);
      setTimeout(() => { btn.textContent = t('save'); btn.className='btn btn-primary'; btn.disabled=false; }, 2500);
    } else {
      throw new Error(d.error || t('write_failed'));
    }
  } catch(e) {
    btn.textContent = t('save'); btn.className = 'btn btn-primary'; btn.disabled = false;
    showError(true);
    toast(t('save_failed'), 4000);
  }
}

function locateMe() {
  if (!navigator.geolocation) return toast(t('no_geo'));
  toast(t('getting_loc'));
  navigator.geolocation.getCurrentPosition(
    pos => { moveTo(pos.coords.latitude, pos.coords.longitude, 16); toast(t('got_loc')); },
    err => toast(t('loc_failed', err.message), 3000),
    { enableHighAccuracy:true, timeout:10000 }
  );
}

function parseLocalCoords(text) {
  const m = text.match(/(-?[0-9]+\\.[0-9]+)[,\\s]+(-?[0-9]+\\.[0-9]+)/);
  if (!m) return null;
  const a = parseFloat(m), b = parseFloat(m);
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lon: b };
  if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return { lat: b, lon: a };
  return { lat: a, lon: b };
}

async function parseUrl() {
  const input = document.getElementById('urlInput').value.trim();
  if (!input) return toast(t('paste_first'));
  toast(t('parsing'));
  try {
    const r = await fetch(PARSE_API + '?format=json&u=' + encodeURIComponent(input), { cache:'no-store' });
    const d = await r.json();
    if (d && typeof d.lat === 'number' && typeof d.lon === 'number') {
      moveTo(d.lat, d.lon, 15);
      toast(d.name ? (d.name + ' (' + d.lon.toFixed(4) + ', ' + d.lat.toFixed(4) + ')') : t('parsed', d.lon, d.lat));
      return;
    }
    throw new Error(d && d.error ? d.error : 'parse failed');
  } catch(e) {
    const local = parseLocalCoords(input);
    if (local) { moveTo(local.lat, local.lon, 15); toast(t('parsed', local.lon, local.lat)); return; }
    toast(t('parse_failed'), 3000);
  }
}

let searchResults = [];
async function searchPlace() {
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return toast(t('enter_place'));
  const box = document.getElementById('searchResults');
  box.innerHTML = '<div class="search-item">' + escHtml(t('searching')) + '<\\/div>';
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&q='+encodeURIComponent(q), { headers: { 'Accept-Language': (lang === 'zh' ? 'zh-CN' : 'en') } });
    searchResults = await r.json();
    if (!searchResults.length) { box.innerHTML = ''; toast(t('not_found', q), 3000); return; }
    box.innerHTML = searchResults.map(function(p, i){
      const name = p.display_name || '';
      return '<div class="search-item" onclick="selectSearchResult(' + i + ')">' +
        '<div class="si-name">' + escHtml(name.split(',')[0]) + '<\\/div>' +
        '<div class="si-sub">' + escHtml(name) + '<\\/div>' +
      '<\\/div>';
    }).join('');
  } catch(e) { box.innerHTML = ''; toast(t('search_failed'), 3000); }
}
function selectSearchResult(i) {
  const p = searchResults[i];
  if (!p) return;
  moveTo(parseFloat(p.lat), parseFloat(p.lon), 15);
  toast((p.display_name || '').slice(0, 40));
}
function restoreReal() {
  fetch(SAVE_API + '?action=clear', { method:'GET', mode:'cors', cache:'no-store' })
    .then(r => r.json())
    .then(d => {
      if (d.success) {
        activeLon = null; activeLat = null; activeAcc = null; activeAlt = null;
        activeStatus = 'cleared'; savedLon = null;
        updateStatus(); renderActive(); renderFavs();
        toast(t('restored'), 30000);
      } else { toast(t('clear_failed_cfg'), 3000); }
    })
    .catch(() => toast(t('clear_failed_cfg'), 3000));
}

document.addEventListener('paste', e => {
  const text = (e.clipboardData||window.clipboardData).getData('text');
  if (text && (text.includes('map') || text.includes('loc') || text.includes('lnglat') || text.includes('baidu') || /[0-9]+\\.[0-9]+/.test(text))) {
    document.getElementById('urlInput').value = text;
    setTimeout(parseUrl, 200);
  }
});
document.getElementById('searchInput').addEventListener('keydown', e => { if(e.key==='Enter') searchPlace(); });
document.getElementById('urlInput').addEventListener('keydown', e => { if(e.key==='Enter') parseUrl(); });
document.getElementById('favNameInput').addEventListener('keydown', e => { if(e.key==='Enter') confirmFav(); });


async function probeEndpoint(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 5000);
  try {
    const r = await fetch(url, { method: 'GET', mode: 'cors', cache: 'no-store', signal: ctrl.signal });
    clearTimeout(timer);
    const d = await r.json();
    return { ok: true, data: d };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function runDiag() {
  const box = document.getElementById('diagBox');
  if (!box) return;
  box.className = 'diag-box show';
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const isZh = (lang === 'zh');
  box.innerHTML = isZh ? '⏳ 正在检测代理、模块与系统证书信任状态…' : '⏳ Checking proxy, module and certificate trust…';

  const ua = navigator.userAgent || '';
  const isWeChat = /MicroMessenger/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const [resMain, resCn] = await Promise.all([
    probeEndpoint('https://gs-loc.apple.com/wloc-settings/save?action=query&_t=' + Date.now(), 5000),
    probeEndpoint('https://gs-loc-cn.apple.com/wloc-settings/save?action=query&_t=' + Date.now(), 5000)
  ]);

  const items = [];
  // 1. Browser check
  if (isWeChat) {
    items.push('<div class="diag-item">❌ <b>' + (isZh ? '浏览器环境' : 'Browser') + '</b>：' +
      (isZh ? '当前在微信内置浏览器中，请点击右上角「…」选择<b>在默认浏览器(Safari)中打开</b>。' : 'Opened inside WeChat. Please open in Safari.') + '</div>');
  } else if (isIOS) {
    items.push('<div class="diag-item">✅ <b>' + (isZh ? '浏览器环境' : 'Browser') + '</b>：' +
      (isZh ? 'iOS 浏览器环境正常' : 'iOS browser OK') + '</div>');
  } else {
    items.push('<div class="diag-item">⚠️ <b>' + (isZh ? '设备环境' : 'Device') + '</b>：' +
      (isZh ? '当前非 iPhone/iPad 设备（请在已开启小火箭的 iOS 设备 Safari 中使用）' : 'Not an iOS device (use Safari on iOS with proxy enabled)') + '</div>');
  }

  // 2. Module & MITM interception on gs-loc.apple.com
  if (resMain.ok) {
    items.push('<div class="diag-item">✅ <b>' + (isZh ? '模块与代理拦截 (gs-loc.apple.com)' : 'Module Interception (gs-loc.apple.com)') + '</b>：' +
      (isZh ? 'iLS Settings 脚本响应正常' : 'iLS Settings script responded OK') + '</div>');
  } else {
    items.push('<div class="diag-item">❌ <b>' + (isZh ? '模块与代理拦截 (gs-loc.apple.com)' : 'Module Interception (gs-loc.apple.com)') + '</b>：' +
      (isZh ? '未拦截到响应。请检查：① 小火箭 VPN 已连接且全局路由选「配置」 ② 模块已启用 ③ HTTPS 解密已开启并安装证书' : 'Failed. Check proxy connection, module enabled, and MITM decryption enabled.') + '</div>');
  }

  // 3. System-wide root certificate full trust check via gs-loc-cn.apple.com
  if (resMain.ok && resCn.ok) {
    items.push('<div class="diag-item">✅ <b>' + (isZh ? '系统根证书完全信任 (gs-loc-cn.apple.com)' : 'System Root Certificate Trust (gs-loc-cn.apple.com)') + '</b>：' +
      (isZh ? '双域名握手通过，系统定位服务可正常改写' : 'Both domains verified, system location daemon can be spoofed') + '</div>');
    showError(false);
  } else if (resMain.ok && !resCn.ok) {
    items.push('<div class="diag-item">❌ <b>' + (isZh ? '系统根证书完全信任 (关键项)' : 'System Root Certificate Trust (Critical)') + '</b>：' +
      (isZh ? '<b>检测到您仅在 Safari 点了“继续访问”，系统并未信任小火箭证书！</b>这样会导致能保存坐标但手机实际定位不变。<br>👉 解决：打开手机「设置 → 通用 → 关于本机 → 证书信任设置」，把小火箭根证书开关打开！' : '<b>Safari temporary bypass detected without system root trust!</b> Go to Settings > General > About > Certificate Trust Settings and enable full trust for the root certificate.') + '</div>');
    showError(true);
  } else {
    items.push('<div class="diag-item">❌ <b>' + (isZh ? '系统根证书完全信任' : 'System Root Certificate Trust') + '</b>：' +
      (isZh ? '握手失败。请确认：① 已在「设置 → 通用 → VPN与设备管理」安装证书描述文件 ② 已在「设置 → 通用 → 关于本机 → 证书信任设置」打开完全信任开关（若重装过证书请先删旧证书再重新生成安装）' : 'Handshake failed. Install the CA profile and enable full trust in Settings > General > About > Certificate Trust Settings.') + '</div>');
    showError(true);
  }

  // 4. Stored coordinates status
  if (resMain.ok && resMain.data && resMain.data.success && resMain.data.enabled) {
    const d = resMain.data;
    items.push('<div class="diag-item">✅ <b>' + (isZh ? '本机已存坐标' : 'Stored Coordinates') + '</b>：' +
      Number(d.longitude).toFixed(6) + ', ' + Number(d.latitude).toFixed(6) +
      (isZh ? '<br>💡 <b>生效提示</b>：每次修改位置后，请<b>开关一次飞行模式</b>，并到「设置 → 隐私与安全性 → 定位服务」<b>关闭定位等待 10 秒再开启</b>即可刷新全机定位。' : '<br>💡 Tip: Toggle Airplane Mode and turn Location Services OFF for 10s then ON to refresh location.') + '</div>');
  } else if (resMain.ok) {
    items.push('<div class="diag-item">ℹ️ <b>' + (isZh ? '本机已存坐标' : 'Stored Coordinates') + '</b>：' +
      (isZh ? '当前未启用虚拟坐标（在地图上选点后点击「储存到设备」即可）' : 'No active coordinates stored yet (pick a point and tap Save to Device)') + '</div>');
  }

  box.innerHTML = items.join('');
}

applyI18n();
queryActive();
<\/script>
</body>
</html>`;
}

/* ==== inlined from src/landing.js ==== */

function getLandingHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>iOS Location Spoofer · 虚拟定位</title>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0a0c11">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>
:root{
  --bg:#0a0c11; --card:#12161d; --card2:#191e28; --line:#242b38;
  --cyan:#17c3cf; --cyan2:#0e97a1; --green:#22c55e; --green2:#159a45;
  --red:#ff5b60; --amber:#f5a623; --txt:#eef2f8; --muted:#8a93a5; --mono:#7fe3ea;
}
*{ margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
body{
  font-family:-apple-system,system-ui,"SF Pro","Helvetica Neue",sans-serif;
  color:var(--txt); line-height:1.5;
  background:
    radial-gradient(1100px 420px at 50% -140px, rgba(23,195,207,.16), transparent 70%),
    radial-gradient(700px 360px at 90% 8%, rgba(34,197,94,.08), transparent 65%),
    var(--bg);
  background-attachment:fixed;
}
.watermark{
  position:fixed; inset:0; pointer-events:none; z-index:0; opacity:0.12;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='360' height='200'><text x='20' y='100' fill='%23ffffff' font-size='13' transform='rotate(-22, 180, 100)'>小红书独家技术ID95975775001 可乐加糖</text></svg>");
  background-repeat:repeat;
}
.wrap{ position:relative; z-index:1; max-width:600px; margin:0 auto; padding:20px 16px calc(44px + env(safe-area-inset-bottom)); }

header{ text-align:center; padding:8px 0 6px; }
header .logowrap{ position:relative; width:74px; margin:0 auto 14px; }
header .logo{ width:74px; height:74px; border-radius:20px; display:block; box-shadow:0 0 0 1px var(--line),0 10px 30px rgba(23,195,207,.28); margin:0 auto; }
h1{ font-size:22px; font-weight:800; letter-spacing:.3px; background:linear-gradient(92deg,#eafcff,#7fe3ea 55%,#22c55e); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
.synced{ font-size:12px; color:#22c55e; font-weight:700; margin-top:8px; }

.ctas{ display:flex; gap:10px; margin:18px 0 12px; }
.enter{ flex:1; display:flex; align-items:center; justify-content:center; gap:8px; padding:17px 14px; border:none; border-radius:14px; font-size:16px; font-weight:800; cursor:pointer; text-decoration:none; transition:transform .12s,box-shadow .12s; }
.enter:active{ transform:scale(.97); }
.enter.go{ background:linear-gradient(135deg,#2ee06a,#129a44); color:#04240f; box-shadow:0 10px 26px rgba(34,197,94,.34); }

.wechat-box{
  background: linear-gradient(135deg, rgba(25,30,40,0.8), rgba(18,22,29,0.95));
  border: 1px solid rgba(23,195,207,0.2);
  border-radius: 14px;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-shadow: 0 4px 20px rgba(0,0,0,0.25);
  backdrop-filter: blur(8px);
  margin-bottom: 4px;
}
.wechat-info{ display:flex; align-items:center; gap:10px; }
.wechat-icon{ font-size:18px; }
.wechat-text{ display:flex; flex-direction:column; }
.wechat-label{ font-size:12px; color:var(--muted); font-weight:500; }
.wechat-id{ font-family:"SF Mono",ui-monospace,monospace; font-size:14px; color:var(--mono); font-weight:700; letter-spacing:.5px; }
.wechat-copy{
  padding: 6px 14px;
  background: rgba(23,195,207,0.12);
  border: 1px solid rgba(23,195,207,0.3);
  border-radius: 8px;
  color: var(--cyan);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all .15s ease;
}
.wechat-copy:active{ transform:scale(.95); background:rgba(23,195,207,0.25); }
.wechat-copy.ok{ background:var(--green); border-color:var(--green); color:#04240f; }

.divider{ height:1px; background:linear-gradient(90deg,transparent,var(--line),transparent); margin:24px 0 20px; }

h2{ font-size:16px; font-weight:800; margin-bottom:4px; display:flex; align-items:center; gap:9px; }
h2::before{ content:""; width:4px; height:16px; border-radius:2px; background:linear-gradient(180deg,var(--cyan),var(--green)); }
.sub{ font-size:12.5px; color:var(--muted); margin:0 0 14px 13px; }

/* 已经去除内部竖条的提示框样式 */
.note{ 
  background: var(--card); 
  border: 1px solid var(--line); 
  border-radius: 14px; 
  padding: 16px; 
  font-size: 12.5px; 
  color: #c3ccdb; 
  margin-bottom: 16px; 
  line-height: 1.6;
}
.note-item{ margin-bottom: 6px; }
.note-item:last-child{ margin-bottom: 0; }
.note-warn{ 
  color: var(--red); 
  font-size: 12px; 
  margin-top: 8px; 
  padding-top: 8px; 
  border-top: 1px dashed var(--line); 
}

.plat{ background:var(--card); border:1px solid var(--line); border-radius:14px; padding:12px; margin-bottom:12px; cursor:pointer; transition:transform .12s, border-color .12s; }
.plat:active{ transform:scale(.99); border-color:var(--cyan); }
.plat .big{ display:flex; align-items:center; justify-content:center; gap:8px; width:100%; padding:14px; border:none; border-radius:11px; background:linear-gradient(135deg,var(--cyan),var(--cyan2)); color:#022a2d; font-size:15.5px; font-weight:800; cursor:pointer; text-align:center; text-decoration:none; transition:filter .12s,transform .12s; }
.plat .big:active{ filter:brightness(1.1); transform:scale(.98); }
.plat .line{ display:flex; align-items:center; gap:8px; margin-top:9px; }
.plat .url{ flex:1; min-width:0; font-family:"SF Mono",ui-monospace,monospace; font-size:11px; color:var(--muted); background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:8px 10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.plat .copy{ flex:none; padding:8px 15px; border:1px solid var(--line); border-radius:8px; background:var(--card2); color:var(--txt); font-size:12.5px; font-weight:600; cursor:pointer; transition:all .12s; }
.plat .copy:active{ background:#2a3140; }
.plat .copy.ok{ background:var(--green); border-color:var(--green); color:#04240f; }

.mitm{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:13px 15px; font-size:12.5px; color:#c3ccdb; margin-top:16px; }
.mitm b{ color:var(--txt); }
.mitm code{ display:inline-block; font-family:"SF Mono",ui-monospace,monospace; font-size:11.5px; color:var(--mono); word-break:break-all; line-height:2; }
.mitm .hosts{ margin-top:8px; padding:10px 12px; background:var(--bg); border:1px solid var(--line); border-radius:9px; }
.mitm .hosts code{ line-height:2.1; }

.toast{ position:fixed; left:50%; bottom:40px; transform:translateX(-50%) translateY(20px); background:rgba(8,10,14,.92); color:#fff; padding:11px 20px; border-radius:22px; font-size:14px; opacity:0; transition:all .25s; pointer-events:none; z-index:99; border:1px solid var(--line); }
.toast.show{ opacity:1; transform:translateX(-50%) translateY(0); }

footer{ text-align:center; font-size:11.5px; color:var(--muted); margin-top:26px; line-height:1.9; }
footer b{ color:#8fe0e6; }
</style>
</head>
<body>
<div class="watermark"></div>
<div class="wrap">
  <header>
    <div class="logowrap"><img class="logo" src="/icon.svg" alt="logo"></div>
    <h1>小红书独家版本  虚拟定位</h1>
    <p class="synced">✅ 最新IOS版本 · 港澳台/百度坐标解析</p>
  </header>

  <div class="ctas">
    <button type="button" class="enter go" id="btnEnter">🗺️ 进入选点网页</button>
  </div>

  <div class="wechat-box">
    <div class="wechat-info">
      <span class="wechat-icon">💬</span>
      <div class="wechat-text">
        <span class="wechat-label">中国大陆微信号</span>
        <span class="wechat-id">LLME-love</span>
      </div>
    </div>
    <button class="wechat-copy" id="copyWechat">复制微信号</button>
  </div>

  <div class="divider"></div>

  <h2>安装与使用说明</h2>
  <p class="sub">点击卡片或「一键导入shadowrocket」直接安装；或点击「复制」手动添加模块。</p>
  
  <div class="note">
    <div class="note-item">📍 <b>生效前提：</b></div>
    <div class="note-item" style="padding-left:18px; color:#a0aec0; line-height:1.7;">
      ① shadowrocket 已开启并连接<br>
      ② 开启 HTTPS 解密 (MITM) 安装证书并信任证书<br>
      ③ 安装模块后选择位置点击「保存到设备」
    </div>
    <div class="note-warn">
      * 支持 iOS 26+，切换定位后若未即时生效可尝试重启一次设备清理缓存。
    </div>
  </div>

  <div id="plats"></div>

  <div class="mitm">
    <b>MITM 主机名（如全部配置成功仍不生效，在 MITM / HTTPS 解密中手动加入下面5个域名）：</b>
    <div class="hosts"><code>gs-loc.apple.com<br>gs-loc-cn.apple.com<br>bluedot.is.autonavi.com<br>bluedot.is.autonavi.com.gds.alibabadns.com<br>gps-ssl.ls.apple.com</code></div>
  </div>

  <footer>
    坐标只存在你<b>当前设备</b>上，服务端不留存记录。<br>
    GNU AGPL-3.0 · 仅供学习研究
  </footer>
</div>

<div class="toast" id="toast"></div>

<script>
(function(){
  var origin = location.origin;
  function u(file){ return origin + '/' + file; }

  var PLATS = [
    {
      name: 'Shadowrocket',
      file: 'ios-location-spoofer.sgmodule',
      scheme: function(x){ return 'shadowrocket://install?module=' + encodeURIComponent(x); }
    }
  ];

  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

  function toast(m){
    var t = document.getElementById('toast');
    t.textContent = m;
    t.classList.add('show');
    setTimeout(function(){ t.classList.remove('show'); }, 1800);
  }

  function copyText(s){
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(s);
    }
    return new Promise(function(res, rej){
      try {
        var ta = document.createElement('textarea');
        ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? res() : rej();
      } catch(e){ rej(e); }
    });
  }

  function doCopy(s, btn, successMsg){
    copyText(s).then(function(){
      toast(successMsg || '已复制');
      var o = btn.textContent;
      btn.classList.add('ok');
      btn.textContent = '✓';
      setTimeout(function(){ btn.textContent = o; btn.classList.remove('ok'); }, 1200);
    }).catch(function(){ toast('复制失败，请手动输入'); });
  }

  var btnEnter = document.getElementById('btnEnter');
  if(btnEnter){
    btnEnter.addEventListener('click', function(){
      toast("正在验证权限...");
      fetch('/api/check-auth')
        .then(function(res) {
          if (res.ok) {
            window.location.href = "/picker";
          } else {
            toast("卡密已过期或失效，请重新登录");
            setTimeout(function(){ location.reload(); }, 1200);
          }
        })
        .catch(function() {
          toast("网络异常，请稍后再试");
        });
    });
  }

  var wcBtn = document.getElementById('copyWechat');
  if(wcBtn){
    wcBtn.addEventListener('click', function(){
      doCopy('LLME-love', wcBtn, '已复制微信号: LLME-love');
    });
  }

  var html = '';
  for (var i=0; i<PLATS.length; i++){
    var p = PLATS[i];
    var url = u(p.file);
    var schemeUrl = p.scheme(url);
    html += '<div class="plat" data-scheme="' + esc(schemeUrl) + '">' +
      '<a class="big" href="' + esc(schemeUrl) + '">一键导入 ' + esc(p.name) + '</a>' +
      '<div class="line" onclick="event.stopPropagation()">' +
      '<span class="url">' + esc(url) + '</span>' +
      '<button class="copy" data-url="' + esc(url) + '">复制</button>' +
      '</div></div>';
  }

  var platsContainer = document.getElementById('plats');
  if(platsContainer){
    platsContainer.innerHTML = html;

    var platCards = platsContainer.querySelectorAll('.plat');
    for (var k=0; k<platCards.length; k++){
      (function(card){
        card.addEventListener('click', function(){
          var scheme = card.getAttribute('data-scheme');
          if(scheme) window.location.href = scheme;
        });
      })(platCards[k]);
    }

    var btns = platsContainer.querySelectorAll('.copy');
    for (var j=0; j<btns.length; j++){
      (function(b){
        b.addEventListener('click', function(e){
          e.stopPropagation();
          doCopy(b.getAttribute('data-url'), b, '已复制模块链接');
        });
      })(btns[j]);
    }
  }
})();
<\/script>
</body>
</html>`;
}

/* ==== inlined from src/index.js (imports stripped, Hono shimmed) ==== */

const app = new Hono();

/* ---- 全局卡密 & 用户名 & 到期时间 & 单设备绑定拦截中间件 ---- */
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  const pathname = url.pathname;

  // 放行静态资源、解绑页面、管理员页面及 API
  const isStaticAsset =
    pathname.endsWith(".png") ||
    pathname.endsWith(".svg") ||
    pathname.endsWith(".ico") ||
    pathname.endsWith(".webmanifest") ||
    pathname.endsWith(".js") ||
    pathname.endsWith(".sgmodule") ||
    pathname.endsWith(".stoverride") ||
    pathname.endsWith(".lnplugin") ||
    pathname.endsWith(".snippet") ||
    pathname.startsWith("/unbind") ||
    pathname.startsWith("/admin") ||
    pathname.startsWith("/api/") ||
    pathname === "/tg";

  if (isStaticAsset) {
    return await next();
  }

  // 1. 获取卡密
  let userKey = c.req.query("key") || c.req.query("token") || c.req.query("pwd") || "";
  const cookieHeader = c.req.header("Cookie") || "";
  const cookies = Object.fromEntries(
    cookieHeader.split(";").map(item => {
      const [k, ...v] = item.trim().split("=");
      return [k, (v || []).join("=")];
    })
  );

  if (!userKey && cookies.card_key) {
    userKey = cookies.card_key;
  }

  // 2. 未输入卡密 -> 显示登录页
  if (!userKey) {
    const loginHtml = `<!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>访问验证</title>
      <style>
        body { font-family: -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0b0b0f; color: #fff; }
        .card { background: #1c1c24; padding: 32px; border-radius: 16px; text-align: center; width: 320px; box-sizing: border-box; }
        input { width: 100%; box-sizing: border-box; padding: 12px; margin-bottom: 16px; border: 1px solid #2c2c3e; background: #0b0b0f; color: #fff; border-radius: 8px; text-align: center; }
        button { width: 100%; padding: 12px; background: #007aff; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; }
        a { color: #8e8e93; font-size: 12px; text-decoration: none; display: inline-block; margin-top: 12px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h3>🔑 请输入卡密</h3>
        <p style="color:#8e8e93;font-size:13px;">请输入有效卡密以继续使用服务</p>
        <form method="GET">
          <input type="text" name="key" placeholder="请输入卡密" required />
          <button type="submit">验证并进入</button>
        </form>
        <a href="/unbind">设备锁定了？点击前往自助解绑</a>
      </div>
    </body>
    </html>`;
    return c.html(loginHtml, 401);
  }

  const KV = c.env?.CARD_KEYS || (typeof CARD_KEYS !== "undefined" ? CARD_KEYS : null);
  if (!KV) return c.text("错误：未能在环境变量中绑定 CARD_KEYS KV 数据库！", 500);

  // 3. 从 KV 校验卡密
  const keyDataRaw = await KV.get(userKey);
  if (!keyDataRaw) {
    return c.html("<h2 style='color:red;text-align:center;margin-top:20%'>❌ 错误：卡密无效或不存在！</h2>", 403);
  }

  let expireDateStr = keyDataRaw;
  let boundDeviceId = null;
  let userName = "尊贵用户";

  if (keyDataRaw.startsWith("{")) {
    try {
      const parsed = JSON.parse(keyDataRaw);
      expireDateStr = parsed.expire || expireDateStr;
      boundDeviceId = parsed.deviceId || null;
      userName = parsed.name || userName;
    } catch (e) {}
  }

  // 4. 到期时间校验
  const formattedExpireStr = expireDateStr.replace(/-(\d)(?=-|$)/g, '-0$1');
  const expireTime = new Date(`${formattedExpireStr}T23:59:59+08:00`).getTime();

  if (isNaN(expireTime) || Date.now() > expireTime) {
    c.header("Set-Cookie", "card_key=; Path=/; Max-Age=0", { append: true });
    return c.html(`<h2 style='color:red;text-align:center;margin-top:20%'>⏰ 用户 [${userName}] 的卡密已于 ${expireDateStr} 到期。</h2>`, 403);
  }

  // 5. 设备绑定校验
  let currentDeviceId = cookies.device_id || crypto.randomUUID();
  if (!boundDeviceId) {
    await KV.put(userKey, JSON.stringify({ name: userName, expire: expireDateStr, deviceId: currentDeviceId }));
  } else if (boundDeviceId !== currentDeviceId) {
    return c.html(`<div style='text-align:center;margin-top:20%;color:#fff;font-family:sans-serif;'>
      <h2 style='color:orange;'>⚠️ 该卡密已被其他设备绑定！</h2>
      <p>如果您更换了设备，请前往解绑页面：</p>
      <a href="/unbind" style="color:#007aff;">👉 点击进入自助解绑页面</a>
    </div>`, 403);
  }

  // 6. 写入 Cookie
  c.header("Set-Cookie", `card_key=${userKey}; Path=/; Max-Age=2592000`, { append: true });
  c.header("Set-Cookie", `device_id=${currentDeviceId}; Path=/; Max-Age=2592000; HttpOnly`, { append: true });
  c.header("Set-Cookie", `expire_date=${expireDateStr}; Path=/; Max-Age=2592000`, { append: true });

  await next();

  // 7. 注入浮窗
  const contentType = c.res.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    const originalBody = await c.res.text();
    const isPermanent = parseInt(expireDateStr.split("-")[0], 10) >= 2099;
    const displayText = isPermanent ? "永久有效" : expireDateStr;

    const floatingBadge = `
      <div id="expire-badge" style="position: fixed; bottom: 12px; right: 12px; z-index: 999999; background: rgba(28,28,36,0.88); backdrop-filter: blur(8px); color: #8e8e93; font-size: 11px; padding: 6px 14px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.1); font-family: -apple-system, sans-serif; pointer-events: none; opacity: 0.9; box-shadow: 0 4px 12px rgba(0,0,0,0.3);">
        🔑 密钥：<span style="color: #ff9500; font-weight: 600; margin-right: 8px;">${userKey}</span>
        👤 用户：<span style="color: #007aff; font-weight: 600; margin-right: 8px;">${userName}</span>
        ⏳ 有效期：<span style="color: #34c759; font-weight: 600;">${displayText}</span>
      </div>
    `;
    const newBody = originalBody.replace("</body>", `${floatingBadge}</body>`);
    c.res = new Response(newBody, c.res);
  }
});

/* ---- CF 内置：用户自助解绑页面 ---- */
app.get("/unbind", (c) => {
  const html = `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>卡密自助解绑</title>
    <style>
      body { font-family: -apple-system, sans-serif; background: #0c0c0e; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
      .box { background: #181820; padding: 30px; border-radius: 16px; width: 320px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
      input { width: 100%; padding: 12px; margin: 10px 0; background: #0c0c0e; border: 1px solid #2a2a38; color: #fff; border-radius: 8px; box-sizing: border-box; text-align: center; }
      .btn { width: 100%; padding: 12px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; margin-top: 10px; box-sizing: border-box; text-decoration: none; display: inline-block; font-size: 14px; }
      .btn-unbind { background: #34c759; color: white; }
      .btn-login { background: #007aff; color: white; margin-top: 12px; }
      #msg { margin-top: 15px; font-size: 13px; word-break: break-all; }
    </style>
  </head>
  <body>
    <div class="box">
      <h2>🔓 设备自助解绑</h2>
      <p style="font-size:12px;color:#888;">更换设备或提示绑定时，输入卡密即可解绑</p>
      <input type="text" id="cardKey" placeholder="请输入您的卡密" />
      <button class="btn btn-unbind" onclick="doUnbind()">一键解绑旧设备</button>
      <a href="/" class="btn btn-login">前往登录 / 进入主页</a>
      <div id="msg"></div>
    </div>
    <script>
      async function doUnbind() {
        const key = document.getElementById("cardKey").value.trim();
        const msgDiv = document.getElementById("msg");
        if (!key) { msgDiv.innerHTML = "<span style='color:red;'>请输入卡密</span>"; return; }
        msgDiv.innerHTML = "<span style='color:#aaa;'>正在解绑中...</span>";
        try {
          const res = await fetch("/api/user-unbind?key=" + encodeURIComponent(key));
          const text = await res.text();
          if (res.ok) {
            msgDiv.innerHTML = "<span style='color:#34c759;'>" + text + "</span><br><br><span style='color:#007aff;font-size:12px;'>3秒后将自动跳往主页...</span>";
            setTimeout(() => {
              window.location.href = "/?key=" + encodeURIComponent(key);
            }, 3000);
          } else {
            msgDiv.innerHTML = "<span style='color:#ff3b30;'>" + text + "</span>";
          }
        } catch (e) {
          msgDiv.innerHTML = "<span style='color:red;'>网络错误，解绑失败</span>";
        }
      }
    </script>
  </body>
  </html>`;
  return c.html(html);
});

/* ---- 用户自助解绑 API ---- */
app.get("/api/user-unbind", async (c) => {
  const targetKey = c.req.query("key");
  if (!targetKey) return c.text("❌ 请输入卡密", 400);

  const KV = c.env?.CARD_KEYS || (typeof CARD_KEYS !== "undefined" ? CARD_KEYS : null);
  const keyDataRaw = await KV.get(targetKey);

  if (!keyDataRaw) return c.text("❌ 卡密不存在或已被删除", 404);

  let expireDateStr = keyDataRaw;
  let userName = "尊贵用户";

  if (keyDataRaw.startsWith("{")) {
    try {
      const parsed = JSON.parse(keyDataRaw);
      expireDateStr = parsed.expire || expireDateStr;
      userName = parsed.name || userName;
    } catch (e) {}
  }

  await KV.put(targetKey, JSON.stringify({ name: userName, expire: expireDateStr }));
  return c.text(`✅ 用户 [${userName}] 的设备解绑成功！现在可以在新设备上登录了。`);
});

/* ---- 管理员后台控制台（/admin） ---- */
app.get("/admin", (c) => {
  const html = `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>管理员控制台</title>
    <style>
      body { font-family: -apple-system, sans-serif; background: #0c0c0e; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px 0; box-sizing: border-box; }
      .box { background: #181820; padding: 24px; border-radius: 16px; width: 340px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); border: 1px solid #2a2a38; }
      h2 { text-align: center; margin-top: 0; margin-bottom: 20px; font-size: 20px; }
      .section-title { font-size: 14px; font-weight: bold; color: #007aff; border-left: 3px solid #007aff; padding-left: 8px; margin: 20px 0 10px 0; text-align: left; }
      input, select { width: 100%; padding: 10px; margin: 6px 0; background: #0c0c0e; border: 1px solid #2a2a38; color: #fff; border-radius: 8px; box-sizing: border-box; font-size: 13px; }
      .btn { width: 100%; padding: 11px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; margin-top: 10px; font-size: 14px; }
      .btn-add { background: #34c759; color: white; }
      .btn-unbind { background: #ff9500; color: white; }
      .btn-gen { background: #2c2c3e; color: #007aff; border: 1px solid #007aff; margin-top: 2px; padding: 6px; font-size: 12px; }
      #msg { margin-top: 15px; font-size: 13px; word-break: break-all; text-align: center; padding: 8px; border-radius: 6px; background: #0c0c0e; display: none; }
    </style>
  </head>
  <body>
    <div class="box">
      <h2>🛠️ 管理员控制台</h2>
      
      <div>
        <label style="font-size: 12px; color: #aaa;">🔑 管理员密码：</label>
        <input type="password" id="adminPwd" placeholder="请输入 ADMIN_PWD" />
      </div>

      <div class="section-title">➕ 快捷生成 / 发放卡密</div>
      <input type="text" id="newKey" placeholder="卡密（可自定义或点击随机生成）" />
      <button class="btn btn-gen" onclick="genRandomKey()">🎲 随机生成卡密</button>
      <input type="text" id="newName" placeholder="用户备注/姓名（如：张三）" value="尊贵用户" />
      <input type="date" id="newExpire" />
      <button class="btn btn-gen" onclick="setPermanent()" style="border-color:#34c759; color:#34c759;">♾️ 设置为永久有效</button>
      <button class="btn btn-add" onclick="doCreateKey()">生成并存入数据库</button>

      <div class="section-title">🔓 强制解绑旧卡密</div>
      <input type="text" id="targetKey" placeholder="需要强制解绑的卡密" />
      <button class="btn btn-unbind" onclick="doAdminUnbind()">强制解绑设备</button>

      <div id="msg"></div>
    </div>

    <script>
      // 默认设置到期时间为一年后
      const nextYear = new Date();
      nextYear.setFullYear(nextYear.getFullYear() + 1);
      document.getElementById("newExpire").value = nextYear.toISOString().split("T")[0];

      function showMsg(html, isSuccess) {
        const msgDiv = document.getElementById("msg");
        msgDiv.style.display = "block";
        msgDiv.style.color = isSuccess ? "#34c759" : "#ff3b30";
        msgDiv.innerHTML = html;
      }

      function genRandomKey() {
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let res = "VIP";
        for (let i = 0; i < 8; i++) {
          res += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        document.getElementById("newKey").value = res;
      }

      function setPermanent() {
        document.getElementById("newExpire").value = "2099-12-31";
      }

      async function doCreateKey() {
        const pwd = document.getElementById("adminPwd").value.trim();
        const key = document.getElementById("newKey").value.trim();
        const name = document.getElementById("newName").value.trim() || "尊贵用户";
        const expire = document.getElementById("newExpire").value;

        if (!pwd || !key || !expire) {
          showMsg("❌ 密码、卡密和到期时间不能为空", false);
          return;
        }

        try {
          const res = await fetch("/api/admin/create-key", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ adminPwd: pwd, key, name, expire })
          });
          const text = await res.text();
          showMsg(text, res.ok);
        } catch (e) {
          showMsg("❌ 网络请求失败", false);
        }
      }

      async function doAdminUnbind() {
        const pwd = document.getElementById("adminPwd").value.trim();
        const key = document.getElementById("targetKey").value.trim();

        if (!pwd || !key) {
          showMsg("❌ 密码和目标卡密不能为空", false);
          return;
        }

        try {
          const res = await fetch("/api/unbind?admin_pwd=" + encodeURIComponent(pwd) + "&key=" + encodeURIComponent(key));
          const text = await res.text();
          showMsg(text, res.ok);
        } catch (e) {
          showMsg("❌ 网络请求失败", false);
        }
      }
    </script>
  </body>
  </html>`;
  return c.html(html);
});

/* ---- 管理员 API：创建/新增卡密 ---- */
app.post("/api/admin/create-key", async (c) => {
  try {
    const body = await c.req.json();
    const { adminPwd, key, name, expire } = body;

    const correctAdminPwd = c.env?.ADMIN_PWD || "your_admin_secret";
    if (adminPwd !== correctAdminPwd) {
      return c.text("❌ 管理员密码错误", 403);
    }

    if (!key || !expire) {
      return c.text("❌ 卡密与到期时间不能为空", 400);
    }

    const KV = c.env?.CARD_KEYS || (typeof CARD_KEYS !== "undefined" ? CARD_KEYS : null);
    if (!KV) return c.text("❌ 未找到 KV 数据库绑定", 500);

    // 存入 KV 数据库，清空旧的设备绑定数据
    await KV.put(key, JSON.stringify({ name: name || "尊贵用户", expire: expire }));

    return c.text(`✅ 卡密创建成功！\n🔑 卡密: ${key}\n👤 用户: ${name}\n⏳ 有效期至: ${expire}`);
  } catch (e) {
    return c.text("❌ 解析请求参数失败", 400);
  }
});

/* ---- 管理员后台解绑 API ---- */
app.get("/api/unbind", async (c) => {
  const adminPwd = c.req.query("admin_pwd");
  const targetKey = c.req.query("key");

  const correctAdminPwd = c.env?.ADMIN_PWD || "your_admin_secret";

  if (adminPwd !== correctAdminPwd) {
    return c.text("❌ 管理员密码错误", 403);
  }
  if (!targetKey) {
    return c.text("❌ 请提供要解绑的卡密 ?key=xxx", 400);
  }

  const KV = c.env?.CARD_KEYS || (typeof CARD_KEYS !== "undefined" ? CARD_KEYS : null);
  const keyDataRaw = await KV.get(targetKey);

  if (!keyDataRaw) {
    return c.text("❌ 未找到该卡密", 404);
  }

  let expireDateStr = keyDataRaw;
  let userName = "尊贵用户";

  if (keyDataRaw.startsWith("{")) {
    try {
      const parsed = JSON.parse(keyDataRaw);
      expireDateStr = parsed.expire || expireDateStr;
      userName = parsed.name || userName;
    } catch (e) {}
  }

  await KV.put(targetKey, JSON.stringify({ name: userName, expire: expireDateStr }));
  return c.text(`✅ 用户 [${userName}] 的卡密 [${targetKey}] 设备解绑成功！当前有效至：${expireDateStr}`);
});

/* ---- API 鉴权 ---- */
app.get("/api/check-auth", (c) => {
  return c.json({ success: true, message: "验证通过" });
});

app.get("/", (c) => {
  c.header("Cache-Control", "no-cache");
  return c.html(getLandingHtml());
});

app.get("/picker", (c) => {
  c.header("Cache-Control", "no-cache");
  return c.html(getPageHtml());
});

/* ---- PWA: manifest + icons ---- */
const MANIFEST = {
  name: "iOS Location Spoofer",
  short_name: "iOSLoc",
  description: "Stateless map picker for iOS Location Spoofer (WGS-84 + altitude).",
  start_url: "/picker",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  background_color: "#f2f2f7",
  theme_color: "#007aff",
  icons: [
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    { src: "/icon-180.png", sizes: "180x180", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
};
const IMG_CACHE = "public, max-age=604800, immutable";
app.get("/manifest.webmanifest", (c) =>
  c.body(JSON.stringify(MANIFEST), 200, { "Content-Type": "application/manifest+json", "Cache-Control": IMG_CACHE })
);
app.get("/icon.svg", (c) => c.body(ICON_SVG, 200, { "Content-Type": "image/svg+xml", "Cache-Control": IMG_CACHE }));
app.get("/icon-180.png", (c) => c.body(b64ToBytes(ICON_180_B64), 200, { "Content-Type": "image/png", "Cache-Control": IMG_CACHE }));
app.get("/icon-512.png", (c) => c.body(b64ToBytes(ICON_512_B64), 200, { "Content-Type": "image/png", "Cache-Control": IMG_CACHE }));
app.get("/favicon.ico", (c) => c.body(ICON_SVG, 200, { "Content-Type": "image/svg+xml", "Cache-Control": IMG_CACHE }));

/* ---- Modules & Overrides ---- */
const JS_HEADERS = { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" };
app.get("/location-spoofer.js", (c) => c.body(b64ToBytes(LOCATION_SPOOFER_B64), 200, JS_HEADERS));
app.get("/wloc.js", (c) => c.body(b64ToBytes(LOCATION_SPOOFER_B64), 200, JS_HEADERS));
app.get("/dist/wloc.js", (c) => c.body(b64ToBytes(LOCATION_SPOOFER_B64), 200, JS_HEADERS));
app.get("/location-settings.js", (c) => c.body(b64ToBytes(LOCATION_SETTINGS_B64), 200, JS_HEADERS));
app.get("/wloc-settings.js", (c) => c.body(b64ToBytes(LOCATION_SETTINGS_B64), 200, JS_HEADERS));
app.get("/dist/wloc-settings.js", (c) => c.body(b64ToBytes(LOCATION_SETTINGS_B64), 200, JS_HEADERS));
app.get("/location-spoofer-qx.js", (c) => c.body(b64ToBytes(LOCATION_SPOOFER_QX_B64), 200, JS_HEADERS));

function sgmodule(origin) {
  return String.raw`#!name=Apple WLOC 定位修改
#!desc=修改 Apple 网络定位返回坐标 (Shadowrocket 小火箭) | 快捷指令(推荐): 设置地理位置 https://www.icloud.com/shortcuts/a82717d8fdad4e6280866fcf911173f7 清理恢复位置 https://www.icloud.com/shortcuts/f42632d406504f24a2cd163af4fe012f | 选点页面: ${origin}/
#!author=Yu9191 Rewrite
#!homepage=${origin}
#!icon=https://raw.githubusercontent.com/Yu9191/wloc/refs/heads/main/wloc.jpg
#!category=Tools

[Script]
Apple WLOC = type=http-response,pattern=^https?:\/\/(?:gs-loc(?:-cn)?\.apple\.com|gsp-ssl\.ls\.apple\.com|bluedot\.is\.autonavi\.com(?:\.gds\.alibabadns\.com)?)\/clls\/wloc,requires-body=1,binary-body-mode=1,max-size=0,timeout=30,script-path=${origin}/dist/wloc.js,argument=longitude=113.94114&latitude=22.544577&accuracy=25&randomRadius=0&logLevel=info
WLOC Settings = type=http-request,pattern=^https?:\/\/gs-loc(-cn)?\.apple\.com\/(?:wloc|ils)-settings\/save,requires-body=0,max-size=0,timeout=10,script-path=${origin}/dist/wloc-settings.js

[MITM]
hostname = %APPEND% gs-loc.apple.com, gs-loc-cn.apple.com, gsp-ssl.ls.apple.com, bluedot.is.autonavi.com, bluedot.is.autonavi.com.gds.alibabadns.com`;
}
function stoverride(origin) {
  return String.raw`name: iOS Location Spoofer (Stateless)
desc: "小紅書獨家ID 95975775001。iOS Location Spoofer 无状态版 (Stash)"
homepage: ${origin}

http:
  mitm:
    - "gs-loc.apple.com"
    - "gs-loc-cn.apple.com"
  script:
    - match: ^https?:\/\/gs-loc(-cn)?\.apple\.com\/clls\/wloc
      name: ios-location-spoofer
      type: response
      require-body: true
      binary-mode: true
      max-size: 0
      timeout: 30
      argument: mode=response&debug=false
    - match: ^https?:\/\/gs-loc(-cn)?\.apple\.com\/ils-settings\/
      name: ios-location-settings
      type: request
      require-body: false
      timeout: 10

script-providers:
  ios-location-spoofer:
    url: ${origin}/location-spoofer.js
    interval: 86400
  ios-location-settings:
    url: ${origin}/location-settings.js
    interval: 86400`;
}
function lnplugin(origin) {
  return String.raw`#!name=iOS Location Spoofer (Stateless)
#!desc=小紅書獨家ID 95975775001。无状态版，配合选点页使用。Loon 插件。
#!homepage=${origin}

[Script]
http-response ^https?:\/\/(?:gs-loc(?:-cn)?\.apple\.com|gsp-ssl\.ls\.apple\.com|bluedot\.is\.autonavi\.com(?:\.gds\.alibabadns\.com)?)\/clls\/wloc(?:\?.*)?$ script-path=${origin}/location-spoofer.js, requires-body=true, binary-body-mode=true, max-size=1048576, timeout=12, tag=iOS Location Spoofer, argument=mode=response&debug=false
http-request ^https?:\/\/gs-loc(?:-cn)?\.apple\.com\/ils-settings\/ script-path=${origin}/location-settings.js?v=20261105, requires-body=false, timeout=10, tag=iLS Settings

[MITM]
hostname = gs-loc.apple.com, gs-loc-cn.apple.com, bluedot.is.autonavi.com, bluedot.is.autonavi.com.gds.alibabadns.com`;
}

function qxsnippet(origin) {
  return String.raw`#!name=iOS Location Spoofer (Stateless)
#!desc=小紅書獨家ID 95975775001。无状态版。Quantumult X 用「重写(rewrite)引用」(非模块/插件)。MITM 主机名需手动加进 QX 设置 → MITM。
#!homepage=${origin}

[rewrite_local]
^https?:\/\/(?:gs-loc(?:-cn)?\.apple\.com|gsp-ssl\.ls\.apple\.com|bluedot\.is\.autonavi\.com(?:\.gds\.alibabadns\.com)?)\/clls\/wloc(?:\?.*)?$ url script-response-body ${origin}/location-spoofer-qx.js
^https?:\/\/gs-loc(?:-cn)?\.apple\.com\/ils-settings\/ url script-echo-response ${origin}/location-settings.js

[mitm]
hostname = gs-loc.apple.com, gs-loc-cn.apple.com, bluedot.is.autonavi.com, bluedot.is.autonavi.com.gds.alibabadns.com`;
}
const TXT = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" };
app.get("/ios-location-spoofer.sgmodule", (c) => c.body(sgmodule(new URL(c.req.url).origin), 200, TXT));
app.get("/ios-location-spoofer.stoverride", (c) => c.body(stoverride(new URL(c.req.url).origin), 200, TXT));
app.get("/ios-location-spoofer.lnplugin", (c) => c.body(lnplugin(new URL(c.req.url).origin), 200, TXT));
app.get("/ios-location-spoofer.snippet", (c) => c.body(qxsnippet(new URL(c.req.url).origin), 200, TXT));

// Map link parsing
app.get("/api/parse", async (c) => {
  const raw = c.req.query("u") || "";
  const cs = (c.req.query("cs") || "").toLowerCase();
  const fmt = (c.req.query("format") || "").toLowerCase();
  try {
    let { lat, lon, name, src } = await parseCoords(raw);
    if (cs === "none") {
      // leave coordinates untouched
    } else if (cs === "bd09" || cs === "baidu") {
      ({ lat, lon } = toWgs84(lat, lon, "baidu"));
    } else if (cs === "gcj") {
      ({ lat, lon } = gcj02ToWgs84(lat, lon));
    } else {
      ({ lat, lon } = toWgs84(lat, lon, src));
    }
    lat = round6(lat);
    lon = round6(lon);
    name = name || "";
    c.header("Access-Control-Allow-Origin", "*");
    if (fmt === "json") return c.json({ lat, lon, name });
    return c.text(`lat=${lat}&lon=${lon}`);
  } catch (e) {
    c.header("Access-Control-Allow-Origin", "*");
    return c.json({ error: String(e && e.message ? e.message : e) }, 422);
  }
});

/* ---- Telegram bot webhook ---- */
app.post("/tg", async (c) => {
  const secret = c.env && c.env.TG_WEBHOOK_SECRET;
  if (secret && c.req.header("X-Telegram-Bot-Api-Secret-Token") !== secret) {
    return c.text("forbidden", 403);
  }
  const token = c.env && c.env.TG_BOT_TOKEN;
  let update = null;
  try { update = await c.req.json(); } catch (e) {}
  const msg = update && (update.message || update.channel_post);
  const text = (msg && msg.text) || "";
  const chatId = msg && msg.chat && msg.chat.id;
  const cmd = text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
  if (token && chatId && (cmd === "/link" || cmd === "/links" || cmd === "/start")) {
    const origin = new URL(c.req.url).origin;
    const reply =
      "📍 iOS 虚拟定位 · 选点主页\n" + origin + "/\n\n" +
      "▶️ 视频教程：小紅書獨家ID 95975775001\n\n" +
      "⚠️ 小紅書獨家ID 95975775001。";
    await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: reply, disable_web_page_preview: false }),
    });
  }
  return c.text("ok", 200);
});

app.onError((e, c) => {
  console.error(`${e}`);
  return c.text(`${e}`, 500);
});

export default {
  async fetch(request, env, ctx) {
    const country = request && request.cf && request.cf.country;
    let pathname = "/";
    try { pathname = new URL(request.url).pathname; } catch (e) {}

    try {
      console.log("REQ " + JSON.stringify({
        country: country || "?",
        path: pathname,
        ref: request.headers.get("referer") || "",
        ua: (request.headers.get("user-agent") || "").slice(0, 90),
      }));
    } catch (e) {}
    
    return app.fetch(request, env, ctx);
  },
};