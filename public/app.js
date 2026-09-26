'use strict';

const PWD_KEY = 'qqaibot-pwd';
let pwd = localStorage.getItem(PWD_KEY) || '';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html !== undefined) node.innerHTML = html;
  return node;
};
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(message, isError) {
  const node = $('#toast');
  node.textContent = message;
  node.className = 'toast show' + (isError ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (node.className = 'toast'), 2600);
}

async function api(path, options = {}) {
  const res = await fetch('/api/' + path, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      'x-webui-password': pwd,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    showAuth(true);
    throw new Error('未授权');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

/* ------------------------------------------------------------------- auth */

function showAuth(show) {
  $('#auth').classList.toggle('hidden', !show);
  $('#shell').classList.toggle('hidden', show);
  if (show) setTimeout(() => $('#authInput').focus(), 50);
}

async function tryAuth(candidate) {
  pwd = candidate;
  try {
    await api('overview');
    localStorage.setItem(PWD_KEY, pwd);
    $('#authError').textContent = '';
    showAuth(false);
    $('#logoutBtn').classList.toggle('hidden', !pwd);
    start();
  } catch (e) {
    localStorage.removeItem(PWD_KEY);
    pwd = '';
    $('#authError').textContent = '密码不正确';
  }
}

$('#authBtn').addEventListener('click', () => tryAuth($('#authInput').value));
$('#authInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') tryAuth($('#authInput').value);
});
$('#logoutBtn').addEventListener('click', () => {
  localStorage.removeItem(PWD_KEY);
  pwd = '';
  location.reload();
});

/* -------------------------------------------------------------------- nav */

let currentTab = 'overview';
const loaders = {};

document.querySelectorAll('.nav').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + tab));
  if (loaders[tab]) loaders[tab]();
}

/* --------------------------------------------------------------- overview */

loaders.overview = async function () {
  const pane = $('#tab-overview');
  try {
    const d = await api('overview');
    $('#connDot').className = 'dot' + (d.connected ? ' ok' : '');
    $('#brandSub').textContent = d.connected
      ? (d.botName ? `${d.botName} (${d.selfId ?? '?'})` : '已连接')
      : '未连接';
    pane.innerHTML = `<h2>概览</h2>
      <div class="grid">
        <div class="card"><div class="label">连接状态</div>
          <div class="value small"><span class="tag ${d.connected ? 'ok' : 'err'}">${d.connected ? '已连接' : '未连接'}</span></div>
          <div class="hint mono">${esc(d.wsUrl)}</div></div>
        <div class="card"><div class="label">机器人</div>
          <div class="value">${esc(d.botName || '—')}</div>
          <div class="hint">QQ ${esc(d.selfId ?? '—')}</div></div>
        <div class="card"><div class="label">运行时长</div>
          <div class="value">${fmtDuration(d.uptimeSec)}</div>
          <div class="hint">最近事件 ${d.lastEventAt ? timeAgo(d.lastEventAt) : '—'}</div></div>
        <div class="card"><div class="label">今日调用</div>
          <div class="value">${d.today.calls}</div>
          <div class="hint">输入 ${d.today.promptTokens} / 输出 ${d.today.completionTokens} tokens</div></div>
        <div class="card"><div class="label">会话数</div>
          <div class="value">${d.scopeCount}</div>
          <div class="hint">共 ${d.messageCount} 条消息记录</div></div>
        <div class="card"><div class="label">会话模型</div>
          <div class="value small mono">${esc(d.models.chat.model || '未配置')}</div>
          <div class="hint mono">${esc(d.models.chat.baseUrl || '—')}</div></div>
        <div class="card"><div class="label">识图模型</div>
          <div class="value small mono">${esc(d.models.vision.model || '未配置')}</div>
          <div class="hint"><span class="tag ${d.models.vision.enabled ? 'ok' : 'off'}">${d.models.vision.enabled ? '已开启' : '已关闭'}</span> · 历史图片 ${esc(d.models.historyImagesMode)}</div></div>
      </div>`;
  } catch (e) {
    pane.innerHTML = `<h2>概览</h2><div class="panel">加载失败：${esc(e.message)}</div>`;
  }
};

