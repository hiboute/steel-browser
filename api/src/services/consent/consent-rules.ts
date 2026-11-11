/**
 * Cookie consent banners: which containers are consent managers, which of their
 * buttons reject or accept, and the decision of what to click. Everything here
 * is pure; the page side (consent-scan.ts) only reports what it sees.
 */

export interface ConsentRule {
  /** Name reported in the session details and timeline. */
  name: string;
  /** Selectors of the banner. A button is only ever looked for inside one of these. */
  containers: string[];
  /** Selectors, inside the container, that are the manager's own reject button. */
  reject: string[];
  /** Selectors, inside the container, that are the manager's own accept button. */
  accept: string[];
  /**
   * Also recognise this container's buttons by their label (the strict lists
   * below) when no selector matches. Off unless the container selector alone
   * proves the element is a consent banner.
   */
  labels?: boolean;
  /**
   * Hosts (suffix match) the document must be on for the rule to apply. Used
   * for consent pages that are a whole document rather than a banner.
   */
  hosts?: string[];
}

/** Consent managers recognised by their own markup. Order is priority. */
export const CONSENT_RULES: readonly ConsentRule[] = [
  {
    name: "onetrust",
    containers: ["#onetrust-banner-sdk", "#onetrust-pc-sdk"],
    reject: ["#onetrust-reject-all-handler", ".ot-pc-refuse-all-handler"],
    accept: ["#onetrust-accept-btn-handler", "#accept-recommended-btn-handler"],
  },
  {
    name: "cookiebot",
    containers: ["#CybotCookiebotDialog"],
    reject: [
      "#CybotCookiebotDialogBodyButtonDecline",
      "#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll",
    ],
    accept: [
      "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
      "#CybotCookiebotDialogBodyButtonAccept",
    ],
  },
  {
    name: "didomi",
    containers: ["#didomi-popup", "#didomi-notice"],
    reject: ["#didomi-notice-disagree-button", ".didomi-continue-without-agreeing"],
    accept: ["#didomi-notice-agree-button"],
  },
  {
    name: "quantcast",
    containers: ["#qc-cmp2-ui", ".qc-cmp2-container"],
    // Its secondary button is "Disagree" on some sites and "More options" on
    // others, so the label decides.
    reject: [],
    accept: [],
    labels: true,
  },
  {
    name: "usercentrics",
    containers: ["#usercentrics-root", "#usercentrics-cmp-ui", "#uc-center-container"],
    reject: ['[data-testid="uc-deny-all-button"]', "button#deny", "button.uc-deny-button"],
    accept: ['[data-testid="uc-accept-all-button"]', "button#accept", "button.uc-accept-button"],
  },
  {
    name: "trustarc",
    containers: ["#truste-consent-track", "#consent_blackbar", ".truste_box_overlay"],
    reject: ["#truste-consent-required", ".rejectAll"],
    accept: ["#truste-consent-button", ".acceptAll"],
  },
  {
    name: "sourcepoint",
    // Rendered inside its own iframe; choice type 13 is reject all, 11 accept all.
    containers: ['.message-container:has(button[class*="sp_choice_type_"])'],
    reject: ["button.sp_choice_type_13", "button.sp_choice_type_REJECT_ALL"],
    accept: ["button.sp_choice_type_11", "button.sp_choice_type_ACCEPT_ALL"],
  },
  {
    name: "google-funding-choices",
    containers: [".fc-consent-root"],
    reject: [".fc-cta-do-not-consent"],
    accept: [".fc-cta-consent"],
  },
  {
    name: "google-search",
    containers: ['div[role="dialog"]:has(#W0wltc)', 'div[role="dialog"]:has(#L2AGLb)'],
    reject: ["#W0wltc"],
    accept: ["#L2AGLb"],
  },
  {
    name: "google-consent-page",
    hosts: ["consent.google.com", "consent.youtube.com"],
    containers: ["body"],
    // Localised buttons inside the save forms; the label decides.
    reject: [],
    accept: [],
    labels: true,
  },
  {
    name: "cookieyes",
    containers: [".cky-consent-container", ".cky-modal"],
    reject: [".cky-btn-reject"],
    accept: [".cky-btn-accept"],
  },
  {
    name: "complianz",
    containers: [".cmplz-cookiebanner"],
    reject: [".cmplz-btn.cmplz-deny"],
    accept: [".cmplz-btn.cmplz-accept"],
  },
  {
    name: "iubenda",
    containers: ["#iubenda-cs-banner"],
    reject: [".iubenda-cs-reject-btn"],
    accept: [".iubenda-cs-accept-btn"],
  },
  {
    name: "osano",
    containers: [".osano-cm-dialog", ".osano-cm-window__dialog"],
    reject: [".osano-cm-denyAll", ".osano-cm-deny"],
    accept: [".osano-cm-accept-all", ".osano-cm-accept"],
  },
  {
    name: "klaro",
    containers: [".klaro .cookie-notice", ".klaro .cookie-modal"],
    reject: [".cn-decline", ".cm-btn-decline"],
    accept: [".cm-btn-accept-all", ".cm-btn-success"],
  },
  {
    name: "borlabs",
    containers: ["#BorlabsCookieBox"],
    reject: ["._brlbs-refuse-btn a", "a._brlbs-refuse-btn", "[data-cookie-refuse]"],
    accept: ["[data-cookie-accept-all]"],
  },
  {
    name: "axeptio",
    containers: ["#axeptio_overlay"],
    reject: ["#axeptio_btn_dismiss"],
    accept: ["#axeptio_btn_acceptAll"],
  },
  {
    name: "tarteaucitron",
    containers: ["#tarteaucitronAlertBig"],
    reject: ["#tarteaucitronAllDenied2"],
    accept: ["#tarteaucitronPersonalize2"],
  },
  {
    name: "consentmanager",
    containers: ["#cmpbox"],
    reject: [".cmpboxbtnno"],
    accept: [".cmpboxbtnyes"],
  },
  {
    name: "hubspot",
    containers: ["#hs-eu-cookie-confirmation"],
    reject: ["#hs-eu-decline-button"],
    accept: ["#hs-eu-confirmation-button"],
  },
  {
    name: "civic",
    containers: ["#ccc-notify", "#ccc-content"],
    reject: ["#ccc-notify-reject", "#ccc-reject-settings"],
    accept: ["#ccc-notify-accept", "#ccc-recommended-settings"],
  },
  {
    name: "termly",
    containers: ["#termly-code-snippet-support"],
    reject: ['[data-tid="banner-decline"]'],
    accept: ['[data-tid="banner-accept"]'],
  },
];

