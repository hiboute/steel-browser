import { describe, expect, it } from "vitest";
import {
  ACCEPT_LABELS,
  CONSENT_RULES,
  REJECT_LABELS,
  chooseConsentAction,
  classifyLabel,
  normalizeLabel,
  ruleAppliesToHost,
  type ConsentContainer,
} from "./consent-rules.js";

describe("normalizeLabel", () => {
  it("folds case, accents, punctuation and spacing", () => {
    expect(normalizeLabel("  Tout   REFUSER ! ")).toBe("tout refuser");
    expect(normalizeLabel("J’accepte")).toBe("j accepte");
    expect(normalizeLabel("Ablehnen und schließen")).toBe("ablehnen und schliessen");
    expect(normalizeLabel("Odrzuć wszystkie")).toBe("odrzuc wszystkie");
    expect(normalizeLabel("Kun nødvendige")).toBe("kun nodvendige");
    expect(normalizeLabel("Accept & close ✕")).toBe("accept close");
    expect(normalizeLabel(null)).toBe("");
  });
});

describe("label lists", () => {
  it("never put the same label on both sides", () => {
    for (const label of REJECT_LABELS) expect(ACCEPT_LABELS.has(label), label).toBe(false);
  });

  it("hold whole labels in normalised form", () => {
    for (const label of [...REJECT_LABELS, ...ACCEPT_LABELS]) {
      expect(label).toBe(normalizeLabel(label));
      expect(label.length).toBeGreaterThan(1);
    }
  });
});

describe("classifyLabel", () => {
  it.each([
    ["Reject All", "reject"],
    ["REJECT ALL COOKIES", "reject"],
    ["Decline", "reject"],
    ["Only necessary cookies", "reject"],
    ["Accept only essential cookies", "reject"],
    ["Continue without accepting", "reject"],
    ["Tout refuser", "reject"],
    ["Continuer sans accepter →", "reject"],
    ["Alle ablehnen", "reject"],
    ["Nur notwendige Cookies", "reject"],
    ["Rechazar todo", "reject"],
    ["Rifiuta tutto", "reject"],
    ["Rejeitar tudo", "reject"],
    ["Alles weigeren", "reject"],
    ["Odrzuć wszystkie", "reject"],
    ["Avvisa alla", "reject"],
    ["Accept All", "accept"],
    ["I agree", "accept"],
    ["OK", "accept"],
    ["Tout accepter", "accept"],
    ["J'accepte", "accept"],
    ["Alle akzeptieren", "accept"],
    ["Aceptar todo", "accept"],
    ["Accetta tutto", "accept"],
    ["Alles accepteren", "accept"],
  ])("%s is %s", (label, action) => {
    expect(classifyLabel(label)).toBe(action);
  });

  it.each([
    "",
    "Manage preferences",
    "Cookie settings",
    "More options",
    "Learn more",
    "Save my choices",
    "Close",
    "Submit",
    "Delete account",
    "Reject all and delete my account",
    "Do not reject",
    "Accept the terms and place the order",
    "Pay now",
    "Sign in",
    "No",
    "Yes",
    "Cancel",
    "Reject all ".repeat(10),
  ])("%j identifies nothing", (label) => {
    expect(classifyLabel(label)).toBeUndefined();
  });
});

describe("consent rules", () => {
  it("name every manager once and give each a container", () => {
    const names = CONSENT_RULES.map((rule) => rule.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of ["onetrust", "cookiebot", "didomi", "quantcast", "usercentrics", "trustarc"])
      expect(names).toContain(name);
    for (const rule of CONSENT_RULES) {
      expect(rule.containers.length).toBeGreaterThan(0);
      // A rule without its own button selectors must say that labels decide.
      if (!rule.reject.length && !rule.accept.length) expect(rule.labels, rule.name).toBe(true);
    }
  });

  it("binds whole-page rules to their hosts", () => {
    const google = CONSENT_RULES.find((rule) => rule.name === "google-consent-page")!;
    expect(google.containers).toEqual(["body"]);
    expect(ruleAppliesToHost(google, "consent.google.com")).toBe(true);
    expect(ruleAppliesToHost(google, "consent.google.fr")).toBe(true);
    expect(ruleAppliesToHost(google, "consent.google.co.uk")).toBe(true);
    expect(ruleAppliesToHost(google, "consent.youtube.com")).toBe(true);
    expect(ruleAppliesToHost(google, "www.google.com")).toBe(false);
    expect(ruleAppliesToHost(google, "consent.google.com.evil.example")).toBe(false);
    expect(ruleAppliesToHost(google, "example.com")).toBe(false);
    const onetrust = CONSENT_RULES.find((rule) => rule.name === "onetrust")!;
    expect(ruleAppliesToHost(onetrust, "example.com")).toBe(true);
  });
});

