// End-to-end smoke test.
//
// Spins up a fake OneBot v11 WebSocket server and a fake OpenAI-compatible HTTP
// server, runs the built bundle against them, then asserts the bot replies only
// when it should.
//
//   node test/e2e.mjs        (run `npm run build` first)

import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS_PORT = 13999;
const AI_PORT = 13998;
const WEBUI_PORT = 18787;
const SELF_ID = 10000;
const GROUP_ID = 55501;

const workDir = path.join(os.tmpdir(), 'qqaibot-e2e');
const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 15000, step = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

// --------------------------------------------------------------- fake AI API

const aiCalls = [];
function startAiServer() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        /* ignore */
      }
      aiCalls.push(body);
      const payload = {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? 'mock',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: `MOCK[${body.model}] 收到` },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => server.listen(AI_PORT, '127.0.0.1', () => resolve(server)));
}

// ------------------------------------------------------------ fake OneBot WS

const sentGroup = [];
const sentPrivate = [];
const emojiLikes = [];
let socket = null;

function handleAction(action, params) {
  switch (action) {
    case 'get_login_info':
      return { user_id: SELF_ID, nickname: '测试机器人' };
    case 'get_group_member_list':
      return [
        { user_id: SELF_ID, nickname: '测试机器人', card: '' },
        { user_id: 10001, nickname: '张三', card: '张三的群名片' },
        { user_id: 10002, nickname: '李四', card: '' },
      ];
    case 'get_group_member_info':
      return { user_id: params.user_id, nickname: params.user_id === 10002 ? '李四' : '张三', card: '' };
    case 'get_group_info':
      return { group_id: GROUP_ID, group_name: '测试群' };
    case 'get_msg':
      return {
        message_id: params.message_id,
        user_id: 10002,
        sender: { user_id: 10002, nickname: '李四', card: '' },
        message: [{ type: 'text', data: { text: '被引用的原话' } }],
      };
    case 'send_group_msg':
    case 'send_group_message':
      sentGroup.push(params);
      return { message_id: 70000 + sentGroup.length };
    case 'send_private_msg':
    case 'send_private_message':
      sentPrivate.push(params);
      return { message_id: 80000 + sentPrivate.length };
    case 'set_msg_emoji_like':
      emojiLikes.push(params);
      return null;
    default:
      return {};
  }
}

function startOneBotServer() {
  const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (raw) => {
      let packet;
      try {
        packet = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const { action, params = {}, echo } = packet;
      const data = handleAction(action, params);
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo }));
    });
    ws.on('close', () => {
      if (socket === ws) socket = null;
    });
  });
  return wss;
}

function pushEvent(event) {
  if (!socket) throw new Error('no OneBot socket connected');
  socket.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), self_id: SELF_ID, ...event }));
}

// --------------------------------------------------------------- test setup

await fsp.rm(workDir, { recursive: true, force: true });
await fsp.mkdir(workDir, { recursive: true });
await fsp.copyFile(path.join(root, 'dist', 'bot.mjs'), path.join(workDir, 'bot.mjs'));
await fsp.cp(path.join(root, 'dist', 'public'), path.join(workDir, 'public'), { recursive: true });

