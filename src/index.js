import { Hono } from "hono";
import { serveStatic } from "hono/cloudflare-workers";
import { parseCoords, toWgs84, gcj02ToWgs84, round6 } from "./parse.js";
import { renderLanding } from "./landing.js"; // 恢复你原有的前端页面渲染模块

const app = new Hono();

// 全局全局跨域支持，确保 API 和错误信息均可顺利跨域返回
app.use("*", async (c, next) => {
  await next();
  c.header("Access-Control-Allow-Origin", "*");
});

// 1. 恢复根路径前端页面渲染，避免首页 500 崩溃
app.get("/", (c) => {
  try {
    if (typeof renderLanding === "function") {
      return renderLanding(c);
    }
  } catch (e) {}
  return c.text("API Service Running");
});

// 2. 地理位置解析 API (融合无损优化版)
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

// 3. 静态资源兜底 (容错处理，防止找不到资源时报错 500)
app.use("/*", async (c, next) => {
  try {
    return await serveStatic({ root: "./" })(c, next);
  } catch (e) {
    return c.text("Not Found", 404);
  }
});

export default app;
