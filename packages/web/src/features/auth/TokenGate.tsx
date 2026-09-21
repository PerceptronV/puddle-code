/** Launch invitations replace the old manual master-token gate. */
export function TokenGate() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-ground">
      <div className="flex w-full max-w-md flex-col gap-10 px-8 pb-24">
        <h1 className="font-mono text-2xl font-semibold text-fg">Puddle</h1>
        <div className="flex flex-col gap-3 text-sm leading-relaxed text-fg-secondary">
          <p>
            Authorise this browser by running{' '}
            <span className="font-mono text-accent">puddle launch</span> in a terminal.
          </p>
          <p>Use the link it opens. Your sessions, drafts and layouts stay in place.</p>
        </div>
      </div>
    </div>
  );
}