/**
 * Lowercases, removes accents and punctuation, collapses spaces: "J'accepte !"
 * becomes "j accepte". Labels are compared in this form only.
 */
export function normalizeLabel(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/ł/g, "l")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Whole labels, not fragments: a button is recognised only when its accessible
// name is exactly one of these once normalised.
const REJECT_LABELS_RAW = [
  // English
  "Reject all",
  "Reject",
  "Reject all cookies",
  "Reject cookies",
  "Reject all and close",
  "Reject optional cookies",
  "Reject additional cookies",
  "Reject non-essential",
  "Reject non-essential cookies",
  "Reject all non-essential cookies",
  "Reject all optional cookies",
  "Decline",
  "Decline all",
  "Decline cookies",
  "Decline all cookies",
  "Decline optional cookies",
  "I decline",
  "Deny",
  "Deny all",
  "Deny all cookies",
  "Refuse",
  "Refuse all",
  "Refuse all cookies",
  "Disagree",
  "I disagree",
  "Do not accept",
  "Do not consent",
  "I do not accept",
  "I do not agree",
  "Only necessary",
  "Necessary only",
  "Only necessary cookies",
  "Necessary cookies only",
  "Use necessary cookies only",
  "Only essential",
  "Essential only",
  "Only essential cookies",
  "Essential cookies only",
  "Use essential cookies only",
  "Only required",
  "Required only",
  "Only required cookies",
  "Required cookies only",
  "Accept only necessary",
  "Accept only necessary cookies",
  "Accept necessary cookies only",
  "Accept only essential",
  "Accept only essential cookies",
  "Accept essential cookies only",
  "Allow only necessary",
  "Allow necessary only",
  "Allow only necessary cookies",
  "Allow essential only",
  "Allow only essential cookies",
  "Allow essential cookies only",
  "Continue without accepting",
  "Continue without agreeing",
  "Continue without consent",
  // French
  "Tout refuser",
  "Refuser",
  "Refuser tout",
  "Refuser les cookies",
  "Refuser tous les cookies",
  "Refuser et fermer",
  "Je refuse",
  "Tout rejeter",
  "Rejeter",
  "Continuer sans accepter",
  "Cookies essentiels uniquement",
  "Nécessaires uniquement",
  "Uniquement les cookies nécessaires",
  "Accepter uniquement les cookies nécessaires",
  "Refuser les cookies optionnels",
  // German
  "Alle ablehnen",
  "Ablehnen",
  "Alles ablehnen",
  "Cookies ablehnen",
  "Alle Cookies ablehnen",
  "Optionale Cookies ablehnen",
  "Ablehnen und schließen",
  "Nicht akzeptieren",
  "Nicht zustimmen",
  "Nur notwendige",
  "Nur notwendige Cookies",
  "Nur notwendige Cookies akzeptieren",
  "Nur erforderliche",
  "Nur erforderliche Cookies",
  "Nur essenzielle",
  "Nur essenzielle Cookies",
  "Nur essenzielle Cookies akzeptieren",
  "Nur technisch notwendige",
  "Nur technisch notwendige Cookies",
  "Weiter ohne Einwilligung",
  "Verweigern",
  "Alle verweigern",
  // Spanish
  "Rechazar todo",
  "Rechazar",
  "Rechazar todas",
  "Rechazar todas las cookies",
  "Rechazar cookies",
  "Rechazar las cookies",
  "Rechazar y cerrar",
  "Denegar",
  "Denegar todas",
  "Denegar todo",
  "No acepto",
  "Solo necesarias",
  "Solo las necesarias",
  "Solo cookies necesarias",
  "Continuar sin aceptar",
  // Italian
  "Rifiuta tutto",
  "Rifiuta",
  "Rifiuta tutti",
  "Rifiuta tutti i cookie",
  "Rifiuta e chiudi",
  "Rifiuto",
  "Nega",
  "Nega tutto",
  "Non accetto",
  "Solo necessari",
  "Solo cookie necessari",
  "Continua senza accettare",
  // Portuguese
  "Rejeitar tudo",
  "Rejeitar",
  "Rejeitar todos",
  "Rejeitar todos os cookies",
  "Rejeitar cookies",
  "Recusar",
  "Recusar tudo",
  "Recusar todos",
  "Recusar cookies",
  "Não aceito",
  "Apenas necessários",
  "Apenas cookies necessários",
  "Somente necessários",
  "Continuar sem aceitar",
  // Dutch
  "Alles weigeren",
  "Weigeren",
  "Alle weigeren",
  "Alle cookies weigeren",
  "Cookies weigeren",
  "Alles afwijzen",
  "Afwijzen",
  "Niet akkoord",
  "Alleen noodzakelijke",
  "Alleen noodzakelijke cookies",
  "Alleen noodzakelijk",
  "Alleen functionele cookies",
  "Doorgaan zonder te accepteren",
  // Polish
  "Odrzuć wszystkie",
  "Odrzuć",
  "Odrzuć wszystko",
  "Nie zgadzam się",
  "Tylko niezbędne",
  "Odmów",
  // Swedish, Danish, Norwegian, Finnish
  "Avvisa alla",
  "Avvisa",
  "Neka alla",
  "Neka",
  "Endast nödvändiga",
  "Endast nödvändiga cookies",
  "Godkänn endast nödvändiga",
  "Afvis alle",
  "Afvis",
  "Afvis alle cookies",
  "Kun nødvendige",
  "Tillad kun nødvendige",
  "Avvis alle",
  "Avvis",
  "Avslå alle",
  "Avslå",
  "Hylkää kaikki",
  "Hylkää",
  "Vain välttämättömät",
  "Kieltäydy",
];

