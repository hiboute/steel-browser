import { useState } from "react";
import { apiUrl, request, sessionPath, type SessionDetails } from "../../api";
import { useResource } from "../../hooks";
import { Page, ErrorMessage } from "../workspace-pages";
import { ActionForm, Empty, Field, JsonDetails, string, useAction, when } from "./common";

export function DataPage({ session }: { session?: SessionDetails | null }) {
  const [tab, setTab] = useState("search"),
    [query, setQuery] = useState(""),
    [cursor, setCursor] = useState(0),
    [detail, setDetail] = useState<any>();
  const rows = useResource<any>(
    tab === "search" && query
      ? `/v1/search?${query}&cursor=${cursor}`
      : tab === "snapshots"
      ? "/v1/page-snapshots"
      : tab === "artifacts"
      ? "/v1/artifacts"
      : tab === "vault"
      ? "/v1/vault/references"
      : tab === "backup"
      ? "/v1/workspace/scopes"
      : null,
    tab === "search" ? 0 : 5000,
  );
  const action = useAction(rows.refresh);
  const show = async (path: string) => {
    try {
      setDetail(await request(path));
    } catch (error) {
      action.setError(String(error));
    }
  };
  return (
    <Page
      title="Evidence & workspace"
      description="Find retained facts, compare meaningful page changes, process downloads, and recover your workspace."
    >
      <div className="history-tabs" role="tablist">
        {["search", "snapshots", "artifacts", "vault", "backup"].map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            onClick={() => {
              setTab(value);
              setDetail(undefined);
            }}
          >
            {
              (
                {
                  search: "Search",
                  snapshots: "Page changes",
                  artifacts: "Documents",
                  vault: "Approved secrets",
                  backup: "Backup & recovery",
                } as Record<string, string>
              )[value]
            }
          </button>
        ))}
      </div>
      <ErrorMessage error={rows.error || action.error} />
      {tab === "search" && (
        <>
          <ActionForm
            title="Search retained work"
            submit="Search"
            onSubmit={async (form) => {
              const params = new URLSearchParams({ q: string(form, "q"), limit: "30" });
              for (const key of ["sessionId", "kind"])
                if (string(form, key)) params.set(key, string(form, key));
              setCursor(0);
              setQuery(params.toString());
            }}
          >
            <Field name="q" label="Search words" required />
            <Field name="sessionId" label="Browser session (optional)" />
            <label className="field">
              Source
              <select className="input" name="kind">
                <option value="">All permitted sources</option>
                {["snapshot", "artifact", "extract", "run", "procedure", "receipt"].map((kind) => (
                  <option key={kind}>{kind}</option>
                ))}
              </select>
            </label>
          </ActionForm>
          {rows.data?.results.length === 0 && (
            <Empty>No permitted retained content matches this search.</Empty>
          )}
          <div className="search-results">
            {rows.data?.results.map((hit: any, index: number) => (
              <article className="work-card" key={hit.id ?? index}>
                <p className="eyebrow">
                  {hit.kind} · {when(hit.observedAt || hit.createdAt)}
                </p>
                <h2>{hit.title}</h2>
                <p>{hit.snippet || hit.excerpt}</p>
                {hit.sessionId && <a href={`?session=${hit.sessionId}`}>Open source browser ↗</a>}
                <JsonDetails value={hit} label="Source reference" />
              </article>
            ))}
          </div>
          {rows.data && (
            <div className="button-row">
              {cursor > 0 && (
                <button className="pill-button" onClick={() => setCursor(Math.max(0, cursor - 30))}>
                  Previous
                </button>
              )}
              {rows.data.nextCursor !== null && rows.data.nextCursor !== undefined && (
                <button
                  className="pill-button"
                  onClick={() => setCursor(Number(rows.data.nextCursor))}
                >
                  Next
                </button>
              )}
              <span className="field-hint">{rows.data.total} matching sources</span>
            </div>
          )}
        </>
      )}
      {tab === "snapshots" && (
        <>
          <ActionForm
            title="Capture a page baseline"
            description="Ignore known noise while retaining source text and optional visual evidence."
            submit="Capture page"
            busy={action.busy}
            error={action.error}
            onSubmit={(form) => {
              const id = string(form, "sessionId");
              return action
                .run(
                  `${sessionPath(id)}/page-snapshots`,
                  {
                    name: string(form, "name") || undefined,
                    selector: string(form, "selector") || undefined,
                    ignoreSelectors: string(form, "ignoreSelectors").split("\n").filter(Boolean),
                    ignorePatterns: string(form, "ignorePatterns").split("\n").filter(Boolean),
                    visual: form.get("visual") === "on",
                  },
                  "POST",
                  id,
                )
                .then(setDetail);
            }}
          >
            <Field name="sessionId" label="Browser session" value={session?.id} required />
            <Field name="name" label="Baseline name" />
            <Field
              name="selector"
              label="Relevant region (CSS selector)"
              hint="Leave empty for page content."
            />
            <label className="field">
              Ignore these regions
              <textarea
                className="input"
                name="ignoreSelectors"
                rows={3}
                placeholder="One selector per line"
              />
            </label>
            <label className="field">
              Ignore literal noise
              <textarea
                className="input"
                name="ignorePatterns"
                rows={3}
                placeholder="One literal text value per line"
              />
            </label>
            <label className="check-row">
              <input name="visual" type="checkbox" />
              Include a visual snapshot
            </label>
          </ActionForm>
          <ActionForm
            title="Compare two captures"
            submit="Compare changes"
            busy={action.busy}
            error={action.error}
            onSubmit={(form) =>
              action
                .run("/v1/page-diffs", {
                  before: string(form, "before"),
                  after: string(form, "after"),
                })
                .then(setDetail)
            }
          >
            {["before", "after"].map((name) => (
              <label className="field" key={name}>
                {name === "before" ? "Baseline" : "New capture"}
                <select className="input" name={name} required>
                  <option value="">Choose a capture</option>
                  {rows.data?.snapshots.map((item: any) => (
                    <option key={item.id} value={item.id}>
                      {item.name || item.url} · {when(item.observedAt)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </ActionForm>
          {detail?.text?.added && (
            <div className="diff-grid">
              <article>
                <h2>Removed</h2>
                {detail.text.removed.map((line: string, i: number) => (
                  <p className="diff-removed" key={i}>
                    {line}
                  </p>
                ))}
              </article>
              <article>
                <h2>Added</h2>
                {detail.text.added.map((line: string, i: number) => (
                  <p className="diff-added" key={i}>
                    {line}
                  </p>
                ))}
              </article>
            </div>
          )}
          <div className="resource-grid">
            {rows.data?.snapshots.map((item: any) => (
              <article className="resource-card" key={item.id}>
                <h2>{item.name || item.url}</h2>
                <p className="field-hint">{when(item.observedAt)}</p>
                {item.hasImage && (
                  <a
                    href={apiUrl(`/v1/page-snapshots/${item.id}/image`)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <img
                      className="evidence-thumb"
                      src={apiUrl(`/v1/page-snapshots/${item.id}/image`)}
                      alt={`Snapshot of ${item.name || item.url}`}
                      loading="lazy"
                    />
                  </a>
                )}
                <div className="button-row">
                  <button
                    className="pill-button"
                    onClick={() => void show(`/v1/page-snapshots/${item.id}`)}
                  >
                    Read evidence
                  </button>
                  <button
                    className="pill-button"
                    disabled={action.busy}
                    onClick={() =>
                      void action
                        .run(`/v1/page-snapshots/${item.id}`, undefined, "DELETE")
                        .catch(() => {})
                    }
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
          {rows.data?.snapshots.length === 0 && <Empty>No saved page captures yet.</Empty>}
        </>
      )}
      {tab === "artifacts" && (
        <>
          <ActionForm
            title="Process a downloaded document"
            description="Verify the file and extract PDF text, table candidates or available OCR. Destinations must be configured by an operator."
            submit="Process document"
            busy={action.busy}
            error={action.error}
            onSubmit={(form) => {
              const id = string(form, "sessionId");
              return action
                .run(
                  `${sessionPath(id)}/artifacts/process`,
                  {
                    path: string(form, "path"),
                    ocr: form.get("ocr") === "on",
                    destination: string(form, "destination") || undefined,
                  },
                  "POST",
                  id,
                )
                .then(setDetail);
            }}
          >
            <Field name="sessionId" label="Browser session" value={session?.id} required />
            <Field name="path" label="Downloaded file path" required />
            <Field name="destination" label="Approved export destination (optional)" />
            <label className="check-row">
              <input name="ocr" type="checkbox" />
              Request OCR when available
            </label>
          </ActionForm>
          <div className="resource-grid">
            {rows.data?.artifacts.map((item: any) => (
              <article className="resource-card" key={item.id}>
                <h2>{item.name}</h2>
                <p>
                  {item.mime} · {Math.ceil(item.bytes / 1024)} KB
                </p>
                <p className="field-hint">SHA256 {item.sha256}</p>
                <button
                  className="pill-button"
                  onClick={() => void show(`/v1/artifacts/${item.id}`)}
                >
                  Read extracted content
                </button>
              </article>
            ))}
          </div>
          {rows.data?.artifacts.length === 0 && <Empty>No processed documents yet.</Empty>}
          {detail?.pages && (
            <div className="document-pages">
              {detail.pages.map((page: any) => (
                <article key={page.page}>
                  <h2>Page {page.page}</h2>
                  <pre>{page.text}</pre>
                  {!!page.tables?.length && (
                    <JsonDetails value={page.tables} label="Table candidates" />
                  )}
                </article>
              ))}
            </div>
          )}
        </>
      )}
      {tab === "vault" && (
        <>
          <p className="field-hint">
            Only approved references are listed. A fill remains bound to its exact HTTPS origin and
            selector, and never submits the form.
          </p>
          {rows.data?.references.length === 0 && (
            <Empty>
              No secret references are approved for your principal. An operator can configure
              origin-scoped references.
            </Empty>
          )}
          {rows.data?.references.map((reference: any) => (
            <ActionForm
              key={reference.id}
              title={reference.label || reference.id}
              description={`${reference.origin} · ${reference.provider}${
                reference.expiresAt ? ` · expires ${when(reference.expiresAt)}` : ""
              }`}
              submit="Fill approved field"
              busy={action.busy}
              error={action.error}
              onSubmit={(form) => {
                const id = string(form, "sessionId");
                return action
                  .run(
                    `${sessionPath(id)}/vault/fill`,
                    {
                      reference: reference.id,
                      selector: string(form, "selector"),
                      frameUrl: string(form, "frameUrl") || undefined,
                    },
                    "POST",
                    id,
                  )
                  .then(setDetail);
              }}
            >
              <Field name="sessionId" label="Browser session" value={session?.id} required />
              <label className="field">
                Approved field
                <select className="input" name="selector" required>
                  {reference.selectors?.map((selector: string) => (
                    <option key={selector}>{selector}</option>
                  ))}
                </select>
              </label>
              <Field name="frameUrl" label="Exact embedded frame URL (optional)" type="url" />
            </ActionForm>
          ))}
        </>
      )}
      {tab === "backup" && (
        <>
          <p className="field-hint">
            Keep the archive passphrase and original store encryption keys separately. Park or
            release live browsers before exporting. Recovery is staged for offline activation.
          </p>
          <ActionForm
            title="Export an encrypted workspace"
            submit="Download encrypted archive"
            busy={action.busy}
            error={action.error}
            onSubmit={async (form) => {
              const result = (await action.run("/v1/workspace/export", {
                scopes: form.getAll("scopes").map(String),
                passphrase: String(form.get("passphrase") || ""),
              })) as { archive: string; createdAt: string };
              const blob = new Blob([JSON.stringify(result)], { type: "application/json" }),
                url = URL.createObjectURL(blob),
                link = document.createElement("a");
              link.href = url;
              link.download = `steel-workspace-${new Date().toISOString().slice(0, 10)}.json`;
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              setDetail({ status: "exported", createdAt: result.createdAt });
            }}
          >
            <fieldset className="step-picks">
              <legend>Include</legend>
              {rows.data?.scopes.map((scope: string) => (
                <label key={scope} className="check-row">
                  <input name="scopes" type="checkbox" value={scope} />
                  {scope.replaceAll("_", " ")}
                </label>
              ))}
            </fieldset>
            <Field
              name="passphrase"
              label="Archive passphrase (at least 16 characters)"
              type="password"
              required
            />
          </ActionForm>
          <ActionForm
            title="Stage workspace recovery"
            description="The running workspace stays active until an operator stops Steel and activates the verified stage."
            submit="Validate and stage recovery"
            busy={action.busy}
            error={action.error}
            onSubmit={async (form) => {
              const file = form.get("archive") as File;
              if (!file?.size) throw new Error("Choose an encrypted workspace archive");
              const parsed = JSON.parse(await file.text());
              return action
                .run("/v1/workspace/restore", {
                  archive: parsed.archive,
                  passphrase: String(form.get("passphrase") || ""),
                  scopes: form.getAll("scopes").map(String),
                  conflict: string(form, "conflict"),
                })
                .then(setDetail);
            }}
          >
            <label className="field">
              Encrypted archive
              <input
                className="input"
                type="file"
                name="archive"
                accept="application/json,.json"
                required
              />
            </label>
            <Field name="passphrase" label="Archive passphrase" type="password" required />
            <label className="field">
              Existing data
              <select name="conflict" className="input">
                <option value="reject">Reject conflicting data</option>
                <option value="replace">Replace selected scopes during offline activation</option>
              </select>
            </label>
            <fieldset className="step-picks">
              <legend>Restore only these scopes</legend>
              {rows.data?.scopes.map((scope: string) => (
                <label key={scope} className="check-row">
                  <input name="scopes" type="checkbox" value={scope} />
                  {scope.replaceAll("_", " ")}
                </label>
              ))}
            </fieldset>
          </ActionForm>
        </>
      )}
      {detail !== undefined && (
        <div className="work-result">
          <button className="pill-button" onClick={() => setDetail(undefined)}>
            Close result
          </button>
          {detail.status === "staged" && <p role="status">Recovery staged. {detail.activation}</p>}
          <pre>{JSON.stringify(detail, null, 2)}</pre>
        </div>
      )}
    </Page>
  );
}
