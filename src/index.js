import { Hono } from "hono/tiny";
import { getPageHtml } from "./page.js";
import { getLandingHtml } from "./landing.js";
import { parseCoords, toWgs84, gcj02ToWgs84, round6 } from "./parse.js";
import { ICON_180_B64, ICON_512_B64, ICON_SVG, b64ToBytes } from "./icons.js";
import { LOCATION_SPOOFER_B64, LOCATION_SETTINGS_B64, LOCATION_SPOOFER_QX_B64 } from "./modules.js";

const app = new Hono();

/* ---- 全局卡密 & 到期时间 & 单设备绑定拦截中间件 ---- */
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  const pathname = url.pathname;

  // 放行静态资源/配置文件请求，防止资源加载失败
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
    pathname === "/tg";

  if (isStaticAsset) {
    return await next();
  }

  // 1. 获取卡密（优先取 URL 参数 ?key=xxx，其次取 Cookie）
  let userKey = c.req.query("key") || c.req.query("token") || c.req.query("pwd") || "";
  const cookieHeader = c.req.header("Cookie") || "";
  const cookies = Object.fromEntries(
    cookieHeader.split(";").map(item => {
      const [k, ...v] = item.trim().split("=");
      return [k, v.join("=")];
    })
  );

  if (!userKey && cookies.card_key) {
    userKey = cookies.card_key;
  }

  // 2. 未输入卡密 -> 显示卡密登录页面
  if (!userKey) {
    const loginHtml = `<!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>访问验证</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0b0b0f; color: #fff; }
        .card { background: #1c1c24; padding: 32px; border-radius: 16px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); text-align: center; width: 320px; box-sizing: border-box; }
        h3 { margin-top: 0; color: #f2f2f7; font-size: 20px; }
        p { color: #8e8e93; font-size: 13px; margin-bottom: 20px; }
        input { width: 100%; box-sizing: border-box; padding: 12px; margin-bottom: 16px; border: 1px solid #2c2c3e; background: #0b0b0f; color: #fff; border-radius: 8px; outline: none; font-size: 14px; text-align: center; }
        button { width: 100%; padding: 12px; background: #007aff; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 15px; font-weight: 600; }
        button:hover { background: #0062cc; }
      </style>
    </head>
    <body>
      <div class="card">
        <h3>🔑 请输入卡密</h3>
        <p>请输入有效卡密以继续使用服务</p>
        <form method="GET">
          <input type="text" name="key" placeholder="请输入卡密" required />
          <button type="submit">验证并进入</button>
        </form>
      </div>
    </body>
    </html>`;
    return c.html(loginHtml, 401);
  }

  // 获取 KV 数据库对象
  const KV = c.env?.CARD_KEYS || (typeof CARD_KEYS !== "undefined" ? CARD_KEYS : null);
  if (!KV) {
    return c.text("错误：未能在环境变量中绑定 CARD_KEYS KV 数据库！", 500);
  }

  // 3. 从 KV 校验卡密
  const keyDataRaw = await KV.get(userKey);
  if (!keyDataRaw) {
    return c.html("<h2 style='color:red;text-align:center;margin-top:20%'>❌ 错误：卡密无效或不存在！</h2>", 403);
  }

  let expireDateStr = keyDataRaw;
  let boundDeviceId = null;

  if (keyDataRaw.startsWith("{")) {
    try {
      const parsed = JSON.parse(keyDataRaw);
      expireDateStr = parsed.expire;
      boundDeviceId = parsed.deviceId;
    } catch (e) {}
  }

  // 4. 到期时间校验
  const expireTime = new Date(expireDateStr + 'T23:59:59Z').getTime();
  if (Date.now() > expireTime) {
    return c.html(`<h2 style='color:red;text-align:center;margin-top:20%'>⏰ 您的卡密已于 ${expireDateStr} 到期，请联系管理员续费。</h2>`, 403);
  }

  // 5. 设备绑定校验 (一卡一人)
  let currentDeviceId = cookies.device_id || crypto.randomUUID();
  if (!boundDeviceId) {
    await KV.put(userKey, JSON.stringify({ expire: expireDateStr, deviceId: currentDeviceId }));
  } else if (boundDeviceId !== currentDeviceId) {
    return c.html("<h2 style='color:orange;text-align:center;margin-top:20%'>⚠️ 提示：该卡密已被其他设备绑定，无法在第二台设备上使用！</h2>", 403);
  }

  // 6. 验证通过：写入持久化 Cookie
  c.header("Set-Cookie", `card_key=${userKey}; Path=/; Max-Age=2592000`, { append: true });
  c.header("Set-Cookie", `device_id=${currentDeviceId}; Path=/; Max-Age=2592000; HttpOnly`, { append: true });
  c.header("Set-Cookie", `expire_date=${expireDateStr}; Path=/; Max-Age=2592000`, { append: true });

  await next();

  // 7. 注入全局浮窗（年份 >= 2099 显示永久有效）
  const contentType = c.res.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    const originalBody = await c.res.text();
    const isPermanent = parseInt(expireDateStr.split("-")[0], 10) >= 2099;
    const displayText = isPermanent ? "永久有效" : expireDateStr;

    const floatingBadge = `
      <div id="expire-badge" style="position: fixed; bottom: 12px; right: 12px; z-index: 999999; background: rgba(28,28,36,0.85); backdrop-filter: blur(8px); color: #8e8e93; font-size: 11px; padding: 6px 12px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.1); font-family: -apple-system, sans-serif; pointer-events: none; opacity: 0.85;">
        ⏳ 服务有效期：<span style="color: #34c759; font-weight: 600;">${displayText}</span>
      </div>
    `;
    const newBody = originalBody.replace("</body>", `${floatingBadge}</body>`);
    c.res = new Response(newBody, c.res);
  }
});

