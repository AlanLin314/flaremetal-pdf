const PATHS = {
  folder:
    '<path d="M3.5 7.5h5.2l1.8 2H20.5v9.2a1.3 1.3 0 0 1-1.3 1.3H4.8a1.3 1.3 0 0 1-1.3-1.3V7.5z"/>',
  download: '<path d="M12 4v10"/><path d="M8 10.5 12 14.5l4-4"/><path d="M5 18.5h14"/>',
  print:
    '<path d="M6 9V3.5h12V9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v6.5H6z"/>',
  undo: '<path d="M8 8H4.5V4.5"/><path d="M5 8.2A7.5 7.5 0 1 1 6.2 16"/>',
  redo: '<path d="M16 8h3.5V4.5"/><path d="M19 8.2A7.5 7.5 0 1 0 17.8 16"/>',
  trash:
    '<path d="M5 7.5h14"/><path d="M9.5 7.4V5.2h5v2.2"/><path d="M7.2 7.5l.7 11h8.2l.7-11"/>',
  minus: '<path d="M6 12h12"/>',
  plus: '<path d="M12 6v12"/><path d="M6 12h12"/>',
  fit: '<path d="M9 4.5H5.5V8"/><path d="M15 4.5h3.5V8"/><path d="M9 19.5H5.5V16"/><path d="M15 19.5h3.5V16"/>',
  left: '<path d="M14.5 6.5 9 12l5.5 5.5"/>',
  right: '<path d="M9.5 6.5 15 12l-5.5 5.5"/>',
  rect: '<rect x="5" y="6" width="14" height="12" rx="1.5"/>',
  brush:
    '<path d="M15.2 4.8a2.2 2.2 0 0 1 3.1 3.1L9.4 16.8 6 18l1.2-3.4 7.9-9.8z"/><path d="M14 6.2 17.8 10"/>',
  eraser:
    '<path d="m15.5 4.5 4 4-8.2 8.2a2 2 0 0 1-2.8 0L5.2 13.4a2 2 0 0 1 0-2.8L9.8 6a2 2 0 0 1 2.8 0z"/><path d="M4.5 20h15"/><path d="m8 13 3.2 3.2"/>',
  pan: '<path d="M12 3.5v17"/><path d="M3.5 12h17"/><path d="m8 7 4-4 4 4"/><path d="m8 17 4 4 4-4"/><path d="m7 8-4 4 4 4"/><path d="m17 8 4 4-4 4"/>',
  turnLeft: '<path d="M4 12a8 8 0 1 0 2.6-6"/><path d="M4 4.5V9h4.5"/>',
  turnRight: '<path d="M20 12a8 8 0 1 1-2.6-6"/><path d="M20 4.5V9h-4.5"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${PATHS[name]}</svg>`;
}
