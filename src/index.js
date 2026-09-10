import { Hono } from "hono";
import { serveStatic } from "hono/cloudflare-workers";
import { parseCoords, toWgs84, gcj02ToWgs84, round6 } from "./parse.js";
import { getLandingHtml } from "./landing.js";

const app = new Hono();

app.use("*", async (c, next) => {
  await next();
  c.header("Access-Control-Allow-Origin", "*");
});

// 1. 首页 UI
app.get("/", (c) => {
  try {
    return c.html(getLandingHtml());
  } catch (e) {
    return c.text("UI Render Error: " + e.message, 500);
  }
});

// 2. 验证卡密 / 权限接口
app.get("/api/check-auth", (c) => {
  const key = c.req.query("key") || c.req.header("Authorization");
  
  if (key && key.trim().length > 0) {
    return c.json({ success: true, message: "验证成功" }, 200);
  }
  return c.json({ success: false, message: "卡密已过期或失效" }, 401);
});

// 3. 卡密换绑 API
app.post("/api/unbind", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { oldKey, newDevice } = body;

    if (!oldKey) {
      return c.json({ success: false, message: "请输入原卡密" }, 400);
    }

    // 换绑业务逻辑（如接入 KV，可在此处解绑旧设备 ID）
    return c.json({ success: true, message: "设备换绑成功！请重新登录" }, 200);
  } catch (e) {
    return c.json({ success: false, message: "换绑失败：" + e.message }, 500);
  }
});

// 4. 后台管理 API (生成卡密/查看列表等)
app.get("/api/admin/keys", (c) => {
  const adminPassword = c.req.query("password") || c.req.header("X-Admin-Pass");

  // 默认后台密码可自行修改
  if (adminPassword !== "admin123") {
    return c.json({ success: false, message: "管理员密码错误" }, 403);
  }

  return c.json({
    success: true,
    data: [
      { key: "DEMO-KEY-8888", status: "Active", expire: "2026-12-31" }
    ]
  });
});

// 5. 坐标解析 API
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

// 6. 静态资源托管
app.use("/*", async (c, next) => {
  try {
    return await serveStatic({ root: "./" })(c, next);
  } catch (e) {
    return c.text("Not Found", 404);
  }
});

export default app;
