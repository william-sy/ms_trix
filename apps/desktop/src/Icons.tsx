// Simple stroke icons drawn for ms_trix (no third-party/brand assets).
import type { ReactNode } from "react";

const Svg = ({ children, size = 20 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

export const BellIcon = () => <Svg><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z" /><path d="M10 20a2 2 0 0 0 4 0" /></Svg>;
export const ChatIcon = () => <Svg><path d="M4 5h16v11H9l-5 4V5Z" /></Svg>;
export const TeamsIcon = () => <Svg><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.2" /><path d="M3 19c0-3.3 2.7-5 6-5s6 1.7 6 5" /><path d="M15 14.5c3 0 6 1.2 6 4.5" /></Svg>;
export const CallIcon = () => <Svg><path d="M6 4h3l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v3a2 2 0 0 1-2 2A15 15 0 0 1 4 6a2 2 0 0 1 2-2Z" /></Svg>;
export const MoreIcon = () => <Svg><circle cx="6" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="18" cy="12" r="1" /></Svg>;
export const SearchIcon = ({ size }: { size?: number }) => <Svg size={size}><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></Svg>;
export const ComposeIcon = () => <Svg><path d="M4 20h4L19 9l-4-4L4 16v4Z" /></Svg>;
export const SendIcon = () => <Svg><path d="M4 12 20 4l-6 16-3-7-7-1Z" /></Svg>;
export const FormatIcon = () => <Svg><path d="M5 19 12 5l7 14M8 14h8" /></Svg>;
export const EmojiIcon = () => <Svg><circle cx="12" cy="12" r="8" /><path d="M9 14a4 4 0 0 0 6 0M9.5 10h0M14.5 10h0" /></Svg>;
export const AttachIcon = () => <Svg><path d="m20 11-8 8a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7" /></Svg>;
export const PlusIcon = () => <Svg><path d="M12 5v14M5 12h14" /></Svg>;
export const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform .15s" }} aria-hidden>
    <path d="m9 6 6 6-6 6" />
  </svg>
);
export const LockIcon = () => <Svg size={14}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Svg>;
export const MuteIcon = () => <Svg size={14}><path d="M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l1.5 2H8" /><path d="m3 3 18 18" /></Svg>;
export const DraftIcon = () => <Svg size={18}><path d="M4 20h4L19 9l-4-4L4 16v4Z" /><path d="M13 7l4 4" /></Svg>;
export const AllOrgsIcon = () => <Svg><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></Svg>;
export const CheckIcon = () => <Svg size={16}><path d="m5 12 5 5 9-10" /></Svg>;
