// uDuke - what the menu page shows, as data: the levels by episode.

export const MODULE_STAGE = 'stage12.195';

const stem = (f) => f.replace(/\.MAP$/i, '');

/**
 * The GRP's maps grouped as Duke numbers them: USER.CON's definelevelname
 * puts each file at volume*11 + level; a map it does not name but called
 * E<v>L<l> goes to that slot; anything else is an "other map". Groups come
 * episode by episode, levels in their order, each labelled "<n> <name>".
 * Episode titles are definevolumename's.
 *
 * @param {string[]} maps  the GRP's .MAP entries
 * @param {{levels: Map<number,{file:string,name:string}>, volumes: string[]}} defs
 */
export function groupLevels(maps, defs = {}) {
  const byFile = new Map();
  for (const [k, lv] of defs.levels ?? []) if (lv?.file) byFile.set(lv.file.toUpperCase(), { k, name: lv.name });
  const eps = new Map(), other = [];
  for (const file of maps) {
    const up = file.toUpperCase();
    let k = byFile.get(up)?.k, name = byFile.get(up)?.name;
    if (k === undefined) {
      const m = /^E(\d)L(\d+)\.MAP$/.exec(up);
      if (m) k = (Number(m[1]) - 1) * 11 + Number(m[2]) - 1;
    }
    if (k === undefined || k < 0) { other.push({ file, label: stem(file), title: file }); continue; }
    const vol = Math.floor(k / 11), lev = k % 11;
    if (!eps.has(vol)) eps.set(vol, []);
    eps.get(vol).push({ file, lev, label: `${lev + 1} ${name || stem(file)}`, title: file });
  }
  const groups = [...eps.keys()].sort((a, b) => a - b).map((vol) => ({
    title: `E${vol + 1}${defs.volumes?.[vol] ? ` ${defs.volumes[vol]}` : ''}`,
    levels: eps.get(vol).sort((a, b) => a.lev - b.lev),
  }));
  if (other.length) groups.push({ title: 'Other maps', levels: other.sort((a, b) => a.label.localeCompare(b.label)) });
  return groups;
}
