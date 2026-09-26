import dotenv from 'dotenv';
import { envFile } from './paths.js';

dotenv.config({ path: envFile });
dotenv.config();

import { QqAiBot } from './bot.js';
import { loadConfig } from './config.js';
import { Database, ensureDirs } from './db.js';
import { configureLogger, createLogger } from './logger.js';
import { configFile, dataDir } from './paths.js';
import { SettingsStore } from './settings.js';
import { startWebUi } from './webui/server.js';

const log = createLogger('main');

async function main(): Promise<void> {
  ensureDirs();
  const { config, created } = loadConfig();
  configureLogger({
    level: config.logging.level,
    keepDays: config.logging.keepDays,
    console: config.logging.console,
  });

  log.info('data dir: %s', dataDir);
  log.info('config: %s%s', configFile, created ? ' (已生成默认配置)' : '');

  if (config.historyImages.mode === 'caption') {
    log.warn(
      '当前 historyImages.mode=caption：历史图片会被转成文字描述。' +
        '若想让多模态模型直接按原顺序看图，请在面板「模型与设置 → 历史图片处理方式」改成 latest。',
    );
  }

  const db = new Database();
  const settings = new SettingsStore(config, db);
  const bot = new QqAiBot(config, db, settings);

  let server: ReturnType<typeof startWebUi> | null = null;
  if (config.webui.enabled) {
    server = startWebUi({
      config,
      db,
      settings,
      bot,
      onConfigSaved: (next) => {
        settings.updateConfig(next);
        log.info('config.yaml 已更新，部分连接设置需重启生效');
      },
    });
  } else {
    log.warn('WebUI 已关闭（config.webui.enabled = false）');
  }

  await bot.start();
  log.info('qqaibot 已启动，等待 SnowLuma 事件…');

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('收到 %s，正在退出…', signal);
    void bot.stop().finally(() => {
      db.close();
      if (server) server.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection: %s', String(reason)));
  process.on('uncaughtException', (err) => log.error('uncaught exception: %s', err.stack ?? err.message));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[fatal]', e);
  process.exit(1);
});
