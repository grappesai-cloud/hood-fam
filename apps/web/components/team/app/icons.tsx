/// The console's line icons: one stroke width, drawn on a 24 grid, coloured by currentColor.

type P = { size?: number; className?: string };

function Svg({ size = 16, className, children }: P & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

export const IconSearch = (p: P) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Svg>;
export const IconFilter = (p: P) => <Svg {...p}><path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" /></Svg>;
export const IconPanel = (p: P) => <Svg {...p}><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M9 4.5v15" /></Svg>;
export const IconWallet = (p: P) => <Svg {...p}><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" /><rect x="4" y="8" width="16" height="11" rx="2" /><circle cx="16" cy="13.5" r="1.2" /></Svg>;
export const IconTracker = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><path d="M12 12l5-5" /></Svg>;
export const IconDashboard = (p: P) => <Svg {...p}><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="4" rx="1" /><rect x="13" y="10" width="7" height="10" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /></Svg>;
export const IconArchive = (p: P) => <Svg {...p}><rect x="3.5" y="4.5" width="17" height="4" rx="1" /><path d="M5 8.5V19h14V8.5M10 12.5h4" /></Svg>;
export const IconImport = (p: P) => <Svg {...p}><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" /></Svg>;
export const IconRocket = (p: P) => <Svg {...p}><path d="M13.5 4.5c3-.8 5.3-.6 6 .1.7.7.9 3-.1 6l-6.4 6.4-5.9-5.9z" /><path d="M7.1 11.1 4.5 10l3-3 3.6.4M12.9 16.9 14 19.5l3-3-.4-3.6M6 18l-1.5 1.5" /></Svg>;
export const IconChevron = (p: P) => <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>;
export const IconBolt = (p: P) => <Svg {...p}><path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" /></Svg>;
export const IconShield = (p: P) => <Svg {...p}><path d="M12 3.5 19 6v5.5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6z" /><path d="M12 3.5v17" /></Svg>;
export const IconHex = (p: P) => <Svg {...p}><path d="M12 3 19.5 7.5v9L12 21l-7.5-4.5v-9z" /><circle cx="12" cy="12" r="2.2" /></Svg>;
export const IconCubes = (p: P) => <Svg {...p}><path d="m12 3 4 2.3v4.6L12 12 8 9.9V5.3zM8 9.9l4 2.1v4.7l-4 2.3-4-2.3v-4.6zM16 9.9l4 2.1v4.7l-4 2.3-4-2.3" /></Svg>;
export const IconHelp = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M9.8 9.5a2.3 2.3 0 1 1 3.2 2.1c-.6.3-1 .8-1 1.5v.4M12 16.6v.1" /></Svg>;
export const IconUsers = (p: P) => <Svg {...p}><circle cx="9" cy="8.5" r="3" /><path d="M3.5 19c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5" /><circle cx="16.5" cy="9.5" r="2.4" /><path d="M16 14.6c2.3.1 4 1.5 4.5 4" /></Svg>;
export const IconCrown = (p: P) => <Svg {...p}><path d="m4 8 4 3.5L12 5l4 6.5L20 8l-1.5 10h-13z" /></Svg>;
export const IconClock = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Svg>;
export const IconGas = (p: P) => <Svg {...p}><path d="M5 20V5.5A1.5 1.5 0 0 1 6.5 4h6A1.5 1.5 0 0 1 14 5.5V20M4 20h11M7.5 8h4M14 10h2a1.5 1.5 0 0 1 1.5 1.5v4a1.3 1.3 0 0 0 2.6 0V8.5L17.5 6" /></Svg>;
export const IconInfo = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8v.1" /></Svg>;
export const IconPencil = (p: P) => <Svg {...p}><path d="m5 19 1-4 9.5-9.5 3 3L9 18zM13.5 7.5l3 3" /></Svg>;
export const IconMap = (p: P) => <Svg {...p}><circle cx="8" cy="9" r="3" /><circle cx="16" cy="7" r="1.8" /><circle cx="15" cy="15.5" r="3.5" /></Svg>;
export const IconCoins = (p: P) => <Svg {...p}><ellipse cx="10" cy="7" rx="5.5" ry="2.5" /><path d="M4.5 7v5c0 1.4 2.5 2.5 5.5 2.5M4.5 12v5c0 1.4 2.5 2.5 5.5 2.5" /><ellipse cx="15" cy="14" rx="5" ry="2.3" /><path d="M10 14v4.5c0 1.3 2.2 2.3 5 2.3s5-1 5-2.3V14" /></Svg>;
export const IconLock = (p: P) => <Svg {...p}><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></Svg>;
export const IconUpload = (p: P) => <Svg {...p}><path d="M12 15V4.5M7.5 9 12 4.5 16.5 9M5 15v4.5h14V15" /></Svg>;
export const IconPalette = (p: P) => <Svg {...p}><path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1.1-1.6-1.1-2.7 0-1 .8-1.6 1.8-1.6h2.2a3.8 3.8 0 0 0 3.8-3.8c0-4-3.8-7.2-8.5-7.2z" /><circle cx="7.5" cy="11" r="1" /><circle cx="10" cy="7.3" r="1" /><circle cx="14.5" cy="7.3" r="1" /></Svg>;
export const IconX = (p: P) => <Svg {...p}><path d="m5 5 14 14M19 5 5 19" /></Svg>;
export const IconSend = (p: P) => <Svg {...p}><path d="M20.5 4 3.5 11l6.5 2.5L12.5 20z" /><path d="m10 13.5 4-4" /></Svg>;
export const IconDoc = (p: P) => <Svg {...p}><path d="M6.5 3.5H14l4 4v13H6.5z" /><path d="M13.5 3.5V8H18M9.5 12.5h5M9.5 16h5" /></Svg>;
export const IconBack = (p: P) => <Svg {...p}><path d="M15 5 8 12l7 7" /></Svg>;
export const IconRefresh = (p: P) => <Svg {...p}><path d="M19 8.5A7.5 7.5 0 0 0 5.2 9.5M5 15.5a7.5 7.5 0 0 0 13.8-1M19 4v4.5h-4.5M5 20v-4.5h4.5" /></Svg>;
export const IconCheck = (p: P) => <Svg {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Svg>;