const pngPath = path.join(workDir, 'pixel.png');
await fsp.writeFile(
  pngPath,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

await fsp.writeFile(
  path.join(workDir, 'config.yaml'),
  `snowluma:
  wsUrl: ws://127.0.0.1:${WS_PORT}/
  accessToken: ""
  reconnect: true
prompt:
  includeContext: true
  timezone: Asia/Shanghai
chat:
  baseUrl: http://127.0.0.1:${AI_PORT}/v1
  apiKey: test
  model: mock-chat
  systemPrompt: 你是测试机器人
vision:
  enabled: true
  baseUrl: http://127.0.0.1:${AI_PORT}/v1
  apiKey: test
  model: mock-vision
historyImages:
  mode: caption
  maxImages: 4
quote:
  enabled: true
  resolve: true
voice:
  transcribe: false
context:
  recordAll: true
  recordImages: true
  maxTurns: 20
  maxContextChars: 12000
  includeTimestamps: false
trigger:
  replyOnEmptyMention: false
reply:
  quoteOnGroup: true
  stripMarkdown: true
ai:
  timeoutMs: 15000
  maxRetries: 0
limits:
  perUserCooldownMs: 0
  busyStrategy: queue
  maxQueuePerScope: 5
webui:
  enabled: true
  host: 127.0.0.1
  port: ${WEBUI_PORT}
  password: ""
logging:
  level: debug
  keepDays: 7
  console: true
media:
  keepDays: 3
`,
  'utf8',
);

const aiServer = await startAiServer();
const wss = startOneBotServer();

const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'bot.mjs'], {
  cwd: workDir,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let botLog = '';
child.stdout.on('data', (d) => (botLog += d.toString()));
child.stderr.on('data', (d) => (botLog += d.toString()));

let exitCode = 1;
try {
  const connected = await waitFor(() => Promise.resolve(socket !== null), 12000);
  check('机器人连接到 OneBot WebSocket', connected);
  if (!connected) throw new Error('bot never connected');
  await waitFor(() => Promise.resolve(botLog.includes('connected as')), 5000);

  const groupEvent = (id, userId, message, extra = {}) => ({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: id,
    group_id: GROUP_ID,
    user_id: userId,
    raw_message: '',
    font: 0,
    sender: {
      user_id: userId,
      nickname: userId === 10002 ? '李四' : '张三',
      card: userId === 10002 ? '李四的群名片' : '张三的群名片',
      role: 'member',
    },
    message,
    ...extra,
  });

  // 1. group mention with a quote and an image
  pushEvent(
    groupEvent(1001, 10001, [
      { type: 'reply', data: { id: '9001' } },
      { type: 'text', data: { text: '看看这个 ' } },
      { type: 'at', data: { qq: String(SELF_ID) } },
      { type: 'image', data: { file: pngPath } },
    ]),
  );
  const replied = await waitFor(() => Promise.resolve(sentGroup.length === 1), 12000);
  check('群内 @机器人 后回复', replied, `发送了 ${sentGroup.length} 条`);
  if (replied) {
    const msg = sentGroup[0].message;
    const hasReply = msg.some((s) => s.type === 'reply' && String(s.data.id) === '1001');
    const text = msg.find((s) => s.type === 'text')?.data?.text ?? '';
    check('群回复引用了原消息', hasReply);
    check('群回复带上了模型输出', text.includes('MOCK[mock-vision]'), text);
  }

  check('带图消息走了识图模型', aiCalls.some((c) => c.model === 'mock-vision'));
  const lastUserMessage = aiCalls[0]?.messages?.at(-1)?.content;
  check(
    '当前图片作为 image_url 发送',
    Array.isArray(lastUserMessage) && lastUserMessage.some((p) => p.type === 'image_url'),
  );
  const systemMessage = aiCalls[0]?.messages?.[0]?.content ?? '';
  check('系统提示词包含人格', systemMessage.includes('你是测试机器人'), systemMessage.slice(0, 40));
  check('系统提示词包含环境段', systemMessage.includes('[环境]') && systemMessage.includes('测试群'));
  check(
    '群聊上下文带发言人前缀',
    JSON.stringify(lastUserMessage).includes('张三的群名片'),
  );
  check(
    '引用内容被解析',
    JSON.stringify(lastUserMessage).includes('被引用的原话'),
  );
  check(
    '群内被 @ 时贴了表情回应',
    emojiLikes.some((e) => String(e.emoji_id) === '424' && Number(e.message_id) === 1001),
    JSON.stringify(emojiLikes[0] ?? null),
  );

  // 2. duplicate message_id must be ignored
  pushEvent(groupEvent(1001, 10001, [{ type: 'at', data: { qq: String(SELF_ID) } }, { type: 'text', data: { text: '重复' } }]));
  await sleep(1500);
  check('重复 message_id 被去重', sentGroup.length === 1, `发送了 ${sentGroup.length} 条`);

  // 3. group message without a mention must be ignored
  pushEvent(groupEvent(1002, 10002, [{ type: 'text', data: { text: '没 at 机器人' } }]));
  await sleep(1200);
  check('群内未 @机器人 不回复', sentGroup.length === 1, `发送了 ${sentGroup.length} 条`);

  // 4. private message triggers a reply
  pushEvent({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 1003,
    user_id: 10002,
    raw_message: '私聊',
    font: 0,
    sender: { user_id: 10002, nickname: '李四' },
    message: [{ type: 'text', data: { text: '私聊测试' } }],
  });
  const privateReplied = await waitFor(() => Promise.resolve(sentPrivate.length === 1), 12000);
  check('私聊消息回复', privateReplied, `发送了 ${sentPrivate.length} 条`);

  // 5. the image got a background caption, replayed as text in later history
  const captionCall = aiCalls.some(
    (c) => c.model === 'mock-vision' && JSON.stringify(c.messages).includes('客观描述'),
  );
  check('后台生成了历史图片描述（caption）', captionCall);

  // 6. a second turn sees the caption instead of the raw image
  pushEvent(
    groupEvent(1004, 10001, [
      { type: 'at', data: { qq: String(SELF_ID) } },
      { type: 'text', data: { text: '刚才那张图是什么' } },
    ]),
  );
  const secondTurn = await waitFor(() => Promise.resolve(sentGroup.length === 2), 12000);
  check('后续轮次回复正常', secondTurn);
  const lastCall = aiCalls.at(-1);
  const historyText = JSON.stringify(lastCall?.messages?.slice(1) ?? []);
  check('历史图片以描述形式回放', historyText.includes('[图片:'), historyText.slice(-160));

  // 6.5 switch to `latest` mode through the panel override; history image replays raw
  await fetch(`http://127.0.0.1:${WEBUI_PORT}/api/overrides`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ overrides: { 'historyImages.mode': 'latest' } }),
  });
  pushEvent(
    groupEvent(1005, 10001, [
      { type: 'at', data: { qq: String(SELF_ID) } },
      { type: 'text', data: { text: '那张图再给我看看' } },
    ]),
  );
  const thirdTurn = await waitFor(() => Promise.resolve(sentGroup.length === 3), 12000);
  check('切换 latest 模式后仍能回复', thirdTurn);
  const latestCall = aiCalls.at(-1);
  const latestFlat = JSON.stringify(latestCall?.messages?.slice(1) ?? []);
  check(
    'latest 模式用识图模型回放真实图片',
    latestCall?.model === 'mock-vision' && latestFlat.includes('"image_url"'),
    `model=${latestCall?.model}`,
  );
  check('latest 模式不再用文字描述代替图片', !latestFlat.includes('[图片:'));

  // 6.7 a passively recorded image replays inline, in its original text/image order
  pushEvent(
    groupEvent(2003, 10002, [
      { type: 'text', data: { text: '这是' } },
      { type: 'image', data: { file: pngPath } },
      { type: 'text', data: { text: '刚拍的' } },
    ]),
  );
  await sleep(1200);
  check('被动图片消息不回复', sentGroup.length === 3, `发送了 ${sentGroup.length} 条`);
  pushEvent(
    groupEvent(2004, 10001, [
      { type: 'at', data: { qq: String(SELF_ID) } },
      { type: 'text', data: { text: '看到了吗' } },
    ]),
  );
  await waitFor(() => Promise.resolve(sentGroup.length === 4), 12000);
  const inlineMessages = aiCalls.at(-1)?.messages ?? [];
  const inlineMsg = inlineMessages.find(
    (m) => Array.isArray(m.content) && JSON.stringify(m.content).includes('刚拍的'),
  );
  const inlineSeq = (inlineMsg?.content ?? []).map((p) => p.type);
  check(
    '被动图片按「文字→图片→文字」原顺序回放',
    inlineSeq.length >= 3 &&
      inlineSeq[0] === 'text' &&
      inlineSeq.includes('image_url') &&
      inlineSeq.at(-1) === 'text' &&
      JSON.stringify(inlineMsg?.content).includes('刚拍的'),
    JSON.stringify(inlineSeq),
  );

  await fetch(`http://127.0.0.1:${WEBUI_PORT}/api/overrides`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ overrides: { 'historyImages.mode': null } }),
  });

  // 6.6 a message without a mention is recorded and shows up in the next @ context
  pushEvent(groupEvent(2001, 10002, [{ type: 'text', data: { text: '今晚九点开黑' } }]));
  await sleep(900);
  check('未 @ 的消息不回复', sentGroup.length === 4, `发送了 ${sentGroup.length} 条`);

  pushEvent(
    groupEvent(2002, 10001, [
      { type: 'at', data: { qq: String(SELF_ID) } },
      { type: 'text', data: { text: '几点开黑' } },
    ]),
  );
  const afterPassive = await waitFor(() => Promise.resolve(sentGroup.length === 5), 12000);
  check('被动消息之后仍能被 @ 触发', afterPassive, `发送了 ${sentGroup.length} 条`);
  const passiveCtx = JSON.stringify(aiCalls.at(-1)?.messages?.slice(1) ?? []);
  check('未 @ 的群消息进入上下文', passiveCtx.includes('今晚九点开黑'), passiveCtx.slice(-220));
  check('被动消息带上了发言人', passiveCtx.includes('李四的群名片'));

  // 7. webui endpoints
  const overview = await fetch(`http://127.0.0.1:${WEBUI_PORT}/api/overview`).then((r) => r.json());
  check('WebUI 概览接口可用', typeof overview.connected === 'boolean');
  check('用量已统计', overview.today.calls >= 3, `calls=${overview.today.calls}`);

  const usage = await fetch(`http://127.0.0.1:${WEBUI_PORT}/api/usage`).then((r) => r.json());
  check(
    '用量按模型分开统计',
    usage.models.some((m) => m.kind === 'chat') && usage.models.some((m) => m.kind === 'vision'),
    JSON.stringify(usage.models.map((m) => `${m.kind}:${m.model}`)),
  );

  const scopes = await fetch(`http://127.0.0.1:${WEBUI_PORT}/api/scopes`).then((r) => r.json());
  check('会话列表含群与私聊', scopes.scopes.length >= 2, JSON.stringify(scopes.scopes.map((s) => s.scope)));

  // 8. per-scope setting toggle through the API
  const put = await fetch(`http://127.0.0.1:${WEBUI_PORT}/api/scopes`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: `group:${GROUP_ID}`, visionEnabled: false }),
  }).then((r) => r.json());
  const saved = put.scopes.find((s) => s.scope === `group:${GROUP_ID}`);
  check('会话级识图开关可保存', saved?.visionEnabled === false && saved?.effectiveVision === false);

  const settings = await fetch(`http://127.0.0.1:${WEBUI_PORT}/api/settings`).then((r) => r.json());
  check('设置接口隐藏了密钥', settings.base.chat.apiKey === '' || settings.base.chat.apiKey.includes('***'));

  exitCode = failed === 0 ? 0 : 1;
} catch (e) {
  console.error('测试异常:', e);
  exitCode = 1;
} finally {
  child.kill();
  await sleep(300);
  wss.close();
  aiServer.close();
  if (exitCode !== 0 || process.env.E2E_VERBOSE) {
    console.log('\n--- bot log ---\n' + botLog);
  }
  console.log('\n================ 结果 ================');
  console.log(`${results.filter((r) => r.ok).length}/${results.length} 通过`);
  process.exit(exitCode);
}
