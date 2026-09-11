import { parseRestrictedYaml } from "../../../plugins/kxm/src/restricted-yaml.mjs";
import "./side-effect.mjs";
export { probeReexport } from "./reexport-target.mjs";

const commentLookalike = "import 'comment-string-not-imported'";
const fromLookalike = 'from "from-string-not-imported"';
void commentLookalike;
void fromLookalike;
// import "line-comment-not-imported"
/* import "block-comment-not-imported" */

export async function loadBannedPi() {
  return import("commander");
}

export async function loadLocalDynamic() {
  return import("./dynamic-local.mjs");
}

export { parseRestrictedYaml };
