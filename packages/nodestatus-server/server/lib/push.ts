import { timingSafeEqual } from 'crypto';
import { Telegraf } from 'telegraf';
import HttpsProxyAgent from 'https-proxy-agent';
import { IWebSocket } from '../../types/server';
import { logger } from './utils';
import type NodeStatus from './nodestatus';

type PushOptions = {
  pushTimeOut: number;
  telegram?: {
    bot_token: string;
    chat_id: string[];
    web_hook?: string;
    proxy?: string;
  }
};

export default function createPush(this: NodeStatus, options: PushOptions) {
  const pushList: Array<(message: string) => void> = [];
  /* ip -> timer */
  const timerMap = new Map<string, NodeJS.Timer>();
  const entities = new Set(['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!', '\\']);

  const parseEntities = (msg: any): string => {
    let str: string;
    if (typeof msg !== 'string') str = msg.toString();
    else str = msg;
    let newStr = '';
    for (const char of str) {
      if (entities.has(char)) {
        newStr += '\\';
      }
      newStr += char;
    }
    return newStr;
  };

  const getBotStatus = (): string => {
    let str = '';
    let online = 0;
    this.serversPub.forEach(obj => {
      const item = new Proxy(obj, {
        get(target, key) {
          const value = Reflect.get(target, key);
          return typeof value === 'string'
            ? parseEntities(value)
            : value;
        }
      });
      str += `节点名: *${item.name}*\n当前状态: `;
      if (item.status.online4 || item.status.online6) {
        str += '✅*在线*\n';
        online++;
      } else {
        str += '❌*离线*';
        str += '\n\n';
        return;
      }
      str += `负载: ${parseEntities(item.status.load.toFixed(2))} \n`;
      str += `CPU: ${Math.round(item.status.cpu)}% \n`;
      str += `内存: ${Math.round((item.status.memory_used / item.status.memory_total) * 100)}% \n`;
      str += `硬盘: ${Math.round((item.status.hdd_used / item.status.hdd_total) * 100)}% \n`;
      str += '\n';
    });
    return `🍊*NodeStatus* \n🤖 当前有 ${this.serversPub.length} 台服务器, 其中在线 ${online} 台\n\n${str}`;
  };

  const tgConfig = options.telegram;

  if (tgConfig?.bot_token) {
    const bot = new Telegraf(tgConfig.bot_token, {
      ...(tgConfig.proxy && {
        telegram: {
          agent: HttpsProxyAgent(tgConfig.proxy)
        }
      })
    });

    const chatId = new Set<string>(tgConfig.chat_id);

    bot.command('start', ctx => {
      const currentChat = ctx.message.chat.id.toString();
      if (chatId.has(currentChat)) {
        ctx.reply(`🍊NodeStatus\n🤖 Hi, this chat id is *${parseEntities(currentChat)}*\\.\nYou have access to this service\\. I will alert you when your servers changed\\.\nYou are currently using NodeStatus: *${parseEntities(process.env.npm_package_version)}*`, { parse_mode: 'MarkdownV2' });
      } else {
        ctx.reply(`🍊NodeStatus\n🤖 Hi, this chat id is *${parseEntities(currentChat)}*\\.\nYou *do not* have permission to use this service\\.\nPlease check your settings\\.`, { parse_mode: 'MarkdownV2' });
      }
    });

    bot.command('status', ctx => {
      if (chatId.has(ctx.message.chat.id.toString())) {
        ctx.reply(getBotStatus(), { parse_mode: 'MarkdownV2' });
      } else {
        ctx.reply('🍊NodeStatus\n*No permission*', { parse_mode: 'MarkdownV2' });
      }
    });

    if (tgConfig.web_hook) {
      const secretPath = `/telegraf/${bot.secretPathComponent()}`;
      bot.telegram.setWebhook(`${tgConfig.web_hook}${secretPath}`).then(() => logger.info('🤖 Telegram Bot is running using webhook'));

      this.server.on('request', (req, res) => {
        if (
          req.url
          && req.url.length === secretPath.length
          && timingSafeEqual(Buffer.from(secretPath), Buffer.from(req.url))
        ) {
          bot.webhookCallback(secretPath)(req, res);
          res.statusCode = 200;
        }
      });
    } else {
      bot.launch().then(() => logger.info('🤖 Telegram Bot is running using polling'));
    }

    pushList.push(message => [...chatId].map(id => bot.telegram.sendMessage(id, `${message}`, { parse_mode: 'MarkdownV2' })));
  }

  this.onServerConnected = (socket: IWebSocket, username) => {
    const ip = socket.ipAddress;
    if (ip) {
      const timer = timerMap.get(ip);
      if (timer) {
        clearTimeout(timer);
        timerMap.delete(ip);
      } else {
        return Promise.all(pushList.map(
          fn => fn(`🍊*NodeStatus* \n😀 One new server has connected\\! \n\n *用户名*: ${parseEntities(username)} \n *节点名*: ${parseEntities(this.servers[username].name)} \n *时间*: ${parseEntities(new Date())}`)
        ));
      }
    }
  };
  this.onServerDisconnected = (socket: IWebSocket, username) => {
    const ip = socket.ipAddress;
    const timer = setTimeout(
      () => {
        Promise.all(pushList.map(
          fn => fn(`🍊*NodeStatus* \n😰 One server has disconnected\\! \n\n *用户名*: ${parseEntities(username)} \n *节点名*: ${parseEntities(this.servers[username]?.name)} \n *时间*: ${parseEntities(new Date())}`)
        )).then();
        ip && timerMap.delete(ip);
      },
      options.pushTimeOut * 1000
    );
    ip && timerMap.set(ip, timer);
  };
}
