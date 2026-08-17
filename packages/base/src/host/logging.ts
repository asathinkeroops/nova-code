import pino, { type Logger, type LoggerOptions } from "pino";

export type { Logger } from "pino";

export interface LoggerConfig {
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  pretty: boolean;
  destination?: string;
}

export function createLogger(config: LoggerConfig): Logger {
  const options: LoggerOptions = {
    level: config.level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (config.pretty) {
    options.transport = {
      target: "pino-pretty",
      options: {
        colorize: !config.destination,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname",
        ...(config.destination ? { destination: config.destination, mkdir: true } : {}),
      },
    };
    return pino(options);
  }

  if (config.destination) {
    return pino(
      options,
      pino.destination({ dest: config.destination, mkdir: true, sync: false }),
    );
  }
  return pino(options);
}
