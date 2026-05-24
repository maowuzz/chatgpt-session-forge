const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { ProxyAgent, setGlobalDispatcher } = require('undici');
const config = require('./config');

setupOutboundProxy();

const app = express();

function setupOutboundProxy() {
  const proxyUrl = resolveProxyUrl(config.proxy);
  if (!proxyUrl) {
    console.log('[Proxy] disabled');
    return;
  }

  try {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    console.log(`[Proxy] Node fetch -> ${maskProxyUrl(proxyUrl)}`);
  } catch (err) {
    console.error(`[Proxy] setup failed: ${err.message}`);
  }
}

function resolveProxyUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.toLowerCase() === 'none' || raw.toLowerCase() === 'direct') return '';
  if (raw.toLowerCase() !== 'auto') return normalizeProxyUrl(raw);
  return normalizeProxyUrl(readWindowsProxyServer());
}

function normalizeProxyUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const first = raw.split(';')[0].replace(/^(https?|socks)=/i, '').trim();
  if (!first) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(first) ? first : `http://${first}`;
}

function readWindowsProxyServer() {
  if (process.platform !== 'win32') return '';
  try {
    const output = execFileSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v',
      'ProxyServer',
    ], { encoding: 'utf8', windowsHide: true });
    const match = output.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

function maskProxyUrl(value) {
  return String(value).replace(/:\/\/([^:@/]+):([^@/]+)@/, '://$1:***@');
}

// ==================== 中间件 ====================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 静态文件
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));

// ==================== 确保数据目录存在 ====================
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const dataFile = path.join(__dirname, config.dataFile);
if (!fs.existsSync(dataFile)) {
  fs.writeFileSync(dataFile, '[]', 'utf-8');
}

// ==================== SSE 连接管理 ====================
const sseClients = new Set();
const recentEvents = [];
const sseEventRunId = Date.now().toString(36);
let sseEventSeq = 0;

function rememberEvent(data) {
  recentEvents.push(data);
  if (recentEvents.length > 80) recentEvents.shift();
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('data: {"type":"connected"}\n\n');

  sseClients.add(res);
  console.log(`[SSE] connected clients=${sseClients.size}`);
  req.on('close', () => {
    sseClients.delete(res);
    console.log(`[SSE] disconnected clients=${sseClients.size}`);
  });
});

function broadcast(data) {
  const eventData = {
    ...data,
    eventId: `${sseEventRunId}-${++sseEventSeq}`,
    time: new Date().toISOString(),
  };
  rememberEvent(eventData);
  const msg = `data: ${JSON.stringify(eventData)}\n\n`;
  console.log(`[SSE] broadcast ${eventData.type || ''}${eventData.status ? `:${eventData.status}` : ''} clients=${sseClients.size}`);
  for (const client of sseClients) {
    client.write(msg);
  }
}

app.get('/api/events/status', (req, res) => {
  res.json({
    success: true,
    clients: sseClients.size,
    recentEvents,
  });
});

// 将 broadcast 挂到 app 上，让路由可以使用
app.set('broadcast', broadcast);

// ==================== 加载路由 ====================
app.use('/api', require('./routes/accounts'));
app.use('/api', require('./routes/mail'));
app.use('/api', require('./routes/chatgpt'));
app.use('/api', require('./routes/convert'));
app.use('/api', require('./routes/warehouse'));
app.use('/api', require('./routes/upload'));

// ==================== 错误处理 ====================
app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  res.status(500).json({
    success: false,
    error: err.message || '服务器内部错误',
  });
});

// ==================== 启动服务 ====================
app.listen(config.port, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   ChatGPT 自动登录凭证管理系统          ║');
  console.log('║                                          ║');
  console.log(`║   🌐 http://localhost:${config.port}              ║`);
  console.log('║                                          ║');
  console.log('║   功能：                                 ║');
  console.log('║   📬 Outlook 双协议取件                  ║');
  console.log('║   🤖 ChatGPT 自动登录                   ║');
  console.log('║   🔄 Session → CPA / sub2api 转换       ║');
  console.log('║   📦 CPA 401 自动仓管                  ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});
