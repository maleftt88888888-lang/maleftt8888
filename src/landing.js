export function getLandingHtml() {
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
  font-family:-apple-system,BlinkMacSystemFont,system-ui,"SF Pro","Helvetica Neue",sans-serif;
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
.wrap{ 
  position:relative; z-index:1; max-width:600px; margin:0 auto; 
  padding:20px 16px calc(44px + constant(safe-area-inset-bottom));
  padding:20px 16px calc(44px + env(safe-area-inset-bottom)); 
}

/* Header / Banner */
header{ text-align:center; padding:12px 0 8px; }
header .logowrap{ position:relative; width:74px; margin:0 auto 14px; }
header .logo{ width:74px; height:74px; border-radius:20px; display:block; box-shadow:0 0 0 1px var(--line),0 10px 30px rgba(23,195,207,.28); }
h1{ font-size:22px; font-weight:800; letter-spacing:.3px; background:linear-gradient(92deg,#eafcff,#7fe3ea 55%,#22c55e); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
.synced{ font-size:12px; color:#22c55e; font-weight:700; margin-top:8px; }

/* 授权卡密面板（结合V2高质感卡片样式） */
.auth-box{
  background: linear-gradient(135deg, rgba(25,30,40,0.8), rgba(18,22,29,0.95));
  border: 1px solid rgba(23,195,207,0.25);
  border-radius: 14px;
  padding: 14px 16px;
  margin: 16px 0 12px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.25);
  backdrop-filter: blur(8px);
}
.auth-title{ font-size:13.5px; font-weight:700; color:var(--mono); margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; }
.auth-input-group{ display:flex; gap:8px; }
.auth-input{ flex:1; background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:10px 12px; color:var(--txt); font-size:13.5px; outline:none; font-family:"SF Mono",ui-monospace,monospace; }
.auth-input:focus{ border-color:var(--cyan); }
.auth-btn{ padding:10px 16px; border:none; border-radius:10px; background:linear-gradient(135deg,var(--cyan),var(--cyan2)); color:#022a2d; font-weight:800; cursor:pointer; }
.auth-sub-btn{ background:rgba(23,195,207,0.1); border:1px solid rgba(23,195,207,0.25); color:var(--cyan); font-size:12px; padding:6px 10px; border-radius:8px; cursor:pointer; font-weight:600; transition:all .15s; }
.auth-sub-btn:active{ transform:scale(.95); }

/* 主操作按钮 */
.ctas{ display:flex; gap:10px; margin:12px 0; }
.enter{ flex:1; display:flex; align-items:center; justify-content:center; gap:8px; padding:17px 14px; border:none; border-radius:14px; font-size:16px; font-weight:800; cursor:pointer; text-decoration:none; transition:transform .12s,box-shadow .12s; }
.enter:active{ transform:scale(.97); }
.enter.go{ background:linear-gradient(135deg,#2ee06a,#129a44); color:#04240f; box-shadow:0 10px 26px rgba(34,197,94,.34); }

/* V2 风格微信联系卡片 */
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

/* 标题与说明框 */
h2{ font-size:16px; font-weight:800; margin-bottom:4px; display:flex; align-items:center; gap:9px; }
h2::before{ content:""; width:4px; height:16px; border-radius:2px; background:linear-gradient(180deg,var(--cyan),var(--green)); }
.sub{ font-size:12.5px; color:var(--muted); margin:0 0 14px 13px; }
.note{ 
  background:var(--card); 
  border:1px solid var(--line); 
  border-radius:14px; 
  padding:14px 16px; 
  font-size:12.5px; 
  color:#c3ccdb; 
  line-height:1.6;
  margin-bottom:16px; 
  box-shadow:0 4px 12px rgba(0,0,0,0.15);
}

/* 平台导入卡片 */
.plat{ background:var(--card); border:1px solid var(--line); border-radius:14px; padding:12px; margin-bottom:12px; }
.plat .big{ display:flex; align-items:center; justify-content:center; gap:8px; width:100%; padding:14px; border:none; border-radius:11px; background:linear-gradient(135deg,var(--cyan),var(--cyan2)); color:#022a2d; font-size:15.5px; font-weight:800; cursor:pointer; text-align:center; transition:filter .12s,transform .12s; }
.plat .big:active{ filter:brightness(1.1); transform:scale(.98); }
.plat .line{ display:flex; align-items:center; gap:8px; margin-top:9px; }
.plat .url{ flex:1; min-width:0; font-family:"SF Mono",ui-monospace,monospace; font-size:11px; color:var(--muted); background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:8px 10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.plat .copy{ flex:none; padding:8px 15px; border:1px solid var(--line); border-radius:8px; background:var(--card2); color:var(--txt); font-size:12.5px; font-weight:600; cursor:pointer; transition:all .12s; }
.plat .copy:active{ background:#2a3140; }
.plat .copy.ok{ background:var(--green); border-color:var(--green); color:#04240f; }

/* MITM 主机名展示 */
.mitm{ background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; font-size:12.5px; color:#c3ccdb; margin-top:16px; }
.mitm code{ display:inline-block; font-family:"SF Mono",ui-monospace,monospace; font-size:11.5px; color:var(--mono); word-break:break-all; line-height:2; }
.mitm .hosts{ margin-top:8px; padding:10px 12px; background:var(--bg); border:1px solid var(--line); border-radius:9px; }

.toast{ position:fixed; left:50%; bottom:40px; transform:translateX(-50%) translateY(20px); background:rgba(8,10,14,.92); color:#fff; padding:11px 20px; border-radius:22px; font-size:14px; opacity:0; transition:all .25s; pointer-events:none; z-index:99; border:1px solid var(--line); }
.toast.show{ opacity:1; transform:translateX(-50%) translateY(0); }

footer{ text-align:center; font-size:11.5px; color:var(--muted); margin-top:26px; line-height:1.9; }
footer a{ color:var(--muted); text-decoration:none; }
footer a:hover{ color:var(--cyan); }
</style>
</head>
<body>
<div class="watermark"></div>
<div class="wrap">
  <header>
    <div class="logowrap"><img class="logo" src="/icon.svg" alt="logo"></div>
    <h1>小红书ID 95975775001 大陆微信号LLME-love ·可乐加糖 虚拟定位</h1>
    <p class="synced">✅ 已同步上游：随机扰动半径 · 港澳台/百度坐标解析</p>
  </header>

  <!-- 卡密激活与换绑 (V1功能) -->
  <div class="auth-box">
    <div class="auth-title">
      <span>🔑 授权卡密状态</span>
      <button class="auth-sub-btn" onclick="handleUnbind()">设备解绑/换绑</button>
    </div>
    <div class="auth-input-group">
      <input type="text" id="licenseKey" class="auth-input" placeholder="请输入授权卡密">
      <button type="button" class="auth-btn" onclick="saveKey()">保存</button>
    </div>
  </div>

  <!-- 主入口 (V1鉴权跳转) -->
  <div class="ctas">
    <button type="button" class="enter go" onclick="handleEnterPicker()">🗺️ 进入选点网页</button>
  </div>

  <!-- 微信联系卡片 (复制V2) -->
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
  <p class="sub">点击「一键导入」直接安装到 Shadowrocket；或点击「复制」手动添加模块。</p>
  <div class="note">📍 支持iOS 26+ 切换后可能需重启一次设备清缓存。生效前提：代理 App 已开启并连接、开启 HTTPS 解密 (MITM) 并信任证书。</div>

  <div id="plats">
    <div class="plat">
      <button class="big" type="button" onclick="openShadowrocket()">一键导入 Shadowrocket</button>
      <div class="line">
        <span class="url" id="url-sr"></span>
        <button class="copy" onclick="doCopy('ios-location-spoofer.sgmodule', this, '已复制模块链接')">复制</button>
      </div>
    </div>
  </div>

  <!-- MITM 证书信息 (V1保留) -->
  <div class="mitm">
    <b>MITM 主机名：</b>
    <div class="hosts"><code>gs-loc.apple.com<br>gs-loc-cn.apple.com<br>bluedot.is.autonavi.com<br>bluedot.is.autonavi.com.gds.alibabadns.com<br>gps-ssl.ls.apple.com</code></div>
  </div>

  <footer>
    <a href="javascript:void(0)" onclick="openAdmin()">后台管理系统</a><br>
    坐标只存在你<b>当前设备</b>上，服务端不留存记录。<br>
    GNU AGPL-3.0 · 仅供学习研究
  </footer>
</div>

<div class="toast" id="toast"></div>

<script>
// --- V1 完整业务逻辑代码 ---
function saveKey() {
  var key = document.getElementById('licenseKey').value.trim();
  if(!key) return toast("请输入有效卡密");
  localStorage.setItem('auth_key', key);
  toast("卡密保存成功");
}

function handleUnbind() {
  var key = localStorage.getItem('auth_key') || document.getElementById('licenseKey').value.trim();
  if(!key) return toast("请先输入原卡密");
  
  if(confirm("确定要解绑当前设备吗？")) {
    fetch('/api/unbind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldKey: key })
    })
    .then(res => res.json())
    .then(data => {
      toast(data.message || "解绑完成");
      if(data.success) {
        localStorage.removeItem('auth_key');
        document.getElementById('licenseKey').value = '';
      }
    })
    .catch(() => toast("解绑请求失败"));
  }
}

function openAdmin() {
  var pass = prompt("请输入后台管理密码：");
  if(!pass) return;
  fetch('/api/admin/keys?password=' + encodeURIComponent(pass))
    .then(res => res.json())
    .then(data => {
      if(data.success) {
        alert("后台登录成功！当前有效卡密数量：" + data.data.length);
      } else {
        toast("密码错误，无法进入后台");
      }
    });
}

function handleEnterPicker() {
  toast("正在验证权限...");
  var key = localStorage.getItem('auth_key') || document.getElementById('licenseKey').value.trim();
  
  fetch('/api/check-auth?key=' + encodeURIComponent(key))
    .then(function(res) {
      if (res.ok) {
        window.location.href = "/picker";
      } else {
        toast("卡密已过期或失效，请重新登录");
      }
    })
    .catch(function() {
      toast("网络异常，请稍后再试");
    });
}

function openShadowrocket() {
  var moduleUrl = location.origin + '/ios-location-spoofer.sgmodule';
  window.location.href = 'shadowrocket://install?module=' + encodeURIComponent(moduleUrl);
}

function toast(m){ 
  var t=document.getElementById('toast'); 
  t.textContent=m; 
  t.classList.add('show'); 
  setTimeout(function(){ t.classList.remove('show'); }, 1800); 
}

/* 升级版复制功能：兼容 HTTPS 安全上下文与 fallback 降级 */
function copyText(s){
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(s);
  }
  return new Promise(function(res, rej){ 
    try { 
      var ta = document.createElement('textarea'); 
      ta.value = s; 
      ta.style.position = 'fixed'; 
      ta.style.opacity = '0'; 
      document.body.appendChild(ta); 
      ta.select(); 
      var ok = document.execCommand('copy'); 
      document.body.removeChild(ta); 
      ok ? res() : rej(); 
    } catch(e){ rej(e); } 
  });
}

function doCopy(fileOrText, btn, successMsg){ 
  var fullUrl = fileOrText.indexOf('http') === 0 ? fileOrText : location.origin + '/' + fileOrText;
  copyText(fullUrl).then(function(){ 
    toast(successMsg || '已复制'); 
    var o = btn.textContent; 
    btn.classList.add('ok'); 
    btn.textContent = '✓'; 
    setTimeout(function(){ btn.textContent = o; btn.classList.remove('ok'); }, 1200); 
  }).catch(function(){ toast('复制失败，请手动选择'); }); 
}

// 绑定微信复制按钮
document.addEventListener('DOMContentLoaded', function(){
  var wcBtn = document.getElementById('copyWechat');
  if(wcBtn){
    wcBtn.addEventListener('click', function(){
      doCopy('LLME-love', wcBtn, '已复制微信号: LLME-love');
    });
  }
});

window.onload = function() {
  document.getElementById('url-sr').textContent = location.origin + '/ios-location-spoofer.sgmodule';
  var savedKey = localStorage.getItem('auth_key');
  if(savedKey) {
    document.getElementById('licenseKey').value = savedKey;
  }
};
</script>
</body>
</html>`;
}
