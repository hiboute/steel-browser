import { z } from "zod";
import type { StartSessionOptions } from "../session.service.js";

export const Name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/);
export const Mode = z.enum(["native", "compatible", "legacy"]);
export type CompatibilityMode = z.infer<typeof Mode>;
export const Settings = z
  .object({
    compatibilityMode: Mode.default("compatible"),
    userAgent: z.string().min(1).max(1024).optional(),
    timezone: z
      .string()
      .max(100)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }, "Invalid timezone")
      .optional(),
    locale: z
      .string()
      .regex(/^[a-zA-Z0-9,-]{2,120}$/)
      .optional(),
    dimensions: z
      .object({
        width: z.number().int().min(240).max(7680),
        height: z.number().int().min(240).max(4320),
      })
      .optional(),
    headless: z.boolean().optional(),
    mobileProfile: Name.optional(),
    egress: z.string().max(80).optional(),
  })
  .strict();
export type IdentitySettings = z.infer<typeof Settings>;
export const ProfileInput = z
  .object({
    expectedRevision: z.number().int().nonnegative().optional(),
    settings: Settings,
    bindings: z
      .object({ browserProfile: Name.optional(), cookieSets: z.array(Name).max(20).optional() })
      .strict()
      .optional(),
  })
  .strict();
export interface IdentityManifest {
  schemaVersion: 2;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  browserVersion?: string;
  settings: IdentitySettings;
  bindings?: { browserProfile?: string; cookieSets?: string[] };
  fingerprint?: StartSessionOptions["fingerprint"];
  migration?: { from: number; at: string; reason: string };
}
export const SiteInput = z
  .object({
    expectedRevision: z.number().int().nonnegative().optional(),
    origin: z
      .string()
      .url()
      .refine((v) => {
        try {
          const u = new URL(v);
          return /^https?:$/.test(u.protocol) && u.origin === v && !u.username && !u.password;
        } catch {
          return false;
        }
      }, "Use an exact HTTP(S) origin without path"),
    identityProfile: Name.optional(),
    settings: Settings.partial().optional(),
    permissions: z
      .array(
        z.enum([
          "geolocation",
          "notifications",
          "camera",
          "microphone",
          "clipboard-read",
          "clipboard-write",
        ]),
      )
      .max(6)
      .default([]),
    extensions: z.array(z.string().max(200)).max(10).default([]),
    interaction: z
      .object({
        frictionDetection: z.boolean().default(true),
        actionDelayMs: z.number().int().min(0).max(5000).default(0),
      })
      .strict()
      .default({ frictionDetection: true, actionDelayMs: 0 }),
  })
  .strict();
export type SiteProfile = z.infer<typeof SiteInput> & {
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastSuccessfulAt?: string;
};
export interface IdentityOptions {
  identityProfile?: string;
  compatibilityMode?: CompatibilityMode;
  siteProfile?: string;
  mobileProfile?: string;
  continuityPolicy?: "warn" | "require-confirmation";
  continuityToken?: string;
  frictionDetection?: boolean;
}
declare module "../session.service.js" {
  interface StartSessionOptions extends IdentityOptions {}
}
declare module "../../types/browser.js" {
  interface BrowserLauncherOptions {
    compatibilityMode?: CompatibilityMode;
  }
}
export class IdentityError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
    public detail?: unknown,
  ) {
    super(message);
  }
}
export function major(version?: string): number | undefined {
  // The last form covers builds that name themselves differently ("Chrome for Testing 153.0.1.2").
  const m = version?.match(
    /(?:Chrome|Chromium|HeadlessChrome)[/ ](\d+)|^(\d+)\.|\b(\d+)\.\d+\.\d+\.\d+\b/,
  );
  return m ? Number(m[1] ?? m[2] ?? m[3]) : undefined;
}
export function now() {
  return new Date().toISOString();
}
export function safeOrigin(raw: string) {
  try {
    return new URL(raw).origin;
  } catch {
    return "unavailable";
  }
}
