// Inline SVG icons (24 px grid, 1.75 stroke). Elements with data-icon="name" are filled by hydrateIcons().
const STROKE: Record<string, string> = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1 1M17.4 17.4l1 1M5.6 18.4l1-1M17.4 6.6l1-1"/>',
  moon: '<path d="M20 14.2A8 8 0 0 1 9.8 4 8 8 0 1 0 20 14.2z"/>',
  captions: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.6 10.3a2.1 2.1 0 1 0 0 3.4M16.6 10.3a2.1 2.1 0 1 0 0 3.4"/>',
  daycycle: '<path d="M12 4a8 8 0 0 1 0 16"/><path d="M12 4a8 8 0 0 0 0 16" stroke-dasharray="1.6 2.4"/><path d="M12 8.5a3.5 3.5 0 0 1 0 7z" fill="currentColor"/>',
  device: '<rect x="3.5" y="5" width="17" height="11.5" rx="2"/><path d="M9 20h6M12 16.5V20"/>',
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
  tower: '<path d="M9.8 21 11 12.5M14.2 21 13 12.5"/><path d="M8.5 12.5 7.5 7.5h9l-1 5z"/><path d="M12 7.5V3M10 10h4M8.5 21h7"/>',
  runway: '<path d="M9 4 5 20M15 4l4 16"/><path d="M12 6v2.5M12 11.5v2M12 16.5V19"/>',
  approach: '<path d="M3.5 6.5 17 15"/><path d="m17 15-5.2-.3M17 15l-1.2-5.2"/><path d="M3 20h18"/>',
  departure: '<path d="M4 16.5 18 8"/><path d="m18 8-5.3-.2M18 8l-1.3 5.2"/><path d="M3 20h18"/>',
  atis: '<circle cx="12" cy="12" r="8"/><path d="M12 11v5M12 8v.1"/>',
  clearance: '<rect x="6" y="5" width="12" height="16" rx="2"/><path d="M9.5 5V3.8h5V5M9.2 13l2 2 3.6-4"/>',
  center: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.2"/><path d="m12 12 4.6-4.6"/>',
  sliders: '<path d="M4 8h9M17 8h3M4 16h3M11 16h9"/><circle cx="15" cy="8" r="2"/><circle cx="9" cy="16" r="2"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.1"/>',
  wind: '<path d="M3 8h9.5a2.5 2.5 0 1 0-2.5-2.5"/><path d="M3 12.5h15a2.5 2.5 0 1 1-2.5 2.5"/><path d="M3 17h6"/>',
  cloud: '<path d="M7 18a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17.2 9 4.5 4.5 0 0 1 17 18z"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.4 3.6 5.2 3.6 8.5s-1.1 6.1-3.6 8.5c-2.5-2.4-3.6-5.2-3.6-8.5S9.5 5.9 12 3.5z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  route: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h6.5a3.5 3.5 0 0 0 0-7h-5a3.5 3.5 0 0 1 0-7H16"/>',
  chevdown: '<path d="m6 9.5 6 6 6-6"/>',
  pin:'<path d="M12 21s6.5-5.6 6.5-11a6.5 6.5 0 0 0-13 0c0 5.4 6.5 11 6.5 11z"/><circle cx="12" cy="10" r="2.2"/>',
};
const FILL: Record<string, string> = {
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
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
