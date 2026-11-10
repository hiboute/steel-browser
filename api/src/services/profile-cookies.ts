import { z } from "zod";
import { env } from "../env.js";
import { CDPCookieSchema, type CookieData } from "./context/types.js";
import { PlatformStore } from "./platform/store.js";

export const PROFILE_COOKIE_SIDECAR = "steel-cookies.json";
const cookiesSchema = z.array(CDPCookieSchema);

/** Read both legacy JSON arrays and the authenticated platform envelope. */
export async function readProfileCookies(
  profileDir: string,
  secret = env.STEEL_DATA_KEY || env.COOKIE_LIBRARY_KEY,
): Promise<CookieData[] | undefined> {
  const stored = await new PlatformStore(profileDir, secret).read<unknown>(PROFILE_COOKIE_SIDECAR);
  return stored === undefined ? undefined : cookiesSchema.parse(stored);
}

/** Atomic mode-0600 write; preserve an existing encrypted file if its key is unavailable. */
export async function writeProfileCookies(
  profileDir: string,
  cookies: CookieData[],
  secret = env.STEEL_DATA_KEY || env.COOKIE_LIBRARY_KEY,
): Promise<void> {
  const store = new PlatformStore(profileDir, secret);
  await readProfileCookies(profileDir, secret);
  await store.write(PROFILE_COOKIE_SIDECAR, cookiesSchema.parse(cookies));
}
