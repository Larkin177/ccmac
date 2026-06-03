// CC-Relay — 轻量协议转换代理
// OpenAI Responses API ↔ DeepSeek Chat Completions API
// 纯 Node.js 实现，零依赖，无需编译

const http = require('http');
const https = require('https');

const PORT = parseInt(process.env.RELAY_PORT || '8788');
const UPSTREAM = process.env.RELAY_UPSTREAM || 'https://api.deepseek.com/v1';
const API_KEY = process.env.DS_API_KEY || '';
const DISPLAY_MODEL = 'mimo';  // model name Codex sees (must match config.toml + catalog)
const UPSTREAM_MODEL = 'deepseek-chat';      // model sent to DeepSeek

if (!API_KEY) {
  console.error('[cc-relay] DS_API_KEY not set, exiting');
  process.exit(1);
}

// ============ Helpers ============

function log(method, path, status) {
  const ts = new Date().toISOString().split('T')[1].slice(0, 12);
  console.log(`[${ts}] ${method} ${path} → ${status}`);
}

function proxyRequest(targetUrl, body, reqHeaders, callback) {
  const url = new URL(targetUrl);
  const data = JSON.stringify(body);

  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Length': Buffer.byteLength(data),
    },
    timeout: 120000,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    let chunks = [];
    proxyRes.on('data', (c) => chunks.push(c));
    proxyRes.on('end', () => {
      callback(null, proxyRes.statusCode, proxyRes.headers, Buffer.concat(chunks).toString());
    });
  });

  proxyReq.on('error', (err) => callback(err));
  proxyReq.on('timeout', () => { proxyReq.destroy(); callback(new Error('upstream timeout')); });
  proxyReq.write(data);
  proxyReq.end();
}

// ============ Responses → Chat Completions ============

function extractContent(item) {
  if (typeof item === 'string') return item;
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) {
    return item.content
      .filter(c => c.type === 'input_text' || c.type === 'output_text')
      .map(c => c.text || '')
      .join('\n');
  }
  if (Array.isArray(item)) {
    return item.filter(i => i.type === 'input_text' || i.type === 'output_text')
      .map(i => i.text || '').join('\n');
  }
  return '';
}

function responsesToChat(body) {
  const messages = [];
  const instructions = body.instructions || '';

  if (instructions) {
    messages.push({ role: 'system', content: instructions });
  }

  // Handle input: string, single item, or array (full conversation)
  const input = body.input;

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input || 'hello' });
  } else if (Array.isArray(input)) {
    // Check if it's a conversation array (has role) or content blocks
    for (const item of input) {
      if (item.role) {
        // Conversation format: { role: "user"|"assistant"|"system", content: ... }
        const role = item.role === 'assistant' ? 'assistant' :
                     item.role === 'system' ? 'system' : 'user';
        messages.push({ role, content: extractContent(item) });
      } else if (item.type === 'message') {
        // Message item format
        const role = item.role === 'assistant' ? 'assistant' : 'user';
        messages.push({ role, content: extractContent(item) });
      } else if (item.type === 'input_text') {
        // Single content block — assume user
        messages.push({ role: 'user', content: item.text || '' });
      }
    }
  } else if (input && typeof input === 'object') {
    // Single item with role
    const role = input.role === 'assistant' ? 'assistant' :
                 input.role === 'system' ? 'system' : 'user';
    messages.push({ role, content: extractContent(input) });
  }

  if (messages.length === 0) {
    messages.push({ role: 'user', content: 'hello' });
  }

  const req = {
    model: UPSTREAM_MODEL,
    messages: messages,
    max_tokens: body.max_output_tokens || 4096,
    stream: body.stream || false,
  };

  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;

  return req;
}

// ============ Chat Completions → Responses ============

function chatToResponse(chatBody) {
  try {
    const data = JSON.parse(chatBody);
    const choice = data.choices?.[0] || {};
    const message = choice.message || {};

    return JSON.stringify({
      id: data.id || ('resp_' + Date.now()),
      object: 'response',
      created_at: data.created || Math.floor(Date.now() / 1000),
      status: 'completed',
      model: data.model || DISPLAY_MODEL,
      output: [{
        type: 'message',
        id: 'msg_' + Date.now(),
        status: 'completed',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: message.content || '',
        }],
      }],
      usage: data.usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    });
  } catch (e) {
    return JSON.stringify({ error: { message: 'Failed to parse upstream response' } });
  }
}

// ============ SSE Stream: Chat → Responses ============

