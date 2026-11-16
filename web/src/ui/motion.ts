// Symmetric enter/exit for elements toggled with `hidden`.
//
// Setting `hidden = true` removes an element on the spot, so things faded in but vanished out. hide() first marks the
// element `data-leaving` (CSS plays a short exit animation), then sets `hidden` when that ends. show() during an exit
// cancels it. The enter animation is whatever the element already declares in CSS.

const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
const EXIT_MS = 150;

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function show(el: HTMLElement) {
  clearTimeout(timers.get(el));
  timers.delete(el);
  if (el.hasAttribute("data-leaving")) {
    el.removeAttribute("data-leaving");
    // restart the enter animation from the current frame
    el.style.animation = "none";
    void el.offsetWidth;
    el.style.animation = "";
  }
  el.hidden = false;
}

export function hide(el: HTMLElement, done?: () => void) {
  if (el.hidden || el.hasAttribute("data-leaving")) return;
  if (reduced()) { el.hidden = true; done?.(); return; }
  el.setAttribute("data-leaving", "");
  timers.set(el, setTimeout(() => {
    timers.delete(el);
    el.removeAttribute("data-leaving");
    el.hidden = true;
    done?.();
  }, EXIT_MS));
}

/** Visible, and not on its way out. */
export const shown = (el: HTMLElement) => !el.hidden && !el.hasAttribute("data-leaving");

export const setShown = (el: HTMLElement, v: boolean) => (v ? show(el) : hide(el));

/** Replay a short "content changed" animation on `el` (e.g. the panel when another aircraft is picked). */
export function swap(el: HTMLElement) {
  if (reduced()) return;
  el.classList.remove("swap");
  void el.offsetWidth;
  el.classList.add("swap");
}
