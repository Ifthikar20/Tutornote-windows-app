import { contextBridge, ipcRenderer } from "electron";

/*
  The bridge for "Explain on screen"'s see-through layer (static/overlay.html): it is told
  what to draw (pick, reading) and sends back where it was clicked.
  Only that page gets this (explain.ts).
*/

contextBridge.exposeInMainWorld(
  "screenOverlay",
  Object.freeze({
    onState: (draw: (state: unknown) => void): void => {
      ipcRenderer.on("overlay:state", (_event, state: unknown) => draw(state));
    },
    pick: (x: number, y: number): void => ipcRenderer.send("overlay:pick", x, y),
    cancel: (): void => ipcRenderer.send("overlay:cancel"),
  }),
);
