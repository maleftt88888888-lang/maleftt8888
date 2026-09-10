import { Hono } from "hono";
import { serveStatic } from "hono/cloudflare-workers";
import { parseCoords, toWgs84, gcj02ToWgs84, round6 } from "./parse.js";

const app = new Hono();

// 地理位置解析 API
app.get("/api/parse", async (c) => {
  // 统一允许跨域，防止前端无法捕获错误信息
  c.header("Access-Control-Allow-Origin", "*");

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

// 静态资源托管 (根据实际使用环境配置，例如 Cloudflare Pages / Workers)
app.use("/*", serveStatic({ root: "./" }));

export default app;
