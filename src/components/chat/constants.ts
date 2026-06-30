/**
 * Constants for chat components
 */

/**
 * Maximum number of lines to display in truncated diffs
 */
export const MAX_DIFF_LINES = 20;

/**
 * The text persisted as a system message when a request is aborted.
 * Keep in sync with AgentLoop.ts and any UI code that checks for abort notices.
 */
export const ABORT_NOTICE_TEXT = 'Interrupted';
export const ABORT_NOTICE_DISPLAY_TEXT = '⎿ Interrupted';
export const LEGACY_ABORT_NOTICE_TEXT = ABORT_NOTICE_DISPLAY_TEXT;

/**
 * ANSI escape sequences for terminal key combinations
 */
export const ANSI = {
  // Basic control characters
  ESC: '\x1b',
  BACKSPACE: '\x7F',
  DELETE: '\x7F', // Backspace character
  FORWARD_DELETE: '\x1b[3~', // Standard forward delete on Linux/Unix
  CTRL_W: '\x17', // Word delete
  NEWLINE: '\n',
  CARRIAGE_RETURN: '\r',
  TAB: '\t',

  // Option/Alt key combinations
  OPTION_LEFT_ARROW_1: '\x1b[1;9D',
  OPTION_LEFT_ARROW_2: '\x1b[1;3D',
  OPTION_RIGHT_ARROW_1: '\x1b[1;9C',
  OPTION_RIGHT_ARROW_2: '\x1b[1;3C',

  // Command/Ctrl key combinations
  CMD_LEFT_ARROW_1: '\x1b[1;2D',
  CMD_LEFT_ARROW_2: '\x1b[H', // Home
  CMD_RIGHT_ARROW_1: '\x1b[1;2C',
  CMD_RIGHT_ARROW_2: '\x1b[F', // End

  // Ctrl+Arrow combinations (commonly supported on Windows terminals)
  CTRL_LEFT_ARROW: '\x1b[1;5D',
  CTRL_RIGHT_ARROW: '\x1b[1;5C',

  // Option+Delete combinations
  OPTION_DELETE_1: '\x1b\x7F',
  OPTION_DELETE_2: '\x17',

  // Cmd+Delete combinations (whole line deletion)
  CMD_DELETE_1: '\x1b[3;2~',
  CMD_DELETE_2: '\x15', // Ctrl+U (delete whole line)

  // Ctrl+Shift+Delete (whole line deletion on many Windows terminals)
  CTRL_SHIFT_DELETE: '\x1b[3;6~',

  // Cmd+Copy and Cmd+Paste combinations
  CMD_COPY: '\x03', // Ctrl+C
  CMD_PASTE: '\x16', // Ctrl+V

  // Alt+V combinations (Windows image paste alternative)
  ALT_V_ESC: 'v', // Alt+V after ESC sequence
  ALT_V_DIRECT: '\x1bv', // Alt+V as ESC+v

  // Option+letter combinations
  OPTION_B: 'b', // After ESC
  OPTION_F: 'f', // After ESC
  OPTION_D: 'd', // After ESC
  OPTION_A: 'a', // After ESC (start of line)
  OPTION_E: 'e', // After ESC (end of line)

  // Shift+Enter combinations (terminal-specific)
  SHIFT_ENTER_GHOSTTY: '\x1b[27;2;13~', // Ghostty, iTerm2, other terminals
  SHIFT_ENTER_XTERM: '\x1b[13;2u', // xterm-style terminals
  // Kitty CSI-u variants we care about
  SHIFT_TAB_KITTY: '\x1b[9;2u',
  ESC_KITTY: '\x1b[27u',

  // Explicit Shift+Arrow mappings (aliases for clarity)
  SHIFT_LEFT_ARROW: '\x1b[1;2D',
  SHIFT_RIGHT_ARROW: '\x1b[1;2C',

  // Mac fn+delete (forward delete) sequences
  MAC_FN_DELETE_KITTY: '\x1b[3;1u', // Kitty CSI-u sequence for fn+delete
  MAC_FN_DELETE_STANDARD: '[3~', // Standard sequence without leading ESC (some terminals)

  // Terminal screen control
  EXIT_ALTERNATE_SCREEN: '\x1b[?1049l',
  ENTER_ALTERNATE_SCREEN: '\x1b[?1049h',
  CLEAR_SCREEN: '\x1b[2J',
  MOVE_CURSOR_HOME: '\x1b[H',
  SHOW_CURSOR: '\x1b[?25h',
  HIDE_CURSOR: '\x1b[?25l',

  // Terminal mode control
  ENABLE_FOCUS_REPORTING: '\x1b[?1004h',
  DISABLE_FOCUS_REPORTING: '\x1b[?1004l',
  ENABLE_BRACKETED_PASTE: '\x1b[?2004h',
  DISABLE_BRACKETED_PASTE: '\x1b[?2004l',
  ENABLE_XTERM_MODIFY_OTHER_KEYS: '\x1b[>4;1m',
  DISABLE_XTERM_MODIFY_OTHER_KEYS: '\x1b[>4;0m',
};

