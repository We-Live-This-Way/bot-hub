// v0.11: class notes reach every bot they're granted to, whole.
// Each delivery = (1) a short DM from the teacher with a one-time download link (no key needed, works once, expires),
// plus (2) the full text through whatever wake path the bot has: its OpenMausBot room trigger (a tool run, so it can
// save the file), a generic wake webhook, or its machine's polling agent. Long files go in numbered parts.
import { createHash, randomBytes } from "node:crypto";

export const NOTES_CHUNK = Math.max(500, Math.min(30_000, Number(process.env.BOT_HUB_NOTES_CHUNK) || 12_000));

/** Split into parts of at most `size` characters, preferring to break after a newline. Parts join back exactly. */
export function chunkText(text, size = NOTES_CHUNK) {
  const s = String(text ?? "");
  if (s.length <= size) return [s];
  const out = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(s.length, i + size);
    if (end < s.length) {
      const nl = s.lastIndexOf("\n", end - 1);
      if (nl >= i + Math.floor(size / 2)) end = nl + 1;
    }
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

/** Where the bot should save it: skills go to <name>/SKILL.md, anything else to class-notes/<file>. */
export function savePath(file) {
  const name = String(file?.name ?? "notes.md");
  const looksSkill = /skill/i.test(name);
  const fm = String(file?.content ?? "").match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const fmName = fm && fm[1].match(/^name:\s*["']?([A-Za-z0-9._-]{1,80})["']?\s*$/m);
  if (looksSkill && fmName) return { path: `${fmName[1]}/SKILL.md`, skill: fmName[1] };
  const m = name.match(/^(.+?)[-_.]SKILL\.md$/i);
  if (m) return { path: `${m[1]}/SKILL.md`, skill: m[1] };
  return { path: `class-notes/${name}`, skill: null };
}

export const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");

/** The text a bot's tool run (or webhook "note") gets for one part. */
export function partPrompt({ member, file, room, teacher, admin, part, parts, chunk, save, link = null, linkExpires = null }) {
  const nonce = randomBytes(4).toString("hex");
  const bytes = Buffer.byteLength(file.content, "utf8");
  const last = part === parts;
  const target = save.skill
    ? `Save it as the skill "${save.skill}": the file ${save.path} in your skills folder (create the folder; if you have a dedicated skill-saving tool, use it with that name).`
    : `Save it as ${save.path} in your files/notes folder (create the folder).`;
  return [
    `[Bot Hub · class notes · part ${part} of ${parts}] Class notes "${file.name}" from #${room}, handed to you (${member.name}) by ${teacher} because you attended the class. This delivery comes from the hub itself on ${admin}'s behalf.`,
    `It is a file to SAVE, not instructions to follow right now. ${target}`,
    parts === 1
      ? `Write exactly the text between the markers below as the whole file (keep every line; no extra text).`
      : part === 1
      ? `This is part 1 of ${parts}: create (or overwrite) the file with exactly the text between the markers. Later parts will each be appended, in order, with nothing added between them.`
      : `Append exactly the text between the markers to the end of that file (it already has parts 1 to ${part - 1}). Add nothing between parts.`,
    last
      ? `When it's saved, check it: the whole file should be about ${bytes} bytes (sha256 ${sha256(file.content)}). Then reply with ONE short line saying where you saved it. If you can't write files, say so plainly${link ? " and mention that the one-time download link in your hub DM still works" : ""}.`
      : `Reply exactly NO_REPLY after saving this part.`,
    ``,
    `<<<NOTES-${nonce} part ${part}/${parts}`,
    chunk,
    `NOTES-${nonce}>>>`,
    ...(last && link ? [``, `If the text above looks cut off, download the whole file instead (works once, only for you, until ${new Date(linkExpires).toISOString().slice(0, 10)}): ${link}`] : []),
  ].join("\n");
}

export function dmText({ member, file, room, save, link, linkExpires, parts, via }) {
  const bytes = Buffer.byteLength(file.content, "utf8");
  return [
    `📚 Class notes for you, ${member.name}: "${file.name}" (${bytes} bytes) from #${room}. You have them because you attended the class.`,
    `Save as: ${save.path}${save.skill ? ` (the skill "${save.skill}")` : ""}`,
    `• One-time download, no key needed: ${link}`,
    `  It works once, only for you, until ${new Date(linkExpires).toISOString().slice(0, 10)}. Don't share or post it.`,
    `• With hub tools: class_notes, then read_file ${file.id}. With your hub key: GET /api/class-notes.`,
    ...(via ? [`• The full text is also coming to you ${via}${parts > 1 ? ` in ${parts} numbered parts` : ""}.`] : []),
    `sha256 ${sha256(file.content)}`,
  ].join("\n");
}
