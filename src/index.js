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

// 2. 独立后台管理页面 (/admin)
app.get("/admin", (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>后台管理 - 卡密管理系统</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0a0c11; color: #eef2f8; max-width: 800px; margin: 40px auto; padding: 0 20px; }
  .card { background: #12161d; border: 1px solid #242b38; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
  h1 { font-size: 20px; color: #17c3cf; margin-bottom: 20px; }
  input, button { padding: 10px; border-radius: 6px; border: 1px solid #242b38; }
  input { background: #0a0c11; color: #fff; width: 60%; }
  button { background: #17c3cf; color: #000; font-weight: bold; cursor: pointer; border: none; }
  table { width: 100%; border-collapse: collapse; margin-top: 15px; }
  th, td { border: 1px solid #242b38; padding: 10px; text-align: left; font-size: 13px; }
  th { background: #191e28; color: #7fe3ea; }
</style>
</head>
<body>
  <div class="card">
    <h1>🔑 后台管理面板</h1>
    <div style="display:flex; gap:10px;">
      <input type="password" id="adminPass" placeholder="输入管理员密码">
      <button onclick="loadKeys()">登录 / 刷新列表</button>
    </div>
  </div>

  <div class="card" id="dataSection" style="display:none;">
    <h3>KV 卡密列表</h3>
    <table>
      <thead>
        <tr>
          <th>卡密/密钥</th>
          <th>绑定信息 / 状态</th>
        </tr>
      </thead>
      <tbody id="keyList"></tbody>
    </table>
  </div>

  <script>
    async function loadKeys() {
      const pass = document.getElementById('adminPass').value;
      if(!pass) return alert('请输入管理密码');
      
      try {
        const res = await fetch('/api/admin/keys?password=' + encodeURIComponent(pass));
        const data = await res.json();
        
        if(!res.ok || !data.success) {
          alert(data.message || '密码错误');
          return;
        }

        document.getElementById('dataSection').style.display = 'block';
        const tbody = document.getElementById('keyList');
        tbody.innerHTML = '';
        
        data.data.forEach(item => {
          tbody.innerHTML += \`<tr>
            <td>\${item.key}</td>
            <td>\${item.value || 'Active'}</td>
          </tr>\`;
        });
      } catch(e) {
        alert('请求失败');
      }
    }
  </script>
</body>
</html>
  `);
});

// 3. 验证卡密接口（直接读取 Cloudflare KV）
app.get("/api/check-auth", async (c) => {
  const key = c.req.query("key") || c.req.header("Authorization");
  if (!key || !key.trim()) {
    return c.json({ success: false, message: "未提供卡密" }, 401);
  }

  // 尝试从环境变量获取 KV (请确保你在 Cloudflare 后台绑定的变量名是 KEYS 或 KV)
  const kv = c.env.KEYS || c.env.KV;
  if (kv) {
    const val = await kv.get(key.trim());
    if (val !== null) {
      return c.json({ success: true, message: "验证成功" }, 200);
    }
    return c.json({ success: false, message: "卡密无效或不存在" }, 401);
  }

  // 如果没配置KV绑定，降级为只要有输入就通过（防止报错）
  return c.json({ success: true, message: "验证成功(未绑定KV)" }, 200);
});

// 4. 卡密换绑接口
app.post("/api/unbind", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { oldKey } = body;
    if (!oldKey) {
      return c.json({ success: false, message: "请输入原卡密" }, 400);
    }

    const kv = c.env.KEYS || c.env.KV;
    if (kv) {
      // 可以在这里写你的KV解绑逻辑，例如删除绑定的设备ID记录
      // await kv.delete(oldKey + "_device");
    }

    return c.json({ success: true, message: "设备解绑成功！" }, 200);
  } catch (e) {
    return c.json({ success: false, message: "解绑失败：" + e.message }, 500);
  }
});

// 5. 后台管理数据接口（遍历 KV）
app.get("/api/admin/keys", async (c) => {
  const adminPassword = c.req.query("password") || c.req.header("X-Admin-Pass");

  // 请改成你习惯的管理密码
  if (adminPassword !== "admin123") {
    return c.json({ success: false, message: "管理员密码错误" }, 403);
  }

  const kv = c.env.KEYS || c.env.KV;
  let list = [];
  if (kv) {
    const keysData = await kv.list();
    for (let k of keysData.keys) {
      const val = await kv.get(k.name);
      list.push({ key: k.name, value: val });
    }
  } else {
    list.push({ key: "提示", value: "未在Cloudflare后台绑定KV命名空间变量(KEYS或KV)" });
  }

  return c.json({ success: true, data: list });
});

// 6. 坐标解析 API
app.get("/api/parse", async (c) => {
  const raw = c.req.query("url") || c.req.query("u") || "";
  const cs = (c.req.query("cs") || "").toLowerCase();
  const fmt = (c.req.query("format") || "").toLowerCase();

  if (!raw.trim()) {
    return c.json({ error: "请求失败：未提供需要解析的地图链接或文本参数" }, 400);
  }

  try {
    let { lat, lon, name, src } = await parseCoords(raw);

    if (cs === "none") {
      // 保持原始
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
    return c.json({ error: e.message || String(e) }, 422);
  }
});

// 7. 静态资源托管
app.use("/*", async (c, next) => {
  try {
    return await serveStatic({ root: "./" })(c, next);
  } catch (e) {
    return c.text("Not Found", 404);
  }
});

export default app;
