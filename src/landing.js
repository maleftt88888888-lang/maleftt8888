import { Hono } from "hono";
import { serveStatic } from "hono/cloudflare-workers";
import { parseCoords, toWgs84, gcj02ToWgs84, round6 } from "./parse.js";
import { getLandingHtml } from "./landing.js"; // 对应你的 landing.js 真实导出名称

const app = new Hono();

// 全局跨域支持，确保错误和 API 响应都能顺畅跨域
app.use("*", async (c, next) => {
  await next();
  c.header("Access-Control-Allow-Origin", "*");
});

// 1. 首页 (/) 返回你的原有前端网页
app.get("/", (c) => {
  try {
    return c.html(getLandingHtml());
  } catch (e) {
    return c.text("UI Render Error: " + e.message, 500);
  }
});

// 2. 坐标解析 API (含防错与兼容优化)
app.get("/api/parse", async (c) => {
  // 同时兼容 url 与 u 参数
  const raw = c.req.query("url") || c.req.query("u") || "";
  const cs = (c.req.query("cs") || "").toLowerCase();
  const fmt = (c.req.query("format") || "").toLowerCase();

  if (!raw.trim()) {
    return c.json({ error: "请求失败：未提供需要解析的地图链接或文本参数 (url 或 u)" }, 400);
  }

  try {
    let { lat, lon, name, src } = await parseCoords(raw);

    // 坐标系转换逻辑
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

// 3. 静态资源托管 (容错处理)
app.use("/*", async (c, next) => {
  try {
    return await serveStatic({ root: "./" })(c, next);
  } catch (e) {
    return c.text("Not Found", 404);
  }
});

export default app;
