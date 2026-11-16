// CI check: structural validation of the vendored Claude Agent Skills.
//
// SCOPE — what this validates and what it does NOT:
//   This validates the skill FILES ONLY: that each skill has a SKILL.md, that its
//   YAML frontmatter is well-formed and carries a valid `name` and `description`
//   within the documented limits, and that every bundled reference link resolves to
//   a file that exists. It does NOT evaluate the audits, UX reviews, or interview
//   coaching the skills produce, nor their quality or effectiveness. Judging a
//   skill's actual OUTPUT would require AI-based evaluation, which is a separate,
//   optional concern and is deliberately out of scope here (see ADR-0009). This is
//   consistent with — not a contradiction of — the app's own deterministic,
//   rule-based quotation checker (ADR-0010): the two operate on different artifacts.
//
// Vendored copies live under .claude/skills/ (verbatim; see .claude/skills/README.md
// for the source repository and commit). Pure: filesystem + YAML parse only; no DB,
// Storage, network, or env.
//
// RULE SOURCES (Anthropic Agent Skills format, verified 2026-11-16):
//   - Overview:       https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
//   - Best practices: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
//   Quoted rules used below:
//     * "Every Skill requires a SKILL.md file with YAML frontmatter."         -> checks 1, 2
//     * "Required fields: name and description."                               -> checks 3, 4
//     * name: "Maximum 64 characters."                                         -> check 5
//     * name: "only lowercase letters, numbers, and hyphens."                  -> check 6
//     * name: "Cannot contain reserved words: anthropic, claude."              -> check 7
//     * name/description: "Cannot contain XML tags."                           -> checks 7, 9
//     * description: "Must be non-empty." / "Maximum 1,024 characters."        -> checks 4, 8
//   (Claude Code's own docs treat name/description as optional; we enforce the
//    stricter published Agent Skills format, which all vendored skills satisfy.)
//   The reference-link integrity check (check 10) is grounded in the skills' own
//   content — each SKILL.md links its bundled references and instructs "do not
//   invent" — not in the spec; a dangling bundled link is a real defect.

import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname, normalize, relative, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// Defaults to the repo's vendored skills. RQA_SKILLS_DIR overrides it so the
// negative tests can point the validator at temporary broken fixtures; CI never
// sets it, so CI always validates .claude/skills/.
const SKILLS_DIR = process.env.RQA_SKILLS_DIR
  ? resolve(process.env.RQA_SKILLS_DIR)
  : join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".claude", "skills");

