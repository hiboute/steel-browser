import { FastifyServerOptions } from "fastify";
import { env } from "./env.js";
import stringify from "json-stringify-safe";
import { logValue, logText, requestLog } from "./utils/log-redaction.js";
import pino from "pino";

interface LoggingConfig {
  [key: string]: FastifyServerOptions["logger"];
}

const credentialRedaction = {
  paths: [
    "req.headers.authorization",
    "req.headers.cookie",
    'req.headers["x-steel-control"]',
    'req.headers["x-steel-proxy-secret"]',
    'req.headers["x-steel-webhook-token"]',
    "headers.authorization",
    'headers["X-Steel-Control"]',
    'headers["X-Steel-Proxy-Secret"]',
    "token",
    "controlToken",
    "pairingToken",
    "passphrase",
  ],
  censor: "[redacted]",
};

const serializers = {
  req: requestLog,
  err: (error: Error) =>
    logValue(pino.stdSerializers.err(error)) as ReturnType<typeof pino.stdSerializers.err>,
};

export const loggingConfig: LoggingConfig = {
  development: {
    serializers,
    redact: credentialRedaction,
    transport: {
      target: "pino-pretty",
      options: {
        translateTime: "HH:MM:ss Z",
        ignore: "pid,hostname",
      },
    },
    ...(env.ENABLE_VERBOSE_LOGGING
      ? {
          hooks: {
            logMethod(inputArgs: any[], method: any) {
              if (inputArgs.length > 1) {
                try {
                  let resultingMessage = "";
                  if (typeof inputArgs[0] === "string") {
                    const [message, ...args] = inputArgs;
                    resultingMessage = `${logText(message)} ${stringify(logValue(args))}`;
                  } else {
                    resultingMessage = stringify(logValue(inputArgs));
                  }
                  return method.apply(this, [resultingMessage]);
                } catch (error) {
                  console.error(
                    "Error trying to process logs with verbose logging enabled: ",
                    error,
                  );
                }
              }
              return method.apply(
                this,
                inputArgs.map((value) => logValue(value)),
              );
            },
          },
        }
      : {}),
    level: process.env.LOG_LEVEL || "debug",
  },
  production: { redact: credentialRedaction, serializers },
  test: false,
};
