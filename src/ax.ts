import { runJXA } from "./osa.js";

export interface AxHit {
  role: string;
  text: string;
  value: string | null;
  pos: [number, number] | null;
  size: [number, number] | null;
}

/**
 * BFS a top-level window group (description "Tracks" / "Library" /
 * "Smart Controls" / …) collecting elements matched by a JXA predicate
 * expression over `role`, `desc`, and `value` string variables.
 */
function groupScanScript(groupDesc: string, matchExpr: string, cap: number): string {
  return `
    const se = Application('System Events');
    const p = se.processes['GarageBand'];
    const w = p.windows[0];
    let root = null;
    try {
      const g = w.uiElements.whose({description: ${JSON.stringify(groupDesc)}});
      if (g.length > 0) root = g[0];
    } catch (e) {}
    if (root === null) {
      'NOGROUP';
    } else {
      const found = [];
      const queue = [root];
      let visited = 0;
      while (queue.length > 0 && visited < 700 && found.length < ${cap}) {
        const el = queue.shift();
        visited++;
        let role = '', desc = '', value = '';
        try { role = String(el.role() || ''); } catch (e) {}
        try { desc = String(el.description() || ''); } catch (e) {}
        try { const v = el.value(); if (v !== null && v !== undefined) value = String(v); } catch (e) {}
        if (${matchExpr}) {
          let pos = null, size = null;
          try { pos = el.position(); } catch (e) {}
          try { size = el.size(); } catch (e) {}
          found.push({ role: role, text: desc || value, value: value === '' ? null : value, pos: pos, size: size });
        }
        try {
          const kids = el.uiElements();
          for (let i = 0; i < kids.length; i++) queue.push(kids[i]);
        } catch (e) {}
      }
      JSON.stringify(found);
    }
  `;
}

/** Scan a named window group; null when the group is not present in the window. */
export async function scanGroup(
  groupDesc: string,
  matchExpr: string,
  cap = 40,
): Promise<AxHit[] | null> {
  const out = await runJXA(groupScanScript(groupDesc, matchExpr, cap), 45_000);
  if (out === "NOGROUP") return null;
  return JSON.parse(out) as AxHit[];
}

/** Set an AXSlider's value by group + description pattern; returns read-back or null. */
export async function setGroupSlider(
  groupDesc: string,
  descPattern: string,
  value: number,
): Promise<number | null> {
  const script = `
    const se = Application('System Events');
    const p = se.processes['GarageBand'];
    const w = p.windows[0];
    let root = null;
    try {
      const g = w.uiElements.whose({description: ${JSON.stringify(groupDesc)}});
      if (g.length > 0) root = g[0];
    } catch (e) {}
    if (root === null) { 'NOGROUP'; } else {
      const re = new RegExp(${JSON.stringify(descPattern)}, 'i');
      let target = null;
      const queue = [root];
      let visited = 0;
      while (queue.length > 0 && visited < 700 && target === null) {
        const el = queue.shift();
        visited++;
        try {
          if (String(el.role()) === 'AXSlider' && re.test(String(el.description()))) { target = el; break; }
        } catch (e) {}
        try {
          const kids = el.uiElements();
          for (let i = 0; i < kids.length; i++) queue.push(kids[i]);
        } catch (e) {}
      }
      if (target === null) { 'NOTFOUND'; } else {
        target.value = ${value};
        delay(0.25);
        String(target.value());
      }
    }
  `;
  const out = await runJXA(script, 45_000);
  return out === "NOGROUP" || out === "NOTFOUND" ? null : parseFloat(out);
}
