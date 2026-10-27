import { contextBridge, ipcRenderer } from "electron";

/*
  The bridge for the desktop companion's blob (static/blob.html): it is told how to look (resting,
  on, reading, blocked) and what its label says; it sends back the student's press and release
  (the drag, or a click), a right click (its menu), and the pointer coming over it or leaving
  (its label shows beside it then, in a window made wider for it). Only that page gets this
  (companion.ts).
*/

contextBridge.exposeInMainWorld(
  "screenBlob",
  Object.freeze({
    onState: (draw: (state: unknown) => void): void => {
      ipcRenderer.on("blob:state", (_event, state: unknown) => draw(state));
      ipcRenderer.send("blob:ready");
    },
    /** The button went down on the blob: it follows the cursor until dragEnd. */
    dragStart: (): void => ipcRenderer.send("blob:drag-start"),
    /** The button came up: a drag ends there, and a press that hardly moved is a click. */
    dragEnd: (): void => ipcRenderer.send("blob:drag-end"),
    /** Turn the tutor on or off (a click, as dragEnd decides; or from the keyboard). */
    toggle: (): void => ipcRenderer.send("blob:toggle"),
    /** A right click: Turn off, Hide the tutor. */
    menu: (): void => ipcRenderer.send("blob:menu"),
    /** The pointer came over the blob, or left it: its label shows, or goes. */
    hover: (on: unknown): void => ipcRenderer.send("blob:hover", on === true),
  }),
);