const ACCEPT_LABELS_RAW = [
  // English
  "Accept all",
  "Accept",
  "Accept all cookies",
  "Accept cookies",
  "Accept and close",
  "Accept & close",
  "Accept and continue",
  "Accept all and close",
  "Accept all and continue",
  "Allow all",
  "Allow all cookies",
  "Allow cookies",
  "Allow",
  "I accept",
  "I agree",
  "Agree",
  "Agree and close",
  "Agree and continue",
  "Agree to all",
  "Yes, I agree",
  "Yes, I accept",
  "Consent",
  "Got it",
  "OK",
  "Okay",
  // French
  "Tout accepter",
  "Accepter",
  "Accepter tout",
  "Accepter et fermer",
  "Accepter les cookies",
  "Accepter tous les cookies",
  "J'accepte",
  "D'accord",
  "Autoriser",
  "Tout autoriser",
  // German
  "Alle akzeptieren",
  "Akzeptieren",
  "Alles akzeptieren",
  "Alle Cookies akzeptieren",
  "Cookies akzeptieren",
  "Akzeptieren und schließen",
  "Zustimmen",
  "Allen zustimmen",
  "Ich stimme zu",
  "Alle zulassen",
  "Alle erlauben",
  "Einverstanden",
  "Verstanden",
  // Spanish
  "Aceptar todo",
  "Aceptar",
  "Aceptar todas",
  "Aceptar todas las cookies",
  "Aceptar cookies",
  "Aceptar y cerrar",
  "Acepto",
  "Permitir todas",
  "De acuerdo",
  "Entendido",
  // Italian
  "Accetta tutto",
  "Accetta",
  "Accetta tutti",
  "Accetta tutti i cookie",
  "Accetta e chiudi",
  "Accetto",
  "Consenti tutti",
  "Ho capito",
  // Portuguese
  "Aceitar tudo",
  "Aceitar",
  "Aceitar todos",
  "Aceitar todos os cookies",
  "Aceitar cookies",
  "Aceito",
  "Concordo",
  "Permitir todos",
  // Dutch
  "Alles accepteren",
  "Accepteren",
  "Alle cookies accepteren",
  "Cookies accepteren",
  "Alles toestaan",
  "Akkoord",
  "Ik ga akkoord",
  // Polish
  "Akceptuj wszystkie",
  "Akceptuj",
  "Akceptuję",
  "Zaakceptuj wszystkie",
  "Zaakceptuj",
  "Zgadzam się",
  // Swedish, Danish, Norwegian, Finnish
  "Acceptera alla",
  "Acceptera",
  "Godkänn alla",
  "Godkänn",
  "Tillåt alla",
  "Accepter alle",
  "Tillad alle",
  "Godta alle",
  "Godta",
  "Aksepter alle",
  "Aksepter",
  "Hyväksy kaikki",
  "Hyväksy",
  "Salli kaikki",
];

