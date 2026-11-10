import { FastifyServerOptions } from "fastify";
import { env } from "./env.js";
import stringify from "json-stringify-safe";

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

export const loggingConfig: LoggingConfig = {
  development: {
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
                    resultingMessage = `${message} ${stringify(args)}`;
                  } else {
                    resultingMessage = stringify(inputArgs);
                  }
                  return method.apply(this, [resultingMessage]);
                } catch (error) {
                  console.error(
                    "Error trying to process logs with verbose logging enabled: ",
                    error,
                  );
                }
              }
              return method.apply(this, inputArgs);
            },
          },
        }
      : {}),
    level: process.env.LOG_LEVEL || "debug",
  },
  production: { redact: credentialRedaction },
  test: false,
};
