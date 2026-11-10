import { useState, type ReactNode, type FormEvent } from "react";
import { mutate } from "../../api";
import { controlHeaders } from "../../control";
import { ErrorMessage } from "../workspace-pages";

export const when = (date?: string | null) => (date ? new Date(date).toLocaleString() : "—");
export const string = (form: FormData, key: string) => String(form.get(key) || "").trim();
export const json = (value: string, fallback: unknown = {}) =>
  value.trim() ? JSON.parse(value) : fallback;
export function JsonDetails({ value, label = "Details" }: { value: unknown; label?: string }) {
  return (
    <details className="json-details">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty-state">{children}</p>;
}
export function ReviewProposal({
  proposal,
}: {
  proposal: {
    destination?: string;
    fields?: Record<string, unknown>;
    attachments?: Array<{ name: string; artifactId?: string; sha256?: string }>;
  };
}) {
  return (
    <div className="review-proposal">
      <p>
        Destination: <strong>{proposal.destination}</strong>
      </p>
      <dl className="proposal-fields">
        {Object.entries(proposal.fields ?? {}).map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</dd>
          </div>
        ))}
      </dl>
      {!!proposal.attachments?.length && (
        <>
          <p>Attachments</p>
          <ul className="attachment-review">
            {proposal.attachments.map((file, index) => (
              <li key={file.artifactId ?? index}>
                <strong>{file.name}</strong>
                {file.sha256 && <code title={file.sha256}>SHA256 {file.sha256}</code>}
              </li>
            ))}
          </ul>
        </>
      )}
      <JsonDetails value={proposal} label="Exact proposed content" />
    </div>
  );
}
export function Field({
  label,
  name,
  value,
  required,
  type = "text",
  hint,
}: {
  label: string;
  name: string;
  value?: string | number;
  required?: boolean;
  type?: string;
  hint?: string;
}) {
  return (
    <label className="field">
      {label}
      <input className="input" name={name} type={type} defaultValue={value} required={required} />
      {hint && <small className="field-hint">{hint}</small>}
    </label>
  );
}
export function JsonField({
  label,
  name,
  value,
  rows = 7,
}: {
  label: string;
  name: string;
  value: unknown;
  rows?: number;
}) {
  return (
    <label className="field">
      {label}
      <textarea
        className="input code-input"
        name={name}
        rows={rows}
        defaultValue={JSON.stringify(value, null, 2)}
        spellCheck={false}
      />
    </label>
  );
}
export function useAction(refresh?: () => void) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [result, setResult] = useState<unknown>();
  const run = async (path: string, body?: unknown, method = "POST", sessionId?: string) => {
    setBusy(true);
    setError(null);
    try {
      const value = await mutate<unknown>(path, body, method, undefined, controlHeaders(sessionId));
      setResult(value);
      refresh?.();
      return value;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, result, run, setError };
}
export function ActionForm({
  title,
  description,
  children,
  onSubmit,
  busy,
  error,
  submit = "Save",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onSubmit: (form: FormData) => Promise<unknown>;
  busy?: boolean;
  error?: string | null;
  submit?: string;
}) {
  const [validationError, setValidationError] = useState<string | null>(null);
  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    setValidationError(null);
    void (async () => {
      try {
        await onSubmit(form);
        element.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((input) => {
          input.value = "";
        });
      } catch (error) {
        setValidationError(error instanceof Error ? error.message : String(error));
      }
    })();
  };
  return (
    <form className="work-form" onSubmit={send}>
      <div>
        <h2>{title}</h2>
        {description && <p className="field-hint">{description}</p>}
      </div>
      <div className="form-grid">{children}</div>
      <ErrorMessage error={validationError || error} />
      <div>
        <button className="button" data-variant="primary" disabled={busy} type="submit">
          {busy ? "Working…" : submit}
        </button>
      </div>
    </form>
  );
}
