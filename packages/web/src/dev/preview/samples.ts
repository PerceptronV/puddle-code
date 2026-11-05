/** Small self-contained documents for exercising the real preview controls. */
export const notebookSample = JSON.stringify(
  {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
    cells: [
      {
        id: 'intro',
        cell_type: 'markdown',
        metadata: {},
        source: ['# Preview notebook\n', 'Try adding a cell or opening the outline.'],
      },
      {
        id: 'hello',
        cell_type: 'code',
        metadata: {},
        source: ['print("Hello, Puddle")'],
        execution_count: 1,
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['Hello, Puddle\n'] }],
      },
    ],
  },
  null,
  2,
);

function samplePdf(): string {
  const text = 'BT /F1 24 Tf 50 740 Td (Puddle PDF preview) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}
export const pdfSample = samplePdf();
