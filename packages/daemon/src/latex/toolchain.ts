export type LatexEngine = 'pdflatex' | 'xelatex' | 'lualatex';
export type LatexCompiler = 'latexmk' | 'tectonic' | LatexEngine;

export interface LatexHostCapabilities {
  available: boolean;
  preferred: LatexCompiler | null;
  engines: LatexEngine[];
  synctex: boolean;
}

export const LATEX_ENGINES = [
  'pdflatex',
  'xelatex',
  'lualatex',
] as const satisfies readonly LatexEngine[];

export const LATEX_TOOLS = [
  'latexmk',
  'tectonic',
  ...LATEX_ENGINES,
  'bibtex',
  'biber',
  'synctex',
] as const;

export type LatexTool = (typeof LATEX_TOOLS)[number];

export interface LatexToolchain {
  paths: Partial<Record<LatexTool, string>>;
  searchPath: string;
}

export function capabilitiesOf(toolchain: LatexToolchain): LatexHostCapabilities {
  const engines = LATEX_ENGINES.filter((engine) => toolchain.paths[engine] !== undefined);
  const preferred: LatexCompiler | null = toolchain.paths.latexmk
    ? 'latexmk'
    : toolchain.paths.tectonic
      ? 'tectonic'
      : (engines[0] ?? null);
  return {
    available: preferred !== null,
    preferred,
    engines,
    synctex: toolchain.paths.synctex !== undefined,
  };
}