export const REJECT_LABELS: ReadonlySet<string> = new Set(REJECT_LABELS_RAW.map(normalizeLabel));
export const ACCEPT_LABELS: ReadonlySet<string> = new Set(ACCEPT_LABELS_RAW.map(normalizeLabel));

export type ConsentAction = "reject" | "accept";

/** What a button's accessible name says it does, or undefined when it is not on a list. */
export function classifyLabel(label: string | null | undefined): ConsentAction | undefined {
  const normalized = normalizeLabel(label);
  if (!normalized || normalized.length > 60) return undefined;
  if (REJECT_LABELS.has(normalized)) return "reject";
  if (ACCEPT_LABELS.has(normalized)) return "accept";
  return undefined;
}

/** One visible button of a consent container, as the page reports it. */
export interface ConsentButton {
  /** Accessible name: aria-label, else the visible text. */
  label: string;
  /** Visible text, when it differs from the accessible name. */
  text?: string;
  /** It matches one of the manager's own reject selectors. */
  reject?: boolean;
  /** It matches one of the manager's own accept selectors. */
  accept?: boolean;
}

/** One visible consent container, as the page reports it. */
export interface ConsentContainer {
  /** Rule name, or "generic" for a container recognised by its attributes and text. */
  manager: string;
  generic?: boolean;
  /** Buttons may be recognised by label (always the case for a generic container). */
  labels?: boolean;
  buttons: ConsentButton[];
}

