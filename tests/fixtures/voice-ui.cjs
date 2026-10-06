// Opens only an isolated voice component; microphone permissions always denied.
const { app, BrowserWindow, session } = require("electron");
app.disableHardwareAcceleration();
app.setPath("userData", process.env.CODEBIT_VOICE_UI_DATA);
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler(
    (_web, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  const win = new BrowserWindow({
    show: false,
    width: 1300,
    height: 820,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(process.env.CODEBIT_VOICE_UI_PAGE);
});
app.on("window-all-closed", () => app.quit());
