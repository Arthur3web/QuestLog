export const ICONS = {
  logo: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2 22 12 12 22 2 12Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter"/></svg>`,
  calendar: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="5" width="18" height="16" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 10h18M8 3v4M16 3v4" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
  close: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>`,
  chevronLeft: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m15 5-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"/></svg>`,
  chevronRight: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"/></svg>`,
  trash: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"/></svg>`,
  subtasks: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4" y="4" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"/><path d="m8 12 3 3 5-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"/></svg>`,
  comment: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 5h16v11H9l-5 4V5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter"/></svg>`,
  attachment: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m20.5 11.5-8.7 8.7a5.2 5.2 0 0 1-7.4-7.4l8.3-8.3a3.7 3.7 0 0 1 5.2 5.2l-8.1 8.1a2.1 2.1 0 0 1-3-3l7.2-7.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"/></svg>`,
  eye: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
  download: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"/></svg>`,
  timer: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="13" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 9v4l3 2M9 2h6M12 2v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>`,
  move: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"/></svg>`,
};

export const ICON_TEXT = {
  theme: "🕹️",
  priorityHigh: "🔴",
  priorityMedium: "🟠",
  priorityNormal: "⚪",
  priorityLow: "🔵",
};

export function renderIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach(element => {
    const icon = ICONS[element.dataset.icon];
    if (icon) element.innerHTML = icon;
  });
  root.querySelectorAll("[data-icon-text]").forEach(element => {
    const icon = ICON_TEXT[element.dataset.iconText];
    if (icon) element.textContent = `${icon} ${element.textContent.trim()}`;
  });
}
