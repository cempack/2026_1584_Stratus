// "i" button: data credits, listed only for what is actually on the map.
import { type CreditOpts, credits } from "../lib/attribution";
import { closeOthers, registerPopover } from "./popovers";

export class Credits {
  private pop = document.getElementById("credits") as HTMLElement;
  private btn = document.getElementById("btn-info") as HTMLButtonElement;
  private list = document.getElementById("credits-list") as HTMLUListElement;

  constructor(private current: () => CreditOpts) {
    registerPopover({ el: this.pop, trigger: this.btn, isOpen: () => !this.pop.hidden, close: () => this.close(), outside: true });
    this.btn.addEventListener("click", () => (this.pop.hidden ? this.open() : this.close()));
    this.pop.querySelector("[data-close]")!.addEventListener("click", () => this.close());
  }

  open() {
    closeOthers(this.pop);
    this.list.replaceChildren(...credits(this.current()).map((c) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = c.href; a.target = "_blank"; a.rel = "noopener noreferrer";
      const name = document.createElement("span"); name.textContent = c.name;
      a.append(name);
      if (c.note) { const s = document.createElement("small"); s.textContent = c.note; a.append(s); }
      li.append(a);
      return li;
    }));
    this.pop.hidden = false;
    this.btn.setAttribute("aria-expanded", "true");
  }

  close() { this.pop.hidden = true; this.btn.setAttribute("aria-expanded", "false"); }
}
