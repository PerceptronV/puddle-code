import type { IBufferCell, ITheme, Terminal } from '@xterm/xterm';

export interface RipplePalette {
  theme: ITheme;
  ansi?: string[];
  boldBright?: boolean;
  link?: (cell: IBufferCell) => string | undefined;
}

// xterm 6 exposes cells through its public buffer API, but not their extended
// underline attributes or OSC 8 targets. Keep the version-specific, read-only
// bridge here; missing internals fall back to public styles, never another parser.
export type ExtendedCell = IBufferCell & {
  getUnderlineStyle?: () => number;
  getUnderlineColor?: () => number;
  isUnderlineColorPalette?: () => boolean;
  isUnderlineColorRGB?: () => boolean;
  extended?: { urlId?: number };
};

export function ripplePalette(terminal: Terminal): RipplePalette {
  const core = (
    terminal as unknown as {
      _core?: {
        _themeService?: {
          colors?: {
            foreground: { rgba: number };
            background: { rgba: number };
            ansi: { rgba: number }[];
          };
        };
        _oscLinkService?: { getLinkData(id: number): { uri: string } | undefined };
      };
    }
  )._core;
  const colours = core?._themeService?.colors;
  const hex = (colour: { rgba: number }) => `#${(colour.rgba >>> 8).toString(16).padStart(6, '0')}`;
  return {
    theme: {
      ...terminal.options.theme,
      ...(colours && { foreground: hex(colours.foreground), background: hex(colours.background) }),
    },
    ansi: colours?.ansi.map(hex),
    boldBright: terminal.options.drawBoldTextInBrightColors,
    link: (cell) => {
      if (cell.isInvisible()) return;
      const id = (cell as ExtendedCell).extended?.urlId;
      const uri = id ? core?._oscLinkService?.getLinkData(id)?.uri : undefined;
      // Match the reader's existing link policy; never execute terminal URLs.
      return uri && /^https?:\/\//i.test(uri) ? uri : undefined;
    },
  };
}
