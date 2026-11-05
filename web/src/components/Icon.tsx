// Small stroke icons (16px), drawn here so the UI needs no icon package.

export type IconName =
  | 'table' | 'floppy' | 'chart' | 'bell' | 'laptop' | 'sitemap' | 'grid' | 'settings' | 'collapse' | 'expand'
  | 'play' | 'bolt' | 'code' | 'close' | 'filter' | 'search' | 'copy' | 'plus' | 'minus' | 'columns' | 'wrap' | 'download' | 'pause'
  | 'chevron-down' | 'chevron-right' | 'pin' | 'maximize' | 'link';

const PATHS: Record<IconName, string> = {
  table: 'M3 5h18v14H3zM3 10h18M9 10v9',
  floppy: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  chart: 'M4 19h16M7 16l3-5 3 3 4-7',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  laptop: 'M4 6h16v10H4zM2 19h20',
  sitemap: 'M10 3h4v4h-4zM4 17h4v4H4zM16 17h4v4h-4zM12 7v5M6 17v-3h12v3',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
  collapse: 'M4 4v16M20 12H9M13 8l-4 4 4 4',
  expand: 'M20 4v16M4 12h11M11 8l4 4-4 4',
  play: 'M7 4l13 8-13 8z',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5',
  close: 'M6 6l12 12M18 6L6 18',
  filter: 'M3 5h18l-7 8v6l-4-2v-4z',
  search: 'M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM15 15l6 6',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  columns: 'M4 4h16v16H4zM10 4v16M15 4v16',
  wrap: 'M4 6h16M4 12h13a3 3 0 0 1 0 6h-4M4 18h5M14 16l-2 2 2 2',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  pause: 'M8 5v14M16 5v14',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-right': 'M9 6l6 6-6 6',
  pin: 'M15 4l5 5-4 1-4 4 1 5-3-3-5 5 5-5-3-3 5 1 4-4z',
  maximize: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  link: 'M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1',
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
