// Assembles the portable, double-clickable release folder.
//
//   node scripts/package.mjs
//
// Produces release/QQAIBot/ with a bundled Node runtime, the single-file bot
// bundle, the WebUI assets and .bat launchers. Nothing here needs npm on the
// target machine.

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const outDir = path.join(root, 'release', 'QQAIBot');

const LAUNCH_BAT = `@echo off
chcp 65001 >nul
title qqaibot
cd /d "%~dp0"

if not exist "runtime\\node.exe" (
  echo [错误] 缺少 runtime\\node.exe，请重新解压完整压缩包。
  pause
  exit /b 1
)

if not exist "app\\config.yaml" (
  echo [错误] 缺少 app\\config.yaml，请重新解压完整压缩包。
  pause
  exit /b 1
)

echo ============================================================
echo                   qqaibot  QQ 机器人
echo ============================================================
echo.

rem SnowLuma 若放在同目录的 snowluma\\ 下，则顺手拉起
tasklist /fi "imagename eq SnowLuma.exe" 2>nul | find /i "SnowLuma.exe" >nul
if errorlevel 1 (
  if exist "snowluma\\SnowLuma.exe" (
    echo 正在启动 SnowLuma...
    start "" "snowluma\\SnowLuma.exe"
    timeout /t 8 >nul
  )
)

echo 管理面板: http://127.0.0.1:8787
echo 请不要关闭本窗口。按 Ctrl+C 可退出自动重启循环。
echo.

:loop
"runtime\\node.exe" --disable-warning=ExperimentalWarning --disable-warning=DEP0169 --disable-warning=DEP0040 "app\\bot.mjs"
if errorlevel 1 (
  echo.
  echo [提示] 机器人异常退出，5 秒后自动重启；要彻底退出请按 Ctrl+C。
  timeout /t 5 >nul
  goto loop
)
echo.
echo 机器人已停止。
pause
`;

const PANEL_BAT = `@echo off
chcp 65001 >nul
title 打开 qqaibot 管理面板
start "" "http://127.0.0.1:8787"
`;

const README_TXT = `============================================================
                 qqaibot  使用说明
============================================================

【一、准备】
先装好 SnowLuma 并让它登录你的 QQ 小号。
打开 SnowLuma 的 WebUI（默认 http://localhost:5099），
在 OneBot 设置里开启「正向 WebSocket」，默认地址
ws://127.0.0.1:3001/ —— qqaibot 默认就是它，一般不用改。
（如果设了 accessToken，去管理面板里填上。）

【二、启动】
双击「一键启动.bat」。
黑窗口出现 "connected as 昵称" 就说明连上了。
首次启动会自动生成 app\\config.yaml 和 data 文件夹，正常现象。
黑窗口不要关，关了机器人就停了。

【三、配置模型（必须做一次）】
双击「打开管理面板.bat」，浏览器打开 http://127.0.0.1:8787
进入「模型与设置」：
  - 会话模型：填 baseUrl、模型名、API Key（比如 DeepSeek）
  - 识图模型：可以填另一家的模型（比如通义千问 VL）；不需要就关掉开关
  - 点「保存」立即生效，不用重启
人设和每个群单独的开关在「会话设置」里。

【四、怎么用】
群聊：@机器人 + 内容（机器人会先给这条消息贴个表情，再回）
私聊：直接发消息
上下文：默认会把群里所有聊天都记进上下文（不只是 @ 机器人的），
        但机器人只在被 @ 时才会回复。想改成只记 @ 的消息，
        到「模型与设置 → 对话上下文」把开关关掉即可。
        「保留对话轮次」控制记多久，1 轮约等于 2 条消息。
图片：识图开启时，直接发图或引用带图的消息都能看；
      群里的图片也会按「文字 → 图片 → 文字」的原顺序一起送给模型，
      不会先转成文字，所以模型能直接看到图。
表情回应：群内被 @ 时会贴一个表情（默认 424），
          想关掉或换别的，到「模型与设置 → 回复行为」改。

【五、面板功能】
概览 / 会话设置 / 模型与设置 / 用量统计 / 运行日志 / 在线测试

【六、升级（不想丢记录时）】
只替换 app\\bot.mjs 和 app\\public\\ 两处，别删 data\\ 文件夹，
也别覆盖 app\\config.yaml。数据库升级前会自动备份成 data\\bot.db.bak-*。
最稳的办法：先把整个文件夹复制一份当备份，再覆盖程序文件。

【七、常见问题】
显示未连接？      检查 SnowLuma 是否在跑、正向 WS 是否开启、端口是否一致。
@ 了没反应？      检查会话开关是否被关；看「运行日志」里的报错。
只贴表情、不回话？ 多半是「最大回复 tokens」太小：带思考过程的推理模型会把额度
                  用在思考上，正文还没开始就被截断。到「模型与设置」把
                  「最大回复 tokens」改成 4096 以上即可（日志里会写 finish_reason=length）。
想彻底重来？      删掉 data 文件夹（清空记录和面板设置），重启即可。
数据在哪？        data\\bot.db（数据库）、data\\logs（日志，留 7 天）、
                  data\\media（图片，留 3 天）。

============================================================
`;

const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

console.log('[package] building bundle...');
run(process.execPath, [path.join(root, 'esbuild.config.mjs')]);

console.log('[package] assembling %s', outDir);
await fsp.rm(path.join(root, 'release'), { recursive: true, force: true });
await fsp.mkdir(path.join(outDir, 'app'), { recursive: true });
await fsp.mkdir(path.join(outDir, 'runtime'), { recursive: true });

// App bundle + WebUI assets (never ship the dev database).
await fsp.cp(dist, path.join(outDir, 'app'), {
  recursive: true,
  filter: (src) => !/[\\/]data([\\/]|$)/.test(src),
});

// Fresh default config + example for the end user.
await fsp.copyFile(path.join(root, 'config.example.yaml'), path.join(outDir, 'app', 'config.yaml'));
await fsp.copyFile(path.join(root, 'config.example.yaml'), path.join(outDir, 'app', 'config.example.yaml'));
await fsp.copyFile(path.join(root, '.env.example'), path.join(outDir, 'app', '.env.example'));

// Bundled Node runtime so the target machine needs no install.
await fsp.copyFile(process.execPath, path.join(outDir, 'runtime', 'node.exe'));

// .env feeds ${VAR} in config.yaml; ship a blank one so it always exists.
await fsp.writeFile(path.join(outDir, 'app', '.env'), '', 'utf8');

await fsp.writeFile(path.join(outDir, '一键启动.bat'), LAUNCH_BAT, 'utf8');
await fsp.writeFile(path.join(outDir, '打开管理面板.bat'), PANEL_BAT, 'utf8');
await fsp.writeFile(path.join(outDir, '使用说明.txt'), README_TXT, 'utf8');

if (!fs.existsSync(path.join(outDir, 'runtime', 'node.exe'))) {
  throw new Error('node.exe was not copied');
}

console.log('[package] done -> %s', outDir);
