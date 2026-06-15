/**
 * push-subscribe.ts — 2026-05-27 PR D.f.
 *
 * Client-side helper for the PWA push opt-in flow. The Settings panel
 * calls these:
 *
 *   ensureServiceWorkerRegistered()  — registers /sw.js if not already
 *   subscribeToPush(operatorId)      — requests permission, calls
 *                                       pushManager.subscribe(), POSTs
 *                                       the result to /api/admin/push/subscribe
 *   unsubscribeFromPush()            — pushManager.unsubscribe() + DELETE
 *                                       the row in DDB
 *   currentSubscriptionState()       — { granted, subscribed, subscriptionId? }
 *
 * Browser support fallback: if Notification or pushManager are absent
 * (older browser / non-PWA-capable), the helpers return null + the UI
 * disables the toggle.
 */

import { api } from './api-client';

const SW_PATH = '/sw.js';
const STORAGE_KEY = 'futurator.push.subscriptionId';

export type PushPermission = 'granted' | 'denied' | 'default';

export interface PushSubscriptionState {
  supported: boolean;
  permission: PushPermission;
  subscribed: boolean;
  /** Local copy of the server-issued subscriptionId for unsubscribe. */
  subscriptionId: string | null;
}

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.Notification === 'function' &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

export async function ensureServiceWorkerRegistered(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  const existing = await navigator.serviceWorker.getRegistration(SW_PATH);
  if (existing) return existing;
  try {
    return await navigator.serviceWorker.register(SW_PATH, { scope: '/' });
  } catch (err) {
    console.warn('[push-subscribe] SW registration failed:', err);
    return null;
  }
}

export async function currentSubscriptionState(): Promise<PushSubscriptionState> {
  if (!isPushSupported()) {
    return { supported: false, permission: 'default', subscribed: false, subscriptionId: null };
  }
  const permission = Notification.permission as PushPermission;
  const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
  if (!reg) {
    return { supported: true, permission, subscribed: false, subscriptionId: null };
  }
  const sub = await reg.pushManager.getSubscription();
  const subscriptionId = window.localStorage.getItem(STORAGE_KEY);
  return {
    supported: true,
    permission,
    subscribed: !!sub,
    subscriptionId,
  };
}

/** Base64URL → Uint8Array helper for VAPID applicationServerKey. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const std = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(std);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export async function subscribeToPush(): Promise<{
  subscriptionId: string;
} | null> {
  if (!isPushSupported()) return null;
  const reg = await ensureServiceWorkerRegistered();
  if (!reg) return null;

  // 1. Request permission. The browser only shows the prompt the first
  //    time; subsequent calls return the prior decision.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return null;

  // 2. Fetch the VAPID public key from the server.
  const { publicKey } = await api.get<{ publicKey: string }>('/admin/push/vapid-public-key');

  // 3. pushManager.subscribe with the application server key.
  // BufferSource accepts ArrayBuffer-backed views; we copy into a fresh
  // ArrayBuffer to satisfy the lib.dom type which is stricter than the
  // runtime behaviour.
  const keyBytes = urlBase64ToUint8Array(publicKey);
  const keyBuffer = new ArrayBuffer(keyBytes.byteLength);
  new Uint8Array(keyBuffer).set(keyBytes);
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBuffer,
  });

  // 4. POST the subscription to the server.
  const json = sub.toJSON();
  const endpoint = json.endpoint as string;
  const keys = json.keys as { p256dh: string; auth: string } | undefined;
  if (!endpoint || !keys) {
    throw new Error('Browser returned an incomplete PushSubscription');
  }
  const { subscriptionId } = await api.post<{ subscriptionId: string }>('/admin/push/subscribe', {
    endpoint,
    keys,
    userAgent: navigator.userAgent,
  });
  window.localStorage.setItem(STORAGE_KEY, subscriptionId);
  return { subscriptionId };
}

export async function unsubscribeFromPush(): Promise<void> {
  if (!isPushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
  if (reg) {
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await sub.unsubscribe().catch(() => {});
    }
  }
  const subscriptionId = window.localStorage.getItem(STORAGE_KEY);
  if (subscriptionId) {
    await api.delete(`/admin/push/subscribe/${subscriptionId}`).catch(() => {});
    window.localStorage.removeItem(STORAGE_KEY);
  }
}

/** Server-driven test fire-off. Returns true if accepted by the API. */
export async function sendTestPush(): Promise<boolean> {
  try {
    await api.post('/admin/push/test', {});
    return true;
  } catch {
    return false;
  }
}