/**
 * Default values for components
 */
export const DEFAULTS = {
  // ChatInput defaults
  INPUT_WIDTH: 60,
  INPUT_PLACEHOLDER: '',

  // ChatFileSuggestions defaults
  MAX_SUGGESTIONS: 6,
  SHOW_HIDDEN_FILES: true,

  // ChatTextBuffer defaults
  VIEWPORT_WIDTH: 80,
  VIEWPORT_HEIGHT: 24,

  // Timeouts
  ESC_TIMEOUT_MS: 50,

  // File suggestions debounce and loading indicator
  // Debounce rapid typing to reduce redundant async work
  FILE_SUGGESTIONS_DEBOUNCE_MS: 100,
  // Delay before showing loading indicator to avoid flicker for fast completions
  FILE_SUGGESTIONS_LOADING_DELAY_MS: 200,
};

/**
 * Special character codes
 */
export const CHAR_CODES = {
  BACKSLASH: 92, // Used to detect Shift+Enter in some terminals
  SPACE: 32,
  MIN_PRINTABLE: 32,
  MAX_PRINTABLE: 126,
};

/**
 * Regex patterns
 */
export const PATTERNS = {
  WHITESPACE: /\s/,
  NON_WHITESPACE: /\S/,
};

/**
 * ASCII art for the header
 */
const DROOL_ASCII = `
█████████    █████████     ████████     ████████    ███
███    ███   ███    ███   ███    ███   ███    ███   ███
███    ███   ███    ███   ███    ███   ███    ███   ███
███    ███   █████████    ███    ███   ███    ███   ███
███    ███   ███    ███   ███    ███   ███    ███   ███
███    ███   ███    ███   ███    ███   ███    ███   ███
█████████    ███    ███    ████████     ████████    █████████`;

/**
 * DROOL block-letter logo as string array, derived from DROOL_ASCII.
 */
export const DROOL_HEADER_LOGO = DROOL_ASCII.trim().split('\n');

/**
 * Minimal DROOL logo for narrow terminals.
 * 21 chars wide, 3 lines tall.
 */
export const DROOL_HEADER_LOGO_MINI = [
  '╔═══════════════════╗',
  '║     D R O O L     ║',
  '╚═══════════════════╝',
];

const INDUSTRY_ROUTER_TOOLTIP =
  'Select Industry Router to automatically pick the best model for each task at lower cost';

/**
 * Practical tooltips shown randomly at startup.
 */
export const HEADER_TOOLTIPS = [
  'Press Ctrl+N to cycle AI models',
  'Use @ to mention files in your prompt',
  'Use /review to start a code review',
  'Press Ctrl+O to toggle detailed view',
  'Use /sessions to browse previous conversations',
  'Press Ctrl+T to open Mission Control',
  'Use /settings to customize your experience',
  'Use /rewind-conversation to rewind to a previous message',
  'Use /missions to start or resume complex multi-step tasks',
  'Use /create-skill to teach Drool new reusable skills',
  'Use /share to share your session with your team',
  'Use /new to start a fresh session with clean context',
  'Use /copy to copy the last response to your clipboard',
  'Use /bug to report issues directly from your session',
  'Use /help to see all available commands',
  'Use /themes to customize colors and override terminal colors',
  'Press Alt/Option+X to disable auto-compress',
  'Use /context to see your context window usage breakdown',
  'Use /loop to repeat a prompt on an interval until stopped',
  'Press Ctrl+Enter to queue a message while Drool is working',
  'Press Ctrl+Shift+V to expand a truncated pasted block',
  'Press f in the model selector to favorite models',
  INDUSTRY_ROUTER_TOOLTIP,
];

/** Tips weighted to appear more often than the default weight of 1. */
export const HEADER_TOOLTIP_WEIGHTS: Record<string, number> = {
  [INDUSTRY_ROUTER_TOOLTIP]: 3,
};
