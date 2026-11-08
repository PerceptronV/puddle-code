// Like the existing preview-surfaces Electron check, retain process inventory
// and native memory readings. These are development-preview observations, not budgets.
export async function measureNativeWindows(application, phase, editorPage) {
  const inventory = () =>
    application.evaluate(({ app, BrowserWindow }) => ({
      metrics: app.getAppMetrics(),
      windows: BrowserWindow.getAllWindows().map((win) => ({
        id: win.id,
        renderer: win.webContents.getOSProcessId(),
        visible: win.isVisible(),
        focused: win.isFocused(),
        minimized: win.isMinimized(),
      })),
    }));
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await inventory(); // Prime interval CPU counters after startup/layout has settled.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const idle = await inventory();
  await editorPage.bringToFront();
  await inventory();
  await editorPage.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    const editor = monaco.editor
      .getEditors()
      .find((editor) => editor.getModel()?.uri.scheme === 'puddle');
    const model = editor.getModel();
    // Two seconds of normal Monaco edits/undo; preserve the original unsaved text.
    for (let index = 0; index < 20; index++) {
      editor.pushUndoStop();
      editor.executeEdits('native-acceptance', [
        {
          range: new monaco.Range(1, 1, 1, 1),
          text: 'x',
          forceMoveMarkers: true,
        },
      ]);
      editor.pushUndoStop();
      await model.undo();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  return { phase, idle, active: await inventory() };
}
