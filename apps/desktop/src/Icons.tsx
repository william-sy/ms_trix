// Simple stroke icons drawn for ms_trix (no third-party/brand assets).
import type { ReactNode } from "react";

const Svg = ({ children, size = 20 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

export const BellIcon = () => <Svg><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z" /><path d="M10 20a2 2 0 0 0 4 0" /></Svg>;
export const ChatIcon = () => <Svg><path d="M4 5h16v11H9l-5 4V5Z" /></Svg>;
export const ThreadsIcon = () => <Svg><path d="M3 4h12v8H7l-4 3V4Z" /><path d="M9 15v1h8l4 3V8h-3" /></Svg>;
export const TeamsIcon = () => <Svg><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.2" /><path d="M3 19c0-3.3 2.7-5 6-5s6 1.7 6 5" /><path d="M15 14.5c3 0 6 1.2 6 4.5" /></Svg>;
export const CallIcon = () => <Svg><path d="M6 4h3l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v3a2 2 0 0 1-2 2A15 15 0 0 1 4 6a2 2 0 0 1 2-2Z" /></Svg>;
export const NotesIcon = () => <Svg><path d="M6 3h9l4 4v14H6Z" /><path d="M15 3v4h4M9 11h7M9 15h7M9 19h4" /></Svg>;
export const CalendarIcon = () => <Svg><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" /></Svg>;
export const MoreIcon = () => <Svg><circle cx="6" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="18" cy="12" r="1" /></Svg>;
export const SearchIcon = ({ size }: { size?: number }) => <Svg size={size}><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></Svg>;
export const ComposeIcon = () => <Svg><path d="M4 20h4L19 9l-4-4L4 16v4Z" /></Svg>;
export const MicIcon = () => <Svg><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></Svg>;
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

// Call controls (outline, like Teams; the "off" variants are struck through).
export const MicOffIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M15 10V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5" /><path d="M5 11a7 7 0 0 0 11.2 5.6M19 11a7 7 0 0 1-.6 2.8M12 18v3M4 4l16 16" /></Svg>;
export const CameraIcon = () => <Svg><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3" /></Svg>;
export const CameraOffIcon = () => <Svg><path d="M8 6h6a2 2 0 0 1 2 2v6M16 16.5V16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2" /><path d="m16 10 5-3v10l-3-1.8M3 3l18 18" /></Svg>;
export const ShareScreenIcon = () => <Svg><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4M12 14V8M9 10.5 12 7.5l3 3" /></Svg>;
export const HandIcon = () => <Svg><path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.6-2.2L3.5 16a1.5 1.5 0 0 1 2.3-2L8 16" /></Svg>;
export const SparkleIcon = () => <Svg><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" /></Svg>;
export const PinIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M9 4h6l-1 6 3 3H7l3-3-1-6ZM12 13v7" /></Svg>;
export const LayoutIcon = () => <Svg><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 12h16M12 4v16" /></Svg>;
export const ExpandIcon = () => <Svg><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></Svg>;
export const PopInIcon = () => <Svg><rect x="3" y="4" width="18" height="16" rx="2" /><rect x="12" y="12" width="7" height="6" rx="1" /></Svg>;
export const NewWindowIcon = () => <Svg><rect x="3" y="7" width="13" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3" /></Svg>;
export const GearIcon = () => <Svg><path d="M19 10.1L21.4 10.7L21.4 13.3L19 13.9L18.2 15.6L19.6 17.7L17.7 19.6L15.6 18.2L13.9 19L13.3 21.4L10.7 21.4L10.1 19L8.4 18.2L6.3 19.6L4.4 17.7L5.8 15.6L5 13.9L2.6 13.3L2.6 10.7L5 10.1L5.8 8.4L4.4 6.3L6.3 4.4L8.4 5.8L10.1 5L10.7 2.6L13.3 2.6L13.9 5L15.6 5.8L17.7 4.4L19.6 6.3L18.2 8.4Z" /><circle cx="12" cy="12" r="3" /></Svg>;
export const SpeakerIcon = () => <Svg><path d="M4 9h4l5-4v14l-5-4H4V9Z" /><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" /></Svg>;
