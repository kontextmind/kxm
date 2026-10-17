#!/usr/bin/env node

// Relative links and heading anchors under plans/.
// Docs lint runs this. It does not call the network.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function githubSlug(value) {
  return value.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "").replace(/ /g, "-");
}

function headingText(raw) {
  let text = raw.trim().replace(/\s+#+\s*$/, "");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/<([^>\s]+)>/g, "$1");
  text = text.replace(/`([^`]*)`/g, "$1");
  text = text.replace(/<\/?[^>]+>/g, "");
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return text;
}

export function headingIds(markdown) {
  const lines = markdown.split("\n");
  const ids = new Set();
  const occurrences = Object.create(null);
  const own = Object.hasOwnProperty;
  let index = 0;
  let fence = null;
  if (lines[0]?.trim() === "---") {
    index = 1;
    while (index < lines.length && lines[index].trim() !== "---") index += 1;
    index += 1;
  }
  function addSlug(text) {
    const original = githubSlug(headingText(text));
    let result = original;
    while (own.call(occurrences, result)) {
      occurrences[original] = (occurrences[original] || 0) + 1;
      result = `${original}-${occurrences[original]}`;
    }
    occurrences[result] = 0;
    ids.add(result);
  }
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    const opened = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (opened && !fence) {
      fence = opened[1];
      continue;
    }
    if (fence && new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) {
      fence = null;
      continue;
    }
    if (fence) continue;
    const atx = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (atx) addSlug(atx[2]);
    for (const match of line.matchAll(/\sid=["']([^"']+)["']/g)) ids.add(match[1]);
    for (const match of line.matchAll(/\sname=["']([^"']+)["']/g)) ids.add(match[1]);
  }
  return ids;
}

function visibleLines(markdown) {
  const lines = markdown.split("\n");
  const visible = [];
  let fence = null;
  let comment = false;
  for (const line of lines) {
    if (!fence && !comment) {
      const opened = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (opened) {
        fence = opened[1];
        visible.push("");
        continue;
      }
    }
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = null;
      visible.push("");
      continue;
    }
    let rest = line;
    let kept = "";
    while (rest.length > 0) {
      if (comment) {
        const end = rest.indexOf("-->");
        if (end < 0) {
          rest = "";
          break;
        }
        comment = false;
        rest = rest.slice(end + 3);
        continue;
      }
      const start = rest.indexOf("<!--");
      if (start < 0) {
        kept += rest;
        rest = "";
        break;
      }
      kept += rest.slice(0, start);
      rest = rest.slice(start + 4);
      comment = true;
    }
    visible.push(kept);
  }
  return visible;
}

function destinationOf(raw) {
  let dest = raw.trim();
  if (dest.startsWith("<") && dest.endsWith(">")) dest = dest.slice(1, -1).trim();
  dest = dest.replace(/\s+"[^"]*"$/, "").replace(/\s+'[^']*'$/, "");
  return dest;
}

function problemsForDestination(file, lineNumber, dest) {
  if (!dest || /^[a-z][a-z0-9+.-]*:/i.test(dest)) return [];
  if (dest.startsWith("//")) return [];
  if (dest.startsWith("/")) {
    return [`${file}:${lineNumber}: absolute path is not a repository link: ${dest}`];
  }
  const hash = dest.indexOf("#");
  let pathPart = hash >= 0 ? dest.slice(0, hash) : dest;
  const frag = hash >= 0 ? dest.slice(hash + 1) : "";
  pathPart = pathPart.split("?")[0];
  let decodedPath = pathPart;
  let decodedFrag = frag;
  try { decodedPath = decodeURIComponent(pathPart); } catch { /* keep raw */ }
  try { decodedFrag = decodeURIComponent(frag); } catch { /* keep raw */ }
  if (!decodedPath) {
    if (!decodedFrag) return [];
    const ids = headingIds(readFileSync(file, "utf8"));
    if (!ids.has(decodedFrag)) return [`${file}:${lineNumber}: missing anchor #${decodedFrag}`];
    return [];
  }
  const target = resolve(dirname(file), decodedPath);
  if (!existsSync(target)) return [`${file}:${lineNumber}: missing ${dest}`];
  if (decodedFrag && target.endsWith(".md")) {
    const ids = headingIds(readFileSync(target, "utf8"));
    if (!ids.has(decodedFrag)) return [`${file}:${lineNumber}: missing anchor ${dest}`];
  }
  return [];
}

function relatedProblems(file, markdown) {
  if (!markdown.startsWith("---\n")) return [];
  const end = markdown.indexOf("\n---", 4);
  if (end < 0) return [];
  const front = markdown.slice(4, end).split("\n");
  const problems = [];
  let inRelated = false;
  for (let index = 0; index < front.length; index += 1) {
    const line = front[index];
    const inline = line.match(/^related:\s*\[(.*)\]\s*$/);
    if (inline) {
      for (const item of inline[1].split(",")) {
        const rel = item.trim().replace(/^["']|["']$/g, "");
        if (!rel || /^[a-z][a-z0-9+.-]*:/i.test(rel)) continue;
        if (!existsSync(resolve(dirname(file), rel))) {
          problems.push(`${file}:${index + 2}: missing related ${rel}`);
        }
      }
      continue;
    }
    if (/^related:\s*$/.test(line)) {
      inRelated = true;
      continue;
    }
    if (inRelated && /^\S/.test(line)) inRelated = false;
    if (!inRelated) continue;
    const item = line.match(/^\s+-\s+(.+?)\s*$/);
    if (!item) continue;
    const rel = item[1].replace(/^["']|["']$/g, "");
    if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) continue;
    if (!existsSync(resolve(dirname(file), rel))) {
      problems.push(`${file}:${index + 2}: missing related ${rel}`);
    }
  }
  return problems;
}

const linkRe = /(!?\[[^\]\n]*\])\(([^)\n]+)\)/g;
// Footnote bodies (`[^id]: prose`) are not link destinations. The URL inside
// the body is an ordinary inline link.
const refRe = /^ {0,3}\[([^\]^\n][^\]]*)\]:\s+(\S+)/;

export function checkFile(file) {
  const markdown = readFileSync(file, "utf8");
  const problems = relatedProblems(file, markdown);
  const lines = visibleLines(markdown);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const match of line.matchAll(linkRe)) {
      problems.push(...problemsForDestination(file, index + 1, destinationOf(match[2])));
    }
    const ref = line.match(refRe);
    if (ref) problems.push(...problemsForDestination(file, index + 1, destinationOf(ref[2])));
  }
  return problems;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith(".md")) out.push(path);
  }
  return out;
}

export function checkPlans(root = repoRoot) {
  const dir = join(root, "plans");
  return walk(dir).flatMap((file) => checkFile(file));
}

function main() {
  const problems = checkPlans();
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(`check-plan-links: ${problems.length} broken`);
    process.exit(1);
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