describe("chooseConsentAction", () => {
  const onetrust: ConsentContainer = {
    manager: "onetrust",
    buttons: [
      { label: "Cookies Settings" },
      { label: "Reject All", reject: true },
      { label: "Accept All Cookies", accept: true },
    ],
  };

  it("prefers reject in both modes", () => {
    for (const mode of ["reject", "accept"] as const) {
      expect(chooseConsentAction([onetrust], mode)).toEqual({
        container: 0,
        button: 1,
        action: "reject",
        manager: "onetrust",
        label: "Reject All",
      });
    }
  });

  it("accepts only in accept mode, and only when the banner offers no reject", () => {
    const acceptOnly: ConsentContainer = {
      manager: "onetrust",
      buttons: [{ label: "Cookies Settings" }, { label: "Accept All Cookies", accept: true }],
    };
    expect(chooseConsentAction([acceptOnly], "reject")).toBeUndefined();
    expect(chooseConsentAction([acceptOnly], "accept")).toMatchObject({
      button: 1,
      action: "accept",
    });
  });

  it("trusts a manager's selector whatever language the button is in", () => {
    const localized: ConsentContainer = {
      manager: "cookiebot",
      buttons: [{ label: "Vain välttämättömät evästeet", reject: true }],
    };
    expect(chooseConsentAction([localized], "reject")).toMatchObject({ action: "reject" });
  });

  it("does not click a selector whose label says the opposite", () => {
    const contradictory: ConsentContainer = {
      manager: "trustarc",
      buttons: [{ label: "Accept all", reject: true }],
    };
    expect(chooseConsentAction([contradictory], "accept")).toBeUndefined();
    const both: ConsentContainer = {
      manager: "trustarc",
      buttons: [{ label: "Continue", reject: true, accept: true }],
    };
    expect(chooseConsentAction([both], "accept")).toBeUndefined();
  });

  it("ignores labels in a known container unless its rule says labels decide", () => {
    const plain: ConsentContainer = { manager: "sourcepoint", buttons: [{ label: "Decline" }] };
    expect(chooseConsentAction([plain], "accept")).toBeUndefined();
    const labelled: ConsentContainer = {
      manager: "quantcast",
      labels: true,
      buttons: [{ label: "MORE OPTIONS" }, { label: "DISAGREE" }, { label: "AGREE" }],
    };
    expect(chooseConsentAction([labelled], "reject")).toMatchObject({
      button: 1,
      action: "reject",
    });
  });

  it("needs an exact label in a generic container", () => {
    const generic: ConsentContainer = {
      manager: "generic",
      generic: true,
      labels: true,
      buttons: [{ label: "Customise" }, { label: "Reject all and continue to checkout" }],
    };
    expect(chooseConsentAction([generic], "accept")).toBeUndefined();
    generic.buttons.push({ label: "Refuser", reject: true });
    // Selector flags mean nothing in a generic container; the label still decides.
    expect(chooseConsentAction([generic], "reject")).toMatchObject({ button: 2, label: "Refuser" });
  });

  it("does not use a button whose accessible name and text disagree", () => {
    const mismatch: ConsentContainer = {
      manager: "generic",
      generic: true,
      labels: true,
      buttons: [{ label: "Reject all", text: "Accept all" }],
    };
    expect(chooseConsentAction([mismatch], "accept")).toBeUndefined();
    const longName: ConsentContainer = {
      manager: "generic",
      generic: true,
      labels: true,
      buttons: [{ label: "Reject all cookies and close this dialog", text: "Reject all" }],
    };
    expect(chooseConsentAction([longName], "reject")).toMatchObject({ action: "reject" });
  });

  it("takes known managers before generic containers, and reject anywhere before accept", () => {
    const generic: ConsentContainer = {
      manager: "generic",
      generic: true,
      labels: true,
      buttons: [{ label: "Reject" }],
    };
    expect(chooseConsentAction([generic, onetrust], "reject")).toMatchObject({
      container: 1,
      manager: "onetrust",
    });
    const acceptOnly: ConsentContainer = {
      manager: "didomi",
      buttons: [{ label: "Agree", accept: true }],
    };
    expect(chooseConsentAction([acceptOnly, generic], "accept")).toMatchObject({
      container: 1,
      action: "reject",
    });
  });

  it("does nothing without containers or buttons", () => {
    expect(chooseConsentAction([], "accept")).toBeUndefined();
    expect(chooseConsentAction([{ manager: "onetrust", buttons: [] }], "accept")).toBeUndefined();
  });
});
