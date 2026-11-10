import type { StartSessionOptions } from "../session.service.js";
import { IdentityError, major } from "./types.js";

export const mobileProfiles = [
  {
    id: "android-compact",
    label: "Android compact emulation",
    width: 393,
    height: 873,
    deviceScaleFactor: 2.75,
    orientation: "portraitPrimary",
    model: "Pixel 7",
    platformVersion: "13.0.0",
  },
  {
    id: "android-large",
    label: "Android large emulation",
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    orientation: "portraitPrimary",
    model: "Pixel 8 Pro",
    platformVersion: "14.0.0",
  },
  {
    id: "android-landscape",
    label: "Android landscape emulation",
    width: 873,
    height: 393,
    deviceScaleFactor: 2.75,
    orientation: "landscapePrimary",
    model: "Pixel 7",
    platformVersion: "13.0.0",
  },
].map((p) => ({
  ...p,
  runtime: "chromium-emulation" as const,
  capabilities: {
    touch: true,
    orientation: true,
    keyboard: "desktop-input-emulation",
    media: "host-dependent",
    downloads: true,
    realDevice: false,
  },
  limits: [
    "Desktop Chromium emulation; not Android OS or Safari",
    "Fonts, GPU, codecs and sensors depend on host",
    "No hardware attestation or mobile radio simulation",
  ],
}));

export function applyMobile(options: StartSessionOptions, browserVersion: string) {
  const p = mobileProfiles.find((p) => p.id === options.mobileProfile);
  if (!p) throw new IdentityError("unknown_mobile_profile", "Unknown mobile profile");
  if (options.compatibilityMode === "native" || options.skipFingerprintInjection)
    throw new IdentityError(
      "mobile_mode_conflict",
      "Mobile emulation requires compatible or legacy mode",
    );
  if (options.userAgent && !/Android/.test(options.userAgent))
    throw new IdentityError(
      "mobile_identity_conflict",
      "Android emulation requires an Android Chromium user agent",
    );
  if (
    options.dimensions &&
    (options.dimensions.width !== p.width || options.dimensions.height !== p.height)
  )
    throw new IdentityError(
      "mobile_dimensions_conflict",
      "Use the preset dimensions or a different preset",
    );
  const version =
    browserVersion.match(/\d+\.\d+\.\d+\.\d+/)?.[0] ?? `${major(browserVersion) ?? 0}.0.0.0`;
  const ua =
    options.userAgent ??
    `Mozilla/5.0 (Linux; Android ${p.platformVersion.split(".")[0]}; ${
      p.model
    }) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Mobile Safari/537.36`;
  options.userAgent = ua;
  options.deviceConfig = { device: "mobile" };
  options.dimensions = { width: p.width, height: p.height };
  // These declared values are deliberately limited to CDP-supported emulation. No GPU/font claims.
  options.fingerprint = {
    fingerprint: {
      navigator: {
        userAgent: ua,
        platform: "Linux armv8l",
        language: "en-US",
        languages: ["en-US", "en"],
        maxTouchPoints: 5,
        userAgentData: {
          brands: [{ brand: "Chromium", version: String(major(browserVersion)) }],
          mobile: true,
          platform: "Android",
          platformVersion: p.platformVersion,
          architecture: "arm",
          bitness: "64",
          model: p.model,
          uaFullVersion: version,
          fullVersionList: [{ brand: "Chromium", version }],
        },
      },
      screen: {
        width: p.width,
        height: p.height,
        availWidth: p.width,
        availHeight: p.height,
        innerWidth: p.width,
        innerHeight: p.height,
        outerWidth: p.width,
        outerHeight: p.height,
        devicePixelRatio: p.deviceScaleFactor,
        colorDepth: 24,
        pixelDepth: 24,
      },
      videoCard: null,
    },
    headers: {
      "accept-language": options.userPreferences?.intl?.accept_languages ?? "en-US,en;q=0.9",
    },
  } as unknown as StartSessionOptions["fingerprint"];
}
