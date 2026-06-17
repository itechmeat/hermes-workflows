// Small inline SVG icons (no icon-library dependency). Stroke-based, inherit
// `currentColor`, sized 1em so they scale with the surrounding text. Decorative
// — marked aria-hidden so screen readers read the adjacent label only.

function Svg({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <svg
      className="hw-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function ChevronDownIcon(): React.ReactElement {
  return <Svg>{<path d="m6 9 6 6 6-6" />}</Svg>;
}

// Check — selection / checked state (Checkbox indicator, Select item indicator).
export function CheckIcon(): React.ReactElement {
  return <Svg>{<path d="M20 6 9 17l-5-5" />}</Svg>;
}

// Open / expand — maximize corners.
export function ExpandIcon(): React.ReactElement {
  return (
    <Svg>
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </Svg>
  );
}

// Back — left arrow.
export function ArrowLeftIcon(): React.ReactElement {
  return (
    <Svg>
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </Svg>
  );
}

// agent_task — a processing unit.
export function CpuIcon(): React.ReactElement {
  return (
    <Svg>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M19 9h3M19 14h3M2 9h3M2 14h3" />
    </Svg>
  );
}

// script — a shell prompt.
export function TerminalIcon(): React.ReactElement {
  return (
    <Svg>
      <path d="m5 8 4 4-4 4" />
      <path d="M13 16h6" />
    </Svg>
  );
}

// condition — a branch.
export function BranchIcon(): React.ReactElement {
  return (
    <Svg>
      <line x1="6" y1="4" x2="6" y2="14" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="7" r="2.5" />
      <path d="M18 9.5a8 8 0 0 1-8 8" />
    </Svg>
  );
}

// human_review — an eye.
export function EyeIcon(): React.ReactElement {
  return (
    <Svg>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

// finish — a flag.
export function FlagIcon(): React.ReactElement {
  return (
    <Svg>
      <path d="M5 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="5" y1="22" x2="5" y2="15" />
    </Svg>
  );
}

// validate — a checked shield.
export function ShieldCheckIcon(): React.ReactElement {
  return (
    <Svg>
      <path d="M12 3 5 6v6c0 4 3 6.5 7 8 4-1.5 7-4 7-8V6z" />
      <path d="m9 12 2 2 4-4" />
    </Svg>
  );
}

// compile preview — a document.
export function FileIcon(): React.ReactElement {
  return (
    <Svg>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="13" y2="17" />
    </Svg>
  );
}

// Prompt node — a speech bubble with text lines (authored instruction text).
export function PromptIcon(): React.ReactElement {
  return (
    <Svg>
      <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.9-.9L3 21l1.9-5.6a8.5 8.5 0 0 1-.9-3.9A8.38 8.38 0 0 1 12.5 3a8.38 8.38 0 0 1 8.5 8.5Z" />
      <line x1="8" y1="10" x2="16" y2="10" />
      <line x1="8" y1="13.5" x2="13" y2="13.5" />
    </Svg>
  );
}

// --- navigation -------------------------------------------------------------

// Workflows — stacked layers.
export function LayersIcon(): React.ReactElement {
  return (
    <Svg>
      <path d="m12 2 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </Svg>
  );
}

// Runs — play.
export function PlayIcon(): React.ReactElement {
  return <Svg>{<path d="M6 4v16l14-8z" />}</Svg>;
}

// Schedules — clock.
export function ClockIcon(): React.ReactElement {
  return (
    <Svg>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Svg>
  );
}

// Settings — sliders.
export function SlidersIcon(): React.ReactElement {
  return (
    <Svg>
      <line x1="4" y1="8" x2="20" y2="8" />
      <circle cx="9" cy="8" r="2" />
      <line x1="4" y1="16" x2="20" y2="16" />
      <circle cx="15" cy="16" r="2" />
    </Svg>
  );
}

// --- editor actions ---------------------------------------------------------

// Save — floppy disk.
export function SaveIcon(): React.ReactElement {
  return (
    <Svg>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
      <path d="M17 21v-8H7v8" />
      <path d="M7 3v5h8" />
    </Svg>
  );
}

// Duplicate — overlapping squares.
export function CopyIcon(): React.ReactElement {
  return (
    <Svg>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Svg>
  );
}

// Auto-layout — framed grid.
export function LayoutIcon(): React.ReactElement {
  return (
    <Svg>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9" y1="21" x2="9" y2="9" />
    </Svg>
  );
}

// Add — plus.
export function PlusIcon(): React.ReactElement {
  return (
    <Svg>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Svg>
  );
}

// Tools — wrench.
export function WrenchIcon(): React.ReactElement {
  return (
    <Svg>
      {
        <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.7 2.7-2.3-2.3 2.7-2.7z" />
      }
    </Svg>
  );
}