// Documented limits (characters). Not invented — see RULE SOURCES above.
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const NAME_PATTERN = /^[a-z0-9-]+$/;
const RESERVED_WORDS = ["anthropic", "claude"];
// Matches a real XML/HTML tag (`<tag ...>`, `</tag>`, `<tag/>`) — a `<` must be
// immediately followed by a letter or `/`. A lone `<`/`>` or `>=`, `->`, `< 4` do
// NOT match, so we honor "no XML tags" without flagging every angle bracket.
const XML_TAG = /<\/?[a-zA-Z][^<>]*>/;

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    console.log(`PASS: ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

/** Split a SKILL.md into its raw frontmatter string and body. */
function splitFrontmatter(text: string): { ok: boolean; yaml?: string; body?: string } {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { ok: false };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return { ok: true, yaml: lines.slice(1, i).join("\n"), body: lines.slice(i + 1).join("\n") };
    }
  }
  return { ok: false }; // opening --- but never closed
}

/** Relative local links `](path)` from markdown body, minus URLs and bare anchors. */
function localLinks(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\]\(([^)]+)\)/g)) {
    let target = m[1].trim();
    // Drop an optional "title": [text](path "title")
    target = target.replace(/\s+["'].*$/, "");
    if (!target) continue;
    if (/^[a-z]+:/i.test(target)) continue; // http:, https:, mailto:, etc.
    if (target.startsWith("#")) continue; // in-page anchor
    target = target.split("#")[0]; // strip #section anchor
    if (!target) continue;
    out.push(target);
  }
  return out;
}

const skillDirs = existsSync(SKILLS_DIR)
  ? readdirSync(SKILLS_DIR).filter((entry) => statSync(join(SKILLS_DIR, entry)).isDirectory())
  : [];

check("skills directory present with at least one skill", skillDirs.length > 0, SKILLS_DIR);

for (const skill of skillDirs.sort()) {
  const dir = join(SKILLS_DIR, skill);
  const skillMd = join(dir, "SKILL.md");

  // 1. SKILL.md exists at the skill root.
  const hasSkillMd = existsSync(skillMd) && statSync(skillMd).isFile();
  check(`${skill}: SKILL.md present`, hasSkillMd);
  if (!hasSkillMd) continue;

  const text = readFileSync(skillMd, "utf8");

  // 2. Frontmatter is a `---`-fenced block and parses as YAML.
  const fm = splitFrontmatter(text);
  check(`${skill}: has --- frontmatter block as first line`, fm.ok);
  if (!fm.ok) continue;

  let data: unknown;
  let parseOk = true;
  try {
    data = parseYaml(fm.yaml ?? "");
  } catch (err) {
    parseOk = false;
    check(`${skill}: frontmatter parses as YAML`, false, (err as Error).message);
  }
  if (!parseOk) continue;
  check(`${skill}: frontmatter parses as YAML`, true);

  const isObject = data !== null && typeof data === "object" && !Array.isArray(data);
  check(`${skill}: frontmatter is a mapping`, isObject);
  if (!isObject) continue;
  const fields = data as Record<string, unknown>;

  const name = fields.name;
  const description = fields.description;

  // 3. name present and non-empty.
  const nameOk = typeof name === "string" && name.trim().length > 0;
  check(`${skill}: name present and non-empty`, nameOk, JSON.stringify(name));
  if (nameOk) {
    const n = name as string;
    // 5. length <= 64
    check(`${skill}: name <= ${NAME_MAX} chars`, n.length <= NAME_MAX, `len=${n.length}`);
    // 6. charset
    check(`${skill}: name is lowercase letters/numbers/hyphens`, NAME_PATTERN.test(n), n);
    // 7. no reserved word, no XML tag
    const reserved = RESERVED_WORDS.find((w) => n.toLowerCase().includes(w));
    check(`${skill}: name has no reserved word (anthropic/claude)`, !reserved, reserved ?? "");
    check(`${skill}: name has no XML tag`, !XML_TAG.test(n), n);
  }

  // 4. description present and non-empty.
  const descOk = typeof description === "string" && description.trim().length > 0;
  check(`${skill}: description present and non-empty`, descOk, JSON.stringify(description));
  if (descOk) {
    const d = description as string;
    // 8. length <= 1024
    check(`${skill}: description <= ${DESCRIPTION_MAX} chars`, d.length <= DESCRIPTION_MAX, `len=${d.length}`);
    // 9. no XML tag
    check(`${skill}: description has no XML tag`, !XML_TAG.test(d), d.slice(0, 60));
  }

  // 10. Every relative local link in the body resolves to an existing file,
  //     and must stay inside the skill folder (no escaping copies).
  const links = localLinks(fm.body ?? "");
  for (const link of links) {
    const resolved = normalize(join(dir, link));
    const insideSkill = !isAbsolute(link) && !relative(dir, resolved).startsWith("..");
    check(`${skill}: reference link stays inside skill folder (${link})`, insideSkill, resolved);
    check(`${skill}: reference link resolves (${link})`, existsSync(resolved), resolved);
  }
}

if (failures > 0) {
  console.error(`\n${failures} skill-structure check(s) failed.`);
  process.exit(1);
}
console.log("\nALL SKILL-STRUCTURE CHECKS PASSED");