/* ----------------------------------------------------------------- scopes */

loaders.scopes = async function () {
  const pane = $('#tab-scopes');
  const d = await api('scopes');
  pane.innerHTML = `<h2>会话设置</h2>
    <div class="panel">
      <div class="row">
        <div class="field"><label>手动添加 / 编辑会话</label>
          <input id="scopeInput" placeholder="group:123456 或 private:10001" /></div>
        <div class="field"><label>&nbsp;</label>
          <button class="ghost" id="scopeAdd">添加</button></div>
      </div>
      <div class="hint">群会话格式 <span class="mono">group:群号</span>，私聊格式 <span class="mono">private:QQ号</span>。默认值（跟随全局）会以“默认”显示。</div>
    </div>
    <div class="panel" id="scopeList"></div>`;

  const list = $('#scopeList');
  if (d.scopes.length === 0) {
    list.innerHTML = '<div class="hint">还没有任何会话记录。收到消息后会自动出现，也可以在上方手动添加。</div>';
  } else {
    const table = el('table');
    table.innerHTML = `<thead><tr>
        <th style="width:22%">会话</th><th style="width:8%">消息</th>
        <th style="width:10%">启用</th><th style="width:12%">识图</th>
        <th>人格（留空跟随全局）</th><th style="width:16%">操作</th>
      </tr></thead>`;
    const tbody = el('tbody');
    for (const s of d.scopes) {
      const tr = el('tr');
      tr.innerHTML = `
        <td class="mono">${esc(s.scope)}<div class="hint">${s.lastAt ? timeAgo(s.lastAt) : ''}</div></td>
        <td>${s.count}</td>
        <td>
          <select data-k="enabled">
            <option value="" ${s.enabled === null ? 'selected' : ''}>默认</option>
            <option value="true" ${s.enabled === true ? 'selected' : ''}>开</option>
            <option value="false" ${s.enabled === false ? 'selected' : ''}>关</option>
          </select>
        </td>
        <td>
          <select data-k="visionEnabled">
            <option value="" ${s.visionEnabled === null ? 'selected' : ''}>默认</option>
            <option value="true" ${s.visionEnabled === true ? 'selected' : ''}>开</option>
            <option value="false" ${s.visionEnabled === false ? 'selected' : ''}>关</option>
          </select>
          <div class="hint">当前：${s.effectiveVision ? '开' : '关'}</div>
        </td>
        <td><textarea data-k="systemPrompt" placeholder="${esc(truncate(s.effectiveSystemPrompt, 60))}">${esc(s.systemPrompt ?? '')}</textarea></td>
        <td>
          <button class="primary tiny" data-act="save">保存</button>
          <button class="danger tiny" data-act="clear">清空并移除</button>
        </td>`;
      tr.querySelector('[data-act="save"]').addEventListener('click', async () => {
        const read = (k) => {
          const node = tr.querySelector(`[data-k="${k}"]`);
          const v = node.value;
          if (k === 'systemPrompt') return v.trim() ? v : null;
          return v === '' ? null : v === 'true';
        };
        try {
          await api('scopes', {
            method: 'PUT',
            body: {
              scope: s.scope,
              enabled: read('enabled'),
              visionEnabled: read('visionEnabled'),
              systemPrompt: read('systemPrompt'),
            },
          });
          toast('已保存 ' + s.scope);
          loaders.scopes();
        } catch (e) {
          toast(e.message, true);
        }
      });
      tr.querySelector('[data-act="clear"]').addEventListener('click', async () => {
        if (!confirm(`清空 ${s.scope} 的聊天记录，并删除它的单独设置？`)) return;
        try {
          await api('scopes?scope=' + encodeURIComponent(s.scope), { method: 'DELETE' });
          toast('已清空');
          loaders.scopes();
        } catch (e) {
          toast(e.message, true);
        }
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    list.appendChild(table);
  }

  $('#scopeAdd').addEventListener('click', async () => {
    const scope = $('#scopeInput').value.trim();
    if (!/^(group|private):\d+$/.test(scope)) {
      toast('格式应为 group:123 或 private:123', true);
      return;
    }
    try {
      await api('scopes', { method: 'PUT', body: { scope } });
      toast('已添加');
      loaders.scopes();
    } catch (e) {
      toast(e.message, true);
    }
  });
};

/* ----------------------------------------------------------------- models */

loaders.models = async function () {
  const pane = $('#tab-models');
  const d = await api('settings');
  const o = d.overrides || {};
  const val = (key, fallback) => (o[key] !== undefined ? o[key] : fallback);

  pane.innerHTML = `<h2>模型与设置</h2>
    <div class="hint" style="margin-bottom:14px">这里的修改会保存到数据库，覆盖 config.yaml（不会改写文件）。留空表示使用 config.yaml 里的值，点“恢复默认”会删除覆盖。</div>

    <div class="panel">
      <h3 style="margin-top:0">会话模型</h3>
      <div class="row">
        <div class="field"><label>接口地址 (baseUrl)</label>
          <input id="chatBaseUrl" placeholder="${esc(d.base.chat.baseUrl)}" value="${esc(val('chat.baseUrl', ''))}" /></div>
        <div class="field"><label>模型名</label>
          <input id="chatModel" placeholder="${esc(d.base.chat.model)}" value="${esc(val('chat.model', ''))}" /></div>
        <div class="field"><label>API Key（当前 ${esc(d.effective.chat.apiKey || '未设置')}）</label>
          <input id="chatApiKey" type="password" placeholder="不改就留空" /></div>
        <div class="field"><label>温度 temperature</label>
          <input id="chatTemperature" type="number" step="0.1" min="0" max="2" placeholder="${d.base.chat.temperature}" value="${esc(val('chat.temperature', ''))}" /></div>
        <div class="field"><label>最大回复 tokens</label>
          <input id="chatMaxTokens" type="number" min="1" placeholder="${d.base.chat.maxTokens}" value="${esc(val('chat.maxTokens', ''))}" /></div>
      </div>
      <div class="field" style="margin-top:12px"><label>系统提示词 / 人格（全局默认）</label>
        <textarea id="systemPrompt" placeholder="${esc(truncate(d.base.chat.systemPrompt, 120))}">${esc(val('chat.systemPrompt', ''))}</textarea></div>
    </div>

    <div class="panel">
      <h3 style="margin-top:0">识图模型</h3>
      <div class="row">
        <div class="field"><label>识图开关（全局）</label>
          <select id="visionEnabled">
            <option value="" ${val('vision.enabled', '') === '' ? 'selected' : ''}>默认（${d.base.vision.enabled ? '开' : '关'}）</option>
            <option value="true" ${val('vision.enabled', '') === 'true' ? 'selected' : ''}>开</option>
            <option value="false" ${val('vision.enabled', '') === 'false' ? 'selected' : ''}>关</option>
          </select></div>
        <div class="field"><label>接口地址 (baseUrl)</label>
          <input id="visionBaseUrl" placeholder="${esc(d.base.vision.baseUrl)}" value="${esc(val('vision.baseUrl', ''))}" /></div>
        <div class="field"><label>模型名</label>
          <input id="visionModel" placeholder="${esc(d.base.vision.model)}" value="${esc(val('vision.model', ''))}" /></div>
        <div class="field"><label>API Key（当前 ${esc(d.effective.vision.apiKey || '未设置')}）</label>
          <input id="visionApiKey" type="password" placeholder="不改就留空" /></div>
      </div>
      <div class="row" style="margin-top:12px">
        <div class="field"><label>历史图片处理方式</label>
          <select id="historyMode">
            <option value="" ${val('historyImages.mode', '') === '' ? 'selected' : ''}>默认（${esc(d.effective.historyImagesMode)}）</option>
            <option value="none" ${val('historyImages.mode', '') === 'none' ? 'selected' : ''}>none - 只显示 [图片]</option>
            <option value="latest" ${val('historyImages.mode', '') === 'latest' ? 'selected' : ''}>latest - 回放真实图片</option>
            <option value="caption" ${val('historyImages.mode', '') === 'caption' ? 'selected' : ''}>caption - 用文字描述代替</option>
          </select></div>
        <div class="field"><label>单次请求最多图片数</label>
          <input id="maxImages" type="number" min="1" placeholder="4" value="${esc(val('vision.maxImagesPerRequest', ''))}" /></div>
      </div>
    </div>

    <div class="panel">
      <h3 style="margin-top:0">对话上下文</h3>
      <div class="row">
        <div class="field"><label>记录群内全部消息</label>
          <select id="recordAll">
            <option value="" ${val('context.recordAll', '') === '' ? 'selected' : ''}>默认（${d.base.context.recordAll ? '开' : '关'}）</option>
            <option value="true" ${val('context.recordAll', '') === 'true' ? 'selected' : ''}>开 - @ 之外的聊天也记入上下文</option>
            <option value="false" ${val('context.recordAll', '') === 'false' ? 'selected' : ''}>关 - 只记 @ 机器人的消息</option>
          </select></div>
        <div class="field"><label>保留对话轮次</label>
          <input id="maxTurns" type="number" min="1" placeholder="${d.base.context.maxTurns}" value="${esc(val('context.maxTurns', ''))}" /></div>
        <div class="field"><label>上下文里的图片</label>
          <select id="recordImages">
            <option value="" ${val('context.recordImages', '') === '' ? 'selected' : ''}>默认（${d.base.context.recordImages ? '下载保存' : '只记占位'}）</option>
            <option value="true" ${val('context.recordImages', '') === 'true' ? 'selected' : ''}>下载保存（按原顺序送给多模态模型）</option>
            <option value="false" ${val('context.recordImages', '') === 'false' ? 'selected' : ''}>只记成 [图片] 占位</option>
          </select></div>
      </div>
      <div class="hint">开启「记录群内全部消息」后，群里没 @ 机器人的聊天也会进入上下文，机器人仍然只在被 @ 时回复。「保留对话轮次」1 轮 ≈ 2 条消息；轮次越多上下文越完整，token 也越多。图片会按「文字 → 图片 → 文字」的原顺序直接发给多模态模型，不再转成文字。</div>
    </div>

    <div class="panel">
      <h3 style="margin-top:0">回复行为</h3>
      <div class="row">
        <div class="field"><label>群内被 @ 时的表情回应（QQ emoji id）</label>
          <input id="emojiReaction" placeholder="${esc(d.base.reply.emojiReaction || '关闭')}" value="${esc(val('reply.emojiReaction', ''))}" /></div>
      </div>
      <div class="hint">群里 @ 机器人时会先给那条消息贴一个表情（默认 424）。留空并保存 = 关闭；想换别的表情就填对应的 emoji id。</div>
    </div>

    <div class="panel">
      <h3 style="margin-top:0">SnowLuma 连接（写入 config.yaml，需重启生效）</h3>
      <div class="row">
        <div class="field"><label>WebSocket 地址</label>
          <input id="wsUrl" value="${esc(d.base.snowluma.wsUrl)}" /></div>
        <div class="field"><label>accessToken（当前 ${esc(d.base.snowluma.accessToken || '未设置')}）</label>
          <input id="accessToken" type="password" placeholder="不改就留空" /></div>
      </div>
    </div>

    <div class="actions">
      <button class="primary" id="saveModels">保存</button>
      <button class="ghost" id="resetModels">恢复默认（删除全部覆盖）</button>
    </div>`;

  $('#saveModels').addEventListener('click', async () => {
    const num = (v) => (v === '' ? null : Number(v));
    const str = (v) => (v.trim() ? v.trim() : null);
    try {
      await api('overrides', {
        method: 'PUT',
        body: {
          overrides: {
            'chat.baseUrl': str($('#chatBaseUrl').value),
            'chat.model': str($('#chatModel').value),
            'chat.systemPrompt': str($('#systemPrompt').value),
            'chat.temperature': num($('#chatTemperature').value),
            'chat.maxTokens': num($('#chatMaxTokens').value),
            'vision.enabled': $('#visionEnabled').value === '' ? null : $('#visionEnabled').value,
            'vision.baseUrl': str($('#visionBaseUrl').value),
            'vision.model': str($('#visionModel').value),
            'historyImages.mode': str($('#historyMode').value),
            'vision.maxImagesPerRequest': num($('#maxImages').value),
            'context.recordAll': $('#recordAll').value === '' ? null : $('#recordAll').value,
            'context.recordImages': $('#recordImages').value === '' ? null : $('#recordImages').value,
            'context.maxTurns': num($('#maxTurns').value),
            'reply.emojiReaction': str($('#emojiReaction').value),
          },
        },
      });
      const chatKey = $('#chatApiKey').value.trim();
      const visionKey = $('#visionApiKey').value.trim();
      if (chatKey || visionKey) {
        await api('overrides', {
          method: 'PUT',
          body: {
            overrides: Object.assign(
              {},
              chatKey ? { 'chat.apiKey': chatKey } : {},
              visionKey ? { 'vision.apiKey': visionKey } : {},
            ),
          },
        });
      }
      const wsUrl = $('#wsUrl').value.trim();
      const token = $('#accessToken').value.trim();
      if (wsUrl || token) {
        await api('config', { method: 'PUT', body: { snowluma: { wsUrl, accessToken: token } } });
      }
      toast('已保存');
      loaders.models();
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('#resetModels').addEventListener('click', async () => {
    if (!confirm('删除全部全局覆盖，恢复 config.yaml 的值？')) return;
    const keys = [
      'chat.baseUrl', 'chat.model', 'chat.systemPrompt', 'chat.temperature', 'chat.maxTokens', 'chat.apiKey',
      'vision.enabled', 'vision.baseUrl', 'vision.model', 'vision.apiKey',
      'historyImages.mode', 'vision.maxImagesPerRequest',
      'context.recordAll', 'context.recordImages', 'context.maxTurns',
      'reply.emojiReaction',
    ];
    const overrides = {};
    for (const k of keys) overrides[k] = null;
    try {
      await api('overrides', { method: 'PUT', body: { overrides } });
      toast('已恢复默认');
      loaders.models();
    } catch (e) {
      toast(e.message, true);
    }
  });
};

/* ------------------------------------------------------------------ usage */

loaders.usage = async function () {
  const pane = $('#tab-usage');
  const d = await api('usage?days=30');
  const max = Math.max(1, ...d.days.map((x) => x.calls));
  const bars = d.days
    .map((x) => `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px" title="${x.day} · ${x.calls} 次">
        <div style="width:100%;max-width:26px;height:${Math.round((x.calls / max) * 120)}px;min-height:2px;background:var(--accent);border-radius:4px 4px 0 0"></div>
        <span class="hint" style="font-size:10px">${x.day.slice(5)}</span>
      </div>`)
    .join('');

  pane.innerHTML = `<h2>用量统计</h2>
    <div class="grid">
      <div class="card"><div class="label">今日调用</div><div class="value">${d.today.calls}</div></div>
      <div class="card"><div class="label">今日输入 tokens</div><div class="value">${d.today.promptTokens}</div></div>
      <div class="card"><div class="label">今日输出 tokens</div><div class="value">${d.today.completionTokens}</div></div>
    </div>
    <h3>最近 30 天调用量</h3>
    <div class="panel"><div style="display:flex;align-items:flex-end;gap:4px;height:170px;overflow-x:auto">${bars || '<span class="hint">暂无数据</span>'}</div></div>
    <h3>按模型统计</h3>
    <div class="panel">${
      d.models.length
        ? `<table><thead><tr><th>类型</th><th>模型</th><th>调用</th><th>输入 tokens</th><th>输出 tokens</th></tr></thead><tbody>${d.models
            .map(
              (m) =>
                `<tr><td><span class="tag ${m.kind === 'vision' ? '' : 'ok'}">${esc(m.kind)}</span></td><td class="mono">${esc(m.model)}</td><td>${m.calls}</td><td>${m.promptTokens}</td><td>${m.completionTokens}</td></tr>`,
            )
            .join('')}</tbody></table>`
        : '<span class="hint">暂无数据</span>'
    }</div>`;
};

/* ------------------------------------------------------------------- logs */

loaders.logs = async function () {
  const pane = $('#tab-logs');
  if (!pane.dataset.ready) {
    pane.innerHTML = `<h2>运行日志</h2>
      <div class="actions" style="margin-top:0;margin-bottom:12px">
        <button class="ghost" id="logRefresh">刷新</button>
        <label class="hint"><input type="checkbox" id="logAuto" checked /> 自动刷新（3s）</label>
        <input id="logFilter" class="ghost" style="padding:7px 10px" placeholder="过滤关键字" />
      </div>
      <div class="logs" id="logView"></div>`;
    pane.dataset.ready = '1';
    $('#logRefresh').addEventListener('click', refreshLogs);
    $('#logFilter').addEventListener('input', () => renderLogs());
    setInterval(() => {
      if (currentTab === 'logs' && $('#logAuto').checked) refreshLogs();
    }, 3000);
  }
  await refreshLogs();
};

let logLines = [];
async function refreshLogs() {
  try {
    const d = await api('logs?tail=500');
    logLines = d.lines || [];
    renderLogs();
  } catch (e) {
    toast(e.message, true);
  }
}

function renderLogs() {
  const view = $('#logView');
  if (!view) return;
  const filter = ($('#logFilter')?.value || '').trim();
  const lines = filter ? logLines.filter((l) => l.includes(filter)) : logLines;
  view.innerHTML = lines
    .map((line) => {
      const level = (line.match(/\[(DEBUG|INFO|WARN|ERROR)\]/) || [])[1] || '';
      return `<span class="lvl-${level}">${esc(line)}</span>`;
    })
    .join('\n');
  view.scrollTop = view.scrollHeight;
}

/* ------------------------------------------------------------------- test */

loaders.test = async function () {
  const pane = $('#tab-test');
  if (pane.dataset.ready) return;
  pane.innerHTML = `<h2>在线测试</h2>
    <div class="panel">
      <div class="row">
        <div class="field"><label>使用哪个会话的设置</label>
          <input id="testScope" value="private:0" placeholder="private:0" /></div>
        <div class="field"><label>&nbsp;</label>
          <button class="ghost" id="testClear">清空对话</button></div>
      </div>
      <div class="hint">直接调用配置好的会话模型，不写入聊天记忆。识图请用上面的会话设置控制。</div>
    </div>
    <div class="chat-box" id="chatBox">
      <div class="msg sys">输入内容开始测试</div>
    </div>
    <div class="bar">
      <input id="testInput" placeholder="输入消息，回车发送…" />
      <button class="primary" id="testSend">发送</button>
    </div>`;
  pane.dataset.ready = '1';

  const send = async () => {
    const input = $('#testInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    addMsg('user', text);
    const waiting = addMsg('sys', '思考中…');
    try {
      const d = await api('test-chat', { method: 'POST', body: { text, scope: $('#testScope').value.trim() } });
      waiting.remove();
      if (d.error) addMsg('sys', '出错：' + d.error);
      else addMsg('bot', d.reply);
    } catch (e) {
      waiting.remove();
      addMsg('sys', '出错：' + e.message);
    }
  };

  $('#testSend').addEventListener('click', send);
  $('#testInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
  $('#testClear').addEventListener('click', () => {
    $('#chatBox').innerHTML = '<div class="msg sys">已清空</div>';
  });
};

function addMsg(kind, text) {
  const box = $('#chatBox');
  const node = el('div', 'msg ' + kind, esc(text));
  box.appendChild(node);
  box.scrollTop = box.scrollHeight;
  return node;
}

/* --------------------------------------------------------------- utilities */

function fmtDuration(sec) {
  if (sec < 60) return sec + ' 秒';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h < 24) return h + ' 小时 ' + m + ' 分';
  return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时';
}

function timeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return diff + ' 秒前';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  return Math.floor(diff / 86400) + ' 天前';
}

function truncate(text, n) {
  const s = String(text ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/* ------------------------------------------------------------------ start */

async function start() {
  await loaders.overview();
  setInterval(() => {
    if (currentTab === 'overview') loaders.overview();
  }, 5000);
}

(async function boot() {
  if (!pwd) {
    // Probe: if the server has no password this succeeds immediately.
    try {
      await api('overview');
      showAuth(false);
      start();
      return;
    } catch {
      showAuth(true);
      return;
    }
  }
  try {
    await api('overview');
    showAuth(false);
    $('#logoutBtn').classList.remove('hidden');
    start();
  } catch {
    showAuth(true);
  }
})();
