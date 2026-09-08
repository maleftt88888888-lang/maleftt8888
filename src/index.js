import { Hono } from "hono/tiny";
import { getPageHtml } from "./page.js";
import { getLandingHtml } from "./landing.js";
import { parseCoords, toWgs84, gcj02ToWgs84, round6 } from "./parse.js";
import { ICON_180_B64, ICON_512_B64, ICON_SVG, b64ToBytes } from "./icons.js";
import { LOCATION_SPOOFER_B64, LOCATION_SETTINGS_B64, LOCATION_SPOOFER_QX_B64 } from "./modules.js";

const app = new Hono();

// 常量定义
const JS_HEADERS = { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" };
const TXT_HEADERS = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" };
const IMG_CACHE = "public, max-age=604800, immutable";
const DEFAULT_USER_NAME = "尊贵用户";

/* ---- 辅助函数：安全获取 KV ---- */
const getKV = (c) => c.env?.CARD_KEYS || (typeof CARD_KEYS !== "undefined" ? CARD_KEYS : null);

/* ---- 辅助函数：解析 KV 数据 ---- */
function parseKeyData(raw) {
  let expire = raw;
  let deviceId = null;
  let name = DEFAULT_USER_NAME;

  if (raw && raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      expire = parsed.expire || expire;
      deviceId = parsed.deviceId || null;
      name = parsed.name || name;
    } catch (e) {
      console.error("解析 KV 数据失败:", e);
    }
  }
  return { expire, deviceId, name };
}

/* ---- 静态资源后缀与路径白名单校验 ---- */
function isStaticOrPublicAsset(pathname) {
  const staticExtensions = [".png", ".svg", ".ico", ".webmanifest", ".js", ".sgmodule", ".stoverride", ".lnplugin", ".snippet"];
  const publicPrefixes = ["/unbind", "/admin", "/api/", "/tg"];

  return (
    staticExtensions.some((ext) => pathname.endsWith(ext)) ||
    publicPrefixes.some((prefix) => pathname.startsWith(prefix))
  );
}

/* ---- 1. 全局身份与卡密拦截中间件 ---- */
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (isStaticOrPublicAsset(url.pathname)) {
    return await next();
  }

  // 获取卡密 (Query -> Cookie)
  let userKey = c.req.query("key") || c.req.query("token") || c.req.query("pwd") || "";
  const cookieHeader = c.req.header("Cookie") || "";
  const cookies = Object.fromEntries(
    cookieHeader.split(";").map((item) => {
      const [k, ...v] = item.trim().split("=");
      return [k, (v || []).join("=")];
    })
  );

  if (!userKey && cookies.card_key) {
    userKey = cookies.card_key;
  }

  // 未输入卡密 -> 显示登录页
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

  const KV = getKV(c);
  if (!KV) return c.text("错误：未能在环境变量中绑定 CARD_KEYS KV 数据库！", 500);

  const keyDataRaw = await KV.get(userKey);
  if (!keyDataRaw) {
    return c.html("<h2 style='color:red;text-align:center;margin-top:20%'>❌ 错误：卡密无效或不存在！</h2>", 403);
  }

  const { expire: expireDateStr, deviceId: boundDeviceId, name: userName } = parseKeyData(keyDataRaw);

  const formattedExpireStr = expireDateStr.replace(/-(\d)(?=-|$)/g, "-0$1");
  const expireTime = new Date(`${formattedExpireStr}T23:59:59+08:00`).getTime();

  if (isNaN(expireTime) || Date.now() > expireTime) {
    c.header("Set-Cookie", "card_key=; Path=/; Max-Age=0", { append: true });
    return c.html(`<h2 style='color:red;text-align:center;margin-top:20%'>⏰ 用户 [${userName}] 的卡密已于 ${expireDateStr} 到期。</h2>`, 403);
  }

  const currentDeviceId = cookies.device_id || crypto.randomUUID();
  if (!boundDeviceId) {
    await KV.put(userKey, JSON.stringify({ name: userName, expire: expireDateStr, deviceId: currentDeviceId }));
  } else if (boundDeviceId !== currentDeviceId) {
    return c.html(`<div style='text-align:center;margin-top:20%;color:#fff;font-family:sans-serif;'>
      <h2 style='color:orange;'>⚠️ 该卡密已被其他设备绑定！</h2>
      <p>如果您更换了设备，请前往解绑页面：</p>
      <a href="/unbind" style="color:#007aff;">👉 点击进入自助解绑页面</a>
    </div>`, 403);
  }

  c.header("Set-Cookie", `card_key=${userKey}; Path=/; Max-Age=2592000`, { append: true });
  c.header("Set-Cookie", `device_id=${currentDeviceId}; Path=/; Max-Age=2592000; HttpOnly`, { append: true });
  c.header("Set-Cookie", `expire_date=${expireDateStr}; Path=/; Max-Age=2592000`, { append: true });

  await next();

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
    c.res = new Response(originalBody.replace("</body>", `${floatingBadge}</body>`), c.res);
  }
});

/* ---- 2. 解绑与管理 API ---- */
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
            setTimeout(() => { window.location.href = "/?key=" + encodeURIComponent(key); }, 3000);
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

