type Labels = Record<string, string | number | boolean>;
const escaped = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

export class Metrics {
  private values = new Map<string, { type: "counter" | "gauge"; samples: Map<string, number> }>();
  private sample(name: string, labels: Labels, type: "counter" | "gauge") {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new Error("Invalid metric name");
    for (const label of Object.keys(labels))
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label)) throw new Error("Invalid metric label");
    let metric = this.values.get(name);
    if (!metric) {
      metric = { type, samples: new Map() };
      this.values.set(name, metric);
    }
    if (metric.type !== type) throw new Error("Metric type cannot change");
    const suffix = Object.keys(labels)
      .sort()
      .map((key) => `${key}="${escaped(String(labels[key]))}"`)
      .join(",");
    return { metric, key: suffix ? `${name}{${suffix}}` : name };
  }
  increment(name: string, labels: Labels = {}, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Invalid counter increment");
    const { metric, key } = this.sample(name, labels, "counter");
    metric.samples.set(key, (metric.samples.get(key) ?? 0) + amount);
  }
  gauge(name: string, value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value)) return;
    const { metric, key } = this.sample(name, labels, "gauge");
    metric.samples.set(key, value);
  }
  render(): string {
    return [...this.values]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([name, { type, samples }]) =>
          `# TYPE ${name} ${type}\n${[...samples]
            .map(([key, value]) => `${key} ${value}`)
            .join("\n")}\n`,
      )
      .join("");
  }

  clearGauge(name: string): void {
    if (this.values.get(name)?.type === "gauge") this.values.delete(name);
  }
}
