import { useSyncExternalStore } from "react";

export interface ControlLease {
  sessionId: string;
  ownerId: string;
  mode: "human" | "agent";
  generation: number;
  expiresAt: string;
}
export interface LocalControl {
  lease: ControlLease;
  token: string;
}
const controls = new Map<string, LocalControl>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
export function setLocalControl(sessionId: string, value: LocalControl | null) {
  if (value) controls.set(sessionId, value);
  else controls.delete(sessionId);
  emit();
}
export function localControl(sessionId: string) {
  const value = controls.get(sessionId);
  return value && Date.parse(value.lease.expiresAt) > Date.now() ? value : null;
}
export function controlHeaders(sessionId?: string): Record<string, string> {
  const control = sessionId ? localControl(sessionId) : null;
  return control ? { "X-Steel-Control": control.token } : {};
}
export function useLocalControl(sessionId: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => controls.get(sessionId) ?? null,
  );
}
