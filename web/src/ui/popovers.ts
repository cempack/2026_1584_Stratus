// Menus and popovers hanging off the UI grid. Only one is open at a time; a press outside closes the transient ones.
export interface PopoverSpec {
  el: HTMLElement;
  trigger: HTMLElement;
  isOpen(): boolean;
  close(): void;
  /** Close on a press outside (menus, popovers). The radio panel stays open so the map can be used while it is. */
  outside?: boolean;
}

const all: PopoverSpec[] = [];

export function registerPopover(p: PopoverSpec) { all.push(p); }

/** Close every popover except the one whose element is `keep`. */
export function closeOthers(keep: HTMLElement | null) {
  for (const p of all) if (p.el !== keep && p.isOpen()) p.close();
}

/** Close the topmost open popover (Escape). Returns true if one was closed. */
export function closeTopmost(): boolean {
  for (let i = all.length - 1; i >= 0; i--) if (all[i].isOpen()) { all[i].close(); return true; }
  return false;
}

document.addEventListener("pointerdown", (e) => {
  const t = e.target as Node | null;
  if (!t) return;
  for (const p of all) if (p.outside && p.isOpen() && !p.el.contains(t) && !p.trigger.contains(t)) p.close();
});
