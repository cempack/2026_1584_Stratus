// Bottom sheet behaviour for the docked cards on phones: a collapsed "peek", drag or tap the handle to expand.
import { isPhone } from "../lib/layout";

export class Sheet {
  open = false;

  constructor(panel: HTMLElement) {
    const handle = panel.querySelector<HTMLElement>(".sheet-handle");
    if (!handle) return;
    let startY = 0, base = 0, moved = false, active = false;
    const collapsed = () => panel.offsetHeight - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--peek")) || 216);
    handle.addEventListener("pointerdown", (e) => {
      active = true; moved = false; startY = e.clientY;
      base = this.open ? 0 : collapsed();
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add("sheet-drag");
    });
    handle.addEventListener("pointermove", (e) => {
      if (!active) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) > 6) moved = true;
      if (moved) panel.style.transform = `translateY(${Math.max(0, Math.min(collapsed(), base + dy))}px)`;
    });
    const end = (e: PointerEvent) => {
      if (!active) return;
      active = false;
      document.body.classList.remove("sheet-drag");
      panel.style.transform = "";
      const dy = e.clientY - startY;
      if (!moved) this.set(!this.open);
      else this.set(dy < -40 ? true : dy > 40 ? false : this.open);
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    panel.addEventListener("click", (e) => {
      if (isPhone(innerWidth) && !this.open && !(e.target as HTMLElement).closest("button, a")) this.set(true);
    });
  }

  set(open: boolean) {
    this.open = open;
    document.body.classList.toggle("sheet-open", open);
  }
}
