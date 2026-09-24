import pino from 'pino';
import { config } from '../config.js';

// Ring buffer of recent log lines exposed to the web panel / CLI.
const RING_SIZE = 500;
export const logRing = [];

const ringStream = {
  write(line) {
    try {
      const obj = JSON.parse(line);
      logRing.push({ time: obj.time, level: obj.level, msg: obj.msg, module: obj.module, err: obj.err?.message });
      if (logRing.length > RING_SIZE) logRing.shift();
    } catch { /* ignore */ }
  },
};

const streams = [{ level: 'trace', stream: ringStream }];
if (process.stdout.isTTY || config.env === 'development') {
  const { default: pretty } = await import('pino-pretty');
  streams.push({ level: config.logLevel, stream: pretty({ colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' }) });
} else {
  streams.push({ level: config.logLevel, stream: process.stdout });
}

export const logger = pino({ level: 'trace', base: undefined }, pino.multistream(streams));
export default logger;
