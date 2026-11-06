import { createRoot } from 'react-dom/client';
import { PdfViewer } from '../../src/features/editor/previews/pdf/PdfViewer';
import { HtmlPreview } from '../../src/features/editor/previews/html/HtmlPreview';

// A complete synthetic three-page PDF, with no file, account or session data.
function pdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>',
  ];
  for (let page = 0; page < 3; page++) {
    const content = Array.from(
      { length: 60 },
      (_, i) => `${(i % 10) / 10} 0.4 0.7 rg ${(i % 6) * 100} ${Math.floor(i / 6) * 70} 90 60 re f`,
    ).join('\n');
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents ${4 + page * 2} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  }
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([source], { type: 'application/pdf' });
}
const blob = pdf();
const root = createRoot(document.getElementById('root')!);
const html = `<style>body{margin:0;background:repeating-linear-gradient(45deg,#345 0 10px,#789 10px 20px)}article{margin:20px;padding:50px;transform:translateZ(0);background:#fffa;backdrop-filter:blur(2px)}</style>${'<article>Synthetic preview surface</article>'.repeat(12)}`;
Object.assign(window, {
  show(kind: string) {
    root.render(
      kind === 'pdf' ? (
        <PdfViewer blob={blob} session="synthetic" path="fixture.pdf" />
      ) : kind === 'html' ? (
        <HtmlPreview session="synthetic" path="fixture.html" text={html} />
      ) : null,
    );
  },
  inventory() {
    return {
      canvases: document.querySelectorAll('canvas').length,
      canvasPixels: [...document.querySelectorAll('canvas')].reduce(
        (total, canvas) => total + canvas.width * canvas.height,
        0,
      ),
      frames: document.querySelectorAll('iframe').length,
      visibility: document.visibilityState,
    };
  },
});