export interface ConsentDecision {
  container: number;
  button: number;
  action: ConsentAction;
  manager: string;
  label: string;
}

function labelAction(button: ConsentButton): ConsentAction | undefined {
  const byName = classifyLabel(button.label);
  const byText = button.text ? classifyLabel(button.text) : undefined;
  // An accessible name and a visible text that disagree identify nothing.
  if (byName && byText && byName !== byText) return undefined;
  return byName ?? byText;
}

function buttonAction(
  button: ConsentButton,
  container: ConsentContainer,
): ConsentAction | undefined {
  const byLabel = labelAction(button);
  if (container.generic) return byLabel;
  // A manager's selector and the label must not contradict each other: a
  // "reject" selector whose button reads "Accept all" is not clicked.
  if (button.reject && button.accept) return undefined;
  if (button.reject) return byLabel === "accept" ? undefined : "reject";
  if (button.accept) return byLabel === "reject" ? undefined : "accept";
  return container.labels ? byLabel : undefined;
}

/**
 * Picks the button to click, or nothing.
 *
 * Reject wins everywhere: a reject button in any container is chosen before an
 * accept button in another. Accept is only ever chosen in "accept" mode, and
 * only in a container that offers no reject. Known managers come before
 * generic containers, in the order the page reported them.
 */
export function chooseConsentAction(
  containers: ConsentContainer[],
  mode: "reject" | "accept",
): ConsentDecision | undefined {
  const ordered = containers
    .map((container, index) => ({ container, index }))
    .sort((a, b) => Number(!!a.container.generic) - Number(!!b.container.generic));
  const find = (wanted: ConsentAction): ConsentDecision | undefined => {
    for (const { container, index } of ordered) {
      const actions = container.buttons.map((button) => buttonAction(button, container));
      if (wanted === "accept" && actions.includes("reject")) continue;
      const button = actions.indexOf(wanted);
      if (button === -1) continue;
      return {
        container: index,
        button,
        action: wanted,
        manager: container.manager,
        label: container.buttons[button].label,
      };
    }
    return undefined;
  };
  return find("reject") ?? (mode === "accept" ? find("accept") : undefined);
}

/** Suffix match of a document host against a rule's hosts ("consent.google.com" covers "consent.google.fr" too). */
export function ruleAppliesToHost(rule: ConsentRule, hostname: string): boolean {
  if (!rule.hosts?.length) return true;
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return rule.hosts.some((entry) => {
    if (host === entry || host.endsWith(`.${entry}`)) return true;
    // Google serves its consent page on every country domain: consent.google.<tld>.
    if (entry === "consent.google.com") return /^consent\.google\.[a-z.]{2,6}$/.test(host);
    return false;
  });
}