/* ---- 方案 B 所需：卡密鉴权 API ---- */
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
const JS_HEADERS = { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" };
app.get("/location-spoofer.js", (c) => c.body(b64ToBytes(LOCATION_SPOOFER_B64), 200, JS_HEADERS));
app.get("/location-settings.js", (c) => c.body(b64ToBytes(LOCATION_SETTINGS_B64), 200, JS_HEADERS));
app.get("/location-spoofer-qx.js", (c) => c.body(b64ToBytes(LOCATION_SPOOFER_QX_B64), 200, JS_HEADERS));

function sgmodule(origin) {
  return String.raw`#!name=iOS Location Spoofer (Stateless)
#!desc=小紅書獨家ID 95975775001。无状态版：坐标写入每台设备各自的本机存储、可公开共用、多人互不覆盖。搭配选点页使用。适用于 Shadowrocket / Surge / Egern。
#!homepage=${origin}

[Script]
iOS Location Spoofer = type=http-response,pattern=^https?:\/\/(?:gs-loc(?:-cn)?\.apple\.com|bluedot\.is\.autonavi\.com(?:\.gds\.alibabadns\.com)?)\/clls\/wloc(?:\?.*)?$,requires-body=1,binary-body-mode=1,max-size=1048576,timeout=10,script-path=${origin}/location-spoofer.js,argument=mode=response&debug=false
iLS Settings = type=http-request,pattern=^https?:\/\/gs-loc(?:-cn)?\.apple\.com\/ils-settings\/,requires-body=0,max-size=0,timeout=10,script-path=${origin}/location-settings.js

[MITM]
hostname = %APPEND% gs-loc.apple.com, gs-loc-cn.apple.com, bluedot.is.autonavi.com, bluedot.is.autonavi.com.gds.alibabadns.com`;
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
http-response ^https?:\/\/(?:gs-loc(?:-cn)?\.apple\.com|bluedot\.is\.autonavi\.com(?:\.gds\.alibabadns\.com)?)\/clls\/wloc(?:\?.*)?$ script-path=${origin}/location-spoofer.js, requires-body=true, binary-body-mode=true, max-size=1048576, timeout=12, tag=iOS Location Spoofer, argument=mode=response&debug=false
http-request ^https?:\/\/gs-loc(?:-cn)?\.apple\.com\/ils-settings\/ script-path=${origin}/location-settings.js, requires-body=false, timeout=10, tag=iLS Settings

[MITM]
hostname = gs-loc.apple.com, gs-loc-cn.apple.com, bluedot.is.autonavi.com, bluedot.is.autonavi.com.gds.alibabadns.com`;
}

function qxsnippet(origin) {
  return String.raw`#!name=iOS Location Spoofer (Stateless)
#!desc=小紅書獨家ID 95975775001。无状态版。Quantumult X 用「重写(rewrite)引用」(非模块/插件)。MITM 主机名需手动加进 QX 设置 → MITM。
#!homepage=${origin}

[rewrite_local]
^https?:\/\/(?:gs-loc(?:-cn)?\.apple\.com|bluedot\.is\.autonavi\.com(?:\.gds\.alibabadns\.com)?)\/clls\/wloc(?:\?.*)?$ url script-response-body ${origin}/location-spoofer-qx.js
^https?:\/\/gs-loc(?:-cn)?\.apple\.com\/ils-settings\/ url script-echo-response ${origin}/location-settings.js

[mitm]
hostname = gs-loc.apple.com, gs-loc-cn.apple.com, bluedot.is.autonavi.com, bluedot.is.autonavi.com.gds.alibabadns.com`;
}
const TXT = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" };
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
