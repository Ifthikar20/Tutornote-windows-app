import { contextBridge, ipcRenderer } from "electron";

/*
  The bridge for "Explain on screen"'s floating panel (static/board.html): what is happening
  before the lesson opens, or what went wrong, comes in; the panel's buttons go out. Only that
  page gets this (explain.ts).
*/

type Command = "again" | "close" | "settings" | "retry";

contextBridge.exposeInMainWorld(
  "screenTutor",
  Object.freeze({
    onMessage: (show: (message: unknown) => void): void => {
      ipcRenderer.on("board:message", (_event, message: unknown) => show(message));
    },
    send: (command: Command): void => ipcRenderer.send("board:command", command),
  }),
);