function streamResponsesToChat(res, body) {
  const chatReq = responsesToChat({ ...body, stream: true });

  const url = new URL(UPSTREAM + '/chat/completions');
  const data = JSON.stringify(chatReq);

  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Length': Buffer.byteLength(data),
      'Accept': 'text/event-stream',
    },
    timeout: 300000,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const responseId = 'resp_' + Date.now();
    const itemId = 'item_' + Date.now();
    const partId = 'part_' + Date.now();
    let fullText = '';
    let firstChunk = true;
    let seq = 0;

    const sse = (type, data, n) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Send initial events
    sse('response.created', { type: 'response.created', response: { id: responseId, object: 'response', status: 'in_progress', model: DISPLAY_MODEL, output: [] } }, seq++);
    sse('response.in_progress', { type: 'response.in_progress', response: { id: responseId, object: 'response', status: 'in_progress', model: DISPLAY_MODEL, output: [] } }, seq++);
    sse('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } }, seq++);
    sse('response.content_part.added', { type: 'response.content_part.added', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }, seq++);

    let buffer = '';

    proxyRes.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') {
          res.end();
          return;
        }

        try {
          const chatChunk = JSON.parse(raw);
          const delta = chatChunk.choices?.[0]?.delta || {};
          const content = delta.content || '';
          const finishReason = chatChunk.choices?.[0]?.finish_reason;

          if (content) {
            fullText += content;
            sse('response.output_text.delta', {
              type: 'response.output_text.delta',
              item_id: itemId,
              output_index: 0,
              content_index: 0,
              delta: content,
            }, seq++);
          }

          if (finishReason === 'stop' || finishReason === 'length') {
            sse('response.output_text.done', {
              type: 'response.output_text.done',
              item_id: itemId,
              output_index: 0,
              content_index: 0,
              text: fullText,
            }, seq++);
            sse('response.content_part.done', {
              type: 'response.content_part.done',
              item_id: itemId,
              output_index: 0,
              content_index: 0,
              part: { type: 'output_text', text: fullText },
            }, seq++);
            sse('response.output_item.done', {
              type: 'response.output_item.done',
              output_index: 0,
              item: { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: fullText }] },
            }, seq++);
            sse('response.completed', {
              type: 'response.completed',
              response: { id: responseId, object: 'response', status: 'completed', output: [{ id: itemId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: fullText }] }] },
            }, seq++);
          }
        } catch (e) {
          // skip malformed chunks
        }
      }
    });

    proxyRes.on('end', () => res.end());
  });

  proxyReq.on('error', (err) => {
    const errorEvent = { type: 'error', error: { message: err.message } };
    res.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`);
    res.end();
  });

  proxyReq.write(data);
  proxyReq.end();
}

// ============ HTTP Server ============

const server = http.createServer((req, res) => {
  const method = req.method;
  const parsedUrl = new URL(req.url, 'http://127.0.0.1');
  const path = parsedUrl.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Health check
  if (path === '/health' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', upstream: UPSTREAM, model: UPSTREAM_MODEL }));
  }

  // Admin page
  if (path === '/admin' || path === '/admin/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!DOCTYPE html><html><head><meta charset=utf-8><title>CC-Relay</title></head>
<body style="font-family:monospace;padding:20px;background:#1a1d29;color:#c4c8d4">
<h1>CC-Relay</h1><p>Status: <span style="color:#22c55e">running</span></p>
<p>Port: ${PORT}</p><p>Upstream: ${UPSTREAM}</p><p>Codex model: ${DISPLAY_MODEL}</p>
</body></html>`);
  }

  // Responses API → Chat Completions (non-streaming)
  if (path === '/v1/responses' && method === 'POST') {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);

        if (parsed.stream) {
          log(method, path, '200 SSE');
          return streamResponsesToChat(res, parsed);
        }

        const chatReq = responsesToChat(parsed);
        log(method, path, '→ upstream');

        proxyRequest(UPSTREAM + '/chat/completions', chatReq, req.headers, (err, status, headers, data) => {
          if (err) {
            log(method, path, 502);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: 'Upstream error: ' + err.message } }));
          }

          const responseBody = chatToResponse(data);
          log(method, path, status);
          res.writeHead(status || 200, { 'Content-Type': 'application/json' });
          res.end(responseBody);
        });
      } catch (e) {
        log(method, path, 400);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Bad request: ' + e.message } }));
      }
    });
    return;
  }

  // Models list (for Codex compatibility)
  if (path === '/v1/models' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      object: 'list',
      data: [{ id: DISPLAY_MODEL, object: 'model', owned_by: 'cc-installer' }],
    }));
  }

  // 404
  log(method, path, 404);
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not found' } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`cc-relay listening on http://127.0.0.1:${PORT}`);
  console.log(`upstream: ${UPSTREAM}`);
  console.log(`upstream model: ${UPSTREAM_MODEL}, display model: ${DISPLAY_MODEL}`);
});

// Graceful shutdown
process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });
