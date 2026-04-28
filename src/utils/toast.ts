// src/utils/toast.ts
// Tiny pub-sub toast system. Use `toast.success("...")` etc. anywhere;
// the <Toaster /> mounted in App receives the events.

export type ToastKind = 'success' | 'error' | 'info';
export interface Toast {
  id: number;
  kind: ToastKind;
  msg: string;
}

type Listener = (t: Toast) => void;
const listeners = new Set<Listener>();
let nextId = 1;

const emit = (kind: ToastKind, msg: string) => {
  const t: Toast = { id: nextId++, kind, msg };
  listeners.forEach((l) => l(t));
};

export const toast = {
  success: (msg: string) => emit('success', msg),
  error:   (msg: string) => emit('error', msg),
  info:    (msg: string) => emit('info', msg),
};

export const subscribeToasts = (l: Listener) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};
