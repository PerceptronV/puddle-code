const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { join } = require('node:path');

const directory = process.env.PUDDLE_KEY_UP_TEST_DIRECTORY;
app.setPath('userData', join(directory, 'profile'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    webPreferences: { backgroundThrottling: false },
  });
  try {
    await win.loadURL(process.env.PREVIEW_URL ?? 'http://localhost:5174/');
    await win.webContents.executeJavaScript(`(async () => {
      while (!document.querySelector('header .profile-trigger')) await new Promise(requestAnimationFrame);
      const { closeSettings } = await import('/src/lib/navigation/hash-route.ts');
      closeSettings();
    })()`);
    win.show();
    win.focus();
    app.focus({ steal: true });
    win.webContents.focus();
    await wait(300);
    const fixture = require(join(directory, 'post-key-up.node'));
    const visible = () =>
      win.webContents.executeJavaScript("!!document.querySelector('[data-host-peek]')");
    fixture.down();
    await wait(250);
    assert.equal(await visible(), true, 'shortcut must open');
    fixture.post();
    await wait(150);
    assert.equal(await visible(), true, 'baseline must reproduce the swallowed Command key-up');
    require(join(directory, 'command-key-up.node'));
    const releases = [];
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyUp') releases.push(input);
    });
    fixture.post();
    await wait(150);
    assert.equal(
      await visible(),
      false,
      'native slash release must dismiss while Command+Option remain held',
    );
    assert.equal(releases.length, 1, 'release must be delivered exactly once');
    assert.equal(releases[0].code, 'Slash');
    assert.equal(releases[0].meta, true);
    assert.equal(releases[0].alt, true);
    console.log(
      'Native Mac key-up: reproduced swallowed release; forwarding dismisses the host overlay exactly once.',
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
