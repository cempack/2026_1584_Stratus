// Inline SVG icons (24 px grid, 1.75 stroke). Elements with data-icon="name" are filled by hydrateIcons().
const STROKE: Record<string, string> = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1 1M17.4 17.4l1 1M5.6 18.4l1-1M17.4 6.6l1-1"/>',
  moon: '<path d="M20 14.2A8 8 0 0 1 9.8 4 8 8 0 1 0 20 14.2z"/>',
  rain: '<path d="M7 15a4 4 0 0 1-.4-7.98A5.5 5.5 0 0 1 17.2 8 3.5 3.5 0 0 1 17 15"/><path d="M8 18v2M12 17v3M16 18v2"/>',
  radio: '<path d="M5.6 18.4a9 9 0 0 1 0-12.8M8.4 15.6a5 5 0 0 1 0-7.2M15.6 8.4a5 5 0 0 1 0 7.2M18.4 5.6a9 9 0 0 1 0 12.8"/><circle cx="12" cy="12" r="1.6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 10 18.7l1-1"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  locate: '<circle cx="12" cy="12" r="3.5"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
  volume: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6"/>',
  layers: '<path d="m12 3.5 9 5-9 5-9-5z"/><path d="m3 13.2 9 5 9-5"/>',
  chevup: '<path d="m6 14.5 6-6 6 6"/>',
  arrowup: '<path d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5"/>',
  arrowdown: '<path d="M12 5v13.5M6.5 13 12 18.5l5.5-5.5"/>',
  pin: '<path d="M12 21s6.5-5.6 6.5-11a6.5 6.5 0 0 0-13 0c0 5.4 6.5 11 6.5 11z"/><circle cx="12" cy="10" r="2.2"/>',
};
const FILL: Record<string, string> = {
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  pause: '<rect x="7" y="5.5" width="3.6" height="13" rx="1"/><rect x="13.4" y="5.5" width="3.6" height="13" rx="1"/>',
  plane: '<path d="M12 2c.8 0 1.2 1.1 1.2 2.2v5.3l8 4.5v2l-8-2.3v5l2.6 1.8v1.5L12 21.2l-3.8 1V20.5l2.6-1.8v-5l-8 2.3v-2l8-4.5V4.2C10.8 3.1 11.2 2 12 2z"/>',
};

export function icon(name: string): string {
  if (name in FILL) return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${FILL[name]}</svg>`;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${STROKE[name] ?? ""}</svg>`;
}

export function hydrateIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => { el.innerHTML = icon(el.dataset.icon!); });
}
