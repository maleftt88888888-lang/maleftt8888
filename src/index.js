import { Hono } from "hono";
import { serveStatic } from "hono/cloudflare-workers";
import { parseCoords, toWgs84, gcj02ToWgs84, round6 } from "./parse.js";
import landingModule from "./landing.js"; // 兼容默认导出与命名导出

const app = new Hono();

// 全局跨域支持
app.use("*", async (c, next) => {
  await next();
  c.header("Access-Control-Allow-Origin", "*");
});

// 1. 根路径前端页面渲染 (兼容各种 landing.js 导出格式)
app.get("/", (c) => {
  try {
    // 情况 1: landing.js 导出了 renderLanding 函数
    if (landingModule && typeof landingModule.renderLanding === "function") {
      return landingModule.renderLanding(c);
    }
    // 情况 2: landing.js 直接 export default 一个处理函数
    if (typeof landingModule === "function") {
      return landingModule(c);
    }
    // 情况 3: landing.js 导出了 HTML 字符串或 HTML 响应
    if (landingModule) {
      return typeof landingModule === "string" ? c.html(landingModule) : landingModule;
    }
  } catch (e) {}
  return c.text("API Service Running");
});

// 2. 地理位置解析 API
app.get("/api/parse", async (c) => {
  const raw = c.req.query("url") || c.req.query("u") || "";
  const cs = (c.req.query("cs") || "").toLowerCase();
  const fmt = (c.req.query("format") || "").toLowerCase();

  if (!raw.trim()) {
    return c.json({ error: "请求失败：未提供需要解析的地图链接或文本参数 (url 或 u)" }, 400);
  }

  try {
    let { lat, lon, name, src } = await parseCoords(raw);

    if (cs === "none") {
      // 保持原始坐标系
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

    if (fmt === "json") {
      return c.json({ lat, lon, name });
    }
    return c.text(`lat=${lat}&lon=${lon}`);
  } catch (e) {
    const errorMsg = e && e.message ? e.message : String(e);
    return c.json({ error: errorMsg }, 422);
  }
});

// 3. 静态资源托管
app.use("/*", async (c, next) => {
  try {
    return await serveStatic({ root: "./" })(c, next);
  } catch (e) {
    return c.text("Not Found", 404);
  }
});

export default app;
