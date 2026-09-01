import { runJXA } from "./osa.js";

/**
 * The LCD readouts (tempo, playhead position) are AXSliders inside the
 * Control Bar group — readable and settable through accessibility. BFS is
 * rooted at the Control Bar (a few dozen nodes) with a window-wide fallback.
 */
function sliderScript(pattern: string, value?: number): string {
  return `
    const se = Application('System Events');
    const p = se.processes['GarageBand'];
    const w = p.windows[0];
    let roots = [];
    try {
      const cbs = w.uiElements.whose({description: 'Control Bar'});
      if (cbs.length > 0) roots.push(cbs[0]);
    } catch (e) {}
    roots.push(w);
    const re = new RegExp(${JSON.stringify(pattern)}, 'i');
    let target = null;
    for (const root of roots) {
      const queue = [root];
      let visited = 0;
      while (queue.length > 0 && visited < 400 && target === null) {
        const el = queue.shift();
        visited++;
        try {
          if (String(el.role()) === 'AXSlider' && re.test(String(el.description()))) {
            target = el;
            break;
          }
        } catch (e) {}
        try {
          const kids = el.uiElements();
          for (let i = 0; i < kids.length; i++) queue.push(kids[i]);
        } catch (e) {}
      }
      if (target !== null) break;
    }
    if (target === null) {
      'NOTFOUND';
    } else {
      ${value !== undefined ? `target.value = ${value}; delay(0.25);` : ""}
      String(target.value());
    }
  `;
}

/** Read an LCD slider's value by description pattern ("tempo", "beat"). Null if not found. */
export async function readLcdSlider(pattern: string): Promise<number | null> {
  const out = await runJXA(sliderScript(pattern), 30_000);
  return out === "NOTFOUND" ? null : parseFloat(out);
}

/** Write an LCD slider's value; returns the read-back value, or null if not found. */
export async function writeLcdSlider(pattern: string, value: number): Promise<number | null> {
  const out = await runJXA(sliderScript(pattern, value), 30_000);
  return out === "NOTFOUND" ? null : parseFloat(out);
}
