/**
 * Theme constants shared by the server-rendered pre-paint script in
 * `app/layout.tsx` and the client-side `ThemeToggle`.
 *
 * This file deliberately has no `"use client"` directive. A server component
 * importing a plain constant *from* a client module does not get the constant —
 * it gets a client-reference stub, and the value reads as `undefined`. That
 * failed silently here: the bootstrap script compiled to
 * `localStorage.getItem(undefined)`, which always returns null, so the stored
 * theme was never replayed and every load flashed. Keep this module neutral so
 * both sides get the real string.
 */

export const THEME_KEY = "dxb-theme";

export type Theme = "system" | "light" | "dark";