app.get("/api/user-unbind", async (c) => {
  const targetKey = c.req.query("key");
  if (!targetKey) return c.text("❌ 请输入卡密", 400);

  const KV = getKV(c);
  if (!KV) return c.text("❌ 未找到 KV 数据库绑定", 500);

  const keyDataRaw = await KV.get(targetKey);
  if (!keyDataRaw) return c.text("❌ 卡密不存在或已被删除", 404);

  const { expire: expireDateStr, name: userName } = parseKeyData(keyDataRaw);

  await KV.put(targetKey, JSON.stringify({ name: userName, expire: expireDateStr }));
  return c.text(`✅ 用户 [${userName}] 的设备解绑成功！现在可以在新设备上登录了。`);
});

/* ---- 3. 页面路由与跨域 API ---- */
app.get("/", (c) => {
  c.header("Cache-Control", "no-cache");
  return c.html(getLandingHtml());
});

app.get("/picker", (c) => {
  c.header("Cache-Control", "no-cache");
  return c.html(getPageHtml());
});

// 地图坐标解析 API (支持直连跨域)
app.get("/api/parse", async (c) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, OPTIONS");

  const raw = c.req.query("u") || "";
  const cs = (c.req.query("cs") || "").toLowerCase();
  const fmt = (c.req.query("format") || "").toLowerCase();

  try {
    let { lat, lon, name, src } = await parseCoords(raw);

    if (cs !== "none") {
      if (cs === "bd09" || cs === "baidu") {
        ({ lat, lon } = toWgs84(lat, lon, "baidu"));
      } else if (cs === "gcj") {
        ({ lat, lon } = gcj02ToWgs84(lat, lon));
      } else {
        ({ lat, lon } = toWgs84(lat, lon, src));
      }
    }

    lat = round6(lat);
    lon = round6(lon);
    name = name || "";

    if (fmt === "json") return c.json({ lat, lon, name });
    return c.text(`lat=${lat}&lon=${lon}`);
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 422);
  }
});

// PWA 与 配置文件路由
const MANIFEST = {
  name: "iOS Location Spoofer",
  short_name: "iOSLoc",
  start_url: "/picker",
  display: "standalone",
  theme_color: "#007aff"
};

app.get("/manifest.webmanifest", (c) => c.body(JSON.stringify(MANIFEST), 200, { "Content-Type": "application/manifest+json", "Cache-Control": IMG_CACHE }));
app.get("/icon.svg", (c) => c.body(ICON_SVG, 200, { "Content-Type": "image/svg+xml", "Cache-Control": IMG_CACHE }));
app.get("/icon-180.png", (c) => c.body(b64ToBytes(ICON_180_B64), 200, { "Content-Type": "image/png", "Cache-Control": IMG_CACHE }));
app.get("/icon-512.png", (c) => c.body(b64ToBytes(ICON_512_B64), 200, { "Content-Type": "image/png", "Cache-Control": IMG_CACHE }));
app.get("/favicon.ico", (c) => c.body(ICON_SVG, 200, { "Content-Type": "image/svg+xml", "Cache-Control": IMG_CACHE }));

app.get("/location-spoofer.js", (c) => c.body(b64ToBytes(LOCATION_SPOOFER_B64), 200, JS_HEADERS));
app.get("/location-settings.js", (c) => c.body(b64ToBytes(LOCATION_SETTINGS_B64), 200, JS_HEADERS));
app.get("/location-spoofer-qx.js", (c) => c.body(b64ToBytes(LOCATION_SPOOFER_QX_B64), 200, JS_HEADERS));

/* ---- 4. 代理脚本生成配置 ---- */
const generateConfigs = {
  sgmodule: (origin) => String.raw`#!name=iOS Location Spoofer (Stateless)
#!desc=iOS Location Spoofer 无状态版
#!homepage=${origin}

[Script]
iOS Location Spoofer = type=http-response,pattern=^https?:\/\/(?:gs-loc(?:-cn)?\.apple\.com|bluedot\.is\.autonavi\.com(?:\.gds\.alibabadns\.com)?)\/clls\/wloc(?:\?.*)?$,requires-body=1,binary-body-mode=1,max-size=1048576,timeout=10,script-path=${origin}/location-spoofer.js,argument=mode=response&debug=false
iLS Settings = type=http-request,pattern=^https?:\/\/gs-loc(?:-cn)?\.apple\.com\/ils-settings\/,requires-body=0,max-size=0,timeout=10,script-path=${origin}/location-settings.js

[MITM]
hostname = %APPEND% gs-loc.apple.com, gs-loc-cn.apple.com, bluedot.is.autonavi.com, bluedot.is.autonavi.com.gds.alibabadns.com`
};

app.get("/ios-location-spoofer.sgmodule", (c) => c.body(generateConfigs.sgmodule(new URL(c.req.url).origin), 200, TXT_HEADERS));

app.onError((e, c) => {
  console.error(`Uncaught Error: ${e}`);
  return c.text(`${e}`, 500);
});

export default {
  async fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  }
};
