#!/usr/bin/env node
import { createRequire as __kxmCreateRequire } from 'node:module'; const require = __kxmCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/yaml/dist/nodes/identity.js
var require_identity = __commonJS({
  "node_modules/yaml/dist/nodes/identity.js"(exports) {
    "use strict";
    var ALIAS = /* @__PURE__ */ Symbol.for("yaml.alias");
    var DOC = /* @__PURE__ */ Symbol.for("yaml.document");
    var MAP = /* @__PURE__ */ Symbol.for("yaml.map");
    var PAIR = /* @__PURE__ */ Symbol.for("yaml.pair");
    var SCALAR = /* @__PURE__ */ Symbol.for("yaml.scalar");
    var SEQ = /* @__PURE__ */ Symbol.for("yaml.seq");
    var NODE_TYPE = /* @__PURE__ */ Symbol.for("yaml.node.type");
    var isAlias2 = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
    var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
    var isMap2 = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
    var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
    var isScalar2 = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
    var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
    function isCollection2(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case MAP:
          case SEQ:
            return true;
        }
      return false;
    }
    function isNode(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case ALIAS:
          case MAP:
          case SCALAR:
          case SEQ:
            return true;
        }
      return false;
    }
    var hasAnchor = (node) => (isScalar2(node) || isCollection2(node)) && !!node.anchor;
    exports.ALIAS = ALIAS;
    exports.DOC = DOC;
    exports.MAP = MAP;
    exports.NODE_TYPE = NODE_TYPE;
    exports.PAIR = PAIR;
    exports.SCALAR = SCALAR;
    exports.SEQ = SEQ;
    exports.hasAnchor = hasAnchor;
    exports.isAlias = isAlias2;
    exports.isCollection = isCollection2;
    exports.isDocument = isDocument;
    exports.isMap = isMap2;
    exports.isNode = isNode;
    exports.isPair = isPair;
    exports.isScalar = isScalar2;
    exports.isSeq = isSeq;
  }
});

// node_modules/yaml/dist/visit.js
var require_visit = __commonJS({
  "node_modules/yaml/dist/visit.js"(exports) {
    "use strict";
    var identity = require_identity();
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove node");
    function visit2(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        visit_(null, node, visitor_, Object.freeze([]));
    }
    visit2.BREAK = BREAK;
    visit2.SKIP = SKIP;
    visit2.REMOVE = REMOVE;
    function visit_(key, node, visitor, path) {
      const ctrl = callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visit_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = visit_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = visit_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = visit_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    async function visitAsync(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        await visitAsync_(null, node, visitor_, Object.freeze([]));
    }
    visitAsync.BREAK = BREAK;
    visitAsync.SKIP = SKIP;
    visitAsync.REMOVE = REMOVE;
    async function visitAsync_(key, node, visitor, path) {
      const ctrl = await callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visitAsync_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = await visitAsync_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = await visitAsync_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = await visitAsync_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    function initVisitor(visitor) {
      if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
        return Object.assign({
          Alias: visitor.Node,
          Map: visitor.Node,
          Scalar: visitor.Node,
          Seq: visitor.Node
        }, visitor.Value && {
          Map: visitor.Value,
          Scalar: visitor.Value,
          Seq: visitor.Value
        }, visitor.Collection && {
          Map: visitor.Collection,
          Seq: visitor.Collection
        }, visitor);
      }
      return visitor;
    }
    function callVisitor(key, node, visitor, path) {
      if (typeof visitor === "function")
        return visitor(key, node, path);
      if (identity.isMap(node))
        return visitor.Map?.(key, node, path);
      if (identity.isSeq(node))
        return visitor.Seq?.(key, node, path);
      if (identity.isPair(node))
        return visitor.Pair?.(key, node, path);
      if (identity.isScalar(node))
        return visitor.Scalar?.(key, node, path);
      if (identity.isAlias(node))
        return visitor.Alias?.(key, node, path);
      return void 0;
    }
    function replaceNode(key, path, node) {
      const parent = path[path.length - 1];
      if (identity.isCollection(parent)) {
        parent.items[key] = node;
      } else if (identity.isPair(parent)) {
        if (key === "key")
          parent.key = node;
        else
          parent.value = node;
      } else if (identity.isDocument(parent)) {
        parent.contents = node;
      } else {
        const pt = identity.isAlias(parent) ? "alias" : "scalar";
        throw new Error(`Cannot replace node with ${pt} parent`);
      }
    }
    exports.visit = visit2;
    exports.visitAsync = visitAsync;
  }
});

// node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS({
  "node_modules/yaml/dist/doc/directives.js"(exports) {
    "use strict";
    var identity = require_identity();
    var visit2 = require_visit();
    var escapeChars = {
      "!": "%21",
      ",": "%2C",
      "[": "%5B",
      "]": "%5D",
      "{": "%7B",
      "}": "%7D"
    };
    var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
    var Directives = class _Directives {
      constructor(yaml, tags) {
        this.docStart = null;
        this.docEnd = false;
        this.yaml = Object.assign({}, _Directives.defaultYaml, yaml);
        this.tags = Object.assign({}, _Directives.defaultTags, tags);
      }
      clone() {
        const copy = new _Directives(this.yaml, this.tags);
        copy.docStart = this.docStart;
        return copy;
      }
      /**
       * During parsing, get a Directives instance for the current document and
       * update the stream state according to the current version's spec.
       */
      atDocument() {
        const res = new _Directives(this.yaml, this.tags);
        switch (this.yaml.version) {
          case "1.1":
            this.atNextDocument = true;
            break;
          case "1.2":
            this.atNextDocument = false;
            this.yaml = {
              explicit: _Directives.defaultYaml.explicit,
              version: "1.2"
            };
            this.tags = Object.assign({}, _Directives.defaultTags);
            break;
        }
        return res;
      }
      /**
       * @param onError - May be called even if the action was successful
       * @returns `true` on success
       */
      add(line, onError) {
        if (this.atNextDocument) {
          this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
          this.tags = Object.assign({}, _Directives.defaultTags);
          this.atNextDocument = false;
        }
        const parts = line.trim().split(/[ \t]+/);
        const name = parts.shift();
        switch (name) {
          case "%TAG": {
            if (parts.length !== 2) {
              onError(0, "%TAG directive should contain exactly two parts");
              if (parts.length < 2)
                return false;
            }
            const [handle, prefix] = parts;
            this.tags[handle] = prefix;
            return true;
          }
          case "%YAML": {
            this.yaml.explicit = true;
            if (parts.length !== 1) {
              onError(0, "%YAML directive should contain exactly one part");
              return false;
            }
            const [version] = parts;
            if (version === "1.1" || version === "1.2") {
              this.yaml.version = version;
              return true;
            } else {
              const isValid = /^\d+\.\d+$/.test(version);
              onError(6, `Unsupported YAML version ${version}`, isValid);
              return false;
            }
          }
          default:
            onError(0, `Unknown directive ${name}`, true);
            return false;
        }
      }
      /**
       * Resolves a tag, matching handles to those defined in %TAG directives.
       *
       * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
       *   `'!local'` tag, or `null` if unresolvable.
       */
      tagName(source, onError) {
        if (source === "!")
          return "!";
        if (source[0] !== "!") {
          onError(`Not a valid tag: ${source}`);
          return null;
        }
        if (source[1] === "<") {
          const verbatim = source.slice(2, -1);
          if (verbatim === "!" || verbatim === "!!") {
            onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
            return null;
          }
          if (source[source.length - 1] !== ">")
            onError("Verbatim tags must end with a >");
          return verbatim;
        }
        const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
        if (!suffix)
          onError(`The ${source} tag has no suffix`);
        const prefix = this.tags[handle];
        if (prefix) {
          try {
            return prefix + decodeURIComponent(suffix);
          } catch (error) {
            onError(String(error));
            return null;
          }
        }
        if (handle === "!")
          return source;
        onError(`Could not resolve tag: ${source}`);
        return null;
      }
      /**
       * Given a fully resolved tag, returns its printable string form,
       * taking into account current tag prefixes and defaults.
       */
      tagString(tag) {
        for (const [handle, prefix] of Object.entries(this.tags)) {
          if (tag.startsWith(prefix))
            return handle + escapeTagName(tag.substring(prefix.length));
        }
        return tag[0] === "!" ? tag : `!<${tag}>`;
      }
      toString(doc) {
        const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
        const tagEntries = Object.entries(this.tags);
        let tagNames;
        if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
          const tags = {};
          visit2.visit(doc.contents, (_key, node) => {
            if (identity.isNode(node) && node.tag)
              tags[node.tag] = true;
          });
          tagNames = Object.keys(tags);
        } else
          tagNames = [];
        for (const [handle, prefix] of tagEntries) {
          if (handle === "!!" && prefix === "tag:yaml.org,2002:")
            continue;
          if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
            lines.push(`%TAG ${handle} ${prefix}`);
        }
        return lines.join("\n");
      }
    };
    Directives.defaultYaml = { explicit: false, version: "1.2" };
    Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
    exports.Directives = Directives;
  }
});

// node_modules/yaml/dist/doc/anchors.js
var require_anchors = __commonJS({
  "node_modules/yaml/dist/doc/anchors.js"(exports) {
    "use strict";
    var identity = require_identity();
    var visit2 = require_visit();
    function anchorIsValid(anchor) {
      if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
        const sa = JSON.stringify(anchor);
        const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
        throw new Error(msg);
      }
      return true;
    }
    function anchorNames(root) {
      const anchors = /* @__PURE__ */ new Set();
      visit2.visit(root, {
        Value(_key, node) {
          if (node.anchor)
            anchors.add(node.anchor);
        }
      });
      return anchors;
    }
    function findNewAnchor(prefix, exclude) {
      for (let i = 1; true; ++i) {
        const name = `${prefix}${i}`;
        if (!exclude.has(name))
          return name;
      }
    }
    function createNodeAnchors(doc, prefix) {
      const aliasObjects = [];
      const sourceObjects = /* @__PURE__ */ new Map();
      let prevAnchors = null;
      return {
        onAnchor: (source) => {
          aliasObjects.push(source);
          prevAnchors ?? (prevAnchors = anchorNames(doc));
          const anchor = findNewAnchor(prefix, prevAnchors);
          prevAnchors.add(anchor);
          return anchor;
        },
        /**
         * With circular references, the source node is only resolved after all
         * of its child nodes are. This is why anchors are set only after all of
         * the nodes have been created.
         */
        setAnchors: () => {
          for (const source of aliasObjects) {
            const ref = sourceObjects.get(source);
            if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) {
              ref.node.anchor = ref.anchor;
            } else {
              const error = new Error("Failed to resolve repeated object (this should not happen)");
              error.source = source;
              throw error;
            }
          }
        },
        sourceObjects
      };
    }
    exports.anchorIsValid = anchorIsValid;
    exports.anchorNames = anchorNames;
    exports.createNodeAnchors = createNodeAnchors;
    exports.findNewAnchor = findNewAnchor;
  }
});

// node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = __commonJS({
  "node_modules/yaml/dist/doc/applyReviver.js"(exports) {
    "use strict";
    function applyReviver(reviver, obj, key, val) {
      if (val && typeof val === "object") {
        if (Array.isArray(val)) {
          for (let i = 0, len = val.length; i < len; ++i) {
            const v0 = val[i];
            const v1 = applyReviver(reviver, val, String(i), v0);
            if (v1 === void 0)
              delete val[i];
            else if (v1 !== v0)
              val[i] = v1;
          }
        } else if (val instanceof Map) {
          for (const k of Array.from(val.keys())) {
            const v0 = val.get(k);
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              val.delete(k);
            else if (v1 !== v0)
              val.set(k, v1);
          }
        } else if (val instanceof Set) {
          for (const v0 of Array.from(val)) {
            const v1 = applyReviver(reviver, val, v0, v0);
            if (v1 === void 0)
              val.delete(v0);
            else if (v1 !== v0) {
              val.delete(v0);
              val.add(v1);
            }
          }
        } else {
          for (const [k, v0] of Object.entries(val)) {
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              delete val[k];
            else if (v1 !== v0)
              val[k] = v1;
          }
        }
      }
      return reviver.call(obj, key, val);
    }
    exports.applyReviver = applyReviver;
  }
});

// node_modules/yaml/dist/nodes/toJS.js
var require_toJS = __commonJS({
  "node_modules/yaml/dist/nodes/toJS.js"(exports) {
    "use strict";
    var identity = require_identity();
    function toJS(value, arg, ctx) {
      if (Array.isArray(value))
        return value.map((v, i) => toJS(v, String(i), ctx));
      if (value && typeof value.toJSON === "function") {
        if (!ctx || !identity.hasAnchor(value))
          return value.toJSON(arg, ctx);
        const data = { aliasCount: 0, count: 1, res: void 0 };
        ctx.anchors.set(value, data);
        ctx.onCreate = (res2) => {
          data.res = res2;
          delete ctx.onCreate;
        };
        const res = value.toJSON(arg, ctx);
        if (ctx.onCreate)
          ctx.onCreate(res);
        return res;
      }
      if (typeof value === "bigint" && !ctx?.keep)
        return Number(value);
      return value;
    }
    exports.toJS = toJS;
  }
});

// node_modules/yaml/dist/nodes/Node.js
var require_Node = __commonJS({
  "node_modules/yaml/dist/nodes/Node.js"(exports) {
    "use strict";
    var applyReviver = require_applyReviver();
    var identity = require_identity();
    var toJS = require_toJS();
    var NodeBase = class {
      constructor(type) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: type });
      }
      /** Create a copy of this node.  */
      clone() {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** A plain JavaScript representation of this node. */
      toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        if (!identity.isDocument(doc))
          throw new TypeError("A document argument is required");
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc,
          keep: true,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this, "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
    };
    exports.NodeBase = NodeBase;
  }
});

// node_modules/yaml/dist/nodes/Alias.js
var require_Alias = __commonJS({
  "node_modules/yaml/dist/nodes/Alias.js"(exports) {
    "use strict";
    var anchors = require_anchors();
    var visit2 = require_visit();
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var Alias = class extends Node.NodeBase {
      constructor(source) {
        super(identity.ALIAS);
        this.source = source;
        Object.defineProperty(this, "tag", {
          set() {
            throw new Error("Alias nodes cannot have tags");
          }
        });
      }
      /**
       * Resolve the value of this alias within `doc`, finding the last
       * instance of the `source` anchor before this node.
       */
      resolve(doc, ctx) {
        if (ctx?.maxAliasCount === 0)
          throw new ReferenceError("Alias resolution is disabled");
        let nodes;
        if (ctx?.aliasResolveCache) {
          nodes = ctx.aliasResolveCache;
        } else {
          nodes = [];
          visit2.visit(doc, {
            Node: (_key, node) => {
              if (identity.isAlias(node) || identity.hasAnchor(node))
                nodes.push(node);
            }
          });
          if (ctx)
            ctx.aliasResolveCache = nodes;
        }
        let found = void 0;
        for (const node of nodes) {
          if (node === this)
            break;
          if (node.anchor === this.source)
            found = node;
        }
        if (found && ctx) {
          const { anchors: anchors2, doc: doc2, maxAliasCount } = ctx;
          let data = anchors2.get(found);
          if (!data) {
            toJS.toJS(found, null, ctx);
            data = anchors2.get(found);
          }
          if (data?.res === void 0) {
            const msg = "This should not happen: Alias anchor was not resolved?";
            throw new ReferenceError(msg);
          }
          if (maxAliasCount >= 0) {
            data.count += 1;
            if (data.aliasCount === 0)
              data.aliasCount = getAliasCount(doc2, found, anchors2);
            if (data.count * data.aliasCount > maxAliasCount) {
              const msg = "Excessive alias count indicates a resource exhaustion attack";
              throw new ReferenceError(msg);
            }
          }
        }
        return found;
      }
      toJSON(_arg, ctx) {
        if (!ctx)
          return { source: this.source };
        const source = this.resolve(ctx.doc, ctx);
        if (!source) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new ReferenceError(msg);
        }
        return ctx.anchors.get(source).res;
      }
      toString(ctx, _onComment, _onChompKeep) {
        const src = `*${this.source}`;
        if (ctx) {
          anchors.anchorIsValid(this.source);
          if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
            const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
            throw new Error(msg);
          }
          if (ctx.implicitKey)
            return `${src} `;
        }
        return src;
      }
    };
    function getAliasCount(doc, node, anchors2) {
      if (identity.isAlias(node)) {
        const source = node.resolve(doc);
        const anchor = anchors2 && source && anchors2.get(source);
        return anchor ? anchor.count * anchor.aliasCount : 0;
      } else if (identity.isCollection(node)) {
        let count = 0;
        for (const item of node.items) {
          const c = getAliasCount(doc, item, anchors2);
          if (c > count)
            count = c;
        }
        return count;
      } else if (identity.isPair(node)) {
        const kc = getAliasCount(doc, node.key, anchors2);
        const vc = getAliasCount(doc, node.value, anchors2);
        return Math.max(kc, vc);
      }
      return 1;
    }
    exports.Alias = Alias;
  }
});

// node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = __commonJS({
  "node_modules/yaml/dist/nodes/Scalar.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
    var Scalar = class extends Node.NodeBase {
      constructor(value) {
        super(identity.SCALAR);
        this.value = value;
      }
      toJSON(arg, ctx) {
        return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
      }
      toString() {
        return String(this.value);
      }
    };
    Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
    Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
    Scalar.PLAIN = "PLAIN";
    Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
    Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
    exports.Scalar = Scalar;
    exports.isScalarValue = isScalarValue;
  }
});

// node_modules/yaml/dist/doc/createNode.js
var require_createNode = __commonJS({
  "node_modules/yaml/dist/doc/createNode.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var defaultTagPrefix = "tag:yaml.org,2002:";
    function findTagObject(value, tagName, tags) {
      if (tagName) {
        const match = tags.filter((t) => t.tag === tagName);
        const tagObj = match.find((t) => !t.format) ?? match[0];
        if (!tagObj)
          throw new Error(`Tag ${tagName} not found`);
        return tagObj;
      }
      return tags.find((t) => t.identify?.(value) && !t.format);
    }
    function createNode(value, tagName, ctx) {
      if (identity.isDocument(value))
        value = value.contents;
      if (identity.isNode(value))
        return value;
      if (identity.isPair(value)) {
        const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
        map.items.push(value);
        return map;
      }
      if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
        value = value.valueOf();
      }
      const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
      let ref = void 0;
      if (aliasDuplicateObjects && value && typeof value === "object") {
        ref = sourceObjects.get(value);
        if (ref) {
          ref.anchor ?? (ref.anchor = onAnchor(value));
          return new Alias.Alias(ref.anchor);
        } else {
          ref = { anchor: null, node: null };
          sourceObjects.set(value, ref);
        }
      }
      if (tagName?.startsWith("!!"))
        tagName = defaultTagPrefix + tagName.slice(2);
      let tagObj = findTagObject(value, tagName, schema.tags);
      if (!tagObj) {
        if (value && typeof value.toJSON === "function") {
          value = value.toJSON();
        }
        if (!value || typeof value !== "object") {
          const node2 = new Scalar.Scalar(value);
          if (ref)
            ref.node = node2;
          return node2;
        }
        tagObj = value instanceof Map ? schema[identity.MAP] : Symbol.iterator in Object(value) ? schema[identity.SEQ] : schema[identity.MAP];
      }
      if (onTagObj) {
        onTagObj(tagObj);
        delete ctx.onTagObj;
      }
      const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
      if (tagName)
        node.tag = tagName;
      else if (!tagObj.default)
        node.tag = tagObj.tag;
      if (ref)
        ref.node = node;
      return node;
    }
    exports.createNode = createNode;
  }
});

// node_modules/yaml/dist/nodes/Collection.js
var require_Collection = __commonJS({
  "node_modules/yaml/dist/nodes/Collection.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var identity = require_identity();
    var Node = require_Node();
    function collectionFromPath(schema, path, value) {
      let v = value;
      for (let i = path.length - 1; i >= 0; --i) {
        const k = path[i];
        if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
          const a = [];
          a[k] = v;
          v = a;
        } else {
          v = /* @__PURE__ */ new Map([[k, v]]);
        }
      }
      return createNode.createNode(v, void 0, {
        aliasDuplicateObjects: false,
        keepUndefined: false,
        onAnchor: () => {
          throw new Error("This should not happen, please report a bug.");
        },
        schema,
        sourceObjects: /* @__PURE__ */ new Map()
      });
    }
    var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;
    var Collection = class extends Node.NodeBase {
      constructor(type, schema) {
        super(type);
        Object.defineProperty(this, "schema", {
          value: schema,
          configurable: true,
          enumerable: false,
          writable: true
        });
      }
      /**
       * Create a copy of this collection.
       *
       * @param schema - If defined, overwrites the original's schema
       */
      clone(schema) {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (schema)
          copy.schema = schema;
        copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /**
       * Adds a value to the collection. For `!!map` and `!!omap` the value must
       * be a Pair instance or a `{ key, value }` object, which may not have a key
       * that already exists in the map.
       */
      addIn(path, value) {
        if (isEmptyPath(path))
          this.add(value);
        else {
          const [key, ...rest] = path;
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.addIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
      /**
       * Removes a value from the collection.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.delete(key);
        const node = this.get(key, true);
        if (identity.isCollection(node))
          return node.deleteIn(rest);
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        const [key, ...rest] = path;
        const node = this.get(key, true);
        if (rest.length === 0)
          return !keepScalar && identity.isScalar(node) ? node.value : node;
        else
          return identity.isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
      }
      hasAllNullValues(allowScalar) {
        return this.items.every((node) => {
          if (!identity.isPair(node))
            return false;
          const n = node.value;
          return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
        });
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       */
      hasIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.has(key);
        const node = this.get(key, true);
        return identity.isCollection(node) ? node.hasIn(rest) : false;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        const [key, ...rest] = path;
        if (rest.length === 0) {
          this.set(key, value);
        } else {
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.setIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
    };
    exports.Collection = Collection;
    exports.collectionFromPath = collectionFromPath;
    exports.isEmptyPath = isEmptyPath;
  }
});

// node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyComment.js"(exports) {
    "use strict";
    var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
    function indentComment(comment, indent) {
      if (/^\n+$/.test(comment))
        return comment.substring(1);
      return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
    }
    var lineComment = (str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
    exports.indentComment = indentComment;
    exports.lineComment = lineComment;
    exports.stringifyComment = stringifyComment;
  }
});

// node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = __commonJS({
  "node_modules/yaml/dist/stringify/foldFlowLines.js"(exports) {
    "use strict";
    var FOLD_FLOW = "flow";
    var FOLD_BLOCK = "block";
    var FOLD_QUOTED = "quoted";
    function foldFlowLines(text2, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
      if (!lineWidth || lineWidth < 0)
        return text2;
      if (lineWidth < minContentWidth)
        minContentWidth = 0;
      const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
      if (text2.length <= endStep)
        return text2;
      const folds = [];
      const escapedFolds = {};
      let end = lineWidth - indent.length;
      if (typeof indentAtStart === "number") {
        if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
          folds.push(0);
        else
          end = lineWidth - indentAtStart;
      }
      let split = void 0;
      let prev = void 0;
      let overflow = false;
      let i = -1;
      let escStart = -1;
      let escEnd = -1;
      if (mode === FOLD_BLOCK) {
        i = consumeMoreIndentedLines(text2, i, indent.length);
        if (i !== -1)
          end = i + endStep;
      }
      for (let ch; ch = text2[i += 1]; ) {
        if (mode === FOLD_QUOTED && ch === "\\") {
          escStart = i;
          switch (text2[i + 1]) {
            case "x":
              i += 3;
              break;
            case "u":
              i += 5;
              break;
            case "U":
              i += 9;
              break;
            default:
              i += 1;
          }
          escEnd = i;
        }
        if (ch === "\n") {
          if (mode === FOLD_BLOCK)
            i = consumeMoreIndentedLines(text2, i, indent.length);
          end = i + indent.length + endStep;
          split = void 0;
        } else {
          if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
            const next = text2[i + 1];
            if (next && next !== " " && next !== "\n" && next !== "	")
              split = i;
          }
          if (i >= end) {
            if (split) {
              folds.push(split);
              end = split + endStep;
              split = void 0;
            } else if (mode === FOLD_QUOTED) {
              while (prev === " " || prev === "	") {
                prev = ch;
                ch = text2[i += 1];
                overflow = true;
              }
              const j = i > escEnd + 1 ? i - 2 : escStart - 1;
              if (escapedFolds[j])
                return text2;
              folds.push(j);
              escapedFolds[j] = true;
              end = j + endStep;
              split = void 0;
            } else {
              overflow = true;
            }
          }
        }
        prev = ch;
      }
      if (overflow && onOverflow)
        onOverflow();
      if (folds.length === 0)
        return text2;
      if (onFold)
        onFold();
      let res = text2.slice(0, folds[0]);
      for (let i2 = 0; i2 < folds.length; ++i2) {
        const fold = folds[i2];
        const end2 = folds[i2 + 1] || text2.length;
        if (fold === 0)
          res = `
${indent}${text2.slice(0, end2)}`;
        else {
          if (mode === FOLD_QUOTED && escapedFolds[fold])
            res += `${text2[fold]}\\`;
          res += `
${indent}${text2.slice(fold + 1, end2)}`;
        }
      }
      return res;
    }
    function consumeMoreIndentedLines(text2, i, indent) {
      let end = i;
      let start = i + 1;
      let ch = text2[start];
      while (ch === " " || ch === "	") {
        if (i < start + indent) {
          ch = text2[++i];
        } else {
          do {
            ch = text2[++i];
          } while (ch && ch !== "\n");
          end = i;
          start = i + 1;
          ch = text2[start];
        }
      }
      return end;
    }
    exports.FOLD_BLOCK = FOLD_BLOCK;
    exports.FOLD_FLOW = FOLD_FLOW;
    exports.FOLD_QUOTED = FOLD_QUOTED;
    exports.foldFlowLines = foldFlowLines;
  }
});

// node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyString.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var foldFlowLines = require_foldFlowLines();
    var getFoldOptions = (ctx, isBlock) => ({
      indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
      lineWidth: ctx.options.lineWidth,
      minContentWidth: ctx.options.minContentWidth
    });
    var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
    function lineLengthOverLimit(str, lineWidth, indentLength) {
      if (!lineWidth || lineWidth < 0)
        return false;
      const limit = lineWidth - indentLength;
      const strLen = str.length;
      if (strLen <= limit)
        return false;
      for (let i = 0, start = 0; i < strLen; ++i) {
        if (str[i] === "\n") {
          if (i - start > limit)
            return true;
          start = i + 1;
          if (strLen - start <= limit)
            return false;
        }
      }
      return true;
    }
    function doubleQuotedString(value, ctx) {
      const json2 = JSON.stringify(value);
      if (ctx.options.doubleQuotedAsJSON)
        return json2;
      const { implicitKey } = ctx;
      const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      let str = "";
      let start = 0;
      for (let i = 0, ch = json2[i]; ch; ch = json2[++i]) {
        if (ch === " " && json2[i + 1] === "\\" && json2[i + 2] === "n") {
          str += json2.slice(start, i) + "\\ ";
          i += 1;
          start = i;
          ch = "\\";
        }
        if (ch === "\\")
          switch (json2[i + 1]) {
            case "u":
              {
                str += json2.slice(start, i);
                const code = json2.substr(i + 2, 4);
                switch (code) {
                  case "0000":
                    str += "\\0";
                    break;
                  case "0007":
                    str += "\\a";
                    break;
                  case "000b":
                    str += "\\v";
                    break;
                  case "001b":
                    str += "\\e";
                    break;
                  case "0085":
                    str += "\\N";
                    break;
                  case "00a0":
                    str += "\\_";
                    break;
                  case "2028":
                    str += "\\L";
                    break;
                  case "2029":
                    str += "\\P";
                    break;
                  default:
                    if (code.substr(0, 2) === "00")
                      str += "\\x" + code.substr(2);
                    else
                      str += json2.substr(i, 6);
                }
                i += 5;
                start = i + 1;
              }
              break;
            case "n":
              if (implicitKey || json2[i + 2] === '"' || json2.length < minMultiLineLength) {
                i += 1;
              } else {
                str += json2.slice(start, i) + "\n\n";
                while (json2[i + 2] === "\\" && json2[i + 3] === "n" && json2[i + 4] !== '"') {
                  str += "\n";
                  i += 2;
                }
                str += indent;
                if (json2[i + 2] === " ")
                  str += "\\";
                i += 1;
                start = i + 1;
              }
              break;
            default:
              i += 1;
          }
      }
      str = start ? str + json2.slice(start) : json2;
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
    }
    function singleQuotedString(value, ctx) {
      if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
        return doubleQuotedString(value, ctx);
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
      return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function quotedString(value, ctx) {
      const { singleQuote } = ctx.options;
      let qs;
      if (singleQuote === false)
        qs = doubleQuotedString;
      else {
        const hasDouble = value.includes('"');
        const hasSingle = value.includes("'");
        if (hasDouble && !hasSingle)
          qs = singleQuotedString;
        else if (hasSingle && !hasDouble)
          qs = doubleQuotedString;
        else
          qs = singleQuote ? singleQuotedString : doubleQuotedString;
      }
      return qs(value, ctx);
    }
    var blockEndNewlines;
    try {
      blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
    } catch {
      blockEndNewlines = /\n+(?!\n|$)/g;
    }
    function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
      const { blockQuote, commentString, lineWidth } = ctx.options;
      if (!blockQuote || /\n[\t ]+$/.test(value)) {
        return quotedString(value, ctx);
      }
      const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
      const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
      if (!value)
        return literal ? "|\n" : ">\n";
      let chomp;
      let endStart;
      for (endStart = value.length; endStart > 0; --endStart) {
        const ch = value[endStart - 1];
        if (ch !== "\n" && ch !== "	" && ch !== " ")
          break;
      }
      let end = value.substring(endStart);
      const endNlPos = end.indexOf("\n");
      if (endNlPos === -1) {
        chomp = "-";
      } else if (value === end || endNlPos !== end.length - 1) {
        chomp = "+";
        if (onChompKeep)
          onChompKeep();
      } else {
        chomp = "";
      }
      if (end) {
        value = value.slice(0, -end.length);
        if (end[end.length - 1] === "\n")
          end = end.slice(0, -1);
        end = end.replace(blockEndNewlines, `$&${indent}`);
      }
      let startWithSpace = false;
      let startEnd;
      let startNlPos = -1;
      for (startEnd = 0; startEnd < value.length; ++startEnd) {
        const ch = value[startEnd];
        if (ch === " ")
          startWithSpace = true;
        else if (ch === "\n")
          startNlPos = startEnd;
        else
          break;
      }
      let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
      if (start) {
        value = value.substring(start.length);
        start = start.replace(/\n+/g, `$&${indent}`);
      }
      const indentSize = indent ? "2" : "1";
      let header = (startWithSpace ? indentSize : "") + chomp;
      if (comment) {
        header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
        if (onComment)
          onComment();
      }
      if (!literal) {
        const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
        let literalFallback = false;
        const foldOptions = getFoldOptions(ctx, true);
        if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) {
          foldOptions.onOverflow = () => {
            literalFallback = true;
          };
        }
        const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
        if (!literalFallback)
          return `>${header}
${indent}${body}`;
      }
      value = value.replace(/\n+/g, `$&${indent}`);
      return `|${header}
${indent}${start}${value}${end}`;
    }
    function plainString(item, ctx, onComment, onChompKeep) {
      const { type, value } = item;
      const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
      if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) {
        return quotedString(value, ctx);
      }
      if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
        return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
      }
      if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes("\n")) {
        return blockString(item, ctx, onComment, onChompKeep);
      }
      if (containsDocumentMarker(value)) {
        if (indent === "") {
          ctx.forceBlockIndent = true;
          return blockString(item, ctx, onComment, onChompKeep);
        } else if (implicitKey && indent === indentStep) {
          return quotedString(value, ctx);
        }
      }
      const str = value.replace(/\n+/g, `$&
${indent}`);
      if (actualString) {
        const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
        const { compat, tags } = ctx.doc.schema;
        if (tags.some(test) || compat?.some(test))
          return quotedString(value, ctx);
      }
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function stringifyString(item, ctx, onComment, onChompKeep) {
      const { implicitKey, inFlow } = ctx;
      const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
      let { type } = item;
      if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
        if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
          type = Scalar.Scalar.QUOTE_DOUBLE;
      }
      const _stringify = (_type) => {
        switch (_type) {
          case Scalar.Scalar.BLOCK_FOLDED:
          case Scalar.Scalar.BLOCK_LITERAL:
            return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
          case Scalar.Scalar.QUOTE_DOUBLE:
            return doubleQuotedString(ss.value, ctx);
          case Scalar.Scalar.QUOTE_SINGLE:
            return singleQuotedString(ss.value, ctx);
          case Scalar.Scalar.PLAIN:
            return plainString(ss, ctx, onComment, onChompKeep);
          default:
            return null;
        }
      };
      let res = _stringify(type);
      if (res === null) {
        const { defaultKeyType, defaultStringType } = ctx.options;
        const t = implicitKey && defaultKeyType || defaultStringType;
        res = _stringify(t);
        if (res === null)
          throw new Error(`Unsupported default string type ${t}`);
      }
      return res;
    }
    exports.stringifyString = stringifyString;
  }
});

// node_modules/yaml/dist/stringify/stringify.js
var require_stringify = __commonJS({
  "node_modules/yaml/dist/stringify/stringify.js"(exports) {
    "use strict";
    var anchors = require_anchors();
    var identity = require_identity();
    var stringifyComment = require_stringifyComment();
    var stringifyString = require_stringifyString();
    function createStringifyContext(doc, options) {
      const opt = Object.assign({
        blockQuote: true,
        commentString: stringifyComment.stringifyComment,
        defaultKeyType: null,
        defaultStringType: "PLAIN",
        directives: null,
        doubleQuotedAsJSON: false,
        doubleQuotedMinMultiLineLength: 40,
        falseStr: "false",
        flowCollectionPadding: true,
        indentSeq: true,
        lineWidth: 80,
        minContentWidth: 20,
        nullStr: "null",
        simpleKeys: false,
        singleQuote: null,
        trailingComma: false,
        trueStr: "true",
        verifyAliasOrder: true
      }, doc.schema.toStringOptions, options);
      let inFlow;
      switch (opt.collectionStyle) {
        case "block":
          inFlow = false;
          break;
        case "flow":
          inFlow = true;
          break;
        default:
          inFlow = null;
      }
      return {
        anchors: /* @__PURE__ */ new Set(),
        doc,
        flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
        indent: "",
        indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
        inFlow,
        options: opt
      };
    }
    function getTagObject(tags, item) {
      if (item.tag) {
        const match = tags.filter((t) => t.tag === item.tag);
        if (match.length > 0)
          return match.find((t) => t.format === item.format) ?? match[0];
      }
      let tagObj = void 0;
      let obj;
      if (identity.isScalar(item)) {
        obj = item.value;
        let match = tags.filter((t) => t.identify?.(obj));
        if (match.length > 1) {
          const testMatch = match.filter((t) => t.test);
          if (testMatch.length > 0)
            match = testMatch;
        }
        tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
      } else {
        obj = item;
        tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
      }
      if (!tagObj) {
        const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
        throw new Error(`Tag not resolved for ${name} value`);
      }
      return tagObj;
    }
    function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
      if (!doc.directives)
        return "";
      const props = [];
      const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
      if (anchor && anchors.anchorIsValid(anchor)) {
        anchors$1.add(anchor);
        props.push(`&${anchor}`);
      }
      const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
      if (tag)
        props.push(doc.directives.tagString(tag));
      return props.join(" ");
    }
    function stringify3(item, ctx, onComment, onChompKeep) {
      if (identity.isPair(item))
        return item.toString(ctx, onComment, onChompKeep);
      if (identity.isAlias(item)) {
        if (ctx.doc.directives)
          return item.toString(ctx);
        if (ctx.resolvedAliases?.has(item)) {
          throw new TypeError(`Cannot stringify circular structure without alias nodes`);
        } else {
          if (ctx.resolvedAliases)
            ctx.resolvedAliases.add(item);
          else
            ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
          item = item.resolve(ctx.doc);
        }
      }
      let tagObj = void 0;
      const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
      tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
      const props = stringifyProps(node, tagObj, ctx);
      if (props.length > 0)
        ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
      const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
      if (!props)
        return str;
      return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
    }
    exports.createStringifyContext = createStringifyContext;
    exports.stringify = stringify3;
  }
});

// node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyPair.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var stringify3 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
      const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
      let keyComment = identity.isNode(key) && key.comment || null;
      if (simpleKeys) {
        if (keyComment) {
          throw new Error("With simple keys, key nodes cannot have comments");
        }
        if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") {
          const msg = "With simple keys, collection cannot be used as a key value";
          throw new Error(msg);
        }
      }
      let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
      ctx = Object.assign({}, ctx, {
        allNullValues: false,
        implicitKey: !explicitKey && (simpleKeys || !allNullValues),
        indent: indent + indentStep
      });
      let keyCommentDone = false;
      let chompKeep = false;
      let str = stringify3.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
      if (!explicitKey && !ctx.inFlow && str.length > 1024) {
        if (simpleKeys)
          throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
        explicitKey = true;
      }
      if (ctx.inFlow) {
        if (allNullValues || value == null) {
          if (keyCommentDone && onComment)
            onComment();
          return str === "" ? "?" : explicitKey ? `? ${str}` : str;
        }
      } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
        str = `? ${str}`;
        if (keyComment && !keyCommentDone) {
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        } else if (chompKeep && onChompKeep)
          onChompKeep();
        return str;
      }
      if (keyCommentDone)
        keyComment = null;
      if (explicitKey) {
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        str = `? ${str}
${indent}:`;
      } else {
        str = `${str}:`;
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      }
      let vsb, vcb, valueComment;
      if (identity.isNode(value)) {
        vsb = !!value.spaceBefore;
        vcb = value.commentBefore;
        valueComment = value.comment;
      } else {
        vsb = false;
        vcb = null;
        valueComment = null;
        if (value && typeof value === "object")
          value = doc.createNode(value);
      }
      ctx.implicitKey = false;
      if (!explicitKey && !keyComment && identity.isScalar(value))
        ctx.indentAtStart = str.length + 1;
      chompKeep = false;
      if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
        ctx.indent = ctx.indent.substring(2);
      }
      let valueCommentDone = false;
      const valueStr = stringify3.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
      let ws = " ";
      if (keyComment || vsb || vcb) {
        ws = vsb ? "\n" : "";
        if (vcb) {
          const cs = commentString(vcb);
          ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
        }
        if (valueStr === "" && !ctx.inFlow) {
          if (ws === "\n" && valueComment)
            ws = "\n\n";
        } else {
          ws += `
${ctx.indent}`;
        }
      } else if (!explicitKey && identity.isCollection(value)) {
        const vs0 = valueStr[0];
        const nl0 = valueStr.indexOf("\n");
        const hasNewline = nl0 !== -1;
        const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
        if (hasNewline || !flow) {
          let hasPropsLine = false;
          if (hasNewline && (vs0 === "&" || vs0 === "!")) {
            let sp0 = valueStr.indexOf(" ");
            if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
              sp0 = valueStr.indexOf(" ", sp0 + 1);
            }
            if (sp0 === -1 || nl0 < sp0)
              hasPropsLine = true;
          }
          if (!hasPropsLine)
            ws = `
${ctx.indent}`;
        }
      } else if (valueStr === "" || valueStr[0] === "\n") {
        ws = "";
      }
      str += ws + valueStr;
      if (ctx.inFlow) {
        if (valueCommentDone && onComment)
          onComment();
      } else if (valueComment && !valueCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
      } else if (chompKeep && onChompKeep) {
        onChompKeep();
      }
      return str;
    }
    exports.stringifyPair = stringifyPair;
  }
});

// node_modules/yaml/dist/log.js
var require_log = __commonJS({
  "node_modules/yaml/dist/log.js"(exports) {
    "use strict";
    var node_process = __require("process");
    function debug(logLevel, ...messages) {
      if (logLevel === "debug")
        console.log(...messages);
    }
    function warn(logLevel, warning) {
      if (logLevel === "debug" || logLevel === "warn") {
        if (typeof node_process.emitWarning === "function")
          node_process.emitWarning(warning);
        else
          console.warn(warning);
      }
    }
    exports.debug = debug;
    exports.warn = warn;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/merge.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var MERGE_KEY = "<<";
    var merge = {
      identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
      default: "key",
      tag: "tag:yaml.org,2002:merge",
      test: /^<<$/,
      resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), {
        addToJSMap: addMergeToJSMap
      }),
      stringify: () => MERGE_KEY
    };
    var isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
    function addMergeToJSMap(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (identity.isSeq(source))
        for (const it of source.items)
          mergeValue(ctx, map, it);
      else if (Array.isArray(source))
        for (const it of source)
          mergeValue(ctx, map, it);
      else
        mergeValue(ctx, map, source);
    }
    function mergeValue(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (!identity.isMap(source))
        throw new Error("Merge sources must be maps or map aliases");
      const srcMap = source.toJSON(null, ctx, Map);
      for (const [key, value2] of srcMap) {
        if (map instanceof Map) {
          if (!map.has(key))
            map.set(key, value2);
        } else if (map instanceof Set) {
          map.add(key);
        } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
          Object.defineProperty(map, key, {
            value: value2,
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      }
      return map;
    }
    function resolveAliasValue(ctx, value) {
      return ctx && identity.isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
    }
    exports.addMergeToJSMap = addMergeToJSMap;
    exports.isMergeKey = isMergeKey;
    exports.merge = merge;
  }
});

// node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = __commonJS({
  "node_modules/yaml/dist/nodes/addPairToJSMap.js"(exports) {
    "use strict";
    var log = require_log();
    var merge = require_merge();
    var stringify3 = require_stringify();
    var identity = require_identity();
    var toJS = require_toJS();
    function addPairToJSMap(ctx, map, { key, value }) {
      if (identity.isNode(key) && key.addToJSMap)
        key.addToJSMap(ctx, map, value);
      else if (merge.isMergeKey(ctx, key))
        merge.addMergeToJSMap(ctx, map, value);
      else {
        const jsKey = toJS.toJS(key, "", ctx);
        if (map instanceof Map) {
          map.set(jsKey, toJS.toJS(value, jsKey, ctx));
        } else if (map instanceof Set) {
          map.add(jsKey);
        } else {
          const stringKey = stringifyKey(key, jsKey, ctx);
          const jsValue = toJS.toJS(value, stringKey, ctx);
          if (stringKey in map)
            Object.defineProperty(map, stringKey, {
              value: jsValue,
              writable: true,
              enumerable: true,
              configurable: true
            });
          else
            map[stringKey] = jsValue;
        }
      }
      return map;
    }
    function stringifyKey(key, jsKey, ctx) {
      if (jsKey === null)
        return "";
      if (typeof jsKey !== "object")
        return String(jsKey);
      if (identity.isNode(key) && ctx?.doc) {
        const strCtx = stringify3.createStringifyContext(ctx.doc, {});
        strCtx.anchors = /* @__PURE__ */ new Set();
        for (const node of ctx.anchors.keys())
          strCtx.anchors.add(node.anchor);
        strCtx.inFlow = true;
        strCtx.inStringifyKey = true;
        const strKey = key.toString(strCtx);
        if (!ctx.mapKeyWarned) {
          let jsonStr = JSON.stringify(strKey);
          if (jsonStr.length > 40)
            jsonStr = jsonStr.substring(0, 36) + '..."';
          log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
          ctx.mapKeyWarned = true;
        }
        return strKey;
      }
      return JSON.stringify(jsKey);
    }
    exports.addPairToJSMap = addPairToJSMap;
  }
});

// node_modules/yaml/dist/nodes/Pair.js
var require_Pair = __commonJS({
  "node_modules/yaml/dist/nodes/Pair.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var stringifyPair = require_stringifyPair();
    var addPairToJSMap = require_addPairToJSMap();
    var identity = require_identity();
    function createPair(key, value, ctx) {
      const k = createNode.createNode(key, void 0, ctx);
      const v = createNode.createNode(value, void 0, ctx);
      return new Pair(k, v);
    }
    var Pair = class _Pair {
      constructor(key, value = null) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
        this.key = key;
        this.value = value;
      }
      clone(schema) {
        let { key, value } = this;
        if (identity.isNode(key))
          key = key.clone(schema);
        if (identity.isNode(value))
          value = value.clone(schema);
        return new _Pair(key, value);
      }
      toJSON(_, ctx) {
        const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        return addPairToJSMap.addPairToJSMap(ctx, pair, this);
      }
      toString(ctx, onComment, onChompKeep) {
        return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
      }
    };
    exports.Pair = Pair;
    exports.createPair = createPair;
  }
});

// node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyCollection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var stringify3 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyCollection(collection, ctx, options) {
      const flow = ctx.inFlow ?? collection.flow;
      const stringify4 = flow ? stringifyFlowCollection : stringifyBlockCollection;
      return stringify4(collection, ctx, options);
    }
    function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
      const { indent, options: { commentString } } = ctx;
      const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
      let chompKeep = false;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment2 = null;
        if (identity.isNode(item)) {
          if (!chompKeep && item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
          if (item.comment)
            comment2 = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (!chompKeep && ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
          }
        }
        chompKeep = false;
        let str2 = stringify3.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
        if (comment2)
          str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
        if (chompKeep && comment2)
          chompKeep = false;
        lines.push(blockItemPrefix + str2);
      }
      let str;
      if (lines.length === 0) {
        str = flowChars.start + flowChars.end;
      } else {
        str = lines[0];
        for (let i = 1; i < lines.length; ++i) {
          const line = lines[i];
          str += line ? `
${indent}${line}` : "\n";
        }
      }
      if (comment) {
        str += "\n" + stringifyComment.indentComment(commentString(comment), indent);
        if (onComment)
          onComment();
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
      const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
      itemIndent += indentStep;
      const itemCtx = Object.assign({}, ctx, {
        indent: itemIndent,
        inFlow: true,
        type: null
      });
      let reqNewline = false;
      let linesAtValue = 0;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment = null;
        if (identity.isNode(item)) {
          if (item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, false);
          if (item.comment)
            comment = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, false);
            if (ik.comment)
              reqNewline = true;
          }
          const iv = identity.isNode(item.value) ? item.value : null;
          if (iv) {
            if (iv.comment)
              comment = iv.comment;
            if (iv.commentBefore)
              reqNewline = true;
          } else if (item.value == null && ik?.comment) {
            comment = ik.comment;
          }
        }
        if (comment)
          reqNewline = true;
        let str = stringify3.stringify(item, itemCtx, () => comment = null);
        reqNewline || (reqNewline = lines.length > linesAtValue || str.includes("\n"));
        if (i < items.length - 1) {
          str += ",";
        } else if (ctx.options.trailingComma) {
          if (ctx.options.lineWidth > 0) {
            reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
          }
          if (reqNewline) {
            str += ",";
          }
        }
        if (comment)
          str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
        lines.push(str);
        linesAtValue = lines.length;
      }
      const { start, end } = flowChars;
      if (lines.length === 0) {
        return start + end;
      } else {
        if (!reqNewline) {
          const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
          reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
        }
        if (reqNewline) {
          let str = start;
          for (const line of lines)
            str += line ? `
${indentStep}${indent}${line}` : "\n";
          return `${str}
${indent}${end}`;
        } else {
          return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
        }
      }
    }
    function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
      if (comment && chompKeep)
        comment = comment.replace(/^\n+/, "");
      if (comment) {
        const ic = stringifyComment.indentComment(commentString(comment), indent);
        lines.push(ic.trimStart());
      }
    }
    exports.stringifyCollection = stringifyCollection;
  }
});

// node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLMap.js"(exports) {
    "use strict";
    var stringifyCollection = require_stringifyCollection();
    var addPairToJSMap = require_addPairToJSMap();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    function findPair(items, key) {
      const k = identity.isScalar(key) ? key.value : key;
      for (const it of items) {
        if (identity.isPair(it)) {
          if (it.key === key || it.key === k)
            return it;
          if (identity.isScalar(it.key) && it.key.value === k)
            return it;
        }
      }
      return void 0;
    }
    var YAMLMap = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:map";
      }
      constructor(schema) {
        super(identity.MAP, schema);
        this.items = [];
      }
      /**
       * A generic collection parsing method that can be extended
       * to other node classes that inherit from YAMLMap
       */
      static from(schema, obj, ctx) {
        const { keepUndefined, replacer } = ctx;
        const map = new this(schema);
        const add = (key, value) => {
          if (typeof replacer === "function")
            value = replacer.call(obj, key, value);
          else if (Array.isArray(replacer) && !replacer.includes(key))
            return;
          if (value !== void 0 || keepUndefined)
            map.items.push(Pair.createPair(key, value, ctx));
        };
        if (obj instanceof Map) {
          for (const [key, value] of obj)
            add(key, value);
        } else if (obj && typeof obj === "object") {
          for (const key of Object.keys(obj))
            add(key, obj[key]);
        }
        if (typeof schema.sortMapEntries === "function") {
          map.items.sort(schema.sortMapEntries);
        }
        return map;
      }
      /**
       * Adds a value to the collection.
       *
       * @param overwrite - If not set `true`, using a key that is already in the
       *   collection will throw. Otherwise, overwrites the previous value.
       */
      add(pair, overwrite) {
        let _pair;
        if (identity.isPair(pair))
          _pair = pair;
        else if (!pair || typeof pair !== "object" || !("key" in pair)) {
          _pair = new Pair.Pair(pair, pair?.value);
        } else
          _pair = new Pair.Pair(pair.key, pair.value);
        const prev = findPair(this.items, _pair.key);
        const sortEntries = this.schema?.sortMapEntries;
        if (prev) {
          if (!overwrite)
            throw new Error(`Key ${_pair.key} already set`);
          if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value))
            prev.value.value = _pair.value;
          else
            prev.value = _pair.value;
        } else if (sortEntries) {
          const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
          if (i === -1)
            this.items.push(_pair);
          else
            this.items.splice(i, 0, _pair);
        } else {
          this.items.push(_pair);
        }
      }
      delete(key) {
        const it = findPair(this.items, key);
        if (!it)
          return false;
        const del = this.items.splice(this.items.indexOf(it), 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const it = findPair(this.items, key);
        const node = it?.value;
        return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? void 0;
      }
      has(key) {
        return !!findPair(this.items, key);
      }
      set(key, value) {
        this.add(new Pair.Pair(key, value), true);
      }
      /**
       * @param ctx - Conversion context, originally set in Document#toJS()
       * @param {Class} Type - If set, forces the returned collection type
       * @returns Instance of Type, Map, or Object
       */
      toJSON(_, ctx, Type) {
        const map = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const item of this.items)
          addPairToJSMap.addPairToJSMap(ctx, map, item);
        return map;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        for (const item of this.items) {
          if (!identity.isPair(item))
            throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
        }
        if (!ctx.allNullValues && this.hasAllNullValues(false))
          ctx = Object.assign({}, ctx, { allNullValues: true });
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "",
          flowChars: { start: "{", end: "}" },
          itemIndent: ctx.indent || "",
          onChompKeep,
          onComment
        });
      }
    };
    exports.YAMLMap = YAMLMap;
    exports.findPair = findPair;
  }
});

// node_modules/yaml/dist/schema/common/map.js
var require_map = __commonJS({
  "node_modules/yaml/dist/schema/common/map.js"(exports) {
    "use strict";
    var identity = require_identity();
    var YAMLMap = require_YAMLMap();
    var map = {
      collection: "map",
      default: true,
      nodeClass: YAMLMap.YAMLMap,
      tag: "tag:yaml.org,2002:map",
      resolve(map2, onError) {
        if (!identity.isMap(map2))
          onError("Expected a mapping for this tag");
        return map2;
      },
      createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
    };
    exports.map = map;
  }
});

// node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLSeq.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var stringifyCollection = require_stringifyCollection();
    var Collection = require_Collection();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var toJS = require_toJS();
    var YAMLSeq = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:seq";
      }
      constructor(schema) {
        super(identity.SEQ, schema);
        this.items = [];
      }
      add(value) {
        this.items.push(value);
      }
      /**
       * Removes a value from the collection.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       *
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return false;
        const del = this.items.splice(idx, 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return void 0;
        const it = this.items[idx];
        return !keepScalar && identity.isScalar(it) ? it.value : it;
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       */
      has(key) {
        const idx = asItemIndex(key);
        return typeof idx === "number" && idx < this.items.length;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       *
       * If `key` does not contain a representation of an integer, this will throw.
       * It may be wrapped in a `Scalar`.
       */
      set(key, value) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          throw new Error(`Expected a valid index, not ${key}.`);
        const prev = this.items[idx];
        if (identity.isScalar(prev) && Scalar.isScalarValue(value))
          prev.value = value;
        else
          this.items[idx] = value;
      }
      toJSON(_, ctx) {
        const seq = [];
        if (ctx?.onCreate)
          ctx.onCreate(seq);
        let i = 0;
        for (const item of this.items)
          seq.push(toJS.toJS(item, String(i++), ctx));
        return seq;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "- ",
          flowChars: { start: "[", end: "]" },
          itemIndent: (ctx.indent || "") + "  ",
          onChompKeep,
          onComment
        });
      }
      static from(schema, obj, ctx) {
        const { replacer } = ctx;
        const seq = new this(schema);
        if (obj && Symbol.iterator in Object(obj)) {
          let i = 0;
          for (let it of obj) {
            if (typeof replacer === "function") {
              const key = obj instanceof Set ? it : String(i++);
              it = replacer.call(obj, key, it);
            }
            seq.items.push(createNode.createNode(it, void 0, ctx));
          }
        }
        return seq;
      }
    };
    function asItemIndex(key) {
      let idx = identity.isScalar(key) ? key.value : key;
      if (idx && typeof idx === "string")
        idx = Number(idx);
      return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
    }
    exports.YAMLSeq = YAMLSeq;
  }
});

// node_modules/yaml/dist/schema/common/seq.js
var require_seq = __commonJS({
  "node_modules/yaml/dist/schema/common/seq.js"(exports) {
    "use strict";
    var identity = require_identity();
    var YAMLSeq = require_YAMLSeq();
    var seq = {
      collection: "seq",
      default: true,
      nodeClass: YAMLSeq.YAMLSeq,
      tag: "tag:yaml.org,2002:seq",
      resolve(seq2, onError) {
        if (!identity.isSeq(seq2))
          onError("Expected a sequence for this tag");
        return seq2;
      },
      createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
    };
    exports.seq = seq;
  }
});

// node_modules/yaml/dist/schema/common/string.js
var require_string = __commonJS({
  "node_modules/yaml/dist/schema/common/string.js"(exports) {
    "use strict";
    var stringifyString = require_stringifyString();
    var string = {
      identify: (value) => typeof value === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str) => str,
      stringify(item, ctx, onComment, onChompKeep) {
        ctx = Object.assign({ actualString: true }, ctx);
        return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
      }
    };
    exports.string = string;
  }
});

// node_modules/yaml/dist/schema/common/null.js
var require_null = __commonJS({
  "node_modules/yaml/dist/schema/common/null.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var nullTag = {
      identify: (value) => value == null,
      createNode: () => new Scalar.Scalar(null),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^(?:~|[Nn]ull|NULL)?$/,
      resolve: () => new Scalar.Scalar(null),
      stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
    };
    exports.nullTag = nullTag;
  }
});

// node_modules/yaml/dist/schema/core/bool.js
var require_bool = __commonJS({
  "node_modules/yaml/dist/schema/core/bool.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var boolTag = {
      identify: (value) => typeof value === "boolean",
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
      resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
      stringify({ source, value }, ctx) {
        if (source && boolTag.test.test(source)) {
          const sv = source[0] === "t" || source[0] === "T";
          if (value === sv)
            return source;
        }
        return value ? ctx.options.trueStr : ctx.options.falseStr;
      }
    };
    exports.boolTag = boolTag;
  }
});

// node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyNumber.js"(exports) {
    "use strict";
    function stringifyNumber({ format, minFractionDigits, tag, value }) {
      if (typeof value === "bigint")
        return String(value);
      const num = typeof value === "number" ? value : Number(value);
      if (!isFinite(num))
        return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
      let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
      if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
        let i = n.indexOf(".");
        if (i < 0) {
          i = n.length;
          n += ".";
        }
        let d = minFractionDigits - (n.length - i - 1);
        while (d-- > 0)
          n += "0";
      }
      return n;
    }
    exports.stringifyNumber = stringifyNumber;
  }
});

// node_modules/yaml/dist/schema/core/float.js
var require_float = __commonJS({
  "node_modules/yaml/dist/schema/core/float.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str));
        const dot = str.indexOf(".");
        if (dot !== -1 && str[str.length - 1] === "0")
          node.minFractionDigits = str.length - dot - 1;
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports.float = float;
    exports.floatExp = floatExp;
    exports.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/core/int.js
var require_int = __commonJS({
  "node_modules/yaml/dist/schema/core/int.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value) && value >= 0)
        return prefix + value.toString(radix);
      return stringifyNumber.stringifyNumber(node);
    }
    var intOct = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^0o[0-7]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
      stringify: (node) => intStringify(node, 8, "0o")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^0x[0-9a-fA-F]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports.int = int;
    exports.intHex = intHex;
    exports.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/core/schema.js
var require_schema = __commonJS({
  "node_modules/yaml/dist/schema/core/schema.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.boolTag,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float
    ];
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/json/schema.js
var require_schema2 = __commonJS({
  "node_modules/yaml/dist/schema/json/schema.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var map = require_map();
    var seq = require_seq();
    function intIdentify(value) {
      return typeof value === "bigint" || Number.isInteger(value);
    }
    var stringifyJSON = ({ value }) => JSON.stringify(value);
    var jsonScalars = [
      {
        identify: (value) => typeof value === "string",
        default: true,
        tag: "tag:yaml.org,2002:str",
        resolve: (str) => str,
        stringify: stringifyJSON
      },
      {
        identify: (value) => value == null,
        createNode: () => new Scalar.Scalar(null),
        default: true,
        tag: "tag:yaml.org,2002:null",
        test: /^null$/,
        resolve: () => null,
        stringify: stringifyJSON
      },
      {
        identify: (value) => typeof value === "boolean",
        default: true,
        tag: "tag:yaml.org,2002:bool",
        test: /^true$|^false$/,
        resolve: (str) => str === "true",
        stringify: stringifyJSON
      },
      {
        identify: intIdentify,
        default: true,
        tag: "tag:yaml.org,2002:int",
        test: /^-?(?:0|[1-9][0-9]*)$/,
        resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
        stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
      },
      {
        identify: (value) => typeof value === "number",
        default: true,
        tag: "tag:yaml.org,2002:float",
        test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
        resolve: (str) => parseFloat(str),
        stringify: stringifyJSON
      }
    ];
    var jsonError = {
      default: true,
      tag: "",
      test: /^/,
      resolve(str, onError) {
        onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
        return str;
      }
    };
    var schema = [map.map, seq.seq].concat(jsonScalars, jsonError);
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/binary.js"(exports) {
    "use strict";
    var node_buffer = __require("buffer");
    var Scalar = require_Scalar();
    var stringifyString = require_stringifyString();
    var binary = {
      identify: (value) => value instanceof Uint8Array,
      // Buffer inherits from Uint8Array
      default: false,
      tag: "tag:yaml.org,2002:binary",
      /**
       * Returns a Buffer in node and an Uint8Array in browsers
       *
       * To use the resulting buffer as an image, you'll want to do something like:
       *
       *   const blob = new Blob([buffer], { type: 'image/jpeg' })
       *   document.querySelector('#photo').src = URL.createObjectURL(blob)
       */
      resolve(src, onError) {
        if (typeof node_buffer.Buffer === "function") {
          return node_buffer.Buffer.from(src, "base64");
        } else if (typeof atob === "function") {
          const str = atob(src.replace(/[\n\r]/g, ""));
          const buffer = new Uint8Array(str.length);
          for (let i = 0; i < str.length; ++i)
            buffer[i] = str.charCodeAt(i);
          return buffer;
        } else {
          onError("This environment does not support reading binary tags; either Buffer or atob is required");
          return src;
        }
      },
      stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
        if (!value)
          return "";
        const buf = value;
        let str;
        if (typeof node_buffer.Buffer === "function") {
          str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
        } else if (typeof btoa === "function") {
          let s = "";
          for (let i = 0; i < buf.length; ++i)
            s += String.fromCharCode(buf[i]);
          str = btoa(s);
        } else {
          throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
        }
        type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
        if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
          const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
          const n = Math.ceil(str.length / lineWidth);
          const lines = new Array(n);
          for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
            lines[i] = str.substr(o, lineWidth);
          }
          str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? "\n" : " ");
        }
        return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
      }
    };
    exports.binary = binary;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/pairs.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLSeq = require_YAMLSeq();
    function resolvePairs(seq, onError) {
      if (identity.isSeq(seq)) {
        for (let i = 0; i < seq.items.length; ++i) {
          let item = seq.items[i];
          if (identity.isPair(item))
            continue;
          else if (identity.isMap(item)) {
            if (item.items.length > 1)
              onError("Each pair must have its own sequence indicator");
            const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
            if (item.commentBefore)
              pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
            if (item.comment) {
              const cn = pair.value ?? pair.key;
              cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
            }
            item = pair;
          }
          seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
        }
      } else
        onError("Expected a sequence for this tag");
      return seq;
    }
    function createPairs(schema, iterable, ctx) {
      const { replacer } = ctx;
      const pairs2 = new YAMLSeq.YAMLSeq(schema);
      pairs2.tag = "tag:yaml.org,2002:pairs";
      let i = 0;
      if (iterable && Symbol.iterator in Object(iterable))
        for (let it of iterable) {
          if (typeof replacer === "function")
            it = replacer.call(iterable, String(i++), it);
          let key, value;
          if (Array.isArray(it)) {
            if (it.length === 2) {
              key = it[0];
              value = it[1];
            } else
              throw new TypeError(`Expected [key, value] tuple: ${it}`);
          } else if (it && it instanceof Object) {
            const keys = Object.keys(it);
            if (keys.length === 1) {
              key = keys[0];
              value = it[key];
            } else {
              throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
            }
          } else {
            key = it;
          }
          pairs2.items.push(Pair.createPair(key, value, ctx));
        }
      return pairs2;
    }
    var pairs = {
      collection: "seq",
      default: false,
      tag: "tag:yaml.org,2002:pairs",
      resolve: resolvePairs,
      createNode: createPairs
    };
    exports.createPairs = createPairs;
    exports.pairs = pairs;
    exports.resolvePairs = resolvePairs;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/omap.js"(exports) {
    "use strict";
    var identity = require_identity();
    var toJS = require_toJS();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var pairs = require_pairs();
    var YAMLOMap = class _YAMLOMap extends YAMLSeq.YAMLSeq {
      constructor() {
        super();
        this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
        this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
        this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
        this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
        this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
        this.tag = _YAMLOMap.tag;
      }
      /**
       * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
       * but TypeScript won't allow widening the signature of a child method.
       */
      toJSON(_, ctx) {
        if (!ctx)
          return super.toJSON(_);
        const map = /* @__PURE__ */ new Map();
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const pair of this.items) {
          let key, value;
          if (identity.isPair(pair)) {
            key = toJS.toJS(pair.key, "", ctx);
            value = toJS.toJS(pair.value, key, ctx);
          } else {
            key = toJS.toJS(pair, "", ctx);
          }
          if (map.has(key))
            throw new Error("Ordered maps must not include duplicate keys");
          map.set(key, value);
        }
        return map;
      }
      static from(schema, iterable, ctx) {
        const pairs$1 = pairs.createPairs(schema, iterable, ctx);
        const omap2 = new this();
        omap2.items = pairs$1.items;
        return omap2;
      }
    };
    YAMLOMap.tag = "tag:yaml.org,2002:omap";
    var omap = {
      collection: "seq",
      identify: (value) => value instanceof Map,
      nodeClass: YAMLOMap,
      default: false,
      tag: "tag:yaml.org,2002:omap",
      resolve(seq, onError) {
        const pairs$1 = pairs.resolvePairs(seq, onError);
        const seenKeys = [];
        for (const { key } of pairs$1.items) {
          if (identity.isScalar(key)) {
            if (seenKeys.includes(key.value)) {
              onError(`Ordered maps must not include duplicate keys: ${key.value}`);
            } else {
              seenKeys.push(key.value);
            }
          }
        }
        return Object.assign(new YAMLOMap(), pairs$1);
      },
      createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
    };
    exports.YAMLOMap = YAMLOMap;
    exports.omap = omap;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/bool.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    function boolStringify({ value, source }, ctx) {
      const boolObj = value ? trueTag : falseTag;
      if (source && boolObj.test.test(source))
        return source;
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    }
    var trueTag = {
      identify: (value) => value === true,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
      resolve: () => new Scalar.Scalar(true),
      stringify: boolStringify
    };
    var falseTag = {
      identify: (value) => value === false,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
      resolve: () => new Scalar.Scalar(false),
      stringify: boolStringify
    };
    exports.falseTag = falseTag;
    exports.trueTag = trueTag;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/float.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str.replace(/_/g, "")),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
        const dot = str.indexOf(".");
        if (dot !== -1) {
          const f = str.substring(dot + 1).replace(/_/g, "");
          if (f[f.length - 1] === "0")
            node.minFractionDigits = f.length;
        }
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports.float = float;
    exports.floatExp = floatExp;
    exports.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/int.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    function intResolve(str, offset, radix, { intAsBigInt }) {
      const sign = str[0];
      if (sign === "-" || sign === "+")
        offset += 1;
      str = str.substring(offset).replace(/_/g, "");
      if (intAsBigInt) {
        switch (radix) {
          case 2:
            str = `0b${str}`;
            break;
          case 8:
            str = `0o${str}`;
            break;
          case 16:
            str = `0x${str}`;
            break;
        }
        const n2 = BigInt(str);
        return sign === "-" ? BigInt(-1) * n2 : n2;
      }
      const n = parseInt(str, radix);
      return sign === "-" ? -1 * n : n;
    }
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value)) {
        const str = value.toString(radix);
        return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
      }
      return stringifyNumber.stringifyNumber(node);
    }
    var intBin = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "BIN",
      test: /^[-+]?0b[0-1_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
      stringify: (node) => intStringify(node, 2, "0b")
    };
    var intOct = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^[-+]?0[0-7_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
      stringify: (node) => intStringify(node, 8, "0")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9][0-9_]*$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^[-+]?0x[0-9a-fA-F_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports.int = int;
    exports.intBin = intBin;
    exports.intHex = intHex;
    exports.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/set.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSet = class _YAMLSet extends YAMLMap.YAMLMap {
      constructor(schema) {
        super(schema);
        this.tag = _YAMLSet.tag;
      }
      add(key) {
        let pair;
        if (identity.isPair(key))
          pair = key;
        else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
          pair = new Pair.Pair(key.key, null);
        else
          pair = new Pair.Pair(key, null);
        const prev = YAMLMap.findPair(this.items, pair.key);
        if (!prev)
          this.items.push(pair);
      }
      /**
       * If `keepPair` is `true`, returns the Pair matching `key`.
       * Otherwise, returns the value of that Pair's key.
       */
      get(key, keepPair) {
        const pair = YAMLMap.findPair(this.items, key);
        return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
      }
      set(key, value) {
        if (typeof value !== "boolean")
          throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
        const prev = YAMLMap.findPair(this.items, key);
        if (prev && !value) {
          this.items.splice(this.items.indexOf(prev), 1);
        } else if (!prev && value) {
          this.items.push(new Pair.Pair(key));
        }
      }
      toJSON(_, ctx) {
        return super.toJSON(_, ctx, Set);
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        if (this.hasAllNullValues(true))
          return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
        else
          throw new Error("Set items must all have null values");
      }
      static from(schema, iterable, ctx) {
        const { replacer } = ctx;
        const set2 = new this(schema);
        if (iterable && Symbol.iterator in Object(iterable))
          for (let value of iterable) {
            if (typeof replacer === "function")
              value = replacer.call(iterable, value, value);
            set2.items.push(Pair.createPair(value, null, ctx));
          }
        return set2;
      }
    };
    YAMLSet.tag = "tag:yaml.org,2002:set";
    var set = {
      collection: "map",
      identify: (value) => value instanceof Set,
      nodeClass: YAMLSet,
      default: false,
      tag: "tag:yaml.org,2002:set",
      createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
      resolve(map, onError) {
        if (identity.isMap(map)) {
          if (map.hasAllNullValues(true))
            return Object.assign(new YAMLSet(), map);
          else
            onError("Set items must all have null values");
        } else
          onError("Expected a mapping for this tag");
        return map;
      }
    };
    exports.YAMLSet = YAMLSet;
    exports.set = set;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/timestamp.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    function parseSexagesimal(str, asBigInt) {
      const sign = str[0];
      const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
      const num = (n) => asBigInt ? BigInt(n) : Number(n);
      const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
      return sign === "-" ? num(-1) * res : res;
    }
    function stringifySexagesimal(node) {
      let { value } = node;
      let num = (n) => n;
      if (typeof value === "bigint")
        num = (n) => BigInt(n);
      else if (isNaN(value) || !isFinite(value))
        return stringifyNumber.stringifyNumber(node);
      let sign = "";
      if (value < 0) {
        sign = "-";
        value *= num(-1);
      }
      const _60 = num(60);
      const parts = [value % _60];
      if (value < 60) {
        parts.unshift(0);
      } else {
        value = (value - parts[0]) / _60;
        parts.unshift(value % _60);
        if (value >= 60) {
          value = (value - parts[0]) / _60;
          parts.unshift(value);
        }
      }
      return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
    }
    var intTime = {
      identify: (value) => typeof value === "bigint" || Number.isInteger(value),
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
      resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
      stringify: stringifySexagesimal
    };
    var floatTime = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
      resolve: (str) => parseSexagesimal(str, false),
      stringify: stringifySexagesimal
    };
    var timestamp = {
      identify: (value) => value instanceof Date,
      default: true,
      tag: "tag:yaml.org,2002:timestamp",
      // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
      // may be omitted altogether, resulting in a date format. In such a case, the time part is
      // assumed to be 00:00:00Z (start of day, UTC).
      test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
      resolve(str) {
        const match = str.match(timestamp.test);
        if (!match)
          throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
        const [, year, month, day, hour, minute, second] = match.map(Number);
        const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
        let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
        const tz = match[8];
        if (tz && tz !== "Z") {
          let d = parseSexagesimal(tz, false);
          if (Math.abs(d) < 30)
            d *= 60;
          date -= 6e4 * d;
        }
        return new Date(date);
      },
      stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
    };
    exports.floatTime = floatTime;
    exports.intTime = intTime;
    exports.timestamp = timestamp;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema3 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/schema.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var binary = require_binary();
    var bool = require_bool2();
    var float = require_float2();
    var int = require_int2();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var set = require_set();
    var timestamp = require_timestamp();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.trueTag,
      bool.falseTag,
      int.intBin,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float,
      binary.binary,
      merge.merge,
      omap.omap,
      pairs.pairs,
      set.set,
      timestamp.intTime,
      timestamp.floatTime,
      timestamp.timestamp
    ];
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/tags.js
var require_tags = __commonJS({
  "node_modules/yaml/dist/schema/tags.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = require_schema();
    var schema$1 = require_schema2();
    var binary = require_binary();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var schema$2 = require_schema3();
    var set = require_set();
    var timestamp = require_timestamp();
    var schemas = /* @__PURE__ */ new Map([
      ["core", schema.schema],
      ["failsafe", [map.map, seq.seq, string.string]],
      ["json", schema$1.schema],
      ["yaml11", schema$2.schema],
      ["yaml-1.1", schema$2.schema]
    ]);
    var tagsByName = {
      binary: binary.binary,
      bool: bool.boolTag,
      float: float.float,
      floatExp: float.floatExp,
      floatNaN: float.floatNaN,
      floatTime: timestamp.floatTime,
      int: int.int,
      intHex: int.intHex,
      intOct: int.intOct,
      intTime: timestamp.intTime,
      map: map.map,
      merge: merge.merge,
      null: _null.nullTag,
      omap: omap.omap,
      pairs: pairs.pairs,
      seq: seq.seq,
      set: set.set,
      timestamp: timestamp.timestamp
    };
    var coreKnownTags = {
      "tag:yaml.org,2002:binary": binary.binary,
      "tag:yaml.org,2002:merge": merge.merge,
      "tag:yaml.org,2002:omap": omap.omap,
      "tag:yaml.org,2002:pairs": pairs.pairs,
      "tag:yaml.org,2002:set": set.set,
      "tag:yaml.org,2002:timestamp": timestamp.timestamp
    };
    function getTags(customTags, schemaName, addMergeTag) {
      const schemaTags = schemas.get(schemaName);
      if (schemaTags && !customTags) {
        return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
      }
      let tags = schemaTags;
      if (!tags) {
        if (Array.isArray(customTags))
          tags = [];
        else {
          const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
        }
      }
      if (Array.isArray(customTags)) {
        for (const tag of customTags)
          tags = tags.concat(tag);
      } else if (typeof customTags === "function") {
        tags = customTags(tags.slice());
      }
      if (addMergeTag)
        tags = tags.concat(merge.merge);
      return tags.reduce((tags2, tag) => {
        const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
        if (!tagObj) {
          const tagName = JSON.stringify(tag);
          const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
        }
        if (!tags2.includes(tagObj))
          tags2.push(tagObj);
        return tags2;
      }, []);
    }
    exports.coreKnownTags = coreKnownTags;
    exports.getTags = getTags;
  }
});

// node_modules/yaml/dist/schema/Schema.js
var require_Schema = __commonJS({
  "node_modules/yaml/dist/schema/Schema.js"(exports) {
    "use strict";
    var identity = require_identity();
    var map = require_map();
    var seq = require_seq();
    var string = require_string();
    var tags = require_tags();
    var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    var Schema = class _Schema {
      constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
        this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
        this.name = typeof schema === "string" && schema || "core";
        this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
        this.tags = tags.getTags(customTags, this.name, merge);
        this.toStringOptions = toStringDefaults ?? null;
        Object.defineProperty(this, identity.MAP, { value: map.map });
        Object.defineProperty(this, identity.SCALAR, { value: string.string });
        Object.defineProperty(this, identity.SEQ, { value: seq.seq });
        this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
      }
      clone() {
        const copy = Object.create(_Schema.prototype, Object.getOwnPropertyDescriptors(this));
        copy.tags = this.tags.slice();
        return copy;
      }
    };
    exports.Schema = Schema;
  }
});

// node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyDocument.js"(exports) {
    "use strict";
    var identity = require_identity();
    var stringify3 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyDocument(doc, options) {
      const lines = [];
      let hasDirectives = options.directives === true;
      if (options.directives !== false && doc.directives) {
        const dir = doc.directives.toString(doc);
        if (dir) {
          lines.push(dir);
          hasDirectives = true;
        } else if (doc.directives.docStart)
          hasDirectives = true;
      }
      if (hasDirectives)
        lines.push("---");
      const ctx = stringify3.createStringifyContext(doc, options);
      const { commentString } = ctx.options;
      if (doc.commentBefore) {
        if (lines.length !== 1)
          lines.unshift("");
        const cs = commentString(doc.commentBefore);
        lines.unshift(stringifyComment.indentComment(cs, ""));
      }
      let chompKeep = false;
      let contentComment = null;
      if (doc.contents) {
        if (identity.isNode(doc.contents)) {
          if (doc.contents.spaceBefore && hasDirectives)
            lines.push("");
          if (doc.contents.commentBefore) {
            const cs = commentString(doc.contents.commentBefore);
            lines.push(stringifyComment.indentComment(cs, ""));
          }
          ctx.forceBlockIndent = !!doc.comment;
          contentComment = doc.contents.comment;
        }
        const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
        let body = stringify3.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
        if (contentComment)
          body += stringifyComment.lineComment(body, "", commentString(contentComment));
        if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
          lines[lines.length - 1] = `--- ${body}`;
        } else
          lines.push(body);
      } else {
        lines.push(stringify3.stringify(doc.contents, ctx));
      }
      if (doc.directives?.docEnd) {
        if (doc.comment) {
          const cs = commentString(doc.comment);
          if (cs.includes("\n")) {
            lines.push("...");
            lines.push(stringifyComment.indentComment(cs, ""));
          } else {
            lines.push(`... ${cs}`);
          }
        } else {
          lines.push("...");
        }
      } else {
        let dc = doc.comment;
        if (dc && chompKeep)
          dc = dc.replace(/^\n+/, "");
        if (dc) {
          if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
            lines.push("");
          lines.push(stringifyComment.indentComment(commentString(dc), ""));
        }
      }
      return lines.join("\n") + "\n";
    }
    exports.stringifyDocument = stringifyDocument;
  }
});

// node_modules/yaml/dist/doc/Document.js
var require_Document = __commonJS({
  "node_modules/yaml/dist/doc/Document.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var toJS = require_toJS();
    var Schema = require_Schema();
    var stringifyDocument = require_stringifyDocument();
    var anchors = require_anchors();
    var applyReviver = require_applyReviver();
    var createNode = require_createNode();
    var directives = require_directives();
    var Document = class _Document {
      constructor(value, replacer, options) {
        this.commentBefore = null;
        this.comment = null;
        this.errors = [];
        this.warnings = [];
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
        let _replacer = null;
        if (typeof replacer === "function" || Array.isArray(replacer)) {
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const opt = Object.assign({
          intAsBigInt: false,
          keepSourceTokens: false,
          logLevel: "warn",
          prettyErrors: true,
          strict: true,
          stringKeys: false,
          uniqueKeys: true,
          version: "1.2"
        }, options);
        this.options = opt;
        let { version } = opt;
        if (options?._directives) {
          this.directives = options._directives.atDocument();
          if (this.directives.yaml.explicit)
            version = this.directives.yaml.version;
        } else
          this.directives = new directives.Directives({ version });
        this.setSchema(version, options);
        this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
      }
      /**
       * Create a deep copy of this Document and its contents.
       *
       * Custom Node values that inherit from `Object` still refer to their original instances.
       */
      clone() {
        const copy = Object.create(_Document.prototype, {
          [identity.NODE_TYPE]: { value: identity.DOC }
        });
        copy.commentBefore = this.commentBefore;
        copy.comment = this.comment;
        copy.errors = this.errors.slice();
        copy.warnings = this.warnings.slice();
        copy.options = Object.assign({}, this.options);
        if (this.directives)
          copy.directives = this.directives.clone();
        copy.schema = this.schema.clone();
        copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** Adds a value to the document. */
      add(value) {
        if (assertCollection(this.contents))
          this.contents.add(value);
      }
      /** Adds a value to the document. */
      addIn(path, value) {
        if (assertCollection(this.contents))
          this.contents.addIn(path, value);
      }
      /**
       * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
       *
       * If `node` already has an anchor, `name` is ignored.
       * Otherwise, the `node.anchor` value will be set to `name`,
       * or if an anchor with that name is already present in the document,
       * `name` will be used as a prefix for a new unique anchor.
       * If `name` is undefined, the generated anchor will use 'a' as a prefix.
       */
      createAlias(node, name) {
        if (!node.anchor) {
          const prev = anchors.anchorNames(this);
          node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
        }
        return new Alias.Alias(node.anchor);
      }
      createNode(value, replacer, options) {
        let _replacer = void 0;
        if (typeof replacer === "function") {
          value = replacer.call({ "": value }, "", value);
          _replacer = replacer;
        } else if (Array.isArray(replacer)) {
          const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
          const asStr = replacer.filter(keyToStr).map(String);
          if (asStr.length > 0)
            replacer = replacer.concat(asStr);
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
        const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(
          this,
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          anchorPrefix || "a"
        );
        const ctx = {
          aliasDuplicateObjects: aliasDuplicateObjects ?? true,
          keepUndefined: keepUndefined ?? false,
          onAnchor,
          onTagObj,
          replacer: _replacer,
          schema: this.schema,
          sourceObjects
        };
        const node = createNode.createNode(value, tag, ctx);
        if (flow && identity.isCollection(node))
          node.flow = true;
        setAnchors();
        return node;
      }
      /**
       * Convert a key and a value into a `Pair` using the current schema,
       * recursively wrapping all values as `Scalar` or `Collection` nodes.
       */
      createPair(key, value, options = {}) {
        const k = this.createNode(key, null, options);
        const v = this.createNode(value, null, options);
        return new Pair.Pair(k, v);
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        return assertCollection(this.contents) ? this.contents.delete(key) : false;
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        if (Collection.isEmptyPath(path)) {
          if (this.contents == null)
            return false;
          this.contents = null;
          return true;
        }
        return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      get(key, keepScalar) {
        return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
      }
      /**
       * Returns item at `path`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        if (Collection.isEmptyPath(path))
          return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
        return identity.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : void 0;
      }
      /**
       * Checks if the document includes a value with the key `key`.
       */
      has(key) {
        return identity.isCollection(this.contents) ? this.contents.has(key) : false;
      }
      /**
       * Checks if the document includes a value at `path`.
       */
      hasIn(path) {
        if (Collection.isEmptyPath(path))
          return this.contents !== void 0;
        return identity.isCollection(this.contents) ? this.contents.hasIn(path) : false;
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      set(key, value) {
        if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, [key], value);
        } else if (assertCollection(this.contents)) {
          this.contents.set(key, value);
        }
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        if (Collection.isEmptyPath(path)) {
          this.contents = value;
        } else if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, Array.from(path), value);
        } else if (assertCollection(this.contents)) {
          this.contents.setIn(path, value);
        }
      }
      /**
       * Change the YAML version and schema used by the document.
       * A `null` version disables support for directives, explicit tags, anchors, and aliases.
       * It also requires the `schema` option to be given as a `Schema` instance value.
       *
       * Overrides all previously set schema options.
       */
      setSchema(version, options = {}) {
        if (typeof version === "number")
          version = String(version);
        let opt;
        switch (version) {
          case "1.1":
            if (this.directives)
              this.directives.yaml.version = "1.1";
            else
              this.directives = new directives.Directives({ version: "1.1" });
            opt = { resolveKnownTags: false, schema: "yaml-1.1" };
            break;
          case "1.2":
          case "next":
            if (this.directives)
              this.directives.yaml.version = version;
            else
              this.directives = new directives.Directives({ version });
            opt = { resolveKnownTags: true, schema: "core" };
            break;
          case null:
            if (this.directives)
              delete this.directives;
            opt = null;
            break;
          default: {
            const sv = JSON.stringify(version);
            throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
          }
        }
        if (options.schema instanceof Object)
          this.schema = options.schema;
        else if (opt)
          this.schema = new Schema.Schema(Object.assign(opt, options));
        else
          throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
      }
      // json & jsonArg are only used from toJSON()
      toJS({ json: json2, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc: this,
          keep: !json2,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
      /**
       * A JSON representation of the document `contents`.
       *
       * @param jsonArg Used by `JSON.stringify` to indicate the array index or
       *   property name.
       */
      toJSON(jsonArg, onAnchor) {
        return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
      }
      /** A YAML representation of the document. */
      toString(options = {}) {
        if (this.errors.length > 0)
          throw new Error("Document with errors cannot be stringified");
        if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
          const s = JSON.stringify(options.indent);
          throw new Error(`"indent" option must be a positive integer, not ${s}`);
        }
        return stringifyDocument.stringifyDocument(this, options);
      }
    };
    function assertCollection(contents) {
      if (identity.isCollection(contents))
        return true;
      throw new Error("Expected a YAML collection as document contents");
    }
    exports.Document = Document;
  }
});

// node_modules/yaml/dist/errors.js
var require_errors = __commonJS({
  "node_modules/yaml/dist/errors.js"(exports) {
    "use strict";
    var YAMLError = class extends Error {
      constructor(name, pos, code, message) {
        super();
        this.name = name;
        this.code = code;
        this.message = message;
        this.pos = pos;
      }
    };
    var YAMLParseError = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLParseError", pos, code, message);
      }
    };
    var YAMLWarning = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLWarning", pos, code, message);
      }
    };
    var prettifyError = (src, lc) => (error) => {
      if (error.pos[0] === -1)
        return;
      error.linePos = error.pos.map((pos) => lc.linePos(pos));
      const { line, col } = error.linePos[0];
      error.message += ` at line ${line}, column ${col}`;
      let ci = col - 1;
      let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
      if (ci >= 60 && lineStr.length > 80) {
        const trimStart = Math.min(ci - 39, lineStr.length - 79);
        lineStr = "\u2026" + lineStr.substring(trimStart);
        ci -= trimStart - 1;
      }
      if (lineStr.length > 80)
        lineStr = lineStr.substring(0, 79) + "\u2026";
      if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
        let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
        if (prev.length > 80)
          prev = prev.substring(0, 79) + "\u2026\n";
        lineStr = prev + lineStr;
      }
      if (/[^ ]/.test(lineStr)) {
        let count = 1;
        const end = error.linePos[1];
        if (end?.line === line && end.col > col) {
          count = Math.max(1, Math.min(end.col - col, 80 - ci));
        }
        const pointer = " ".repeat(ci) + "^".repeat(count);
        error.message += `:

${lineStr}
${pointer}
`;
      }
    };
    exports.YAMLError = YAMLError;
    exports.YAMLParseError = YAMLParseError;
    exports.YAMLWarning = YAMLWarning;
    exports.prettifyError = prettifyError;
  }
});

// node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = __commonJS({
  "node_modules/yaml/dist/compose/resolve-props.js"(exports) {
    "use strict";
    function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
      let spaceBefore = false;
      let atNewline = startOnNewline;
      let hasSpace = startOnNewline;
      let comment = "";
      let commentSep = "";
      let hasNewline = false;
      let reqSpace = false;
      let tab = null;
      let anchor = null;
      let tag = null;
      let newlineAfterProp = null;
      let comma = null;
      let found = null;
      let start = null;
      for (const token of tokens) {
        if (reqSpace) {
          if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
            onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
          reqSpace = false;
        }
        if (tab) {
          if (atNewline && token.type !== "comment" && token.type !== "newline") {
            onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
          }
          tab = null;
        }
        switch (token.type) {
          case "space":
            if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	")) {
              tab = token;
            }
            hasSpace = true;
            break;
          case "comment": {
            if (!hasSpace)
              onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = token.source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += commentSep + cb;
            commentSep = "";
            atNewline = false;
            break;
          }
          case "newline":
            if (atNewline) {
              if (comment)
                comment += token.source;
              else if (!found || indicator !== "seq-item-ind")
                spaceBefore = true;
            } else
              commentSep += token.source;
            atNewline = true;
            hasNewline = true;
            if (anchor || tag)
              newlineAfterProp = token;
            hasSpace = true;
            break;
          case "anchor":
            if (anchor)
              onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
            if (token.source.endsWith(":"))
              onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
            anchor = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          case "tag": {
            if (tag)
              onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
            tag = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          }
          case indicator:
            if (anchor || tag)
              onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
            if (found)
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
            found = token;
            atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
            hasSpace = false;
            break;
          case "comma":
            if (flow) {
              if (comma)
                onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
              comma = token;
              atNewline = false;
              hasSpace = false;
              break;
            }
          // else fallthrough
          default:
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
            atNewline = false;
            hasSpace = false;
        }
      }
      const last = tokens[tokens.length - 1];
      const end = last ? last.offset + last.source.length : offset;
      if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
        onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      }
      if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      return {
        comma,
        found,
        spaceBefore,
        comment,
        hasNewline,
        anchor,
        tag,
        newlineAfterProp,
        end,
        start: start ?? end
      };
    }
    exports.resolveProps = resolveProps;
  }
});

// node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = __commonJS({
  "node_modules/yaml/dist/compose/util-contains-newline.js"(exports) {
    "use strict";
    function containsNewline(key) {
      if (!key)
        return null;
      switch (key.type) {
        case "alias":
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          if (key.source.includes("\n"))
            return true;
          if (key.end) {
            for (const st of key.end)
              if (st.type === "newline")
                return true;
          }
          return false;
        case "flow-collection":
          for (const it of key.items) {
            for (const st of it.start)
              if (st.type === "newline")
                return true;
            if (it.sep) {
              for (const st of it.sep)
                if (st.type === "newline")
                  return true;
            }
            if (containsNewline(it.key) || containsNewline(it.value))
              return true;
          }
          return false;
        default:
          return true;
      }
    }
    exports.containsNewline = containsNewline;
  }
});

// node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = __commonJS({
  "node_modules/yaml/dist/compose/util-flow-indent-check.js"(exports) {
    "use strict";
    var utilContainsNewline = require_util_contains_newline();
    function flowIndentCheck(indent, fc, onError) {
      if (fc?.type === "flow-collection") {
        const end = fc.end[0];
        if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
          const msg = "Flow end indicator should be more indented than parent";
          onError(end, "BAD_INDENT", msg, true);
        }
      }
    }
    exports.flowIndentCheck = flowIndentCheck;
  }
});

// node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = __commonJS({
  "node_modules/yaml/dist/compose/util-map-includes.js"(exports) {
    "use strict";
    var identity = require_identity();
    function mapIncludes(ctx, items, search) {
      const { uniqueKeys } = ctx.options;
      if (uniqueKeys === false)
        return false;
      const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
      return items.some((pair) => isEqual(pair.key, search));
    }
    exports.mapIncludes = mapIncludes;
  }
});

// node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-map.js"(exports) {
    "use strict";
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    var utilMapIncludes = require_util_map_includes();
    var startColMsg = "All mapping items must start at the same column";
    function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
      const map = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      let offset = bm.offset;
      let commentEnd = null;
      for (const collItem of bm.items) {
        const { start, key, sep: sep2, value } = collItem;
        const keyProps = resolveProps.resolveProps(start, {
          indicator: "explicit-key-ind",
          next: key ?? sep2?.[0],
          offset,
          onError,
          parentIndent: bm.indent,
          startOnNewline: true
        });
        const implicitKey = !keyProps.found;
        if (implicitKey) {
          if (key) {
            if (key.type === "block-seq")
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
            else if ("indent" in key && key.indent !== bm.indent)
              onError(offset, "BAD_INDENT", startColMsg);
          }
          if (!keyProps.anchor && !keyProps.tag && !sep2) {
            commentEnd = keyProps.end;
            if (keyProps.comment) {
              if (map.comment)
                map.comment += "\n" + keyProps.comment;
              else
                map.comment = keyProps.comment;
            }
            continue;
          }
          if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
            onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
          }
        } else if (keyProps.found?.indent !== bm.indent) {
          onError(offset, "BAD_INDENT", startColMsg);
        }
        ctx.atKey = true;
        const keyStart = keyProps.end;
        const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
        ctx.atKey = false;
        if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        const valueProps = resolveProps.resolveProps(sep2 ?? [], {
          indicator: "map-value-ind",
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: bm.indent,
          startOnNewline: !key || key.type === "block-scalar"
        });
        offset = valueProps.end;
        if (valueProps.found) {
          if (implicitKey) {
            if (value?.type === "block-map" && !valueProps.hasNewline)
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
            if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
              onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep2, null, valueProps, onError);
          if (ctx.schema.compat)
            utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
          offset = valueNode.range[2];
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        } else {
          if (implicitKey)
            onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
          if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        }
      }
      if (commentEnd && commentEnd < offset)
        onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
      map.range = [bm.offset, offset, commentEnd ?? offset];
      return map;
    }
    exports.resolveBlockMap = resolveBlockMap;
  }
});

// node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-seq.js"(exports) {
    "use strict";
    var YAMLSeq = require_YAMLSeq();
    var resolveProps = require_resolve_props();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
      const seq = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = bs.offset;
      let commentEnd = null;
      for (const { start, value } of bs.items) {
        const props = resolveProps.resolveProps(start, {
          indicator: "seq-item-ind",
          next: value,
          offset,
          onError,
          parentIndent: bs.indent,
          startOnNewline: true
        });
        if (!props.found) {
          if (props.anchor || props.tag || value) {
            if (value?.type === "block-seq")
              onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
            else
              onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
          } else {
            commentEnd = props.end;
            if (props.comment)
              seq.comment = props.comment;
            continue;
          }
        }
        const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
        offset = node.range[2];
        seq.items.push(node);
      }
      seq.range = [bs.offset, offset, commentEnd ?? offset];
      return seq;
    }
    exports.resolveBlockSeq = resolveBlockSeq;
  }
});

// node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = __commonJS({
  "node_modules/yaml/dist/compose/resolve-end.js"(exports) {
    "use strict";
    function resolveEnd(end, offset, reqSpace, onError) {
      let comment = "";
      if (end) {
        let hasSpace = false;
        let sep2 = "";
        for (const token of end) {
          const { source, type } = token;
          switch (type) {
            case "space":
              hasSpace = true;
              break;
            case "comment": {
              if (reqSpace && !hasSpace)
                onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
              const cb = source.substring(1) || " ";
              if (!comment)
                comment = cb;
              else
                comment += sep2 + cb;
              sep2 = "";
              break;
            }
            case "newline":
              if (comment)
                sep2 += source;
              hasSpace = true;
              break;
            default:
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
          }
          offset += source.length;
        }
      }
      return { comment, offset };
    }
    exports.resolveEnd = resolveEnd;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-collection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilMapIncludes = require_util_map_includes();
    var blockMsg = "Block collections are not allowed within flow collections";
    var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
    function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
      const isMap2 = fc.start.source === "{";
      const fcName = isMap2 ? "flow map" : "flow sequence";
      const NodeClass = tag?.nodeClass ?? (isMap2 ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
      const coll = new NodeClass(ctx.schema);
      coll.flow = true;
      const atRoot = ctx.atRoot;
      if (atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = fc.offset + fc.start.source.length;
      for (let i = 0; i < fc.items.length; ++i) {
        const collItem = fc.items[i];
        const { start, key, sep: sep2, value } = collItem;
        const props = resolveProps.resolveProps(start, {
          flow: fcName,
          indicator: "explicit-key-ind",
          next: key ?? sep2?.[0],
          offset,
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (!props.found) {
          if (!props.anchor && !props.tag && !sep2 && !value) {
            if (i === 0 && props.comma)
              onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
            else if (i < fc.items.length - 1)
              onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
            if (props.comment) {
              if (coll.comment)
                coll.comment += "\n" + props.comment;
              else
                coll.comment = props.comment;
            }
            offset = props.end;
            continue;
          }
          if (!isMap2 && ctx.options.strict && utilContainsNewline.containsNewline(key))
            onError(
              key,
              // checked by containsNewline()
              "MULTILINE_IMPLICIT_KEY",
              "Implicit keys of flow sequence pairs need to be on a single line"
            );
        }
        if (i === 0) {
          if (props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        } else {
          if (!props.comma)
            onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
          if (props.comment) {
            let prevItemComment = "";
            loop: for (const st of start) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
            if (prevItemComment) {
              let prev = coll.items[coll.items.length - 1];
              if (identity.isPair(prev))
                prev = prev.value ?? prev.key;
              if (prev.comment)
                prev.comment += "\n" + prevItemComment;
              else
                prev.comment = prevItemComment;
              props.comment = props.comment.substring(prevItemComment.length + 1);
            }
          }
        }
        if (!isMap2 && !sep2 && !props.found) {
          const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep2, null, props, onError);
          coll.items.push(valueNode);
          offset = valueNode.range[2];
          if (isBlock(value))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else {
          ctx.atKey = true;
          const keyStart = props.end;
          const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
          if (isBlock(key))
            onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
          ctx.atKey = false;
          const valueProps = resolveProps.resolveProps(sep2 ?? [], {
            flow: fcName,
            indicator: "map-value-ind",
            next: value,
            offset: keyNode.range[2],
            onError,
            parentIndent: fc.indent,
            startOnNewline: false
          });
          if (valueProps.found) {
            if (!isMap2 && !props.found && ctx.options.strict) {
              if (sep2)
                for (const st of sep2) {
                  if (st === valueProps.found)
                    break;
                  if (st.type === "newline") {
                    onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                    break;
                  }
                }
              if (props.start < valueProps.found.offset - 1024)
                onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
            }
          } else if (value) {
            if ("source" in value && value.source?.[0] === ":")
              onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
            else
              onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep2, null, valueProps, onError) : null;
          if (valueNode) {
            if (isBlock(value))
              onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
          } else if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          if (isMap2) {
            const map = coll;
            if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
              onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
            map.items.push(pair);
          } else {
            const map = new YAMLMap.YAMLMap(ctx.schema);
            map.flow = true;
            map.items.push(pair);
            const endRange = (valueNode ?? keyNode).range;
            map.range = [keyNode.range[0], endRange[1], endRange[2]];
            coll.items.push(map);
          }
          offset = valueNode ? valueNode.range[2] : valueProps.end;
        }
      }
      const expectedEnd = isMap2 ? "}" : "]";
      const [ce, ...ee] = fc.end;
      let cePos = offset;
      if (ce?.source === expectedEnd)
        cePos = ce.offset + ce.source.length;
      else {
        const name = fcName[0].toUpperCase() + fcName.substring(1);
        const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
        onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
        if (ce && ce.source.length !== 1)
          ee.unshift(ce);
      }
      if (ee.length > 0) {
        const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
        if (end.comment) {
          if (coll.comment)
            coll.comment += "\n" + end.comment;
          else
            coll.comment = end.comment;
        }
        coll.range = [fc.offset, cePos, end.offset];
      } else {
        coll.range = [fc.offset, cePos, cePos];
      }
      return coll;
    }
    exports.resolveFlowCollection = resolveFlowCollection;
  }
});

// node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = __commonJS({
  "node_modules/yaml/dist/compose/compose-collection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveBlockMap = require_resolve_block_map();
    var resolveBlockSeq = require_resolve_block_seq();
    var resolveFlowCollection = require_resolve_flow_collection();
    function resolveCollection(CN, ctx, token, onError, tagName, tag) {
      const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag);
      const Coll = coll.constructor;
      if (tagName === "!" || tagName === Coll.tagName) {
        coll.tag = Coll.tagName;
        return coll;
      }
      if (tagName)
        coll.tag = tagName;
      return coll;
    }
    function composeCollection(CN, ctx, token, props, onError) {
      const tagToken = props.tag;
      const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
      if (token.type === "block-seq") {
        const { anchor, newlineAfterProp: nl } = props;
        const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
        if (lastProp && (!nl || nl.offset < lastProp.offset)) {
          const message = "Missing newline after block sequence props";
          onError(lastProp, "MISSING_CHAR", message);
        }
      }
      const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
      if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
        return resolveCollection(CN, ctx, token, onError, tagName);
      }
      let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
      if (!tag) {
        const kt = ctx.schema.knownTags[tagName];
        if (kt?.collection === expType) {
          ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
          tag = kt;
        } else {
          if (kt) {
            onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
          } else {
            onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
          }
          return resolveCollection(CN, ctx, token, onError, tagName);
        }
      }
      const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
      const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
      const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
      node.range = coll.range;
      node.tag = tagName;
      if (tag?.format)
        node.format = tag.format;
      return node;
    }
    exports.composeCollection = composeCollection;
  }
});

// node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-scalar.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    function resolveBlockScalar(ctx, scalar, onError) {
      const start = scalar.offset;
      const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
      if (!header)
        return { value: "", type: null, comment: "", range: [start, start, start] };
      const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
      const lines = scalar.source ? splitLines(scalar.source) : [];
      let chompStart = lines.length;
      for (let i = lines.length - 1; i >= 0; --i) {
        const content = lines[i][1];
        if (content === "" || content === "\r")
          chompStart = i;
        else
          break;
      }
      if (chompStart === 0) {
        const value2 = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
        let end2 = start + header.length;
        if (scalar.source)
          end2 += scalar.source.length;
        return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
      }
      let trimIndent = scalar.indent + header.indent;
      let offset = scalar.offset + header.length;
      let contentStart = 0;
      for (let i = 0; i < chompStart; ++i) {
        const [indent, content] = lines[i];
        if (content === "" || content === "\r") {
          if (header.indent === 0 && indent.length > trimIndent)
            trimIndent = indent.length;
        } else {
          if (indent.length < trimIndent) {
            const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
            onError(offset + indent.length, "MISSING_CHAR", message);
          }
          if (header.indent === 0)
            trimIndent = indent.length;
          contentStart = i;
          if (trimIndent === 0 && !ctx.atRoot) {
            const message = "Block scalar values in collections must be indented";
            onError(offset, "BAD_INDENT", message);
          }
          break;
        }
        offset += indent.length + content.length + 1;
      }
      for (let i = lines.length - 1; i >= chompStart; --i) {
        if (lines[i][0].length > trimIndent)
          chompStart = i + 1;
      }
      let value = "";
      let sep2 = "";
      let prevMoreIndented = false;
      for (let i = 0; i < contentStart; ++i)
        value += lines[i][0].slice(trimIndent) + "\n";
      for (let i = contentStart; i < chompStart; ++i) {
        let [indent, content] = lines[i];
        offset += indent.length + content.length + 1;
        const crlf = content[content.length - 1] === "\r";
        if (crlf)
          content = content.slice(0, -1);
        if (content && indent.length < trimIndent) {
          const src = header.indent ? "explicit indentation indicator" : "first line";
          const message = `Block scalar lines must not be less indented than their ${src}`;
          onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
          indent = "";
        }
        if (type === Scalar.Scalar.BLOCK_LITERAL) {
          value += sep2 + indent.slice(trimIndent) + content;
          sep2 = "\n";
        } else if (indent.length > trimIndent || content[0] === "	") {
          if (sep2 === " ")
            sep2 = "\n";
          else if (!prevMoreIndented && sep2 === "\n")
            sep2 = "\n\n";
          value += sep2 + indent.slice(trimIndent) + content;
          sep2 = "\n";
          prevMoreIndented = true;
        } else if (content === "") {
          if (sep2 === "\n")
            value += "\n";
          else
            sep2 = "\n";
        } else {
          value += sep2 + content;
          sep2 = " ";
          prevMoreIndented = false;
        }
      }
      switch (header.chomp) {
        case "-":
          break;
        case "+":
          for (let i = chompStart; i < lines.length; ++i)
            value += "\n" + lines[i][0].slice(trimIndent);
          if (value[value.length - 1] !== "\n")
            value += "\n";
          break;
        default:
          value += "\n";
      }
      const end = start + header.length + scalar.source.length;
      return { value, type, comment: header.comment, range: [start, end, end] };
    }
    function parseBlockScalarHeader({ offset, props }, strict, onError) {
      if (props[0].type !== "block-scalar-header") {
        onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
        return null;
      }
      const { source } = props[0];
      const mode = source[0];
      let indent = 0;
      let chomp = "";
      let error = -1;
      for (let i = 1; i < source.length; ++i) {
        const ch = source[i];
        if (!chomp && (ch === "-" || ch === "+"))
          chomp = ch;
        else {
          const n = Number(ch);
          if (!indent && n)
            indent = n;
          else if (error === -1)
            error = offset + i;
        }
      }
      if (error !== -1)
        onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
      let hasSpace = false;
      let comment = "";
      let length = source.length;
      for (let i = 1; i < props.length; ++i) {
        const token = props[i];
        switch (token.type) {
          case "space":
            hasSpace = true;
          // fallthrough
          case "newline":
            length += token.source.length;
            break;
          case "comment":
            if (strict && !hasSpace) {
              const message = "Comments must be separated from other tokens by white space characters";
              onError(token, "MISSING_CHAR", message);
            }
            length += token.source.length;
            comment = token.source.substring(1);
            break;
          case "error":
            onError(token, "UNEXPECTED_TOKEN", token.message);
            length += token.source.length;
            break;
          /* istanbul ignore next should not happen */
          default: {
            const message = `Unexpected token in block scalar header: ${token.type}`;
            onError(token, "UNEXPECTED_TOKEN", message);
            const ts = token.source;
            if (ts && typeof ts === "string")
              length += ts.length;
          }
        }
      }
      return { mode, indent, chomp, comment, length };
    }
    function splitLines(source) {
      const split = source.split(/\n( *)/);
      const first = split[0];
      const m = first.match(/^( *)/);
      const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
      const lines = [line0];
      for (let i = 1; i < split.length; i += 2)
        lines.push([split[i], split[i + 1]]);
      return lines;
    }
    exports.resolveBlockScalar = resolveBlockScalar;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-scalar.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var resolveEnd = require_resolve_end();
    function resolveFlowScalar(scalar, strict, onError) {
      const { offset, type, source, end } = scalar;
      let _type;
      let value;
      const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
      switch (type) {
        case "scalar":
          _type = Scalar.Scalar.PLAIN;
          value = plainValue(source, _onError);
          break;
        case "single-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_SINGLE;
          value = singleQuotedValue(source, _onError);
          break;
        case "double-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_DOUBLE;
          value = doubleQuotedValue(source, _onError);
          break;
        /* istanbul ignore next should not happen */
        default:
          onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
          return {
            value: "",
            type: null,
            comment: "",
            range: [offset, offset + source.length, offset + source.length]
          };
      }
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
      return {
        value,
        type: _type,
        comment: re.comment,
        range: [offset, valueEnd, re.offset]
      };
    }
    function plainValue(source, onError) {
      let badChar = "";
      switch (source[0]) {
        /* istanbul ignore next should not happen */
        case "	":
          badChar = "a tab character";
          break;
        case ",":
          badChar = "flow indicator character ,";
          break;
        case "%":
          badChar = "directive indicator character %";
          break;
        case "|":
        case ">": {
          badChar = `block scalar indicator ${source[0]}`;
          break;
        }
        case "@":
        case "`": {
          badChar = `reserved character ${source[0]}`;
          break;
        }
      }
      if (badChar)
        onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
      return unfoldLines(source);
    }
    function singleQuotedValue(source, onError) {
      if (source[source.length - 1] !== "'" || source.length === 1)
        onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
      return unfoldLines(source.slice(1, -1)).replace(/''/g, "'");
    }
    function unfoldLines(source) {
      const line = /(.*?)\r?\n/sy;
      let match = line.exec(source);
      if (!match)
        return source;
      let trimEnd, trimBoth;
      try {
        trimEnd = new RegExp("(?<![ 	])[ 	]+$");
        trimBoth = new RegExp("^[ 	]+|(?<![ 	])[ 	]+$", "g");
      } catch {
        trimEnd = /[ \t]+$/;
        trimBoth = /^[ \t]+|[ \t]+$/g;
      }
      let res = match[1].replace(trimEnd, "");
      let sep2 = " ";
      let pos = line.lastIndex;
      while (match = line.exec(source)) {
        const lm = match[1].replace(trimBoth, "");
        if (lm === "") {
          if (sep2 === "\n")
            res += sep2;
          else
            sep2 = "\n";
        } else {
          res += sep2 + lm;
          sep2 = " ";
        }
        pos = line.lastIndex;
      }
      const last = /[ \t]*(.*)/sy;
      last.lastIndex = pos;
      match = last.exec(source);
      return res + sep2 + (match?.[1] ?? "");
    }
    function doubleQuotedValue(source, onError) {
      let res = "";
      for (let i = 1; i < source.length - 1; ++i) {
        const ch = source[i];
        if (ch === "\r" && source[i + 1] === "\n")
          continue;
        if (ch === "\n") {
          const { fold, offset } = foldNewline(source, i);
          res += fold;
          i = offset;
        } else if (ch === "\\") {
          let next = source[++i];
          const cc = escapeCodes[next];
          if (cc)
            res += cc;
          else if (next === "\n") {
            next = source[i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "\r" && source[i + 1] === "\n") {
            next = source[++i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "x" || next === "u" || next === "U") {
            const length = next === "x" ? 2 : next === "u" ? 4 : 8;
            res += parseCharCode(source, i + 1, length, onError);
            i += length;
          } else {
            const raw = source.substr(i - 1, 2);
            onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
            res += raw;
          }
        } else if (ch === " " || ch === "	") {
          const wsStart = i;
          let next = source[i + 1];
          while (next === " " || next === "	")
            next = source[++i + 1];
          if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n"))
            res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
        } else {
          res += ch;
        }
      }
      if (source[source.length - 1] !== '"' || source.length === 1)
        onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
      return res;
    }
    function foldNewline(source, offset) {
      let fold = "";
      let ch = source[offset + 1];
      while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
        if (ch === "\r" && source[offset + 2] !== "\n")
          break;
        if (ch === "\n")
          fold += "\n";
        offset += 1;
        ch = source[offset + 1];
      }
      if (!fold)
        fold = " ";
      return { fold, offset };
    }
    var escapeCodes = {
      "0": "\0",
      // null character
      a: "\x07",
      // bell character
      b: "\b",
      // backspace
      e: "\x1B",
      // escape character
      f: "\f",
      // form feed
      n: "\n",
      // line feed
      r: "\r",
      // carriage return
      t: "	",
      // horizontal tab
      v: "\v",
      // vertical tab
      N: "\x85",
      // Unicode next line
      _: "\xA0",
      // Unicode non-breaking space
      L: "\u2028",
      // Unicode line separator
      P: "\u2029",
      // Unicode paragraph separator
      " ": " ",
      '"': '"',
      "/": "/",
      "\\": "\\",
      "	": "	"
    };
    function parseCharCode(source, offset, length, onError) {
      const cc = source.substr(offset, length);
      const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
      const code = ok ? parseInt(cc, 16) : NaN;
      try {
        return String.fromCodePoint(code);
      } catch {
        const raw = source.substr(offset - 2, length + 2);
        onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        return raw;
      }
    }
    exports.resolveFlowScalar = resolveFlowScalar;
  }
});

// node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = __commonJS({
  "node_modules/yaml/dist/compose/compose-scalar.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    function composeScalar(ctx, token, tagToken, onError) {
      const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
      const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
      let tag;
      if (ctx.options.stringKeys && ctx.atKey) {
        tag = ctx.schema[identity.SCALAR];
      } else if (tagName)
        tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
      else if (token.type === "scalar")
        tag = findScalarTagByTest(ctx, value, token, onError);
      else
        tag = ctx.schema[identity.SCALAR];
      let scalar;
      try {
        const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
        scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
        scalar = new Scalar.Scalar(value);
      }
      scalar.range = range;
      scalar.source = value;
      if (type)
        scalar.type = type;
      if (tagName)
        scalar.tag = tagName;
      if (tag.format)
        scalar.format = tag.format;
      if (comment)
        scalar.comment = comment;
      return scalar;
    }
    function findScalarTagByName(schema, value, tagName, tagToken, onError) {
      if (tagName === "!")
        return schema[identity.SCALAR];
      const matchWithTest = [];
      for (const tag of schema.tags) {
        if (!tag.collection && tag.tag === tagName) {
          if (tag.default && tag.test)
            matchWithTest.push(tag);
          else
            return tag;
        }
      }
      for (const tag of matchWithTest)
        if (tag.test?.test(value))
          return tag;
      const kt = schema.knownTags[tagName];
      if (kt && !kt.collection) {
        schema.tags.push(Object.assign({}, kt, { default: false, test: void 0 }));
        return kt;
      }
      onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
      return schema[identity.SCALAR];
    }
    function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
      const tag = schema.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema[identity.SCALAR];
      if (schema.compat) {
        const compat = schema.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema[identity.SCALAR];
        if (tag.tag !== compat.tag) {
          const ts = directives.tagString(tag.tag);
          const cs = directives.tagString(compat.tag);
          const msg = `Value may be parsed as either ${ts} or ${cs}`;
          onError(token, "TAG_RESOLVE_FAILED", msg, true);
        }
      }
      return tag;
    }
    exports.composeScalar = composeScalar;
  }
});

// node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = __commonJS({
  "node_modules/yaml/dist/compose/util-empty-scalar-position.js"(exports) {
    "use strict";
    function emptyScalarPosition(offset, before, pos) {
      if (before) {
        pos ?? (pos = before.length);
        for (let i = pos - 1; i >= 0; --i) {
          let st = before[i];
          switch (st.type) {
            case "space":
            case "comment":
            case "newline":
              offset -= st.source.length;
              continue;
          }
          st = before[++i];
          while (st?.type === "space") {
            offset += st.source.length;
            st = before[++i];
          }
          break;
        }
      }
      return offset;
    }
    exports.emptyScalarPosition = emptyScalarPosition;
  }
});

// node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = __commonJS({
  "node_modules/yaml/dist/compose/compose-node.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var composeCollection = require_compose_collection();
    var composeScalar = require_compose_scalar();
    var resolveEnd = require_resolve_end();
    var utilEmptyScalarPosition = require_util_empty_scalar_position();
    var CN = { composeNode, composeEmptyNode };
    function composeNode(ctx, token, props, onError) {
      const atKey = ctx.atKey;
      const { spaceBefore, comment, anchor, tag } = props;
      let node;
      let isSrcToken = true;
      switch (token.type) {
        case "alias":
          node = composeAlias(ctx, token, onError);
          if (anchor || tag)
            onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
          break;
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "block-scalar":
          node = composeScalar.composeScalar(ctx, token, tag, onError);
          if (anchor)
            node.anchor = anchor.source.substring(1);
          break;
        case "block-map":
        case "block-seq":
        case "flow-collection":
          try {
            node = composeCollection.composeCollection(CN, ctx, token, props, onError);
            if (anchor)
              node.anchor = anchor.source.substring(1);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            onError(token, "RESOURCE_EXHAUSTION", message);
          }
          break;
        default: {
          const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
          onError(token, "UNEXPECTED_TOKEN", message);
          isSrcToken = false;
        }
      }
      node ?? (node = composeEmptyNode(ctx, token.offset, void 0, null, props, onError));
      if (anchor && node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
        const msg = "With stringKeys, all keys must be strings";
        onError(tag ?? token, "NON_STRING_KEY", msg);
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        if (token.type === "scalar" && token.source === "")
          node.comment = comment;
        else
          node.commentBefore = comment;
      }
      if (ctx.options.keepSourceTokens && isSrcToken)
        node.srcToken = token;
      return node;
    }
    function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
      const token = {
        type: "scalar",
        offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
        indent: -1,
        source: ""
      };
      const node = composeScalar.composeScalar(ctx, token, tag, onError);
      if (anchor) {
        node.anchor = anchor.source.substring(1);
        if (node.anchor === "")
          onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        node.comment = comment;
        node.range[2] = end;
      }
      return node;
    }
    function composeAlias({ options }, { offset, source, end }, onError) {
      const alias = new Alias.Alias(source.substring(1));
      if (alias.source === "")
        onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
      if (alias.source.endsWith(":"))
        onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
      alias.range = [offset, valueEnd, re.offset];
      if (re.comment)
        alias.comment = re.comment;
      return alias;
    }
    exports.composeEmptyNode = composeEmptyNode;
    exports.composeNode = composeNode;
  }
});

// node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = __commonJS({
  "node_modules/yaml/dist/compose/compose-doc.js"(exports) {
    "use strict";
    var Document = require_Document();
    var composeNode = require_compose_node();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    function composeDoc(options, directives, { offset, start, value, end }, onError) {
      const opts = Object.assign({ _directives: directives }, options);
      const doc = new Document.Document(void 0, opts);
      const ctx = {
        atKey: false,
        atRoot: true,
        directives: doc.directives,
        options: doc.options,
        schema: doc.schema
      };
      const props = resolveProps.resolveProps(start, {
        indicator: "doc-start",
        next: value ?? end?.[0],
        offset,
        onError,
        parentIndent: 0,
        startOnNewline: true
      });
      if (props.found) {
        doc.directives.docStart = true;
        if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
          onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
      }
      doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
      const contentEnd = doc.contents.range[2];
      const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
      if (re.comment)
        doc.comment = re.comment;
      doc.range = [offset, contentEnd, re.offset];
      return doc;
    }
    exports.composeDoc = composeDoc;
  }
});

// node_modules/yaml/dist/compose/composer.js
var require_composer = __commonJS({
  "node_modules/yaml/dist/compose/composer.js"(exports) {
    "use strict";
    var node_process = __require("process");
    var directives = require_directives();
    var Document = require_Document();
    var errors = require_errors();
    var identity = require_identity();
    var composeDoc = require_compose_doc();
    var resolveEnd = require_resolve_end();
    function getErrorPos(src) {
      if (typeof src === "number")
        return [src, src + 1];
      if (Array.isArray(src))
        return src.length === 2 ? src : [src[0], src[1]];
      const { offset, source } = src;
      return [offset, offset + (typeof source === "string" ? source.length : 1)];
    }
    function parsePrelude(prelude) {
      let comment = "";
      let atComment = false;
      let afterEmptyLine = false;
      for (let i = 0; i < prelude.length; ++i) {
        const source = prelude[i];
        switch (source[0]) {
          case "#":
            comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
            atComment = true;
            afterEmptyLine = false;
            break;
          case "%":
            if (prelude[i + 1]?.[0] !== "#")
              i += 1;
            atComment = false;
            break;
          default:
            if (!atComment)
              afterEmptyLine = true;
            atComment = false;
        }
      }
      return { comment, afterEmptyLine };
    }
    var Composer = class {
      constructor(options = {}) {
        this.doc = null;
        this.atDirectives = false;
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
        this.onError = (source, code, message, warning) => {
          const pos = getErrorPos(source);
          if (warning)
            this.warnings.push(new errors.YAMLWarning(pos, code, message));
          else
            this.errors.push(new errors.YAMLParseError(pos, code, message));
        };
        this.directives = new directives.Directives({ version: options.version || "1.2" });
        this.options = options;
      }
      decorate(doc, afterDoc) {
        const { comment, afterEmptyLine } = parsePrelude(this.prelude);
        if (comment) {
          const dc = doc.contents;
          if (afterDoc) {
            doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
          } else if (afterEmptyLine || doc.directives.docStart || !dc) {
            doc.commentBefore = comment;
          } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
            let it = dc.items[0];
            if (identity.isPair(it))
              it = it.key;
            const cb = it.commentBefore;
            it.commentBefore = cb ? `${comment}
${cb}` : comment;
          } else {
            const cb = dc.commentBefore;
            dc.commentBefore = cb ? `${comment}
${cb}` : comment;
          }
        }
        if (afterDoc) {
          for (let i = 0; i < this.errors.length; ++i)
            doc.errors.push(this.errors[i]);
          for (let i = 0; i < this.warnings.length; ++i)
            doc.warnings.push(this.warnings[i]);
        } else {
          doc.errors = this.errors;
          doc.warnings = this.warnings;
        }
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
      }
      /**
       * Current stream status information.
       *
       * Mostly useful at the end of input for an empty stream.
       */
      streamInfo() {
        return {
          comment: parsePrelude(this.prelude).comment,
          directives: this.directives,
          errors: this.errors,
          warnings: this.warnings
        };
      }
      /**
       * Compose tokens into documents.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *compose(tokens, forceDoc = false, endOffset = -1) {
        for (const token of tokens)
          yield* this.next(token);
        yield* this.end(forceDoc, endOffset);
      }
      /** Advance the composer by one CST token. */
      *next(token) {
        if (node_process.env.LOG_STREAM)
          console.dir(token, { depth: null });
        switch (token.type) {
          case "directive":
            this.directives.add(token.source, (offset, message, warning) => {
              const pos = getErrorPos(token);
              pos[0] += offset;
              this.onError(pos, "BAD_DIRECTIVE", message, warning);
            });
            this.prelude.push(token.source);
            this.atDirectives = true;
            break;
          case "document": {
            const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
            if (this.atDirectives && !doc.directives.docStart)
              this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
            this.decorate(doc, false);
            if (this.doc)
              yield this.doc;
            this.doc = doc;
            this.atDirectives = false;
            break;
          }
          case "byte-order-mark":
          case "space":
            break;
          case "comment":
          case "newline":
            this.prelude.push(token.source);
            break;
          case "error": {
            const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
            const error = new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
            if (this.atDirectives || !this.doc)
              this.errors.push(error);
            else
              this.doc.errors.push(error);
            break;
          }
          case "doc-end": {
            if (!this.doc) {
              const msg = "Unexpected doc-end without preceding document";
              this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
              break;
            }
            this.doc.directives.docEnd = true;
            const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
            this.decorate(this.doc, true);
            if (end.comment) {
              const dc = this.doc.comment;
              this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
            }
            this.doc.range[2] = end.offset;
            break;
          }
          default:
            this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
        }
      }
      /**
       * Call at end of input to yield any remaining document.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *end(forceDoc = false, endOffset = -1) {
        if (this.doc) {
          this.decorate(this.doc, true);
          yield this.doc;
          this.doc = null;
        } else if (forceDoc) {
          const opts = Object.assign({ _directives: this.directives }, this.options);
          const doc = new Document.Document(void 0, opts);
          if (this.atDirectives)
            this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
          doc.range = [0, endOffset, endOffset];
          this.decorate(doc, false);
          yield doc;
        }
      }
    };
    exports.Composer = Composer;
  }
});

// node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = __commonJS({
  "node_modules/yaml/dist/parse/cst-scalar.js"(exports) {
    "use strict";
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    var errors = require_errors();
    var stringifyString = require_stringifyString();
    function resolveAsScalar(token, strict = true, onError) {
      if (token) {
        const _onError = (pos, code, message) => {
          const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
          if (onError)
            onError(offset, code, message);
          else
            throw new errors.YAMLParseError([offset, offset + 1], code, message);
        };
        switch (token.type) {
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
          case "block-scalar":
            return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
        }
      }
      return null;
    }
    function createScalarToken(value, context) {
      const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey,
        indent: indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      const end = context.end ?? [
        { type: "newline", offset: -1, indent, source: "\n" }
      ];
      switch (source[0]) {
        case "|":
        case ">": {
          const he = source.indexOf("\n");
          const head = source.substring(0, he);
          const body = source.substring(he + 1) + "\n";
          const props = [
            { type: "block-scalar-header", offset, indent, source: head }
          ];
          if (!addEndtoBlockProps(props, end))
            props.push({ type: "newline", offset: -1, indent, source: "\n" });
          return { type: "block-scalar", offset, indent, props, source: body };
        }
        case '"':
          return { type: "double-quoted-scalar", offset, indent, source, end };
        case "'":
          return { type: "single-quoted-scalar", offset, indent, source, end };
        default:
          return { type: "scalar", offset, indent, source, end };
      }
    }
    function setScalarValue(token, value, context = {}) {
      let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
      let indent = "indent" in token ? token.indent : null;
      if (afterKey && typeof indent === "number")
        indent += 2;
      if (!type)
        switch (token.type) {
          case "single-quoted-scalar":
            type = "QUOTE_SINGLE";
            break;
          case "double-quoted-scalar":
            type = "QUOTE_DOUBLE";
            break;
          case "block-scalar": {
            const header = token.props[0];
            if (header.type !== "block-scalar-header")
              throw new Error("Invalid block scalar header");
            type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
            break;
          }
          default:
            type = "PLAIN";
        }
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey: implicitKey || indent === null,
        indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      switch (source[0]) {
        case "|":
        case ">":
          setBlockScalarValue(token, source);
          break;
        case '"':
          setFlowScalarValue(token, source, "double-quoted-scalar");
          break;
        case "'":
          setFlowScalarValue(token, source, "single-quoted-scalar");
          break;
        default:
          setFlowScalarValue(token, source, "scalar");
      }
    }
    function setBlockScalarValue(token, source) {
      const he = source.indexOf("\n");
      const head = source.substring(0, he);
      const body = source.substring(he + 1) + "\n";
      if (token.type === "block-scalar") {
        const header = token.props[0];
        if (header.type !== "block-scalar-header")
          throw new Error("Invalid block scalar header");
        header.source = head;
        token.source = body;
      } else {
        const { offset } = token;
        const indent = "indent" in token ? token.indent : -1;
        const props = [
          { type: "block-scalar-header", offset, indent, source: head }
        ];
        if (!addEndtoBlockProps(props, "end" in token ? token.end : void 0))
          props.push({ type: "newline", offset: -1, indent, source: "\n" });
        for (const key of Object.keys(token))
          if (key !== "type" && key !== "offset")
            delete token[key];
        Object.assign(token, { type: "block-scalar", indent, props, source: body });
      }
    }
    function addEndtoBlockProps(props, end) {
      if (end)
        for (const st of end)
          switch (st.type) {
            case "space":
            case "comment":
              props.push(st);
              break;
            case "newline":
              props.push(st);
              return true;
          }
      return false;
    }
    function setFlowScalarValue(token, source, type) {
      switch (token.type) {
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          token.type = type;
          token.source = source;
          break;
        case "block-scalar": {
          const end = token.props.slice(1);
          let oa = source.length;
          if (token.props[0].type === "block-scalar-header")
            oa -= token.props[0].source.length;
          for (const tok of end)
            tok.offset += oa;
          delete token.props;
          Object.assign(token, { type, source, end });
          break;
        }
        case "block-map":
        case "block-seq": {
          const offset = token.offset + source.length;
          const nl = { type: "newline", offset, indent: token.indent, source: "\n" };
          delete token.items;
          Object.assign(token, { type, source, end: [nl] });
          break;
        }
        default: {
          const indent = "indent" in token ? token.indent : -1;
          const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
          for (const key of Object.keys(token))
            if (key !== "type" && key !== "offset")
              delete token[key];
          Object.assign(token, { type, indent, source, end });
        }
      }
    }
    exports.createScalarToken = createScalarToken;
    exports.resolveAsScalar = resolveAsScalar;
    exports.setScalarValue = setScalarValue;
  }
});

// node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = __commonJS({
  "node_modules/yaml/dist/parse/cst-stringify.js"(exports) {
    "use strict";
    var stringify3 = (cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst);
    function stringifyToken(token) {
      switch (token.type) {
        case "block-scalar": {
          let res = "";
          for (const tok of token.props)
            res += stringifyToken(tok);
          return res + token.source;
        }
        case "block-map":
        case "block-seq": {
          let res = "";
          for (const item of token.items)
            res += stringifyItem(item);
          return res;
        }
        case "flow-collection": {
          let res = token.start.source;
          for (const item of token.items)
            res += stringifyItem(item);
          for (const st of token.end)
            res += st.source;
          return res;
        }
        case "document": {
          let res = stringifyItem(token);
          if (token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
        default: {
          let res = token.source;
          if ("end" in token && token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
      }
    }
    function stringifyItem({ start, key, sep: sep2, value }) {
      let res = "";
      for (const st of start)
        res += st.source;
      if (key)
        res += stringifyToken(key);
      if (sep2)
        for (const st of sep2)
          res += st.source;
      if (value)
        res += stringifyToken(value);
      return res;
    }
    exports.stringify = stringify3;
  }
});

// node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS({
  "node_modules/yaml/dist/parse/cst-visit.js"(exports) {
    "use strict";
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove item");
    function visit2(cst, visitor) {
      if ("type" in cst && cst.type === "document")
        cst = { start: cst.start, value: cst.value };
      _visit(Object.freeze([]), cst, visitor);
    }
    visit2.BREAK = BREAK;
    visit2.SKIP = SKIP;
    visit2.REMOVE = REMOVE;
    visit2.itemAtPath = (cst, path) => {
      let item = cst;
      for (const [field, index] of path) {
        const tok = item?.[field];
        if (tok && "items" in tok) {
          item = tok.items[index];
        } else
          return void 0;
      }
      return item;
    };
    visit2.parentCollection = (cst, path) => {
      const parent = visit2.itemAtPath(cst, path.slice(0, -1));
      const field = path[path.length - 1][0];
      const coll = parent?.[field];
      if (coll && "items" in coll)
        return coll;
      throw new Error("Parent collection not found");
    };
    function _visit(path, item, visitor) {
      let ctrl = visitor(item, path);
      if (typeof ctrl === "symbol")
        return ctrl;
      for (const field of ["key", "value"]) {
        const token = item[field];
        if (token && "items" in token) {
          for (let i = 0; i < token.items.length; ++i) {
            const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              token.items.splice(i, 1);
              i -= 1;
            }
          }
          if (typeof ctrl === "function" && field === "key")
            ctrl = ctrl(item, path);
        }
      }
      return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
    }
    exports.visit = visit2;
  }
});

// node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS({
  "node_modules/yaml/dist/parse/cst.js"(exports) {
    "use strict";
    var cstScalar = require_cst_scalar();
    var cstStringify = require_cst_stringify();
    var cstVisit = require_cst_visit();
    var BOM = "\uFEFF";
    var DOCUMENT = "";
    var FLOW_END = "";
    var SCALAR = "";
    var isCollection2 = (token) => !!token && "items" in token;
    var isScalar2 = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
    function prettyToken(token) {
      switch (token) {
        case BOM:
          return "<BOM>";
        case DOCUMENT:
          return "<DOC>";
        case FLOW_END:
          return "<FLOW_END>";
        case SCALAR:
          return "<SCALAR>";
        default:
          return JSON.stringify(token);
      }
    }
    function tokenType(source) {
      switch (source) {
        case BOM:
          return "byte-order-mark";
        case DOCUMENT:
          return "doc-mode";
        case FLOW_END:
          return "flow-error-end";
        case SCALAR:
          return "scalar";
        case "---":
          return "doc-start";
        case "...":
          return "doc-end";
        case "":
        case "\n":
        case "\r\n":
          return "newline";
        case "-":
          return "seq-item-ind";
        case "?":
          return "explicit-key-ind";
        case ":":
          return "map-value-ind";
        case "{":
          return "flow-map-start";
        case "}":
          return "flow-map-end";
        case "[":
          return "flow-seq-start";
        case "]":
          return "flow-seq-end";
        case ",":
          return "comma";
      }
      switch (source[0]) {
        case " ":
        case "	":
          return "space";
        case "#":
          return "comment";
        case "%":
          return "directive-line";
        case "*":
          return "alias";
        case "&":
          return "anchor";
        case "!":
          return "tag";
        case "'":
          return "single-quoted-scalar";
        case '"':
          return "double-quoted-scalar";
        case "|":
        case ">":
          return "block-scalar-header";
      }
      return null;
    }
    exports.createScalarToken = cstScalar.createScalarToken;
    exports.resolveAsScalar = cstScalar.resolveAsScalar;
    exports.setScalarValue = cstScalar.setScalarValue;
    exports.stringify = cstStringify.stringify;
    exports.visit = cstVisit.visit;
    exports.BOM = BOM;
    exports.DOCUMENT = DOCUMENT;
    exports.FLOW_END = FLOW_END;
    exports.SCALAR = SCALAR;
    exports.isCollection = isCollection2;
    exports.isScalar = isScalar2;
    exports.prettyToken = prettyToken;
    exports.tokenType = tokenType;
  }
});

// node_modules/yaml/dist/parse/lexer.js
var require_lexer = __commonJS({
  "node_modules/yaml/dist/parse/lexer.js"(exports) {
    "use strict";
    var cst = require_cst();
    function isEmpty(ch) {
      switch (ch) {
        case void 0:
        case " ":
        case "\n":
        case "\r":
        case "	":
          return true;
        default:
          return false;
      }
    }
    var hexDigits = new Set("0123456789ABCDEFabcdef");
    var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
    var flowIndicatorChars = new Set(",[]{}");
    var invalidAnchorChars = new Set(" ,[]{}\n\r	");
    var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
    var Lexer = class {
      constructor() {
        this.atEnd = false;
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        this.buffer = "";
        this.flowKey = false;
        this.flowLevel = 0;
        this.indentNext = 0;
        this.indentValue = 0;
        this.lineEndPos = null;
        this.next = null;
        this.pos = 0;
      }
      /**
       * Generate YAML tokens from the `source` string. If `incomplete`,
       * a part of the last line may be left as a buffer for the next call.
       *
       * @returns A generator of lexical tokens
       */
      *lex(source, incomplete = false) {
        if (source) {
          if (typeof source !== "string")
            throw TypeError("source is not a string");
          this.buffer = this.buffer ? this.buffer + source : source;
          this.lineEndPos = null;
        }
        this.atEnd = !incomplete;
        let next = this.next ?? "stream";
        while (next && (incomplete || this.hasChars(1)))
          next = yield* this.parseNext(next);
      }
      atLineEnd() {
        let i = this.pos;
        let ch = this.buffer[i];
        while (ch === " " || ch === "	")
          ch = this.buffer[++i];
        if (!ch || ch === "#" || ch === "\n")
          return true;
        if (ch === "\r")
          return this.buffer[i + 1] === "\n";
        return false;
      }
      charAt(n) {
        return this.buffer[this.pos + n];
      }
      continueScalar(offset) {
        let ch = this.buffer[offset];
        if (this.indentNext > 0) {
          let indent = 0;
          while (ch === " ")
            ch = this.buffer[++indent + offset];
          if (ch === "\r") {
            const next = this.buffer[indent + offset + 1];
            if (next === "\n" || !next && !this.atEnd)
              return offset + indent + 1;
          }
          return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
        }
        if (ch === "-" || ch === ".") {
          const dt = this.buffer.substr(offset, 3);
          if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
            return -1;
        }
        return offset;
      }
      getLine() {
        let end = this.lineEndPos;
        if (typeof end !== "number" || end !== -1 && end < this.pos) {
          end = this.buffer.indexOf("\n", this.pos);
          this.lineEndPos = end;
        }
        if (end === -1)
          return this.atEnd ? this.buffer.substring(this.pos) : null;
        if (this.buffer[end - 1] === "\r")
          end -= 1;
        return this.buffer.substring(this.pos, end);
      }
      hasChars(n) {
        return this.pos + n <= this.buffer.length;
      }
      setNext(state) {
        this.buffer = this.buffer.substring(this.pos);
        this.pos = 0;
        this.lineEndPos = null;
        this.next = state;
        return null;
      }
      peek(n) {
        return this.buffer.substr(this.pos, n);
      }
      *parseNext(next) {
        switch (next) {
          case "stream":
            return yield* this.parseStream();
          case "line-start":
            return yield* this.parseLineStart();
          case "block-start":
            return yield* this.parseBlockStart();
          case "doc":
            return yield* this.parseDocument();
          case "flow":
            return yield* this.parseFlowCollection();
          case "quoted-scalar":
            return yield* this.parseQuotedScalar();
          case "block-scalar":
            return yield* this.parseBlockScalar();
          case "plain-scalar":
            return yield* this.parsePlainScalar();
        }
      }
      *parseStream() {
        let line = this.getLine();
        if (line === null)
          return this.setNext("stream");
        if (line[0] === cst.BOM) {
          yield* this.pushCount(1);
          line = line.substring(1);
        }
        if (line[0] === "%") {
          let dirEnd = line.length;
          let cs = line.indexOf("#");
          while (cs !== -1) {
            const ch = line[cs - 1];
            if (ch === " " || ch === "	") {
              dirEnd = cs - 1;
              break;
            } else {
              cs = line.indexOf("#", cs + 1);
            }
          }
          while (true) {
            const ch = line[dirEnd - 1];
            if (ch === " " || ch === "	")
              dirEnd -= 1;
            else
              break;
          }
          const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
          yield* this.pushCount(line.length - n);
          this.pushNewline();
          return "stream";
        }
        if (this.atLineEnd()) {
          const sp = yield* this.pushSpaces(true);
          yield* this.pushCount(line.length - sp);
          yield* this.pushNewline();
          return "stream";
        }
        yield cst.DOCUMENT;
        return yield* this.parseLineStart();
      }
      *parseLineStart() {
        const ch = this.charAt(0);
        if (!ch && !this.atEnd)
          return this.setNext("line-start");
        if (ch === "-" || ch === ".") {
          if (!this.atEnd && !this.hasChars(4))
            return this.setNext("line-start");
          const s = this.peek(3);
          if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
            yield* this.pushCount(3);
            this.indentValue = 0;
            this.indentNext = 0;
            return s === "---" ? "doc" : "stream";
          }
        }
        this.indentValue = yield* this.pushSpaces(false);
        if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
          this.indentNext = this.indentValue;
        return yield* this.parseBlockStart();
      }
      *parseBlockStart() {
        const [ch0, ch1] = this.peek(2);
        if (!ch1 && !this.atEnd)
          return this.setNext("block-start");
        if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
          const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
          this.indentNext = this.indentValue + 1;
          this.indentValue += n;
          return "block-start";
        }
        return "doc";
      }
      *parseDocument() {
        yield* this.pushSpaces(true);
        const line = this.getLine();
        if (line === null)
          return this.setNext("doc");
        let n = yield* this.pushIndicators();
        switch (line[n]) {
          case "#":
            yield* this.pushCount(line.length - n);
          // fallthrough
          case void 0:
            yield* this.pushNewline();
            return yield* this.parseLineStart();
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel = 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            return "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "doc";
          case '"':
          case "'":
            return yield* this.parseQuotedScalar();
          case "|":
          case ">":
            n += yield* this.parseBlockScalarHeader();
            n += yield* this.pushSpaces(true);
            yield* this.pushCount(line.length - n);
            yield* this.pushNewline();
            return yield* this.parseBlockScalar();
          default:
            return yield* this.parsePlainScalar();
        }
      }
      *parseFlowCollection() {
        let nl, sp;
        let indent = -1;
        do {
          nl = yield* this.pushNewline();
          if (nl > 0) {
            sp = yield* this.pushSpaces(false);
            this.indentValue = indent = sp;
          } else {
            sp = 0;
          }
          sp += yield* this.pushSpaces(true);
        } while (nl + sp > 0);
        const line = this.getLine();
        if (line === null)
          return this.setNext("flow");
        if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
          const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
          if (!atFlowEndMarker) {
            this.flowLevel = 0;
            yield cst.FLOW_END;
            return yield* this.parseLineStart();
          }
        }
        let n = 0;
        while (line[n] === ",") {
          n += yield* this.pushCount(1);
          n += yield* this.pushSpaces(true);
          this.flowKey = false;
        }
        n += yield* this.pushIndicators();
        switch (line[n]) {
          case void 0:
            return "flow";
          case "#":
            yield* this.pushCount(line.length - n);
            return "flow";
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel += 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            this.flowKey = true;
            this.flowLevel -= 1;
            return this.flowLevel ? "flow" : "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "flow";
          case '"':
          case "'":
            this.flowKey = true;
            return yield* this.parseQuotedScalar();
          case ":": {
            const next = this.charAt(1);
            if (this.flowKey || isEmpty(next) || next === ",") {
              this.flowKey = false;
              yield* this.pushCount(1);
              yield* this.pushSpaces(true);
              return "flow";
            }
          }
          // fallthrough
          default:
            this.flowKey = false;
            return yield* this.parsePlainScalar();
        }
      }
      *parseQuotedScalar() {
        const quote = this.charAt(0);
        let end = this.buffer.indexOf(quote, this.pos + 1);
        if (quote === "'") {
          while (end !== -1 && this.buffer[end + 1] === "'")
            end = this.buffer.indexOf("'", end + 2);
        } else {
          while (end !== -1) {
            let n = 0;
            while (this.buffer[end - 1 - n] === "\\")
              n += 1;
            if (n % 2 === 0)
              break;
            end = this.buffer.indexOf('"', end + 1);
          }
        }
        const qb = this.buffer.substring(0, end);
        let nl = qb.indexOf("\n", this.pos);
        if (nl !== -1) {
          while (nl !== -1) {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = qb.indexOf("\n", cs);
          }
          if (nl !== -1) {
            end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
          }
        }
        if (end === -1) {
          if (!this.atEnd)
            return this.setNext("quoted-scalar");
          end = this.buffer.length;
        }
        yield* this.pushToIndex(end + 1, false);
        return this.flowLevel ? "flow" : "doc";
      }
      *parseBlockScalarHeader() {
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        let i = this.pos;
        while (true) {
          const ch = this.buffer[++i];
          if (ch === "+")
            this.blockScalarKeep = true;
          else if (ch > "0" && ch <= "9")
            this.blockScalarIndent = Number(ch) - 1;
          else if (ch !== "-")
            break;
        }
        return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
      }
      *parseBlockScalar() {
        let nl = this.pos - 1;
        let indent = 0;
        let ch;
        loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent += 1;
              break;
            case "\n":
              nl = i2;
              indent = 0;
              break;
            case "\r": {
              const next = this.buffer[i2 + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === "\n")
                break;
            }
            // fallthrough
            default:
              break loop;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("block-scalar");
        if (indent >= this.indentNext) {
          if (this.blockScalarIndent === -1)
            this.indentNext = indent;
          else {
            this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
          }
          do {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = this.buffer.indexOf("\n", cs);
          } while (nl !== -1);
          if (nl === -1) {
            if (!this.atEnd)
              return this.setNext("block-scalar");
            nl = this.buffer.length;
          }
        }
        let i = nl + 1;
        ch = this.buffer[i];
        while (ch === " ")
          ch = this.buffer[++i];
        if (ch === "	") {
          while (ch === "	" || ch === " " || ch === "\r" || ch === "\n")
            ch = this.buffer[++i];
          nl = i - 1;
        } else if (!this.blockScalarKeep) {
          do {
            let i2 = nl - 1;
            let ch2 = this.buffer[i2];
            if (ch2 === "\r")
              ch2 = this.buffer[--i2];
            const lastChar = i2;
            while (ch2 === " ")
              ch2 = this.buffer[--i2];
            if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent > lastChar)
              nl = i2;
            else
              break;
          } while (true);
        }
        yield cst.SCALAR;
        yield* this.pushToIndex(nl + 1, true);
        return yield* this.parseLineStart();
      }
      *parsePlainScalar() {
        const inFlow = this.flowLevel > 0;
        let end = this.pos - 1;
        let i = this.pos - 1;
        let ch;
        while (ch = this.buffer[++i]) {
          if (ch === ":") {
            const next = this.buffer[i + 1];
            if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
              break;
            end = i;
          } else if (isEmpty(ch)) {
            let next = this.buffer[i + 1];
            if (ch === "\r") {
              if (next === "\n") {
                i += 1;
                ch = "\n";
                next = this.buffer[i + 1];
              } else
                end = i;
            }
            if (next === "#" || inFlow && flowIndicatorChars.has(next))
              break;
            if (ch === "\n") {
              const cs = this.continueScalar(i + 1);
              if (cs === -1)
                break;
              i = Math.max(i, cs - 2);
            }
          } else {
            if (inFlow && flowIndicatorChars.has(ch))
              break;
            end = i;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("plain-scalar");
        yield cst.SCALAR;
        yield* this.pushToIndex(end + 1, true);
        return inFlow ? "flow" : "doc";
      }
      *pushCount(n) {
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos += n;
          return n;
        }
        return 0;
      }
      *pushToIndex(i, allowEmpty) {
        const s = this.buffer.slice(this.pos, i);
        if (s) {
          yield s;
          this.pos += s.length;
          return s.length;
        } else if (allowEmpty)
          yield "";
        return 0;
      }
      *pushIndicators() {
        let n = 0;
        loop: while (true) {
          switch (this.charAt(0)) {
            case "!":
              n += yield* this.pushTag();
              n += yield* this.pushSpaces(true);
              continue loop;
            case "&":
              n += yield* this.pushUntil(isNotAnchorChar);
              n += yield* this.pushSpaces(true);
              continue loop;
            case "-":
            // this is an error
            case "?":
            // this is an error outside flow collections
            case ":": {
              const inFlow = this.flowLevel > 0;
              const ch1 = this.charAt(1);
              if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
                if (!inFlow)
                  this.indentNext = this.indentValue + 1;
                else if (this.flowKey)
                  this.flowKey = false;
                n += yield* this.pushCount(1);
                n += yield* this.pushSpaces(true);
                continue loop;
              }
            }
          }
          break loop;
        }
        return n;
      }
      *pushTag() {
        if (this.charAt(1) === "<") {
          let i = this.pos + 2;
          let ch = this.buffer[i];
          while (!isEmpty(ch) && ch !== ">")
            ch = this.buffer[++i];
          return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
        } else {
          let i = this.pos + 1;
          let ch = this.buffer[i];
          while (ch) {
            if (tagChars.has(ch))
              ch = this.buffer[++i];
            else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
              ch = this.buffer[i += 3];
            } else
              break;
          }
          return yield* this.pushToIndex(i, false);
        }
      }
      *pushNewline() {
        const ch = this.buffer[this.pos];
        if (ch === "\n")
          return yield* this.pushCount(1);
        else if (ch === "\r" && this.charAt(1) === "\n")
          return yield* this.pushCount(2);
        else
          return 0;
      }
      *pushSpaces(allowTabs) {
        let i = this.pos - 1;
        let ch;
        do {
          ch = this.buffer[++i];
        } while (ch === " " || allowTabs && ch === "	");
        const n = i - this.pos;
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos = i;
        }
        return n;
      }
      *pushUntil(test) {
        let i = this.pos;
        let ch = this.buffer[i];
        while (!test(ch))
          ch = this.buffer[++i];
        return yield* this.pushToIndex(i, false);
      }
    };
    exports.Lexer = Lexer;
  }
});

// node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = __commonJS({
  "node_modules/yaml/dist/parse/line-counter.js"(exports) {
    "use strict";
    var LineCounter = class {
      constructor() {
        this.lineStarts = [];
        this.addNewLine = (offset) => this.lineStarts.push(offset);
        this.linePos = (offset) => {
          let low = 0;
          let high = this.lineStarts.length;
          while (low < high) {
            const mid = low + high >> 1;
            if (this.lineStarts[mid] < offset)
              low = mid + 1;
            else
              high = mid;
          }
          if (this.lineStarts[low] === offset)
            return { line: low + 1, col: 1 };
          if (low === 0)
            return { line: 0, col: offset };
          const start = this.lineStarts[low - 1];
          return { line: low, col: offset - start + 1 };
        };
      }
    };
    exports.LineCounter = LineCounter;
  }
});

// node_modules/yaml/dist/parse/parser.js
var require_parser = __commonJS({
  "node_modules/yaml/dist/parse/parser.js"(exports) {
    "use strict";
    var node_process = __require("process");
    var cst = require_cst();
    var lexer = require_lexer();
    function includesToken(list, type) {
      for (let i = 0; i < list.length; ++i)
        if (list[i].type === type)
          return true;
      return false;
    }
    function findNonEmptyIndex(list) {
      for (let i = 0; i < list.length; ++i) {
        switch (list[i].type) {
          case "space":
          case "comment":
          case "newline":
            break;
          default:
            return i;
        }
      }
      return -1;
    }
    function isFlowToken(token) {
      switch (token?.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "flow-collection":
          return true;
        default:
          return false;
      }
    }
    function getPrevProps(parent) {
      switch (parent.type) {
        case "document":
          return parent.start;
        case "block-map": {
          const it = parent.items[parent.items.length - 1];
          return it.sep ?? it.start;
        }
        case "block-seq":
          return parent.items[parent.items.length - 1].start;
        /* istanbul ignore next should not happen */
        default:
          return [];
      }
    }
    function getFirstKeyStartProps(prev) {
      if (prev.length === 0)
        return [];
      let i = prev.length;
      loop: while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
      while (prev[++i]?.type === "space") {
      }
      return prev.splice(i, prev.length);
    }
    function arrayPushArray(target, source) {
      if (source.length < 1e5)
        Array.prototype.push.apply(target, source);
      else
        for (let i = 0; i < source.length; ++i)
          target.push(source[i]);
    }
    function fixFlowSeqItems(fc) {
      if (fc.start.type === "flow-seq-start") {
        for (const it of fc.items) {
          if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
            if (it.key)
              it.value = it.key;
            delete it.key;
            if (isFlowToken(it.value)) {
              if (it.value.end)
                arrayPushArray(it.value.end, it.sep);
              else
                it.value.end = it.sep;
            } else
              arrayPushArray(it.start, it.sep);
            delete it.sep;
          }
        }
      }
    }
    var Parser = class {
      /**
       * @param onNewLine - If defined, called separately with the start position of
       *   each new line (in `parse()`, including the start of input).
       */
      constructor(onNewLine) {
        this.atNewLine = true;
        this.atScalar = false;
        this.indent = 0;
        this.offset = 0;
        this.onKeyLine = false;
        this.stack = [];
        this.source = "";
        this.type = "";
        this.lexer = new lexer.Lexer();
        this.onNewLine = onNewLine;
      }
      /**
       * Parse `source` as a YAML stream.
       * If `incomplete`, a part of the last line may be left as a buffer for the next call.
       *
       * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
       *
       * @returns A generator of tokens representing each directive, document, and other structure.
       */
      *parse(source, incomplete = false) {
        if (this.onNewLine && this.offset === 0)
          this.onNewLine(0);
        for (const lexeme of this.lexer.lex(source, incomplete))
          yield* this.next(lexeme);
        if (!incomplete)
          yield* this.end();
      }
      /**
       * Advance the parser by the `source` of one lexical token.
       */
      *next(source) {
        this.source = source;
        if (node_process.env.LOG_TOKENS)
          console.log("|", cst.prettyToken(source));
        if (this.atScalar) {
          this.atScalar = false;
          yield* this.step();
          this.offset += source.length;
          return;
        }
        const type = cst.tokenType(source);
        if (!type) {
          const message = `Not a YAML token: ${source}`;
          yield* this.pop({ type: "error", offset: this.offset, message, source });
          this.offset += source.length;
        } else if (type === "scalar") {
          this.atNewLine = false;
          this.atScalar = true;
          this.type = "scalar";
        } else {
          this.type = type;
          yield* this.step();
          switch (type) {
            case "newline":
              this.atNewLine = true;
              this.indent = 0;
              if (this.onNewLine)
                this.onNewLine(this.offset + source.length);
              break;
            case "space":
              if (this.atNewLine && source[0] === " ")
                this.indent += source.length;
              break;
            case "explicit-key-ind":
            case "map-value-ind":
            case "seq-item-ind":
              if (this.atNewLine)
                this.indent += source.length;
              break;
            case "doc-mode":
            case "flow-error-end":
              return;
            default:
              this.atNewLine = false;
          }
          this.offset += source.length;
        }
      }
      /** Call at end of input to push out any remaining constructions */
      *end() {
        while (this.stack.length > 0)
          yield* this.pop();
      }
      get sourceToken() {
        const st = {
          type: this.type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
        return st;
      }
      *step() {
        const top = this.peek(1);
        if (this.type === "doc-end" && top?.type !== "doc-end") {
          while (this.stack.length > 0)
            yield* this.pop();
          this.stack.push({
            type: "doc-end",
            offset: this.offset,
            source: this.source
          });
          return;
        }
        if (!top)
          return yield* this.stream();
        switch (top.type) {
          case "document":
            return yield* this.document(top);
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return yield* this.scalar(top);
          case "block-scalar":
            return yield* this.blockScalar(top);
          case "block-map":
            return yield* this.blockMap(top);
          case "block-seq":
            return yield* this.blockSequence(top);
          case "flow-collection":
            return yield* this.flowCollection(top);
          case "doc-end":
            return yield* this.documentEnd(top);
        }
        yield* this.pop();
      }
      peek(n) {
        return this.stack[this.stack.length - n];
      }
      *pop(error) {
        const token = error ?? this.stack.pop();
        if (!token) {
          const message = "Tried to pop an empty stack";
          yield { type: "error", offset: this.offset, source: "", message };
        } else if (this.stack.length === 0) {
          yield token;
        } else {
          const top = this.peek(1);
          if (token.type === "block-scalar") {
            token.indent = "indent" in top ? top.indent : 0;
          } else if (token.type === "flow-collection" && top.type === "document") {
            token.indent = 0;
          }
          if (token.type === "flow-collection")
            fixFlowSeqItems(token);
          switch (top.type) {
            case "document":
              top.value = token;
              break;
            case "block-scalar":
              top.props.push(token);
              break;
            case "block-map": {
              const it = top.items[top.items.length - 1];
              if (it.value) {
                top.items.push({ start: [], key: token, sep: [] });
                this.onKeyLine = true;
                return;
              } else if (it.sep) {
                it.value = token;
              } else {
                Object.assign(it, { key: token, sep: [] });
                this.onKeyLine = !it.explicitKey;
                return;
              }
              break;
            }
            case "block-seq": {
              const it = top.items[top.items.length - 1];
              if (it.value)
                top.items.push({ start: [], value: token });
              else
                it.value = token;
              break;
            }
            case "flow-collection": {
              const it = top.items[top.items.length - 1];
              if (!it || it.value)
                top.items.push({ start: [], key: token, sep: [] });
              else if (it.sep)
                it.value = token;
              else
                Object.assign(it, { key: token, sep: [] });
              return;
            }
            /* istanbul ignore next should not happen */
            default:
              yield* this.pop();
              yield* this.pop(token);
          }
          if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
            const last = token.items[token.items.length - 1];
            if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
              if (top.type === "document")
                top.end = last.start;
              else
                top.items.push({ start: last.start });
              token.items.splice(-1, 1);
            }
          }
        }
      }
      *stream() {
        switch (this.type) {
          case "directive-line":
            yield { type: "directive", offset: this.offset, source: this.source };
            return;
          case "byte-order-mark":
          case "space":
          case "comment":
          case "newline":
            yield this.sourceToken;
            return;
          case "doc-mode":
          case "doc-start": {
            const doc = {
              type: "document",
              offset: this.offset,
              start: []
            };
            if (this.type === "doc-start")
              doc.start.push(this.sourceToken);
            this.stack.push(doc);
            return;
          }
        }
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML stream`,
          source: this.source
        };
      }
      *document(doc) {
        if (doc.value)
          return yield* this.lineEnd(doc);
        switch (this.type) {
          case "doc-start": {
            if (findNonEmptyIndex(doc.start) !== -1) {
              yield* this.pop();
              yield* this.step();
            } else
              doc.start.push(this.sourceToken);
            return;
          }
          case "anchor":
          case "tag":
          case "space":
          case "comment":
          case "newline":
            doc.start.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(doc);
        if (bv)
          this.stack.push(bv);
        else {
          yield {
            type: "error",
            offset: this.offset,
            message: `Unexpected ${this.type} token in YAML document`,
            source: this.source
          };
        }
      }
      *scalar(scalar) {
        if (this.type === "map-value-ind") {
          const prev = getPrevProps(this.peek(2));
          const start = getFirstKeyStartProps(prev);
          let sep2;
          if (scalar.end) {
            sep2 = scalar.end;
            sep2.push(this.sourceToken);
            delete scalar.end;
          } else
            sep2 = [this.sourceToken];
          const map = {
            type: "block-map",
            offset: scalar.offset,
            indent: scalar.indent,
            items: [{ start, key: scalar, sep: sep2 }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else
          yield* this.lineEnd(scalar);
      }
      *blockScalar(scalar) {
        switch (this.type) {
          case "space":
          case "comment":
          case "newline":
            scalar.props.push(this.sourceToken);
            return;
          case "scalar":
            scalar.source = this.source;
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine) {
              let nl = this.source.indexOf("\n") + 1;
              while (nl !== 0) {
                this.onNewLine(this.offset + nl);
                nl = this.source.indexOf("\n", nl) + 1;
              }
            }
            yield* this.pop();
            break;
          /* istanbul ignore next should not happen */
          default:
            yield* this.pop();
            yield* this.step();
        }
      }
      *blockMap(map) {
        const it = map.items[map.items.length - 1];
        switch (this.type) {
          case "newline":
            this.onKeyLine = false;
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "space":
          case "comment":
            if (it.value) {
              map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              if (this.atIndentedComment(it.start, map.indent)) {
                const prev = map.items[map.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  map.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
        }
        if (this.indent >= map.indent) {
          const atMapIndent = !this.onKeyLine && this.indent === map.indent;
          const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
          let start = [];
          if (atNextItem && it.sep && !it.value) {
            const nl = [];
            for (let i = 0; i < it.sep.length; ++i) {
              const st = it.sep[i];
              switch (st.type) {
                case "newline":
                  nl.push(i);
                  break;
                case "space":
                  break;
                case "comment":
                  if (st.indent > map.indent)
                    nl.length = 0;
                  break;
                default:
                  nl.length = 0;
              }
            }
            if (nl.length >= 2)
              start = it.sep.splice(nl[1]);
          }
          switch (this.type) {
            case "anchor":
            case "tag":
              if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start });
                this.onKeyLine = true;
              } else if (it.sep) {
                it.sep.push(this.sourceToken);
              } else {
                it.start.push(this.sourceToken);
              }
              return;
            case "explicit-key-ind":
              if (!it.sep && !it.explicitKey) {
                it.start.push(this.sourceToken);
                it.explicitKey = true;
              } else if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start, explicitKey: true });
              } else {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [this.sourceToken], explicitKey: true }]
                });
              }
              this.onKeyLine = true;
              return;
            case "map-value-ind":
              if (it.explicitKey) {
                if (!it.sep) {
                  if (includesToken(it.start, "newline")) {
                    Object.assign(it, { key: null, sep: [this.sourceToken] });
                  } else {
                    const start2 = getFirstKeyStartProps(it.start);
                    this.stack.push({
                      type: "block-map",
                      offset: this.offset,
                      indent: this.indent,
                      items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                    });
                  }
                } else if (it.value) {
                  map.items.push({ start: [], key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start, key: null, sep: [this.sourceToken] }]
                  });
                } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                  const start2 = getFirstKeyStartProps(it.start);
                  const key = it.key;
                  const sep2 = it.sep;
                  sep2.push(this.sourceToken);
                  delete it.key;
                  delete it.sep;
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key, sep: sep2 }]
                  });
                } else if (start.length > 0) {
                  it.sep = it.sep.concat(start, this.sourceToken);
                } else {
                  it.sep.push(this.sourceToken);
                }
              } else {
                if (!it.sep) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else if (it.value || atNextItem) {
                  map.items.push({ start, key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: [], key: null, sep: [this.sourceToken] }]
                  });
                } else {
                  it.sep.push(this.sourceToken);
                }
              }
              this.onKeyLine = true;
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (atNextItem || it.value) {
                map.items.push({ start, key: fs, sep: [] });
                this.onKeyLine = true;
              } else if (it.sep) {
                this.stack.push(fs);
              } else {
                Object.assign(it, { key: fs, sep: [] });
                this.onKeyLine = true;
              }
              return;
            }
            default: {
              const bv = this.startBlockValue(map);
              if (bv) {
                if (bv.type === "block-seq") {
                  if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                    yield* this.pop({
                      type: "error",
                      offset: this.offset,
                      message: "Unexpected block-seq-ind on same line with key",
                      source: this.source
                    });
                    return;
                  }
                } else if (atMapIndent) {
                  map.items.push({ start });
                }
                this.stack.push(bv);
                return;
              }
            }
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *blockSequence(seq) {
        const it = seq.items[seq.items.length - 1];
        switch (this.type) {
          case "newline":
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                seq.items.push({ start: [this.sourceToken] });
            } else
              it.start.push(this.sourceToken);
            return;
          case "space":
          case "comment":
            if (it.value)
              seq.items.push({ start: [this.sourceToken] });
            else {
              if (this.atIndentedComment(it.start, seq.indent)) {
                const prev = seq.items[seq.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  seq.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
          case "anchor":
          case "tag":
            if (it.value || this.indent <= seq.indent)
              break;
            it.start.push(this.sourceToken);
            return;
          case "seq-item-ind":
            if (this.indent !== seq.indent)
              break;
            if (it.value || includesToken(it.start, "seq-item-ind"))
              seq.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
        }
        if (this.indent > seq.indent) {
          const bv = this.startBlockValue(seq);
          if (bv) {
            this.stack.push(bv);
            return;
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *flowCollection(fc) {
        const it = fc.items[fc.items.length - 1];
        if (this.type === "flow-error-end") {
          let top;
          do {
            yield* this.pop();
            top = this.peek(1);
          } while (top?.type === "flow-collection");
        } else if (fc.end.length === 0) {
          switch (this.type) {
            case "comma":
            case "explicit-key-ind":
              if (!it || it.sep)
                fc.items.push({ start: [this.sourceToken] });
              else
                it.start.push(this.sourceToken);
              return;
            case "map-value-ind":
              if (!it || it.value)
                fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              return;
            case "space":
            case "comment":
            case "newline":
            case "anchor":
            case "tag":
              if (!it || it.value)
                fc.items.push({ start: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                it.start.push(this.sourceToken);
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (!it || it.value)
                fc.items.push({ start: [], key: fs, sep: [] });
              else if (it.sep)
                this.stack.push(fs);
              else
                Object.assign(it, { key: fs, sep: [] });
              return;
            }
            case "flow-map-end":
            case "flow-seq-end":
              fc.end.push(this.sourceToken);
              return;
          }
          const bv = this.startBlockValue(fc);
          if (bv)
            this.stack.push(bv);
          else {
            yield* this.pop();
            yield* this.step();
          }
        } else {
          const parent = this.peek(2);
          if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
            yield* this.pop();
            yield* this.step();
          } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            fixFlowSeqItems(fc);
            const sep2 = fc.end.splice(1, fc.end.length);
            sep2.push(this.sourceToken);
            const map = {
              type: "block-map",
              offset: fc.offset,
              indent: fc.indent,
              items: [{ start, key: fc, sep: sep2 }]
            };
            this.onKeyLine = true;
            this.stack[this.stack.length - 1] = map;
          } else {
            yield* this.lineEnd(fc);
          }
        }
      }
      flowScalar(type) {
        if (this.onNewLine) {
          let nl = this.source.indexOf("\n") + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf("\n", nl) + 1;
          }
        }
        return {
          type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
      }
      startBlockValue(parent) {
        switch (this.type) {
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return this.flowScalar(this.type);
          case "block-scalar-header":
            return {
              type: "block-scalar",
              offset: this.offset,
              indent: this.indent,
              props: [this.sourceToken],
              source: ""
            };
          case "flow-map-start":
          case "flow-seq-start":
            return {
              type: "flow-collection",
              offset: this.offset,
              indent: this.indent,
              start: this.sourceToken,
              items: [],
              end: []
            };
          case "seq-item-ind":
            return {
              type: "block-seq",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken] }]
            };
          case "explicit-key-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            start.push(this.sourceToken);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, explicitKey: true }]
            };
          }
          case "map-value-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, key: null, sep: [this.sourceToken] }]
            };
          }
        }
        return null;
      }
      atIndentedComment(start, indent) {
        if (this.type !== "comment")
          return false;
        if (this.indent <= indent)
          return false;
        return start.every((st) => st.type === "newline" || st.type === "space");
      }
      *documentEnd(docEnd) {
        if (this.type !== "doc-mode") {
          if (docEnd.end)
            docEnd.end.push(this.sourceToken);
          else
            docEnd.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
        }
      }
      *lineEnd(token) {
        switch (this.type) {
          case "comma":
          case "doc-start":
          case "doc-end":
          case "flow-seq-end":
          case "flow-map-end":
          case "map-value-ind":
            yield* this.pop();
            yield* this.step();
            break;
          case "newline":
            this.onKeyLine = false;
          // fallthrough
          case "space":
          case "comment":
          default:
            if (token.end)
              token.end.push(this.sourceToken);
            else
              token.end = [this.sourceToken];
            if (this.type === "newline")
              yield* this.pop();
        }
      }
    };
    exports.Parser = Parser;
  }
});

// node_modules/yaml/dist/public-api.js
var require_public_api = __commonJS({
  "node_modules/yaml/dist/public-api.js"(exports) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var errors = require_errors();
    var log = require_log();
    var identity = require_identity();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    function parseOptions(options) {
      const prettyErrors = options.prettyErrors !== false;
      const lineCounter$1 = options.lineCounter || prettyErrors && new lineCounter.LineCounter() || null;
      return { lineCounter: lineCounter$1, prettyErrors };
    }
    function parseAllDocuments(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      const docs = Array.from(composer$1.compose(parser$1.parse(source)));
      if (prettyErrors && lineCounter2)
        for (const doc of docs) {
          doc.errors.forEach(errors.prettifyError(source, lineCounter2));
          doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
        }
      if (docs.length > 0)
        return docs;
      return Object.assign([], { empty: true }, composer$1.streamInfo());
    }
    function parseDocument2(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      let doc = null;
      for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
        if (!doc)
          doc = _doc;
        else if (doc.options.logLevel !== "silent") {
          doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
          break;
        }
      }
      if (prettyErrors && lineCounter2) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
      }
      return doc;
    }
    function parse3(src, reviver, options) {
      let _reviver = void 0;
      if (typeof reviver === "function") {
        _reviver = reviver;
      } else if (options === void 0 && reviver && typeof reviver === "object") {
        options = reviver;
      }
      const doc = parseDocument2(src, options);
      if (!doc)
        return null;
      doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
      if (doc.errors.length > 0) {
        if (doc.options.logLevel !== "silent")
          throw doc.errors[0];
        else
          doc.errors = [];
      }
      return doc.toJS(Object.assign({ reviver: _reviver }, options));
    }
    function stringify3(value, replacer, options) {
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === void 0 && replacer) {
        options = replacer;
      }
      if (typeof options === "string")
        options = options.length;
      if (typeof options === "number") {
        const indent = Math.round(options);
        options = indent < 1 ? void 0 : indent > 8 ? { indent: 8 } : { indent };
      }
      if (value === void 0) {
        const { keepUndefined } = options ?? replacer ?? {};
        if (!keepUndefined)
          return void 0;
      }
      if (identity.isDocument(value) && !_replacer)
        return value.toString(options);
      return new Document.Document(value, _replacer, options).toString(options);
    }
    exports.parse = parse3;
    exports.parseAllDocuments = parseAllDocuments;
    exports.parseDocument = parseDocument2;
    exports.stringify = stringify3;
  }
});

// node_modules/yaml/dist/index.js
var require_dist = __commonJS({
  "node_modules/yaml/dist/index.js"(exports) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var Schema = require_Schema();
    var errors = require_errors();
    var Alias = require_Alias();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var cst = require_cst();
    var lexer = require_lexer();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    var publicApi = require_public_api();
    var visit2 = require_visit();
    exports.Composer = composer.Composer;
    exports.Document = Document.Document;
    exports.Schema = Schema.Schema;
    exports.YAMLError = errors.YAMLError;
    exports.YAMLParseError = errors.YAMLParseError;
    exports.YAMLWarning = errors.YAMLWarning;
    exports.Alias = Alias.Alias;
    exports.isAlias = identity.isAlias;
    exports.isCollection = identity.isCollection;
    exports.isDocument = identity.isDocument;
    exports.isMap = identity.isMap;
    exports.isNode = identity.isNode;
    exports.isPair = identity.isPair;
    exports.isScalar = identity.isScalar;
    exports.isSeq = identity.isSeq;
    exports.Pair = Pair.Pair;
    exports.Scalar = Scalar.Scalar;
    exports.YAMLMap = YAMLMap.YAMLMap;
    exports.YAMLSeq = YAMLSeq.YAMLSeq;
    exports.CST = cst;
    exports.Lexer = lexer.Lexer;
    exports.LineCounter = lineCounter.LineCounter;
    exports.Parser = parser.Parser;
    exports.parse = publicApi.parse;
    exports.parseAllDocuments = publicApi.parseAllDocuments;
    exports.parseDocument = publicApi.parseDocument;
    exports.stringify = publicApi.stringify;
    exports.visit = visit2.visit;
    exports.visitAsync = visit2.visitAsync;
  }
});

// plugins/kxm/src/hub.ts
import { createHash as createHash4, createHmac } from "node:crypto";
import { existsSync as existsSync5 } from "node:fs";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { dirname as dirname5, join as join6, resolve as resolve6 } from "node:path";

// plugins/kxm/src/protocol.ts
import { randomUUID } from "node:crypto";
var DEFAULT_PORT = 7331;
var DEFAULT_STALE_AFTER_MS = 3e4;
var DEFAULT_MAX_HOPS = 5;
var DEFAULT_MESSAGE_TTL_MS = 24 * 60 * 6e4;
var MIN_MESSAGE_TTL_MS = 1e3;
var MAX_MESSAGE_TTL_MS = 7 * 24 * 60 * 6e4;
var DEFAULT_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 6e4;
var MIN_MESSAGE_RETENTION_MS = 1e3;
var DEFAULT_RATE_LIMIT_MAX = 600;
var DEFAULT_RATE_LIMIT_WINDOW_MS = 6e4;
var MAX_BODY_BYTES = 256 * 1024;
var MAX_CONTENT_CHARS = 32e3;
var MAX_AGENT_HOST_CHARS = 64;
function agentPresenceView(agent, staleAfterMs = DEFAULT_STALE_AFTER_MS, now = Date.now()) {
  const lastSeenMs = Date.parse(agent.lastSeenAt);
  const leaseExpiresAtMs = (Number.isFinite(lastSeenMs) ? lastSeenMs : 0) + staleAfterMs;
  const leaseExpiresAt = new Date(leaseExpiresAtMs).toISOString();
  if (!agent.online) return { leaseExpiresAt, presence: "offline" };
  return { leaseExpiresAt, presence: now < leaseExpiresAtMs ? "online" : "stale" };
}
function toAgentRecord(agent, staleAfterMs, now) {
  return { ...agent, ...agentPresenceView(agent, staleAfterMs, now) };
}
var ProtocolError = class extends Error {
  statusCode;
  code;
  extras;
  constructor(statusCode, message, code = "protocol_error", extras) {
    super(message);
    this.name = "ProtocolError";
    this.statusCode = statusCode;
    this.code = code;
    if (extras) this.extras = extras;
  }
};
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function newId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
function requireString(value, field, options = {}) {
  if (typeof value !== "string") {
    throw new ProtocolError(400, `${field} must be a string`);
  }
  const result = value.trim();
  if (!options.allowEmpty && result.length === 0) {
    throw new ProtocolError(400, `${field} cannot be empty`);
  }
  if (options.max !== void 0 && result.length > options.max) {
    throw new ProtocolError(400, `${field} exceeds ${options.max} characters`);
  }
  return result;
}
function optionalString(value, field, max) {
  if (value === void 0 || value === null || value === "") return void 0;
  return requireString(value, field, { max });
}
function parseDeliveryMode(value) {
  if (value === void 0) return "followUp";
  if (value === "steer" || value === "followUp" || value === "nextTurn") return value;
  throw new ProtocolError(400, "delivery must be steer, followUp, or nextTurn");
}
function parseBoundedInteger(value, field, fallback, min, max) {
  if (value === void 0) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ProtocolError(400, `${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}
var TERMINAL_RECEIPT_SCHEMA = "kxm.terminal-receipt.v1";
var VALID_TERMINAL_STATUSES = /* @__PURE__ */ new Set(["accepted", "audit_escalation", "rejected", "error"]);
function validateTerminalReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, "terminal receipt must be an object", "invalid_terminal_receipt");
  }
  const record = value;
  if (record.schema !== void 0 && record.schema !== TERMINAL_RECEIPT_SCHEMA) {
    throw new ProtocolError(400, `terminal receipt schema must be ${TERMINAL_RECEIPT_SCHEMA}`, "invalid_terminal_receipt");
  }
  const status = record.status;
  if (!status || !VALID_TERMINAL_STATUSES.has(status)) {
    throw new ProtocolError(
      400,
      `terminal receipt status must be one of: ${Array.from(VALID_TERMINAL_STATUSES).join(", ")}`,
      "invalid_terminal_receipt"
    );
  }
  const seat = requireString(record.seat, "seat", { max: 64 });
  const runId = requireString(record.runId, "runId", { max: 128 });
  const stageId = requireString(record.stageId, "stageId", { max: 128 });
  const timestamp = requireString(record.timestamp, "timestamp", { max: 64 });
  const host2 = requireString(record.host, "host", { max: 64 });
  const model = requireString(record.model, "model", { max: 128 });
  let evidence;
  if (record.evidence !== void 0) {
    if (!record.evidence || typeof record.evidence !== "object" || Array.isArray(record.evidence)) {
      throw new ProtocolError(400, "terminal receipt evidence must be an object", "invalid_terminal_receipt");
    }
    evidence = record.evidence;
  }
  let metrics;
  if (record.metrics !== void 0) {
    if (!record.metrics || typeof record.metrics !== "object" || Array.isArray(record.metrics)) {
      throw new ProtocolError(400, "terminal receipt metrics must be an object", "invalid_terminal_receipt");
    }
    metrics = record.metrics;
  }
  const escalationReason = optionalString(record.escalationReason, "escalationReason", 1024);
  const ruling = optionalString(record.ruling, "ruling", 2048);
  return {
    schema: TERMINAL_RECEIPT_SCHEMA,
    status,
    seat,
    runId,
    stageId,
    timestamp,
    host: host2,
    model,
    ...evidence ? { evidence } : {},
    ...metrics ? { metrics } : {},
    ...escalationReason ? { escalationReason } : {},
    ...ruling ? { ruling } : {}
  };
}

// plugins/kxm/src/diagnostics.ts
function workflowScopeExtras(operation, assignedCoordinatorName) {
  return {
    operation,
    assignedCoordinatorName,
    nextAction: "use_assigned_coordinator"
  };
}

// plugins/kxm/src/commands.ts
import { createHash as createHash2, randomUUID as randomUUID2, timingSafeEqual } from "node:crypto";

// plugins/kxm/src/workflow.ts
import { createHash } from "node:crypto";
var JOURNAL_CATEGORIES = [
  "plan",
  "decision",
  "contradiction",
  "error",
  "lesson",
  "observation",
  "hypothesis",
  "experiment",
  "state-change",
  "skill-candidate"
];
var EVIDENCE_REQUIRED_JOURNAL_CATEGORIES = ["lesson", "skill-candidate"];
var PROMOTABLE_JOURNAL_CATEGORIES = ["skill-candidate", "hypothesis", "experiment"];
function parseJournalCategory(value) {
  if (typeof value !== "string" || !JOURNAL_CATEGORIES.includes(value)) {
    throw new ProtocolError(
      400,
      `invalid journal category: must be one of ${JOURNAL_CATEGORIES.join(", ")}`,
      "invalid_journal_category"
    );
  }
  return value;
}
function journalEvidenceRequired(category) {
  return EVIDENCE_REQUIRED_JOURNAL_CATEGORIES.includes(category);
}
var WORKFLOW_TERMINAL_TARGET = "$terminal";
function normalizeOutcomeValue(value, field) {
  if (typeof value === "string") return { target: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a stage ID, "$terminal", or a { target, maxTransitions } rule`);
  }
  const rule = value;
  if (typeof rule.target !== "string" || !rule.target.trim()) {
    throw new Error(`${field}.target must be a non-empty stage ID or "$terminal"`);
  }
  if (rule.maxTransitions !== void 0 && (!Number.isInteger(rule.maxTransitions) || rule.maxTransitions < 1 || rule.maxTransitions > 100)) {
    throw new Error(`${field}.maxTransitions must be an integer between 1 and 100`);
  }
  return { target: rule.target, ...rule.maxTransitions !== void 0 ? { maxTransitions: rule.maxTransitions } : {} };
}
function journalPromotionState(entry) {
  if (!PROMOTABLE_JOURNAL_CATEGORIES.includes(entry.category)) return void 0;
  const records = entry.promotion ?? [];
  return records.length === 0 ? "proposed" : records[records.length - 1]?.to;
}
function applyJournalPromotion(entry, decision, decidedAt) {
  if (!PROMOTABLE_JOURNAL_CATEGORIES.includes(entry.category)) {
    throw new ProtocolError(
      400,
      `journal entries of category ${entry.category} do not participate in promotion`,
      "journal_promotion_invalid"
    );
  }
  if (decision.decidedBy === entry.agentId) {
    throw new ProtocolError(
      400,
      "the author of a journal entry cannot decide its promotion",
      "journal_promotion_invalid"
    );
  }
  if (!Array.isArray(decision.evidenceRefs) || decision.evidenceRefs.length < 1 || decision.evidenceRefs.some((ref) => typeof ref !== "string" || !ref.trim())) {
    throw new ProtocolError(
      400,
      "journal promotion requires at least one durable evidence reference",
      "journal_promotion_invalid"
    );
  }
  const current = journalPromotionState(entry);
  if (current !== "proposed") {
    throw new ProtocolError(
      400,
      `journal entry promotion already reached terminal state ${current}`,
      "journal_promotion_invalid"
    );
  }
  const record = {
    schema: "kxm.journal-promotion.v1",
    from: "proposed",
    to: decision.to,
    evidenceRefs: decision.evidenceRefs.map((ref) => ref.trim()),
    decidedBy: decision.decidedBy,
    reason: decision.reason,
    decidedAt
  };
  return { ...entry, promotion: [...entry.promotion ?? [], record] };
}
function improvementReport(entries) {
  const areas = [
    "harness",
    "gates",
    "implementation",
    "workflow",
    "documentation",
    "security",
    "other"
  ];
  const severityWeight = { error: 3, warning: 2, info: 1 };
  return areas.map((area) => {
    const matching = entries.filter((entry) => entry.area === area);
    const priorities = [...matching].filter((entry) => entry.category === "error" || entry.category === "contradiction" || entry.category === "lesson" || entry.category === "skill-candidate").sort((left, right) => severityWeight[right.severity] - severityWeight[left.severity]).slice(0, 10);
    return {
      area,
      total: matching.length,
      errors: matching.filter((entry) => entry.category === "error").length,
      contradictions: matching.filter((entry) => entry.category === "contradiction").length,
      lessons: matching.filter((entry) => entry.category === "lesson").length,
      priorities
    };
  }).filter((report) => report.total > 0);
}
function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}
function stringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  return value.map((item) => item.trim());
}
function canonicalWorkflowEvidenceKey(value) {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}
function normalizeWorkflowEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized = /* @__PURE__ */ new Map();
  for (const [requirement, candidate] of Object.entries(value)) {
    const key = canonicalWorkflowEvidenceKey(requirement);
    if (!key) continue;
    const values = Array.isArray(candidate) ? candidate : [candidate];
    const safeValues = values.filter((item) => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
    if (safeValues.length > 0) {
      normalized.set(key, [.../* @__PURE__ */ new Set([...normalized.get(key) ?? [], ...safeValues])]);
    }
  }
  return Object.fromEntries(normalized);
}
function normalizeVerifiedWorkflowEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = /* @__PURE__ */ new Map();
  for (const [rawRequirement, rawSnapshots] of Object.entries(value)) {
    const requirement = canonicalWorkflowEvidenceKey(rawRequirement);
    if (!requirement || !Array.isArray(rawSnapshots)) continue;
    const snapshots = rawSnapshots.filter((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const snapshot = candidate;
      return snapshot.schema === "pi-mesh.verified-peer-evidence.v1" && typeof snapshot.messageId === "string" && typeof snapshot.producerId === "string" && typeof snapshot.producerName === "string" && snapshot.status === "replied" && typeof snapshot.requestSha256 === "string" && typeof snapshot.replySha256 === "string" && typeof snapshot.createdAt === "string" && typeof snapshot.replyCreatedAt === "string" && typeof snapshot.repliedAt === "string" && typeof snapshot.verifiedAt === "string" && snapshot.context?.schema === "pi-mesh.workflow-message-context.v1";
    });
    if (snapshots.length) result.set(requirement, snapshots);
  }
  return Object.fromEntries(result);
}
function mergeVerifiedWorkflowEvidence(current, incoming = {}) {
  const merged = new Map(Object.entries(normalizeVerifiedWorkflowEvidence(current)));
  for (const [rawRequirement, snapshots] of Object.entries(incoming)) {
    const requirement = canonicalWorkflowEvidenceKey(rawRequirement);
    if (!requirement) continue;
    const values = [...merged.get(requirement) ?? []];
    for (const snapshot of snapshots) {
      if (!values.some((candidate) => candidate.messageId === snapshot.messageId)) values.push(snapshot);
    }
    if (values.length) merged.set(requirement, values);
  }
  return Object.fromEntries(merged);
}
function mergeWorkflowEvidence(current, incoming = {}) {
  const merged = new Map(Object.entries(normalizeWorkflowEvidence(current)));
  const seen = /* @__PURE__ */ new Set();
  for (const [rawRequirement, rawValue] of Object.entries(incoming)) {
    const requirement = canonicalWorkflowEvidenceKey(rawRequirement);
    if (!requirement || typeof rawValue !== "string" || !rawValue.trim()) {
      throw new ProtocolError(400, "evidence must contain non-empty keyed string values", "invalid_workflow_evidence");
    }
    if (seen.has(requirement)) {
      throw new ProtocolError(
        400,
        `evidence contains duplicate normalized requirement identity: ${requirement}`,
        "invalid_workflow_evidence"
      );
    }
    seen.add(requirement);
    const value = rawValue.trim();
    const values = merged.get(requirement) ?? [];
    if (!values.includes(value)) values.push(value);
    merged.set(requirement, values);
  }
  return Object.fromEntries(merged);
}
function workflowEvidenceStrings(evidence) {
  return Object.entries(evidence).flatMap(([requirement, candidate]) => {
    const values = Array.isArray(candidate) ? candidate : [candidate];
    return values.map((value) => `${requirement}: ${value}`);
  });
}
function activeWorkflowAttempt(stage) {
  return stage.attempts + 1;
}
function validIsoTimestamp(value) {
  if (!value) return void 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function verifyWorkflowEvidenceReferences(run, stage, references, lookup, verifiedAt) {
  const expectedAttempt = activeWorkflowAttempt(stage);
  const result = /* @__PURE__ */ new Map();
  const seenRequirements = /* @__PURE__ */ new Set();
  const seenMessageIds = /* @__PURE__ */ new Set();
  for (const [rawRequirement, reference] of Object.entries(references)) {
    const requirementKey = canonicalWorkflowEvidenceKey(rawRequirement);
    if (!requirementKey || seenRequirements.has(requirementKey)) {
      throw new ProtocolError(
        400,
        `evidenceRefs contains duplicate or empty requirement identity: ${requirementKey || "(empty)"}`,
        "invalid_workflow_evidence_refs"
      );
    }
    seenRequirements.add(requirementKey);
    const policy = stage.resolvedEvidencePolicies?.[requirementKey];
    if (!policy) {
      throw new ProtocolError(
        400,
        `requirement ${requirementKey} does not declare a resolved peer evidence policy`,
        "workflow_evidence_policy_missing"
      );
    }
    if (!reference || !Array.isArray(reference.messageIds) || reference.messageIds.length < 1 || reference.messageIds.length > 16) {
      throw new ProtocolError(
        400,
        `evidenceRefs.${requirementKey}.messageIds must contain between 1 and 16 message IDs`,
        "invalid_workflow_evidence_refs"
      );
    }
    const eligibleProducerIds = new Set(policy.eligibleProducers.map((producer) => producer.id));
    const snapshots = [];
    for (const rawMessageId of reference.messageIds) {
      const messageId = typeof rawMessageId === "string" ? rawMessageId.trim() : "";
      if (!messageId || seenMessageIds.has(messageId)) {
        throw new ProtocolError(
          400,
          `evidenceRefs contains an empty or duplicate message ID: ${messageId || "(empty)"}`,
          "invalid_workflow_evidence_refs"
        );
      }
      seenMessageIds.add(messageId);
      const message = lookup.getMessage(messageId);
      if (!message) {
        throw new ProtocolError(400, `peer evidence message not found: ${messageId}`, "workflow_provenance_invalid");
      }
      const context = message.workflowContext;
      if (context?.schema !== "pi-mesh.workflow-message-context.v1" || context.runId !== run.id || context.stageId !== stage.id || context.requirementKey !== requirementKey || context.attempt !== expectedAttempt) {
        throw new ProtocolError(
          400,
          `peer evidence message ${messageId} is not bound to ${run.id}/${stage.id}/${requirementKey}/attempt-${expectedAttempt}`,
          "workflow_provenance_invalid"
        );
      }
      if (message.project !== run.project || message.from !== run.targetAgentId || message.to === run.targetAgentId) {
        throw new ProtocolError(
          400,
          `peer evidence message ${messageId} has an invalid project or direction`,
          "workflow_provenance_invalid"
        );
      }
      if (!eligibleProducerIds.has(message.to)) {
        throw new ProtocolError(
          400,
          `peer evidence producer ${message.toName} is not eligible for ${requirementKey}`,
          "workflow_provenance_invalid"
        );
      }
      if (message.correlationId !== run.id || message.status !== "replied" || !message.reply?.content.trim()) {
        throw new ProtocolError(
          400,
          `peer evidence message ${messageId} is not a replied message for run ${run.id}`,
          "workflow_provenance_invalid"
        );
      }
      const createdAt = validIsoTimestamp(message.createdAt);
      const deliveredAt = message.deliveredAt === void 0 ? void 0 : validIsoTimestamp(message.deliveredAt);
      const replyCreatedAt = validIsoTimestamp(message.reply.createdAt);
      const repliedAt = validIsoTimestamp(message.repliedAt);
      if (createdAt === void 0 || replyCreatedAt === void 0 || repliedAt === void 0 || message.deliveredAt !== void 0 && deliveredAt === void 0 || deliveredAt !== void 0 && (deliveredAt < createdAt || deliveredAt > repliedAt) || replyCreatedAt < createdAt || repliedAt < replyCreatedAt) {
        throw new ProtocolError(
          400,
          `peer evidence message ${messageId} has incoherent reply timestamps`,
          "workflow_provenance_invalid"
        );
      }
      snapshots.push({
        schema: "pi-mesh.verified-peer-evidence.v1",
        messageId: message.id,
        producerId: message.to,
        producerName: message.toName,
        context: { ...context },
        status: "replied",
        requestSha256: createHash("sha256").update(message.content, "utf8").digest("hex"),
        replySha256: createHash("sha256").update(message.reply.content, "utf8").digest("hex"),
        createdAt: message.createdAt,
        replyCreatedAt: message.reply.createdAt,
        repliedAt: message.repliedAt,
        verifiedAt
      });
    }
    result.set(requirementKey, snapshots);
  }
  return Object.fromEntries(result);
}
function peerEvidenceRequirementStatus(stage, requirementKey, runId, verifiedEvidence = normalizeVerifiedWorkflowEvidence(stage.verifiedEvidence)) {
  const canonicalKey = canonicalWorkflowEvidenceKey(requirementKey);
  const policy = stage.resolvedEvidencePolicies?.[canonicalKey];
  if (!policy) return void 0;
  const attempt = activeWorkflowAttempt(stage);
  const eligibleIds = new Set(policy.eligibleProducers.map((producer) => producer.id));
  const producers = /* @__PURE__ */ new Set();
  for (const snapshot of verifiedEvidence[canonicalKey] ?? []) {
    if (snapshot.schema === "pi-mesh.verified-peer-evidence.v1" && snapshot.status === "replied" && snapshot.context?.schema === "pi-mesh.workflow-message-context.v1" && snapshot.context.runId === runId && snapshot.context.stageId === stage.id && snapshot.context.requirementKey === canonicalKey && snapshot.context.attempt === attempt && eligibleIds.has(snapshot.producerId) && /^[a-f0-9]{64}$/.test(snapshot.requestSha256) && /^[a-f0-9]{64}$/.test(snapshot.replySha256) && validIsoTimestamp(snapshot.createdAt) !== void 0 && validIsoTimestamp(snapshot.replyCreatedAt) !== void 0 && validIsoTimestamp(snapshot.repliedAt) !== void 0 && validIsoTimestamp(snapshot.verifiedAt) !== void 0) producers.add(snapshot.producerId);
  }
  const approval = stage.degradationApprovals?.find(
    (candidate) => candidate.requirementKey === canonicalKey && candidate.attempt === attempt
  );
  const effectiveMinProducers = approval?.approvedMinProducers ?? policy.minProducers;
  return {
    requirementKey: canonicalKey,
    policyMinProducers: policy.minProducers,
    effectiveMinProducers,
    producers: [...producers],
    met: producers.size >= effectiveMinProducers,
    degraded: Boolean(approval && producers.size < policy.minProducers && producers.size >= effectiveMinProducers),
    ...approval ? { approval } : {}
  };
}
function requireCompleteEvidence(stage, evidence, verifiedEvidence, runId) {
  const missing = [];
  const peerStatuses = [];
  for (const rawRequirement of stage.requiredEvidence) {
    const requirement = canonicalWorkflowEvidenceKey(rawRequirement);
    const peerStatus = peerEvidenceRequirementStatus(stage, requirement, runId, verifiedEvidence);
    if (peerStatus) {
      peerStatuses.push(peerStatus);
      if (!peerStatus.met) missing.push(requirement);
    } else if (stage.evidencePolicies?.[requirement]) {
      throw new ProtocolError(
        409,
        `stage ${stage.id} evidence policy ${requirement} was not resolved when the run started`,
        "workflow_evidence_policy_unresolved"
      );
    } else if (!evidence[requirement]?.length) {
      missing.push(requirement);
    }
  }
  if (missing.length === 0) return peerStatuses;
  throw new ProtocolError(
    400,
    `stage ${stage.id} is missing required evidence: ${missing.join(", ")}`,
    "workflow_evidence_incomplete",
    {
      missingRequirements: missing,
      providedRequirements: Object.keys(evidence),
      peerRequirements: peerStatuses
    }
  );
}
function parseWorkflowEvidencePolicies(value, stageId, requiredEvidence, workflowId, targetName, warn) {
  if (value === void 0) return void 0;
  const rawPolicies = object(value, `stage ${stageId} evidencePolicies`);
  const policies = /* @__PURE__ */ new Map();
  for (const [rawRequirement, rawPolicy] of Object.entries(rawPolicies)) {
    const requirementKey = canonicalWorkflowEvidenceKey(
      requireString(rawRequirement, `stage ${stageId} evidencePolicies requirement`, { max: 128 })
    );
    if (!requiredEvidence.includes(requirementKey)) {
      throw new Error(`stage ${stageId} evidence policy ${requirementKey} must match requiredEvidence`);
    }
    if (policies.has(requirementKey)) {
      throw new Error(`stage ${stageId} evidencePolicies keys must be unique after normalization`);
    }
    const policy = object(rawPolicy, `stage ${stageId} evidencePolicies.${requirementKey}`);
    const supportedPolicyFields = /* @__PURE__ */ new Set([
      "kind",
      "minProducers",
      "eligibleAgents",
      "acceptedStatuses",
      "degradation"
    ]);
    const unsupportedPolicyFields = Object.keys(policy).filter((field) => !supportedPolicyFields.has(field));
    if (unsupportedPolicyFields.length) {
      throw new Error(
        `stage ${stageId} evidencePolicies.${requirementKey} contains unsupported fields: ${unsupportedPolicyFields.join(", ")}`
      );
    }
    if (policy.kind !== "peer-reply") {
      throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.kind must be peer-reply`);
    }
    const minProducers = policy.minProducers;
    if (!Number.isInteger(minProducers) || minProducers < 1 || minProducers > 8) {
      throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.minProducers must be an integer between 1 and 8`);
    }
    const eligibleAgents = stringArray(
      policy.eligibleAgents,
      `stage ${stageId} evidencePolicies.${requirementKey}.eligibleAgents`
    );
    if (eligibleAgents.length < 1 || eligibleAgents.length > 16) {
      throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.eligibleAgents must contain between 1 and 16 selectors`);
    }
    const normalizedSelectors = eligibleAgents.map((selector) => selector.toLowerCase());
    if (new Set(normalizedSelectors).size !== normalizedSelectors.length) {
      throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.eligibleAgents must be unique`);
    }
    if (normalizedSelectors.includes(targetName)) {
      throw new Error(
        `workflow ${workflowId} stage ${stageId} evidencePolicies.${requirementKey}.eligibleAgents must not include the workflow target ${targetName}: the target cannot produce peer evidence for its own run`
      );
    }
    if (minProducers > normalizedSelectors.length) {
      throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.minProducers exceeds eligibleAgents`);
    }
    if (policy.acceptedStatuses !== void 0) {
      const statuses = stringArray(
        policy.acceptedStatuses,
        `stage ${stageId} evidencePolicies.${requirementKey}.acceptedStatuses`
      );
      if (statuses.length !== 1 || statuses[0] !== "replied") {
        throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.acceptedStatuses must be ["replied"]`);
      }
    }
    let degradation;
    if (policy.degradation !== void 0) {
      const rawDegradation = object(
        policy.degradation,
        `stage ${stageId} evidencePolicies.${requirementKey}.degradation`
      );
      const unsupportedDegradationFields = Object.keys(rawDegradation).filter((field) => field !== "minProducers");
      if (unsupportedDegradationFields.length) {
        throw new Error(
          `stage ${stageId} evidencePolicies.${requirementKey}.degradation contains unsupported fields: ${unsupportedDegradationFields.join(", ")}`
        );
      }
      const degradedMin = rawDegradation.minProducers;
      if (!Number.isInteger(degradedMin) || degradedMin < 1 || degradedMin >= minProducers) {
        throw new Error(
          `stage ${stageId} evidencePolicies.${requirementKey}.degradation.minProducers must be at least 1 and lower than minProducers`
        );
      }
      degradation = { minProducers: degradedMin };
      if (degradation.minProducers < 2) {
        warn(
          `workflow ${workflowId} stage ${stageId} evidence policy ${requirementKey}: degradation.minProducers is ${degradation.minProducers} (< 2); a single producer can satisfy the degraded peer-reply quorum`
        );
      }
    }
    policies.set(requirementKey, {
      kind: "peer-reply",
      minProducers,
      eligibleAgents,
      acceptedStatuses: ["replied"],
      ...degradation ? { degradation } : {}
    });
  }
  return policies.size ? Object.fromEntries(policies) : void 0;
}
function parseWorkflowDefinitions(raw, environment = process.env, onWarning) {
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("KXM_WEBHOOK_WORKFLOWS must be a JSON array");
  const warn = (message) => {
    onWarning?.(message);
  };
  const ids = /* @__PURE__ */ new Set();
  return parsed.map((entry, definitionIndex) => {
    const value = object(entry, `workflow ${definitionIndex}`);
    const id = requireString(value.id, "workflow.id", { max: 64 });
    if (ids.has(id)) throw new Error(`duplicate workflow id: ${id}`);
    ids.add(id);
    const source = value.source ?? "generic";
    if (source !== "jira" && source !== "github" && source !== "generic") {
      throw new Error(`workflow ${id} source must be jira, github, or generic`);
    }
    const delivery = value.delivery ?? "followUp";
    if (delivery !== "steer" && delivery !== "followUp") {
      throw new Error(`workflow ${id} delivery must be steer or followUp`);
    }
    const secretEnv = value.secretEnv === void 0 ? void 0 : requireString(value.secretEnv, "workflow.secretEnv", { max: 128 });
    if (value.secret !== void 0 && secretEnv) {
      throw new Error(`workflow ${id} must configure only one of secret or secretEnv`);
    }
    const secret = requireString(secretEnv ? environment[secretEnv] : value.secret, "workflow.secret", { max: 512 });
    if (secret.length < 16) throw new Error(`workflow ${id} secret must contain at least 16 characters`);
    const signalSecretEnv = value.signalSecretEnv === void 0 ? void 0 : requireString(value.signalSecretEnv, "workflow.signalSecretEnv", { max: 128 });
    if (value.signalSecret !== void 0 && signalSecretEnv) {
      throw new Error(`workflow ${id} must configure only one of signalSecret or signalSecretEnv`);
    }
    const signalSecret = signalSecretEnv ? requireString(environment[signalSecretEnv], "workflow.signalSecret", { max: 512 }) : value.signalSecret === void 0 ? void 0 : requireString(value.signalSecret, "workflow.signalSecret", { max: 512 });
    if (signalSecret && signalSecret.length < 16) {
      throw new Error(`workflow ${id} signalSecret must contain at least 16 characters`);
    }
    const target = requireString(value.target, "workflow.target", { max: 80 });
    const targetName = target.toLowerCase();
    if (!Array.isArray(value.stages) || value.stages.length === 0 || value.stages.length > 32) {
      throw new Error(`workflow ${id} must define between 1 and 32 stages`);
    }
    const stageIds = /* @__PURE__ */ new Set();
    const stages = value.stages.map((stageEntry, stageIndex) => {
      const stage = object(stageEntry, `workflow ${id} stage ${stageIndex}`);
      const stageId = requireString(stage.id, "stage.id", { max: 64 });
      if (stageIds.has(stageId)) throw new Error(`duplicate stage id ${stageId} in workflow ${id}`);
      stageIds.add(stageId);
      const maxAttempts = stage.maxAttempts ?? 3;
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
        throw new Error(`stage ${stageId} maxAttempts must be an integer between 1 and 20`);
      }
      const area = stage.area ? requireString(stage.area, "stage.area", { max: 24 }) : void 0;
      if (area && !["harness", "gates", "implementation", "workflow", "documentation", "security", "other"].includes(area)) {
        throw new Error(`stage ${stageId} area is invalid`);
      }
      const requiredEvidence = stringArray(stage.requiredEvidence ?? [], "stage.requiredEvidence").map((requirement, requirementIndex) => canonicalWorkflowEvidenceKey(
        requireString(requirement, `stage.requiredEvidence[${requirementIndex}]`, { max: 128 })
      ));
      if (requiredEvidence.length > 32) throw new Error(`stage ${stageId} may require at most 32 evidence keys`);
      if (new Set(requiredEvidence).size !== requiredEvidence.length) {
        throw new Error(`stage ${stageId} requiredEvidence keys must be unique`);
      }
      const evidencePolicies = parseWorkflowEvidencePolicies(
        stage.evidencePolicies,
        stageId,
        requiredEvidence,
        id,
        targetName,
        warn
      );
      const on = parseOutcomeMap(stageId, stage.on);
      const stageMaxTransitions = stage.maxTransitions;
      if (stageMaxTransitions !== void 0 && (!Number.isInteger(stageMaxTransitions) || stageMaxTransitions < 1 || stageMaxTransitions > 100)) {
        throw new Error(`stage ${stageId} maxTransitions must be an integer between 1 and 100`);
      }
      const autoResumeLimit = stage.autoResumeLimit;
      if (autoResumeLimit !== void 0 && (!Number.isInteger(autoResumeLimit) || autoResumeLimit < 1 || autoResumeLimit > 20)) {
        throw new Error(`stage ${stageId} autoResumeLimit must be an integer between 1 and 20`);
      }
      return {
        id: stageId,
        label: requireString(stage.label ?? stageId, "stage.label", { max: 128 }),
        instructions: requireString(stage.instructions, "stage.instructions", { max: 4e3 }),
        requiredEvidence,
        maxAttempts,
        ...autoResumeLimit !== void 0 ? { autoResumeLimit } : {},
        ...area ? { area } : {},
        ...evidencePolicies ? { evidencePolicies } : {},
        ...on ? { on } : {},
        ...stageMaxTransitions !== void 0 ? { maxTransitions: stageMaxTransitions } : {}
      };
    });
    const definitionMaxTransitions = value.maxTransitions;
    if (definitionMaxTransitions !== void 0) validateWorkflowTransitions({ id, stages, maxTransitions: definitionMaxTransitions });
    else validateWorkflowTransitions({ id, stages });
    const stageIdSet = new Set(stages.map((stage) => stage.id));
    const parseOracleConfig = (raw2, field) => {
      if (raw2 === void 0) return void 0;
      const candidate = object(raw2, `workflow ${id} ${field}`);
      const stageId = requireString(candidate.stageId, `workflow ${id} ${field}.stageId`, { max: 64 });
      if (!stageIdSet.has(stageId)) {
        throw new Error(`workflow ${id} ${field}.stageId references unknown stage ${stageId}`);
      }
      const evidenceKey = canonicalWorkflowEvidenceKey(requireString(candidate.evidenceKey, `workflow ${id} ${field}.evidenceKey`, { max: 128 }));
      return { stageId, evidenceKey };
    };
    const reproOracle = parseOracleConfig(value.reproOracle, "reproOracle");
    const planHash = parseOracleConfig(value.planHash, "planHash");
    let requirePlanHash;
    if (value.requirePlanHash !== void 0) {
      const required = stringArray(value.requirePlanHash, `workflow ${id} requirePlanHash`);
      for (const stageId of required) {
        if (!stageIdSet.has(stageId)) {
          throw new Error(`workflow ${id} requirePlanHash references unknown stage ${stageId}`);
        }
      }
      requirePlanHash = [...new Set(required)].sort();
    }
    let filter;
    if (value.filter !== void 0) {
      const candidate = object(value.filter, `workflow ${id} filter`);
      filter = {
        path: requireString(candidate.path, "filter.path", { max: 256 }),
        equals: requireString(candidate.equals, "filter.equals", { max: 512 })
      };
    }
    if (value.ttlMs !== void 0 && (!Number.isInteger(value.ttlMs) || value.ttlMs < MIN_MESSAGE_TTL_MS || value.ttlMs > MAX_MESSAGE_TTL_MS)) {
      throw new Error(`workflow ${id} ttlMs must be an integer between ${MIN_MESSAGE_TTL_MS} and ${MAX_MESSAGE_TTL_MS}`);
    }
    return {
      id,
      source,
      project: requireString(value.project, "workflow.project", { max: 128 }),
      target,
      secret,
      ...signalSecret ? { signalSecret } : {},
      ...value.event ? { event: requireString(value.event, "workflow.event", { max: 128 }) } : {},
      ...filter ? { filter } : {},
      delivery,
      ...value.ttlMs !== void 0 ? { ttlMs: value.ttlMs } : {},
      ...value.maxTransitions !== void 0 ? { maxTransitions: value.maxTransitions } : {},
      ...reproOracle ? { reproOracle } : {},
      ...planHash ? { planHash } : {},
      ...requirePlanHash ? { requirePlanHash } : {},
      promptTemplate: requireString(value.promptTemplate, "workflow.promptTemplate", { max: 2e4 }),
      stages
    };
  });
}
function validateWorkflowTransitions(definition) {
  const stageIndex = new Map(definition.stages.map((stage, index) => [stage.id, index]));
  let hasBackEdge = false;
  for (const stage of definition.stages) {
    if (!stage.on) continue;
    for (const [outcome, rawValue] of Object.entries(stage.on)) {
      if (!outcome.trim()) throw new Error(`stage ${stage.id} declares an empty outcome key`);
      const rule = normalizeOutcomeValue(rawValue, `stage ${stage.id} on.${outcome}`);
      if (rule.target === WORKFLOW_TERMINAL_TARGET) continue;
      const targetIndex = stageIndex.get(rule.target);
      if (targetIndex === void 0) {
        throw new Error(`stage ${stage.id} on.${outcome} targets unknown stage ${rule.target}`);
      }
      const sourceIndex = stageIndex.get(stage.id);
      if (targetIndex > sourceIndex + 1) {
        throw new Error(
          `stage ${stage.id} on.${outcome} skips intermediate stages by targeting ${rule.target}; forward transitions must target the next stage so approvals and gates cannot be bypassed`
        );
      }
      if (targetIndex <= sourceIndex) hasBackEdge = true;
    }
  }
  if (definition.maxTransitions !== void 0 && (!Number.isInteger(definition.maxTransitions) || definition.maxTransitions < 1 || definition.maxTransitions > 200)) {
    throw new Error(`workflow ${definition.id} maxTransitions must be an integer between 1 and 200`);
  }
  if (hasBackEdge && (definition.maxTransitions === void 0 || definition.maxTransitions < 1)) {
    throw new Error(`workflow ${definition.id} declares a back-edge but no maxTransitions budget; cycles without budgets are rejected`);
  }
}
function parseOutcomeMap(stageId, raw) {
  if (raw === void 0) return void 0;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`stage ${stageId} on must be an object`);
  }
  const map = {};
  for (const [outcome, value] of Object.entries(raw)) {
    map[outcome] = normalizeOutcomeValue(value, `stage ${stageId} on.${outcome}`);
  }
  return map;
}
function valueAtPath(payload, path) {
  let current = payload;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return void 0;
    current = current[part];
  }
  return current;
}
function renderWorkflowPrompt(template, payload) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, path) => {
    const value = valueAtPath(payload, path);
    if (value === void 0 || value === null) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}
function canonicalizeForHash(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).filter(([, candidate]) => candidate !== void 0).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, candidate]) => [key, canonicalizeForHash(candidate)])
    );
  }
  return value;
}
function canonicalWorkflowDefinitionJson(definition) {
  const { secret: _secret, signalSecret: _signalSecret, ...publicDefinition } = definition;
  return JSON.stringify(canonicalizeForHash(publicDefinition));
}
function workflowDefinitionHash(definition) {
  return createHash("sha256").update(canonicalWorkflowDefinitionJson(definition), "utf8").digest("hex");
}
function resolveOutcomeRule(stage, outcomeKey) {
  const raw = stage.on?.[outcomeKey];
  return raw === void 0 ? void 0 : normalizeOutcomeValue(raw, `stage ${stage.id} on.${outcomeKey}`);
}
function transitionCounts(run, fromStage, outcome, target) {
  const records = run.transitions ?? [];
  return {
    total: records.length,
    fromStage: records.filter((record) => record.fromStage === fromStage).length,
    forEdge: records.filter((record) => record.fromStage === fromStage && record.outcome === outcome && record.toStage === target).length
  };
}
function recordTransition(run, fromStage, rule, outcome, attempt, evidenceKeys, timestamp) {
  const record = {
    id: newId("trans"),
    fromStage,
    toStage: rule.target,
    outcome,
    attempt,
    evidenceKeys,
    at: timestamp
  };
  run.transitions = [...run.transitions ?? [], record];
  return record;
}
function enterStage(run, stage, timestamp) {
  stage.status = "in_progress";
  stage.attempts = 0;
  stage.evidence = {};
  stage.verifiedEvidence = {};
  stage.startedAt = timestamp;
  stage.updatedAt = timestamp;
  delete stage.summary;
  run.currentStage = stage.id;
  run.updatedAt = timestamp;
}
function takeDeclaredTransition(run, stage, rule, outcome, summary, attempt, timestamp, evidenceKeys) {
  const definitionBudget = run.maxTransitions;
  const counts = transitionCounts(run, stage.id, outcome, rule.target);
  const edgeExhausted = rule.maxTransitions !== void 0 && counts.forEdge >= rule.maxTransitions;
  const stageExhausted = stage.maxTransitions !== void 0 && counts.fromStage >= stage.maxTransitions;
  const globalExhausted = definitionBudget !== void 0 && counts.total >= definitionBudget;
  if (edgeExhausted || stageExhausted || globalExhausted) {
    stage.completedAt = timestamp;
    run.status = "failed";
    delete run.currentStage;
    run.updatedAt = timestamp;
    return {
      retry: false,
      completed: false,
      run,
      exhausted: true
    };
  }
  const record = recordTransition(run, stage.id, rule, outcome, attempt, evidenceKeys.slice(0, 32), timestamp);
  if (rule.target === WORKFLOW_TERMINAL_TARGET) {
    stage.completedAt = timestamp;
    run.status = "completed";
    delete run.currentStage;
    run.completedAt = timestamp;
    run.updatedAt = timestamp;
    return { retry: false, completed: true, run, transition: record };
  }
  const target = run.stages.find((candidate) => candidate.id === rule.target);
  if (!target) {
    run.status = "failed";
    delete run.currentStage;
    return { retry: false, completed: false, run, exhausted: true };
  }
  stage.summary = summary;
  enterStage(run, target, timestamp);
  return { retry: false, completed: false, run, transition: record };
}
function evidenceValueSha256(evidence, key) {
  const values = evidence[canonicalWorkflowEvidenceKey(key)];
  if (!values || values.length === 0) return void 0;
  return createHash("sha256").update([...values].sort().join("\n"), "utf8").digest("hex");
}
function enforceOracles(run, stageId, evidence) {
  if (run.oracle) {
    const presented = evidenceValueSha256(evidence, run.oracle.evidenceKey);
    if (presented !== void 0 && presented !== run.oracle.sha256) {
      throw new ProtocolError(
        400,
        `evidence ${run.oracle.evidenceKey} does not match the immutable reproduction oracle captured at ${run.oracle.capturedAt}; the confirmed reproduction may not be weakened`,
        "weakened_reproduction"
      );
    }
  }
  if (run.requirePlanHash?.includes(stageId) && !run.planHash) {
    throw new ProtocolError(
      400,
      `stage ${stageId} requires an approved plan hash before it can checkpoint`,
      "plan_hash_required"
    );
  }
}
function captureOracles(run, stageId, evidence, timestamp) {
  if (run.reproOracle?.stageId === stageId) {
    const sha256 = evidenceValueSha256(evidence, run.reproOracle.evidenceKey);
    if (sha256 !== void 0) {
      run.oracle = { evidenceKey: run.reproOracle.evidenceKey, sha256, capturedAt: timestamp };
    }
  }
  if (run.planHashConfig?.stageId === stageId) {
    const sha256 = evidenceValueSha256(evidence, run.planHashConfig.evidenceKey);
    if (sha256 !== void 0) {
      run.planHash = { evidenceKey: run.planHashConfig.evidenceKey, sha256, capturedAt: timestamp };
    }
  }
}
function checkpointRun(run, stageId, status, summary, evidence, timestamp, verifiedEvidence = {}, outcome) {
  if (run.status !== "running") throw new ProtocolError(409, `workflow is ${run.status}`, "workflow_terminal");
  const stage = run.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new ProtocolError(404, `workflow stage not found: ${stageId}`, "workflow_stage_not_found");
  if (stage.id !== run.currentStage || stage.status !== "in_progress") {
    throw new ProtocolError(409, `stage ${stageId} is not currently active`, "workflow_stage_out_of_order");
  }
  const accumulatedEvidence = mergeWorkflowEvidence(stage.evidence, evidence);
  const accumulatedVerifiedEvidence = mergeVerifiedWorkflowEvidence(stage.verifiedEvidence, verifiedEvidence);
  enforceOracles(run, stageId, accumulatedEvidence);
  const peerStatuses = status === "passed" ? requireCompleteEvidence(stage, accumulatedEvidence, accumulatedVerifiedEvidence, run.id) : [];
  const degradedRequirements = peerStatuses.filter((peerStatus) => peerStatus.degraded);
  stage.attempts += 1;
  stage.summary = summary;
  if (status === "passed") {
    stage.evidence = accumulatedEvidence;
    if (Object.keys(accumulatedVerifiedEvidence).length) stage.verifiedEvidence = accumulatedVerifiedEvidence;
    captureOracles(run, stageId, accumulatedEvidence, timestamp);
    if (degradedRequirements.length) {
      stage.degraded = true;
      stage.degradedRequirements = degradedRequirements.map((peerStatus) => peerStatus.requirementKey);
    }
  }
  stage.updatedAt = timestamp;
  run.updatedAt = timestamp;
  if (status !== "passed") {
    stage.status = status;
    if (stage.attempts >= stage.maxAttempts) {
      stage.completedAt = timestamp;
      run.status = "failed";
      delete run.currentStage;
      return { retry: false, completed: false, run };
    }
    if (stage.autoResumeLimit !== void 0 && stage.attempts >= stage.autoResumeLimit) {
      stage.status = "in_progress";
      const reason = summary || `autoResumeLimit of ${stage.autoResumeLimit} reached on stage ${stage.id}`;
      const receipt = validateTerminalReceipt({
        schema: TERMINAL_RECEIPT_SCHEMA,
        status: "audit_escalation",
        seat: stage.id,
        runId: run.id,
        stageId: stage.id,
        timestamp,
        host: "pi",
        model: "default",
        escalationReason: reason
      });
      const expiresAt = new Date(Date.parse(timestamp) + 24 * 60 * 60 * 1e3).toISOString();
      waitForWorkflowSignal(run, stage.id, "audit_escalation", reason, timestamp, expiresAt);
      stage.receipt = receipt;
      stage.auditEscalation = {
        reason,
        timestamp,
        receipt
      };
      return { retry: false, completed: false, run };
    }
    stage.status = status;
    const outcomeKey = outcome ?? status;
    const rule = resolveOutcomeRule(stage, outcomeKey);
    if (rule && stage.attempts < stage.maxAttempts) {
      const result = takeDeclaredTransition(run, stage, rule, outcomeKey, summary, stage.attempts, timestamp, Object.keys(accumulatedEvidence));
      if (result.transition !== void 0 && !result.completed && rule.target !== stage.id) {
        stage.status = "pending";
      }
      return result;
    }
    stage.status = "in_progress";
    return { retry: true, completed: false, run };
  }
  stage.status = "passed";
  stage.completedAt = timestamp;
  const passedRule = resolveOutcomeRule(stage, outcome ?? "passed");
  if (passedRule) {
    return takeDeclaredTransition(run, stage, passedRule, outcome ?? "passed", summary, stage.attempts, timestamp, Object.keys(accumulatedEvidence));
  }
  const next = run.stages.find((candidate) => candidate.status === "pending");
  if (next) {
    next.status = "in_progress";
    next.startedAt = timestamp;
    next.updatedAt = timestamp;
    run.currentStage = next.id;
    return {
      retry: false,
      completed: false,
      run,
      ...degradedRequirements.length ? { degraded: true } : {}
    };
  }
  run.status = "completed";
  delete run.currentStage;
  run.completedAt = timestamp;
  return {
    retry: false,
    completed: true,
    run,
    ...degradedRequirements.length ? { degraded: true } : {}
  };
}
function waitForWorkflowSignal(run, stageId, signalKey, summary, timestamp, expiresAt, evidence = {}, verifiedEvidence = {}) {
  if (run.status !== "running") throw new ProtocolError(409, `workflow is ${run.status}`, "workflow_not_running");
  const stage = run.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new ProtocolError(404, `workflow stage not found: ${stageId}`, "workflow_stage_not_found");
  if (stage.id !== run.currentStage || stage.status !== "in_progress") {
    throw new ProtocolError(409, `stage ${stageId} is not currently active`, "workflow_stage_out_of_order");
  }
  if (Date.parse(expiresAt) <= Date.parse(timestamp)) {
    throw new ProtocolError(400, "workflow signal expiry must be in the future", "workflow_wait_invalid");
  }
  stage.evidence = mergeWorkflowEvidence(stage.evidence, evidence);
  const accumulatedVerifiedEvidence = mergeVerifiedWorkflowEvidence(stage.verifiedEvidence, verifiedEvidence);
  if (Object.keys(accumulatedVerifiedEvidence).length) stage.verifiedEvidence = accumulatedVerifiedEvidence;
  stage.status = "waiting";
  stage.updatedAt = timestamp;
  run.status = "waiting";
  run.waiting = { stageId, signalKey, summary, createdAt: timestamp, expiresAt };
  run.updatedAt = timestamp;
  return run;
}
function resumeWorkflowFromSignal(run, signalKey, status, summary, evidence, timestamp) {
  if (run.status !== "waiting" || !run.waiting) {
    throw new ProtocolError(409, `workflow is ${run.status}`, "workflow_not_waiting");
  }
  if (run.waiting.signalKey !== signalKey) {
    throw new ProtocolError(409, `workflow is waiting for ${run.waiting.signalKey}`, "workflow_signal_mismatch");
  }
  const stageId = run.waiting.stageId;
  const stage = run.stages.find((candidate) => candidate.id === stageId);
  if (!stage || stage.id !== run.currentStage || stage.status !== "waiting") {
    throw new ProtocolError(409, "workflow wait state is inconsistent", "workflow_wait_inconsistent");
  }
  const accumulatedEvidence = mergeWorkflowEvidence(stage.evidence, evidence);
  if (status === "passed") {
    requireCompleteEvidence(
      stage,
      accumulatedEvidence,
      normalizeVerifiedWorkflowEvidence(stage.verifiedEvidence),
      run.id
    );
  }
  run.status = "running";
  stage.status = "in_progress";
  delete run.waiting;
  const result = checkpointRun(run, stageId, status, summary, evidence, timestamp);
  return { ...result, stageId };
}
function approveWorkflowDegradation(run, stageId, requirement, reason, approvalId, timestamp) {
  if (run.status !== "running" && run.status !== "waiting") {
    throw new ProtocolError(409, `workflow is ${run.status}`, "workflow_terminal");
  }
  const stage = run.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new ProtocolError(404, `workflow stage not found: ${stageId}`, "workflow_stage_not_found");
  if (stage.id !== run.currentStage || stage.status !== "in_progress" && stage.status !== "waiting") {
    throw new ProtocolError(409, `stage ${stageId} is not currently active`, "workflow_stage_out_of_order");
  }
  const requirementKey = canonicalWorkflowEvidenceKey(requirement);
  const policy = stage.resolvedEvidencePolicies?.[requirementKey];
  if (!policy?.degradation) {
    throw new ProtocolError(
      400,
      `requirement ${requirementKey} does not permit degraded quorum`,
      "workflow_degradation_forbidden"
    );
  }
  const attempt = activeWorkflowAttempt(stage);
  const existing = stage.degradationApprovals?.find(
    (candidate) => candidate.requirementKey === requirementKey && candidate.attempt === attempt
  );
  if (existing) {
    if (existing.reason !== reason.trim()) {
      throw new ProtocolError(
        409,
        `degradation was already approved for ${requirementKey} attempt ${attempt}`,
        "workflow_degradation_conflict"
      );
    }
    return { run, approval: existing, created: false };
  }
  const approval = {
    schema: "pi-mesh.workflow-degradation-approval.v1",
    id: approvalId,
    requirementKey,
    attempt,
    policyMinProducers: policy.minProducers,
    approvedMinProducers: policy.degradation.minProducers,
    approvedBy: "kxm-admin",
    reason: requireString(reason, "reason", { max: 1e3 }),
    approvedAt: timestamp
  };
  (stage.degradationApprovals ??= []).push(approval);
  stage.updatedAt = timestamp;
  run.updatedAt = timestamp;
  return { run, approval, created: true };
}

// plugins/kxm/src/client.ts
var HubHttpError = class extends Error {
  statusCode;
  code;
  requestId;
  extras;
  constructor(statusCode, message, code, requestId, extras) {
    super(message);
    this.name = "HubHttpError";
    this.statusCode = statusCode;
    if (code) this.code = code;
    if (requestId) this.requestId = requestId;
    if (extras) this.extras = extras;
  }
};

// plugins/kxm/src/commands.ts
function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}
function optionalString2(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function optionalWorkflowContext(value) {
  if (value === void 0) return void 0;
  const context = asRecord(value);
  if (!Number.isInteger(context.attempt) || context.attempt < 1 || context.attempt > 20) {
    throw new Error("workflowContext.attempt must be an integer between 1 and 20");
  }
  return {
    runId: requiredString(context.runId, "workflowContext.runId"),
    stageId: requiredString(context.stageId, "workflowContext.stageId"),
    requirementKey: requiredString(context.requirementKey, "workflowContext.requirementKey"),
    attempt: context.attempt
  };
}
function optionalEvidenceRefs(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function isTerminalMessageError(error) {
  return error instanceof HubHttpError && (error.statusCode === 409 || error.statusCode === 404 && error.code === "message_not_found");
}
function isTerminalMessage(message) {
  return message.status === "replied" || message.status === "cancelled" || message.status === "expired" || message.status === "error";
}
async function reconcileInbox(client, inbox, notifiedInbox) {
  await Promise.all(
    [...inbox.keys()].map(async (messageId) => {
      try {
        const current = await client.getMessage(messageId);
        if (isTerminalMessage(current)) {
          inbox.delete(messageId);
          notifiedInbox?.delete(messageId);
        } else {
          inbox.set(messageId, current);
        }
      } catch (error) {
        if (isTerminalMessageError(error)) {
          inbox.delete(messageId);
          notifiedInbox?.delete(messageId);
          return;
        }
        throw error;
      }
    })
  );
}
function resolveProject(client, projectArg) {
  const proj = optionalString2(projectArg) ?? client.agent?.project;
  if (!proj) {
    throw new Error('missing required parameter "project"');
  }
  return proj;
}
var AGENT_COMMANDS = [
  {
    name: "kxm_list",
    group: "peer",
    verb: "list",
    label: "List hub peers",
    description: "List peer agents in this project's hub pool with their names, purposes, host label, and hub-clocked presence (online, stale, offline). Registered offline peers are listed only when includeOffline is set.",
    parameters: {
      type: "object",
      properties: {
        includeOffline: {
          type: "boolean",
          description: "Also list registered peers whose hub lease has expired"
        }
      },
      additionalProperties: false
    },
    async execute(client, args) {
      return { agents: await client.listAgents({ includeOffline: args.includeOffline === true }) };
    }
  },
  {
    name: "kxm_send",
    group: "peer",
    verb: "send",
    label: "Send peer request",
    description: "Send a focused request to a peer agent. Returns a message ID for kxm_get or kxm_await. For durable peer evidence, workflowContext is the hub-authorized provenance scope; correlation and idempotency are transport concerns and do not establish evidence provenance.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Peer name or agent ID" },
        content: { type: "string", description: "Focused request with the expected response or artifact" },
        delivery: {
          type: "string",
          enum: ["steer", "followUp", "nextTurn"],
          default: "followUp",
          description: "followUp is the safe default; use steer only for active blockers"
        },
        correlationId: {
          type: "string",
          description: "Optional task grouping; the hub binds it to runId when workflowContext is supplied"
        },
        idempotencyKey: {
          type: "string",
          description: "Retry/deduplication key only; not a workflow security or evidence binding"
        },
        workflowContext: {
          type: "object",
          description: "Requested provenance scope; the hub authorizes and persists the canonical binding",
          properties: {
            runId: { type: "string", description: "Active durable workflow run ID" },
            stageId: { type: "string", description: "Active workflow stage ID" },
            requirementKey: { type: "string", description: "Required evidence identity this peer reply may satisfy" },
            attempt: { type: "integer", minimum: 1, maximum: 20, description: "Current one-based stage attempt" }
          },
          required: ["runId", "stageId", "requirementKey", "attempt"],
          additionalProperties: false
        },
        ttlMs: { type: "number", minimum: 1e3, maximum: 6048e5, description: "Message TTL in milliseconds" },
        allowOffline: {
          type: "boolean",
          default: false,
          description: "Queue the request if the target is a registered offline agent in this project"
        }
      },
      required: ["target", "content"],
      additionalProperties: false
    },
    async execute(client, args) {
      const delivery = optionalString2(args.delivery);
      const correlationId = optionalString2(args.correlationId);
      const idempotencyKey = optionalString2(args.idempotencyKey);
      const workflowContext = optionalWorkflowContext(args.workflowContext);
      const message = await client.send({
        target: requiredString(args.target, "target"),
        content: requiredString(args.content, "content"),
        ...delivery ? { delivery } : {},
        ...correlationId ? { correlationId } : {},
        ...idempotencyKey ? { idempotencyKey } : {},
        ...workflowContext ? { workflowContext } : {},
        ...typeof args.ttlMs === "number" ? { ttlMs: args.ttlMs } : {},
        ...args.allowOffline === true ? { allowOffline: true } : {}
      });
      return { messageId: message.id, status: message.status, target: message.toName };
    }
  },
  {
    name: "kxm_get",
    group: "peer",
    verb: "get",
    label: "Get peer request",
    description: "Check the status and optional reply for a previously sent request.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID of the sent request" }
      },
      required: ["messageId"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.getMessage(requiredString(args.messageId, "messageId"));
    }
  },
  {
    name: "kxm_fanout",
    group: "peer",
    verb: "fanout",
    label: "Fanout peer requests",
    description: "Ask one through three peers independently and return replies for comparison and synthesis. A local timeout or request cancellation returns a pending response with a durable messageId for kxm_get or an exact retry.",
    parameters: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 3,
          description: "One through three target peer names or agent IDs"
        },
        content: { type: "string", description: "Task description sent to all targets" },
        correlationId: {
          type: "string",
          description: "Optional task grouping; the hub binds it to runId when workflowContext is supplied"
        },
        idempotencyKeyPrefix: {
          type: "string",
          description: "Stable retry/deduplication prefix only; not a workflow security or evidence binding"
        },
        workflowContext: {
          type: "object",
          description: "Requested provenance scope shared by each request",
          properties: {
            runId: { type: "string", description: "Active durable workflow run ID" },
            stageId: { type: "string", description: "Active workflow stage ID" },
            requirementKey: { type: "string", description: "Required evidence identity these peer replies may satisfy" },
            attempt: { type: "integer", minimum: 1, maximum: 20, description: "Current one-based stage attempt" }
          },
          required: ["runId", "stageId", "requirementKey", "attempt"],
          additionalProperties: false
        },
        ttlMs: { type: "number", minimum: 1e3, maximum: 6048e5, description: "Message TTL in milliseconds" },
        timeoutMs: { type: "number", minimum: 100, maximum: 18e5, description: "Client wait timeout in milliseconds" }
      },
      required: ["targets", "content"],
      additionalProperties: false
    },
    async execute(client, args, context) {
      const targets = Array.isArray(args.targets) ? args.targets.map((t) => requiredString(t, "target")) : [];
      return {
        responses: await client.fanout({
          targets,
          content: requiredString(args.content, "content"),
          ...optionalString2(args.correlationId) ? { correlationId: optionalString2(args.correlationId) } : {},
          ...optionalString2(args.idempotencyKeyPrefix) ? { idempotencyKeyPrefix: optionalString2(args.idempotencyKeyPrefix) } : {},
          ...optionalWorkflowContext(args.workflowContext) ? { workflowContext: optionalWorkflowContext(args.workflowContext) } : {},
          ...typeof args.ttlMs === "number" ? { ttlMs: args.ttlMs } : {},
          ...typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {},
          ...context?.signal ? { signal: context.signal } : {}
        })
      };
    }
  },
  {
    name: "kxm_await",
    group: "peer",
    verb: "await",
    label: "Await peer response",
    description: "Wait until a sent request receives a reply or reaches a terminal error. Capped at 60 seconds (60000ms); longer waits are workflow wait steps.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID of the sent request" },
        timeoutMs: {
          type: "number",
          minimum: 100,
          maximum: 6e4,
          default: 6e4,
          description: "Timeout in milliseconds (capped at 60 seconds)"
        }
      },
      required: ["messageId"],
      additionalProperties: false
    },
    async execute(client, args, context) {
      const timeoutMs = Math.min(
        typeof args.timeoutMs === "number" ? args.timeoutMs : 6e4,
        6e4
      );
      return await client.awaitResponse(
        requiredString(args.messageId, "messageId"),
        timeoutMs,
        context?.signal
      );
    }
  },
  {
    name: "kxm_cancel",
    group: "peer",
    verb: "cancel",
    label: "Cancel peer request",
    description: "Cancel a queued or delivered request sent by this agent.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID of the request to cancel" }
      },
      required: ["messageId"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.cancel(requiredString(args.messageId, "messageId"));
    }
  },
  {
    name: "kxm_inbox",
    group: "peer",
    verb: "inbox",
    label: "List inbound requests",
    description: "List inbound peer requests awaiting a reply.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    async execute(client, _args, context) {
      if (context?.inbox) {
        await reconcileInbox(client, context.inbox, context.notifiedInbox);
        return { messages: [...context.inbox.values()] };
      }
      return { messages: [] };
    }
  },
  {
    name: "kxm_reply",
    group: "peer",
    verb: "reply",
    label: "Reply to peer request",
    description: "Reply to an inbound peer request using its message ID.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID of the inbound request" },
        content: { type: "string", description: "Final response with evidence and remaining risks" }
      },
      required: ["messageId", "content"],
      additionalProperties: false
    },
    async execute(client, args, context) {
      const messageId = requiredString(args.messageId, "messageId");
      try {
        const message = await client.reply(messageId, requiredString(args.content, "content"));
        if (context?.inbox) {
          context.inbox.delete(messageId);
          context.notifiedInbox?.delete(messageId);
        }
        return { messageId, status: message.status, recipient: message.fromName };
      } catch (error) {
        if (context?.inbox && isTerminalMessageError(error)) {
          context.inbox.delete(messageId);
          context.notifiedInbox?.delete(messageId);
        }
        throw error;
      }
    }
  },
  {
    name: "kxm_workflow_list",
    group: "workflow",
    verb: "runs",
    label: "List workflow runs",
    description: "List durable webhook workflows assigned to this agent.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    async execute(client) {
      return { runs: await client.listWorkflows() };
    }
  },
  {
    name: "kxm_workflow_get",
    group: "workflow",
    verb: "run",
    label: "Get workflow run",
    description: "Get a workflow's stages and journal of plans, decisions, contradictions, errors, and lessons.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Workflow run ID" }
      },
      required: ["runId"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.getWorkflow(requiredString(args.runId, "runId"));
    }
  },
  {
    name: "kxm_workflow_checkpoint",
    group: "workflow",
    verb: "checkpoint",
    label: "Checkpoint workflow stage",
    description: "Record a stage result with evidence keyed by the stage's required evidence identities. Cite peer-reply requirements through evidenceRefs so the hub can verify provenance and quorum; caller-authored evidence strings cannot satisfy those policies. Warnings and failures require another attempt until passed or exhausted.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Active durable workflow run ID" },
        stageId: { type: "string", description: "Active stage ID" },
        status: { type: "string", enum: ["passed", "warning", "failed"], description: "Stage outcome" },
        summary: { type: "string", description: "Summary of changes, verification, and remaining risks" },
        evidence: {
          type: "object",
          additionalProperties: { type: "string" },
          maxProperties: 64,
          description: "Key-value evidence mapping required keys to proof strings"
        },
        evidenceRefs: {
          type: "object",
          description: "Peer evidence references keyed by required evidence identity",
          patternProperties: {
            "^(.*)$": {
              type: "object",
              properties: {
                messageIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 }
              },
              required: ["messageIds"],
              additionalProperties: false
            }
          },
          additionalProperties: {
            type: "object",
            properties: {
              messageIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 }
            },
            required: ["messageIds"],
            additionalProperties: false
          },
          maxProperties: 32
        }
      },
      required: ["runId", "stageId", "status", "summary"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.checkpointWorkflow(requiredString(args.runId, "runId"), {
        stageId: requiredString(args.stageId, "stageId"),
        status: requiredString(args.status, "status"),
        summary: requiredString(args.summary, "summary"),
        ...args.evidence && typeof args.evidence === "object" && !Array.isArray(args.evidence) ? { evidence: args.evidence } : {},
        ...optionalEvidenceRefs(args.evidenceRefs) ? { evidenceRefs: optionalEvidenceRefs(args.evidenceRefs) } : {}
      });
    }
  },
  {
    name: "kxm_workflow_record",
    group: "workflow",
    verb: "record",
    label: "Record workflow journal entry",
    description: "Record a plan, decision, contradiction, error, or lesson for continuous improvement.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Active durable workflow run ID" },
        category: {
          type: "string",
          enum: ["plan", "decision", "contradiction", "error", "lesson"],
          description: "Category of journal entry"
        },
        area: {
          type: "string",
          enum: ["harness", "gates", "implementation", "workflow", "documentation", "security", "other"],
          description: "System area"
        },
        severity: {
          type: "string",
          enum: ["info", "warning", "error"],
          default: "info",
          description: "Severity level"
        },
        summary: { type: "string", description: "Concise description of the observation or decision" },
        details: { type: "string", description: "Extended details, context, and reasoning" },
        evidence: {
          type: "array",
          items: { type: "string" },
          maxItems: 32,
          description: "Durable evidence strings or URIs"
        },
        relatedEntryIds: {
          type: "array",
          items: { type: "string" },
          maxItems: 16,
          description: "Related previous journal entry IDs"
        }
      },
      required: ["runId", "category", "area", "summary"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.recordWorkflowEntry(requiredString(args.runId, "runId"), {
        category: requiredString(args.category, "category"),
        area: requiredString(args.area, "area"),
        ...optionalString2(args.severity) ? { severity: optionalString2(args.severity) } : {},
        summary: requiredString(args.summary, "summary"),
        ...optionalString2(args.details) ? { details: optionalString2(args.details) } : {},
        ...Array.isArray(args.evidence) ? { evidence: args.evidence } : {},
        ...Array.isArray(args.relatedEntryIds) ? { relatedEntryIds: args.relatedEntryIds } : {}
      });
    }
  },
  {
    name: "kxm_workflow_wait",
    group: "workflow",
    verb: "wait",
    label: "Wait for workflow signal",
    description: "Pause the active stage until a signed external callback checkpoints it and resumes the coordinator. Cite peer-reply requirements through evidenceRefs so the hub can verify provenance and quorum; verified evidence is accumulated with callback evidence.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Active durable workflow run ID" },
        stageId: { type: "string", description: "Active stage ID" },
        signalKey: { type: "string", description: "Stable callback key, such as github-pr-42-checks" },
        summary: { type: "string", description: "What is running externally and what result is expected" },
        evidence: {
          type: "object",
          additionalProperties: { type: "string" },
          maxProperties: 64,
          description: "Evidence gathered before the wait"
        },
        evidenceRefs: {
          type: "object",
          description: "Peer evidence references verified before waiting",
          patternProperties: {
            "^(.*)$": {
              type: "object",
              properties: {
                messageIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 }
              },
              required: ["messageIds"],
              additionalProperties: false
            }
          },
          additionalProperties: {
            type: "object",
            properties: {
              messageIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 }
            },
            required: ["messageIds"],
            additionalProperties: false
          },
          maxProperties: 32
        },
        timeoutMs: {
          type: "number",
          minimum: 1e3,
          maximum: 2592e6,
          description: "Maximum wait duration in milliseconds"
        }
      },
      required: ["runId", "stageId", "signalKey", "summary"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.waitForWorkflowSignal(requiredString(args.runId, "runId"), {
        stageId: requiredString(args.stageId, "stageId"),
        signalKey: requiredString(args.signalKey, "signalKey"),
        summary: requiredString(args.summary, "summary"),
        ...args.evidence && typeof args.evidence === "object" && !Array.isArray(args.evidence) ? { evidence: args.evidence } : {},
        ...optionalEvidenceRefs(args.evidenceRefs) ? { evidenceRefs: optionalEvidenceRefs(args.evidenceRefs) } : {},
        ...typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}
      });
    }
  },
  {
    name: "kxm_improvement_report",
    group: "workflow",
    verb: "improve-report",
    label: "Summarize improvement report",
    description: "Summarize workflow errors, contradictions, and lessons by improvement area.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    async execute(client) {
      return await client.improvementReport();
    }
  },
  {
    name: "kxm_context",
    group: "context",
    verb: "get",
    label: "Get KXM context packet",
    description: "Normal entry point for KXM context. Assembles a token-budgeted role-aware context packet from durable journal evidence, temporal state, knowledge, episodes, and skills. Superseded and rejected records are excluded. Use KXM context tools instead of provider-specific memory APIs.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project scope (must be the client's project)" },
        role: {
          type: "string",
          description: "Requesting role: repro, planner, critic, implementer, verifier, or custom"
        },
        task: { type: "string", description: "What the role is trying to accomplish" },
        workflowRunId: { type: "string", description: "Workflow run scope" },
        stageId: { type: "string", description: "Workflow stage scope" },
        budgetTokens: { type: "integer", description: "Token budget; defaults to the role policy" },
        includeKinds: {
          type: "array",
          items: { type: "string", enum: ["evidence", "state", "episode", "knowledge", "skill"] },
          description: "Restrict packet to these item kinds"
        }
      },
      required: ["role", "task"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.contextGet({
        project: resolveProject(client, args.project),
        role: requiredString(args.role, "role"),
        task: requiredString(args.task, "task"),
        ...optionalString2(args.workflowRunId) ? { workflowRunId: optionalString2(args.workflowRunId) } : {},
        ...optionalString2(args.stageId) ? { stageId: optionalString2(args.stageId) } : {},
        ...typeof args.budgetTokens === "number" ? { budgetTokens: args.budgetTokens } : {},
        ...Array.isArray(args.includeKinds) ? { includeKinds: args.includeKinds } : {}
      });
    }
  },
  {
    name: "kxm_recall",
    group: "context",
    verb: "recall",
    label: "Recall context metadata",
    description: "Search durable context records for a project by query; returns bounded metadata only.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project identifier" },
        query: { type: "string", description: "Query string" },
        kinds: { type: "array", items: { type: "string" }, description: "Kinds filter" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum results" }
      },
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.contextRecall({
        project: resolveProject(client, args.project),
        ...optionalString2(args.query) ? { query: optionalString2(args.query) } : {},
        ...Array.isArray(args.kinds) ? { kinds: args.kinds } : {},
        ...typeof args.limit === "number" ? { limit: args.limit } : {}
      });
    }
  },
  {
    name: "kxm_state",
    group: "context",
    verb: "state",
    label: "Get temporal state",
    description: "Current value for one temporal state key, optionally as of a historical timestamp.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project identifier" },
        key: { type: "string", description: "State key" },
        asOf: { type: "string", description: "ISO-8601 timestamp for historical queries" }
      },
      required: ["key"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.contextState({
        project: resolveProject(client, args.project),
        key: requiredString(args.key, "key"),
        ...optionalString2(args.asOf) ? { asOf: optionalString2(args.asOf) } : {}
      });
    }
  },
  {
    name: "kxm_episode",
    group: "context",
    verb: "episode",
    label: "Get workflow episodes",
    description: "Episodic learning from workflow journals: errors, lessons, observations, experiments for a project.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project identifier" },
        workflowRunId: { type: "string", description: "Optional workflow run scope" }
      },
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.contextEpisode({
        project: resolveProject(client, args.project),
        ...optionalString2(args.workflowRunId) ? { workflowRunId: optionalString2(args.workflowRunId) } : {}
      });
    }
  },
  {
    name: "kxm_promote",
    group: "context",
    verb: "promote",
    label: "Propose state promotion",
    description: "Propose a change to one authoritative state key. Promotion requires durable evidence.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project identifier" },
        key: { type: "string", description: "State key to promote" },
        summary: { type: "string", description: "Promotion summary" },
        authority: {
          type: "string",
          enum: ["policy", "instruction", "evidence", "hypothesis"],
          description: "Authority class"
        },
        confidence: {
          type: "string",
          enum: ["verified", "probable", "uncertain"],
          description: "Confidence level"
        },
        evidenceRefs: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 32,
          description: "Evidence item references backing the promotion"
        }
      },
      required: ["key", "summary", "authority", "confidence", "evidenceRefs"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.contextStatePropose({
        project: resolveProject(client, args.project),
        key: requiredString(args.key, "key"),
        summary: requiredString(args.summary, "summary"),
        authority: requiredString(args.authority, "authority"),
        confidence: requiredString(args.confidence, "confidence"),
        evidenceRefs: Array.isArray(args.evidenceRefs) ? args.evidenceRefs : []
      });
    }
  }
];
var AGENT_COMMANDS_MAP = new Map(
  AGENT_COMMANDS.map((cmd) => [cmd.name, cmd])
);
function timingSafeStringCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const hashA = createHash2("sha256").update(a).digest();
  const hashB = createHash2("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

// plugins/kxm/src/redact.ts
var SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\bya29\.[A-Za-z0-9._~+/-]+=*/g,
  /\b1\/\/[A-Za-z0-9_-]+/g,
  /\b1\/[A-Za-z0-9_-]{20,}/g,
  /("?(?:access_token|refresh_token|id_token|sessionKey|session_key|claude_oauth_token|anthropicApiKey)"?\s*[:=]\s*")[^"]*(")/gi,
  /\bKXM_[A-Z0-9_]*(TOKEN|SECRET|KEY)[A-Z0-9_]*=\S+/gi,
  /\b(GITHUB_TOKEN|GH_TOKEN|KXM_AUTH_TOKEN|KXM_WORKFLOW_SIGNAL_SECRET|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_API_KEY)=\S+/gi,
  /\b[A-Fa-f0-9]{64}\b/g
];
function redactSecrets(value) {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[redacted]");
  }
  return result;
}
function redactStringList(values, maxItems = 32) {
  return values.slice(0, maxItems).map((value) => redactSecrets(value).slice(0, 500));
}

// plugins/kxm/src/context.ts
var MAX_CONTEXT_SUMMARY_CHARS = 4e3;
var MAX_CONTEXT_ID_REFS = 64;
var MAX_CONTEXT_ITEMS = 256;
var MIN_CONTEXT_BUDGET_TOKENS = 512;
var MAX_CONTEXT_BUDGET_TOKENS = 2e5;
var DEFAULT_CONTEXT_BUDGET_TOKENS = 32e3;
var MAX_CONTEXT_ROLE_CHARS = 64;
var MAX_CONTEXT_TASK_CHARS = 2e3;
var AUTHORITY_GRANT_FLOOR = {
  human: "policy",
  workflow: "policy",
  git: "instruction",
  peer: "evidence",
  tool: "evidence",
  external: "evidence",
  derived: "evidence"
};
function authorityGrantFloor(sourceType) {
  return AUTHORITY_GRANT_FLOOR[sourceType];
}
var RESERVED_CONTROL_PLANE_FIELDS = /* @__PURE__ */ new Set([
  "permissions",
  "tools",
  "allow",
  "deny",
  "grants",
  "approval",
  "policy",
  "scopes",
  "credentials",
  "secrets",
  "token",
  "apiKey",
  "password"
]);
var CONTEXT_ITEM_KINDS = ["evidence", "state", "episode", "knowledge", "skill"];
var CONTEXT_SOURCE_TYPES = [
  "human",
  "git",
  "workflow",
  "tool",
  "peer",
  "external",
  "derived"
];
var CONTEXT_AUTHORITIES = ["policy", "instruction", "evidence", "hypothesis"];
var CONTEXT_CONFIDENCES = ["verified", "probable", "uncertain"];
var CONTEXT_SCOPES = ["agent", "project", "run", "operator"];
function oneOf(value, field, allowed) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new ProtocolError(400, `${field} must be one of ${allowed.join(", ")}`, "invalid_context_field");
  }
  return value;
}
function idRefs(value, field, required = false) {
  if (value === void 0 || value === null) return required ? [] : void 0;
  if (!Array.isArray(value)) {
    throw new ProtocolError(400, `${field} must be an array of identifiers`, "invalid_context_field");
  }
  if (value.length > MAX_CONTEXT_ID_REFS) {
    throw new ProtocolError(
      400,
      `${field} exceeds ${MAX_CONTEXT_ID_REFS} references`,
      "context_limits_exceeded"
    );
  }
  const seen = /* @__PURE__ */ new Set();
  const refs = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || !candidate.trim()) {
      throw new ProtocolError(400, `${field} must contain non-empty identifiers`, "invalid_context_field");
    }
    const ref = candidate.trim();
    if (seen.has(ref)) {
      throw new ProtocolError(400, `${field} contains duplicate reference ${ref}`, "invalid_context_field");
    }
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}
function optionalIsoTimestamp(value, field) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ProtocolError(400, `${field} must be an ISO-8601 timestamp`, "invalid_context_field");
  }
  return value;
}
function parseContextItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, "context item must be an object", "invalid_context_item");
  }
  const input = value;
  for (const field of Object.keys(input)) {
    if (RESERVED_CONTROL_PLANE_FIELDS.has(field)) {
      throw new ProtocolError(
        403,
        `context items may not carry control-plane field "${field}"`,
        "context_authority_violation"
      );
    }
  }
  const item = {
    id: requireString(input.id, "context item id", { max: 128 }),
    kind: oneOf(input.kind, "context item kind", CONTEXT_ITEM_KINDS),
    project: requireString(input.project, "context item project", { max: 200 }),
    summary: redactSecrets(requireString(input.summary, "context item summary", { max: MAX_CONTEXT_SUMMARY_CHARS })),
    provenance: parseContextProvenance(input.provenance),
    authority: oneOf(input.authority, "context item authority", CONTEXT_AUTHORITIES),
    confidence: oneOf(input.confidence, "context item confidence", CONTEXT_CONFIDENCES)
  };
  if (input.scope !== void 0 && input.scope !== null) {
    item.scope = oneOf(input.scope, "context item scope", CONTEXT_SCOPES);
  }
  const observedAt = optionalIsoTimestamp(input.observedAt, "context item observedAt");
  const validFrom = optionalIsoTimestamp(input.validFrom, "context item validFrom");
  const validUntil = optionalIsoTimestamp(input.validUntil, "context item validUntil");
  if (observedAt !== void 0) item.observedAt = observedAt;
  if (validFrom !== void 0) item.validFrom = validFrom;
  if (validUntil !== void 0) item.validUntil = validUntil;
  if (input.status !== void 0 && input.status !== null) {
    item.status = oneOf(input.status, "context item status", ["current", "superseded", "proposed", "rejected"]);
  }
  const supersedes = idRefs(input.supersedes, "context item supersedes");
  if (supersedes !== void 0) {
    if (supersedes.includes(item.id)) {
      throw new ProtocolError(400, "context item cannot supersede itself", "invalid_context_item");
    }
    item.supersedes = supersedes;
  }
  const evidenceRefs = idRefs(input.evidenceRefs, "context item evidenceRefs");
  if (evidenceRefs !== void 0) item.evidenceRefs = evidenceRefs;
  const stateKey = input.stateKey === void 0 || input.stateKey === null ? void 0 : requireString(input.stateKey, "context item stateKey", { max: 200 });
  if (stateKey !== void 0) item.stateKey = stateKey;
  if (item.kind === "state" && item.stateKey === void 0) {
    throw new ProtocolError(400, "state items require a stateKey", "invalid_context_item");
  }
  if (item.kind === "state" && item.status === void 0) {
    throw new ProtocolError(400, "state items require an explicit lifecycle status", "invalid_context_item");
  }
  const grantFloor = authorityRank(authorityGrantFloor(item.provenance.sourceType));
  if (authorityRank(item.authority) > grantFloor) {
    throw new ProtocolError(
      403,
      `content of origin ${item.provenance.sourceType} cannot claim ${item.authority} authority`,
      "context_authority_violation"
    );
  }
  return item;
}
function parseContextProvenance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, "context provenance must be an object", "invalid_context_item");
  }
  const input = value;
  const provenance = {
    sourceType: oneOf(input.sourceType, "context provenance sourceType", CONTEXT_SOURCE_TYPES)
  };
  const sourceRef = input.sourceRef === void 0 || input.sourceRef === null ? void 0 : requireString(input.sourceRef, "context provenance sourceRef", { max: 512 });
  if (sourceRef !== void 0) provenance.sourceRef = redactSecrets(sourceRef);
  const derivedFrom = idRefs(input.derivedFrom, "context provenance derivedFrom");
  if (derivedFrom !== void 0) provenance.derivedFrom = derivedFrom;
  return provenance;
}
function parseContextRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, "context request must be an object", "invalid_context_request");
  }
  const input = value;
  const request = {
    project: requireString(input.project, "context request project", { max: 200 }),
    role: requireString(input.role, "context request role", { max: MAX_CONTEXT_ROLE_CHARS }),
    task: requireString(input.task, "context request task", { max: MAX_CONTEXT_TASK_CHARS })
  };
  const workflowRunId = input.workflowRunId === void 0 || input.workflowRunId === null ? void 0 : requireString(input.workflowRunId, "context request workflowRunId", { max: 128 });
  if (workflowRunId !== void 0) request.workflowRunId = workflowRunId;
  const stageId = input.stageId === void 0 || input.stageId === null ? void 0 : requireString(input.stageId, "context request stageId", { max: 128 });
  if (stageId !== void 0) request.stageId = stageId;
  if (input.budgetTokens !== void 0 && input.budgetTokens !== null) {
    const budget = input.budgetTokens;
    if (!Number.isInteger(budget) || budget < MIN_CONTEXT_BUDGET_TOKENS || budget > MAX_CONTEXT_BUDGET_TOKENS) {
      throw new ProtocolError(
        400,
        `context request budgetTokens must be an integer between ${MIN_CONTEXT_BUDGET_TOKENS} and ${MAX_CONTEXT_BUDGET_TOKENS}`,
        "invalid_context_request"
      );
    }
    request.budgetTokens = budget;
  }
  if (input.includeKinds !== void 0 && input.includeKinds !== null) {
    if (!Array.isArray(input.includeKinds) || input.includeKinds.length < 1 || input.includeKinds.length > CONTEXT_ITEM_KINDS.length) {
      throw new ProtocolError(
        400,
        "context request includeKinds must be a non-empty array of item kinds",
        "invalid_context_request"
      );
    }
    request.includeKinds = input.includeKinds.map((kind) => oneOf(kind, "context request includeKinds", CONTEXT_ITEM_KINDS));
  }
  return request;
}
function validateContextPacketContents(request, packet) {
  const items = [...packet.currentState, ...packet.knowledge, ...packet.episodes, ...packet.skills, ...packet.contradictions];
  if (items.length > MAX_CONTEXT_ITEMS) {
    throw new ProtocolError(400, `context packet exceeds ${MAX_CONTEXT_ITEMS} items`, "context_limits_exceeded");
  }
  const allowed = request.includeKinds ? new Set(request.includeKinds) : void 0;
  for (const item of items) {
    if (item.project !== request.project && item.project !== "_shared") {
      throw new ProtocolError(
        400,
        `context packet contains cross-project item ${item.id}`,
        "context_isolation_violation"
      );
    }
    if (allowed && !allowed.has(item.kind)) {
      throw new ProtocolError(
        400,
        `context packet contains item ${item.id} of unrequested kind ${item.kind}`,
        "context_isolation_violation"
      );
    }
  }
}
function estimateContextTokens(items) {
  let characters = 0;
  for (const item of items) {
    characters += item.summary.length + item.id.length + item.kind.length;
    if (item.provenance.sourceRef) characters += item.provenance.sourceRef.length;
  }
  return Math.ceil(characters / 4);
}
function authorityRank(authority) {
  switch (authority) {
    case "policy":
      return 3;
    case "instruction":
      return 2;
    case "evidence":
      return 1;
    case "hypothesis":
      return 0;
  }
}
function contextItemAuditMetadata(item) {
  const metadata = {
    id: item.id,
    kind: item.kind,
    authority: item.authority,
    confidence: item.confidence,
    sourceType: item.provenance.sourceType,
    derived: item.provenance.sourceType === "derived" || (item.provenance.derivedFrom?.length ?? 0) > 0,
    lineageDepth: item.provenance.derivedFrom?.length ?? 0
  };
  if (item.status !== void 0) metadata.status = item.status;
  if (item.provenance.sourceRef !== void 0) metadata.sourceRef = item.provenance.sourceRef;
  return metadata;
}
function provenanceSummaryOf(items) {
  const summary = {};
  for (const item of items) {
    summary[item.provenance.sourceType] = (summary[item.provenance.sourceType] ?? 0) + 1;
  }
  for (const key of Object.keys(summary).sort()) {
    if (summary[key] === 0) delete summary[key];
  }
  return summary;
}

// plugins/kxm/src/arbiter.ts
var ROLE_POLICIES = [
  {
    role: "repro",
    label: "Reproduction specialist",
    kinds: ["episode", "knowledge"],
    journalCategories: ["error", "lesson", "observation", "contradiction"],
    budgetTokens: 8e3
  },
  {
    role: "planner",
    label: "Planner",
    kinds: ["state", "knowledge", "evidence"],
    journalCategories: ["plan", "decision", "contradiction", "observation", "hypothesis", "experiment"],
    budgetTokens: 16e3
  },
  {
    role: "critic",
    label: "Independent critic",
    kinds: ["knowledge", "evidence", "episode"],
    journalCategories: ["contradiction", "error", "lesson", "experiment"],
    budgetTokens: 12e3
  },
  {
    role: "implementer",
    label: "Implementer",
    kinds: ["knowledge", "state", "skill", "episode"],
    journalCategories: ["plan", "decision", "lesson", "state-change"],
    budgetTokens: 16e3
  },
  {
    role: "verifier",
    label: "Verifier",
    kinds: ["evidence", "knowledge", "episode"],
    journalCategories: ["plan", "error", "lesson", "contradiction"],
    budgetTokens: 8e3
  }
];
function rolePolicy(role) {
  return ROLE_POLICIES.find((policy) => policy.role === role) ?? {
    role,
    label: role,
    kinds: ["knowledge", "evidence"],
    journalCategories: ["lesson", "observation"],
    budgetTokens: DEFAULT_CONTEXT_BUDGET_TOKENS
  };
}
var CONFIDENCE_RANK = { verified: 3, probable: 2, uncertain: 1 };
var AUTHORITY_WEIGHT = { policy: 3, instruction: 2, evidence: 1, hypothesis: 0 };
function arbitrate(requestInput, pool, options = {}) {
  const request = parseContextRequest(requestInput);
  const policy = rolePolicy(request.role);
  const budget = request.budgetTokens ?? policy.budgetTokens;
  const contradictions = new Set(options.contradictionIds ?? []);
  const candidates = [];
  let excludedSuperseded = 0;
  for (const candidate of pool) {
    if (candidate.project !== request.project && candidate.project !== "_shared") {
      throw new ProtocolError(
        403,
        `context pool contains cross-project item ${candidate.id}`,
        "context_isolation_violation"
      );
    }
    if (candidate.status === "superseded" || candidate.status === "rejected") {
      excludedSuperseded += 1;
      continue;
    }
    candidates.push(candidate);
  }
  if (options.skillLifecycle) {
    for (const metadata of options.skillLifecycle.list("promoted")) {
      try {
        options.skillLifecycle.verify("promoted", metadata.id);
        candidates.push(parseContextItem({
          id: `skill_${metadata.id}`,
          kind: "skill",
          project: request.project,
          summary: metadata.description ? `${metadata.name}: ${metadata.description}` : metadata.name,
          provenance: {
            sourceType: "git",
            sourceRef: `skill:${metadata.id}@${metadata.contentSha256}`
          },
          authority: "instruction",
          confidence: "verified",
          status: "current"
        }));
      } catch {
      }
    }
  }
  const kindRank = /* @__PURE__ */ new Map();
  const requestedKinds = request.includeKinds ?? policy.kinds;
  requestedKinds.forEach((kind, index) => kindRank.set(kind, index));
  const kindPreference = (item) => {
    const rank = kindRank.get(item.kind);
    return rank === void 0 ? requestedKinds.length : rank;
  };
  const ordered = [...candidates].sort(
    (left, right) => (contradictions.has(right.id) ? 1 : 0) - (contradictions.has(left.id) ? 1 : 0) || (left.project === request.project ? 0 : 1) - (right.project === request.project ? 0 : 1) || kindPreference(left) - kindPreference(right) || CONFIDENCE_RANK[right.confidence] - CONFIDENCE_RANK[left.confidence] || AUTHORITY_WEIGHT[right.authority] - AUTHORITY_WEIGHT[left.authority] || left.id.localeCompare(right.id)
  );
  const kindAllowed = (item) => (request.includeKinds ?? policy.kinds).includes(item.kind) || contradictions.has(item.id);
  const selected = [];
  const unresolvedGaps = [];
  for (const item of ordered) {
    if (selected.length >= MAX_CONTEXT_ITEMS) {
      unresolvedGaps.push("context item limit reached; refine the task or kinds");
      break;
    }
    if (!kindAllowed(item)) continue;
    const nextTokens = estimateContextTokens([...selected, item]);
    if (nextTokens > budget) {
      if (selected.length === 0) {
        unresolvedGaps.push(`budget of ${budget} tokens cannot fit any selected context`);
        break;
      }
      unresolvedGaps.push(`budget of ${budget} tokens reached; ${ordered.length - selected.length} candidates deferred`);
      break;
    }
    selected.push(item);
  }
  if (candidates.length === 0) {
    unresolvedGaps.push("no context records exist for this project yet");
  }
  const bySection = (kind) => selected.filter((item) => item.kind === kind && !contradictions.has(item.id));
  const packet = {
    workingState: options.workingState ?? {},
    currentState: bySection("state").filter((item) => item.status === "current" || item.status === void 0),
    knowledge: bySection("knowledge"),
    episodes: bySection("episode"),
    skills: bySection("skill").filter((item) => item.status !== "proposed"),
    contradictions: selected.filter((item) => contradictions.has(item.id)),
    unresolvedGaps,
    provenanceSummary: provenanceSummaryOf(selected),
    estimatedTokens: estimateContextTokens(selected)
  };
  validateContextPacketContents(request, packet);
  return {
    packet,
    audit: {
      request: {
        project: request.project,
        role: request.role,
        task: request.task,
        ...request.workflowRunId !== void 0 ? { workflowRunId: request.workflowRunId } : {},
        ...request.stageId !== void 0 ? { stageId: request.stageId } : {}
      },
      selectedIds: selected.map((item) => item.id),
      provenanceSummary: packet.provenanceSummary,
      estimatedTokens: packet.estimatedTokens,
      budgetTokens: budget,
      candidateCount: candidates.length,
      excludedSuperseded,
      unresolvedGaps
    }
  };
}
function journalEntryToContextItem(entry, project) {
  const kind = entry.category === "plan" || entry.category === "decision" || entry.category === "lesson" ? "knowledge" : entry.category === "skill-candidate" ? "skill" : "evidence";
  const item = {
    id: `journal_${entry.id}`,
    kind,
    project,
    summary: entry.summary,
    provenance: {
      sourceType: "workflow",
      sourceRef: `journal:${entry.id}`
    },
    authority: entry.category === "decision" || entry.category === "plan" ? "evidence" : "evidence",
    confidence: entry.severity === "error" ? "probable" : "probable",
    ...entry.stageId !== void 0 ? { observedAt: entry.createdAt } : {},
    evidenceRefs: entry.evidence.filter((ref) => ref.length > 0 && ref.length <= 200).slice(0, 16)
  };
  if (entry.stageId !== void 0) item.observedAt = entry.createdAt;
  if (kind === "skill") item.status = "proposed";
  return parseContextItem(item);
}
function memoryRecordToContextItem(record, project) {
  let authority = "instruction";
  if (record.authority === "evidence") {
    authority = "evidence";
  }
  const sourceType = CONTEXT_SOURCE_TYPES.includes(record.provenance?.sourceType) ? record.provenance.sourceType : "git";
  const targetProject = record.scope === "operator" ? "_shared" : project;
  return parseContextItem({
    id: `mem_${record.id}`,
    kind: "knowledge",
    scope: record.scope,
    project: targetProject,
    summary: record.summary,
    provenance: {
      sourceType,
      sourceRef: record.provenance?.sourceRef ?? `memory:${record.id}.md`
    },
    authority,
    confidence: record.confidence,
    status: record.lifecycle === "active" ? "current" : "superseded",
    evidenceRefs: record.evidenceRefs && record.evidenceRefs.length > 0 ? record.evidenceRefs : void 0
  });
}
function explainContextItem(id, pool) {
  const byId = new Map(pool.map((item2) => [item2.id, item2]));
  const item = byId.get(id);
  if (!item) return { item: void 0, lineage: [], evidenceRefs: [], sources: [] };
  const lineage = [];
  const queue = [...item.provenance.derivedFrom ?? []];
  const seen = /* @__PURE__ */ new Set();
  while (queue.length > 0) {
    const ancestorId = queue.shift();
    if (seen.has(ancestorId)) continue;
    seen.add(ancestorId);
    lineage.push(ancestorId);
    const ancestor = byId.get(ancestorId);
    for (const older of ancestor?.provenance.derivedFrom ?? []) queue.push(older);
  }
  lineage.sort();
  const sources = [item, ...lineage.map((ancestorId) => byId.get(ancestorId))].filter((candidate) => candidate !== void 0).map((candidate) => ({
    id: candidate.id,
    sourceType: candidate.provenance.sourceType,
    ...candidate.provenance.sourceRef !== void 0 ? { sourceRef: candidate.provenance.sourceRef } : {}
  }));
  return {
    item,
    lineage,
    evidenceRefs: item.evidenceRefs ?? [],
    sources
  };
}

// plugins/kxm/src/memory.ts
var import_yaml = __toESM(require_dist(), 1);
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
var MEMORY_SCHEMA = "kxm.memory.v1";
var VALID_SCOPES = /* @__PURE__ */ new Set(["agent", "project", "run", "operator"]);
var VALID_AUTHORITIES = /* @__PURE__ */ new Set(["instruction", "evidence", "promoted"]);
var VALID_CONFIDENCES = /* @__PURE__ */ new Set(["verified", "probable", "uncertain"]);
var VALID_LIFECYCLES = /* @__PURE__ */ new Set(["active", "deprecated", "superseded"]);
var BANNED_CONTROL_PLANE_FIELDS = /* @__PURE__ */ new Set([
  "permissions",
  "tools",
  "allow",
  "deny",
  "grants",
  "approval",
  "policy",
  "scopes",
  "credentials",
  "secrets",
  "token",
  "apiKey",
  "password"
]);
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("memory file must contain YAML frontmatter enclosed in '---'");
  }
  return { frontmatter: match[1] ?? "", body: match[2]?.trim() ?? "" };
}
function parseMemoryRecord(raw, filename = "memory.md") {
  const { frontmatter, body } = parseFrontmatter(raw);
  const data = (0, import_yaml.parse)(frontmatter);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`invalid YAML frontmatter in ${filename}`);
  }
  for (const field of BANNED_CONTROL_PLANE_FIELDS) {
    if (field in data) {
      throw new Error(`memory record ${filename} may not carry control-plane field '${field}'`);
    }
  }
  if (data.schema !== MEMORY_SCHEMA) {
    throw new Error(`memory record ${filename} has unsupported schema: expected ${MEMORY_SCHEMA}, got ${String(data.schema)}`);
  }
  const id = typeof data.id === "string" ? data.id.trim() : "";
  if (!id || !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/i.test(id)) {
    throw new Error(`memory record ${filename} has invalid id: ${String(data.id)}`);
  }
  const scope = data.scope;
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(`memory record ${filename} has invalid scope: must be one of agent, project, run, operator`);
  }
  const kind = typeof data.kind === "string" ? data.kind.trim() : "";
  if (!kind) {
    throw new Error(`memory record ${filename} is missing kind`);
  }
  const rawSummary = typeof data.summary === "string" ? data.summary.trim() : "";
  if (!rawSummary) {
    throw new Error(`memory record ${filename} is missing summary`);
  }
  const summary = redactSecrets(rawSummary);
  const rawProv = data.provenance;
  if (!rawProv || typeof rawProv !== "object" || typeof rawProv.sourceType !== "string" || !rawProv.sourceType.trim()) {
    throw new Error(`memory record ${filename} is missing provenance.sourceType`);
  }
  const provenance = {
    sourceType: rawProv.sourceType.trim(),
    ...typeof rawProv.sourceRef === "string" ? { sourceRef: redactSecrets(rawProv.sourceRef.trim()) } : {},
    ...typeof rawProv.runId === "string" ? { runId: rawProv.runId.trim() } : {},
    ...typeof rawProv.timestamp === "string" ? { timestamp: rawProv.timestamp.trim() } : {}
  };
  const authority = data.authority;
  if (!VALID_AUTHORITIES.has(authority)) {
    throw new Error(`memory record ${filename} has invalid authority: ${String(data.authority)}`);
  }
  const confidence = data.confidence;
  if (!VALID_CONFIDENCES.has(confidence)) {
    throw new Error(`memory record ${filename} has invalid confidence: ${String(data.confidence)}`);
  }
  const lifecycle = data.lifecycle;
  if (!VALID_LIFECYCLES.has(lifecycle)) {
    throw new Error(`memory record ${filename} has invalid lifecycle: ${String(data.lifecycle)}`);
  }
  const rawRefs = Array.isArray(data.evidenceRefs) ? data.evidenceRefs : [];
  const evidenceRefs = rawRefs.map(String);
  return {
    schema: MEMORY_SCHEMA,
    id,
    scope,
    kind,
    summary,
    provenance,
    authority,
    confidence,
    lifecycle,
    evidenceRefs,
    ...body ? { body } : {}
  };
}
function memoryDirectories(repoRoot) {
  const root = resolve(repoRoot);
  const memoryDir = join(root, ".kxm", "memory");
  const candidatesDir = join(memoryDir, "candidates");
  return { memoryDir, candidatesDir };
}
function loadAuthoredMemory(repoRoot) {
  const { memoryDir } = memoryDirectories(repoRoot);
  if (!existsSync(memoryDir)) return [];
  const records = [];
  const entries = readdirSync(memoryDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && extname(entry.name) === ".md") {
      const fullPath = join(memoryDir, entry.name);
      try {
        const text2 = readFileSync(fullPath, "utf8");
        const record = parseMemoryRecord(text2, entry.name);
        if (record.lifecycle === "active") {
          records.push(record);
        }
      } catch (error) {
        throw new Error(`failed to parse authored memory file ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return records.sort((left, right) => left.id.localeCompare(right.id));
}

// plugins/kxm/src/state.ts
var MAX_STATE_EVIDENCE_REFS = 32;
function timestampMs(value) {
  if (value === void 0) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}
function stateActiveAt(item, atMs) {
  if (item.kind !== "state") return false;
  if (item.status !== "current" && item.status !== "superseded") return false;
  const from = timestampMs(item.validFrom);
  const until = item.validUntil === void 0 ? Number.POSITIVE_INFINITY : timestampMs(item.validUntil);
  return from <= atMs && atMs < until;
}
function latestActive(items) {
  let best;
  for (const item of items) {
    if (best === void 0 || timestampMs(item.validFrom) > timestampMs(best.validFrom) || timestampMs(item.validFrom) === timestampMs(best.validFrom) && item.id > best.id) {
      best = item;
    }
  }
  return best;
}
function findSuperseder(items, id) {
  return items.find((item) => (item.supersedes ?? []).includes(id));
}
function detectStateContradictions(project, items, setValuedKeys = /* @__PURE__ */ new Set()) {
  const byKey = /* @__PURE__ */ new Map();
  for (const item of items) {
    if (item.kind !== "state" || item.project !== project) continue;
    const key = item.stateKey ?? "";
    const bucket = byKey.get(key) ?? [];
    bucket.push(item);
    byKey.set(key, bucket);
  }
  const contradictions = [];
  for (const [stateKey, bucket] of [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (setValuedKeys.has(stateKey)) continue;
    const competingCurrentIds = bucket.filter((item) => item.status === "current").map((item) => item.id).sort();
    const competingProposalIds = bucket.filter((item) => item.status === "proposed").map((item) => item.id).sort();
    if (competingCurrentIds.length > 1 || competingProposalIds.length > 1) {
      contradictions.push({ project, stateKey, competingCurrentIds, competingProposalIds });
    }
  }
  return contradictions;
}
function parseStateItem(value) {
  const item = parseContextItem(value);
  if (item.kind !== "state") {
    throw new ProtocolError(400, "state layer accepts only state items", "invalid_state_item");
  }
  return item;
}
var NativeStateProvider = class {
  name = "native-sqlite";
  store;
  now;
  setValuedKeys;
  constructor(store, options = {}) {
    this.store = store;
    this.now = options.now ?? nowIso;
    this.setValuedKeys = options.setValuedKeys ?? /* @__PURE__ */ new Set();
  }
  projectState(project) {
    return this.store.listContextItems(project, ["state"]);
  }
  itemsForKey(project, key) {
    return this.projectState(project).filter((item) => item.stateKey === key);
  }
  /** Current value for a key at a point in time. Superseded values never
   * appear as current: historical queries return the item that *was* current
   * at `asOf` via its validity window. Fails closed when a single-valued key
   * holds competing current items. */
  async get(project, key, asOf) {
    const scopedProject = requireNonEmpty(project, "project");
    const scopedKey = requireNonEmpty(key, "key");
    if (this.setValuedKeys.has(scopedKey)) {
      throw new ProtocolError(
        400,
        `state key ${scopedKey} is set-valued; use currentSet`,
        "state_key_set_valued"
      );
    }
    const atMs = asOf === void 0 ? Date.parse(this.now()) : requireIso(asOf, "asOf");
    const active = this.itemsForKey(scopedProject, scopedKey).filter((item) => stateActiveAt(item, atMs));
    const currents = active.filter((item) => item.status === "current");
    if (currents.length > 1) {
      throw new ProtocolError(
        409,
        `state key ${scopedKey} has competing current items; resolve the contradiction first`,
        "state_contradiction"
      );
    }
    const winner = currents.length === 1 ? currents[0] : latestActive(active);
    return winner ?? null;
  }
  /** All current items for a set-valued key. */
  async currentSet(project, key) {
    const scopedProject = requireNonEmpty(project, "project");
    const scopedKey = requireNonEmpty(key, "key");
    if (!this.setValuedKeys.has(scopedKey)) {
      throw new ProtocolError(400, `state key ${scopedKey} is single-valued`, "state_key_single_valued");
    }
    return this.itemsForKey(scopedProject, scopedKey).filter((item) => item.status === "current").sort((left, right) => left.id.localeCompare(right.id));
  }
  /** Record a proposal. Proposing changes nothing until an authorized,
   * evidence-bound promotion runs. Returns the durable proposal item ID. */
  async propose(change) {
    if (change?.schema !== "kxm.state-change-proposal.v1") {
      throw new ProtocolError(400, "invalid state change proposal schema", "invalid_state_proposal");
    }
    const project = requireNonEmpty(change.project, "proposal project");
    const key = requireNonEmpty(change.key, "proposal key");
    const evidenceRefs = boundedRefs(change.evidenceRefs, "proposal evidenceRefs");
    const proposal = parseStateItem({
      id: newId("ctx"),
      kind: "state",
      project,
      summary: change.summary,
      provenance: {
        sourceType: change.proposedBy.startsWith("agent_") ? "peer" : "human",
        sourceRef: `proposed-by:${change.proposedBy}`
      },
      authority: change.authority,
      confidence: change.confidence,
      stateKey: key,
      status: "proposed",
      validFrom: this.now(),
      evidenceRefs,
      ...change.supersedes ? { supersedes: boundedRefs(change.supersedes, "proposal supersedes") } : {}
    });
    this.store.saveContextItem(proposal);
    return proposal.id;
  }
  /** Promote a proposal to current with durable evidence. The promoter must
   * differ from the proposal author (agents may propose but never silently
   * promote). Superseded previous values get an explicit validity window so
   * historical queries stay deterministic. */
  async promote(proposalId, evidence, promotedBy) {
    const id = requireNonEmpty(proposalId, "proposalId");
    const promoter = requireNonEmpty(promotedBy, "promotedBy");
    const evidenceRefs = boundedRefs(evidence, "promotion evidence");
    const proposal = this.store.getContextItem(id);
    if (!proposal || proposal.kind !== "state") {
      throw new ProtocolError(404, `state proposal ${id} not found`, "state_proposal_not_found");
    }
    if (proposal.status !== "proposed") {
      throw new ProtocolError(
        400,
        `state proposal ${id} already reached lifecycle state ${proposal.status}`,
        "state_proposal_not_promotable"
      );
    }
    const proposedBy = proposal.provenance.sourceRef?.startsWith("proposed-by:") ? proposal.provenance.sourceRef.slice("proposed-by:".length) : void 0;
    if (proposedBy === promoter) {
      throw new ProtocolError(
        400,
        "the author of a state proposal cannot promote it",
        "state_promotion_invalid"
      );
    }
    const now = this.now();
    const key = proposal.stateKey ?? "";
    if (!key) {
      throw new ProtocolError(400, "state proposal has no stateKey", "state_promotion_invalid");
    }
    let supersededIds = [];
    if (!this.setValuedKeys.has(key)) {
      const atMs = Date.parse(now);
      const supersededItems = this.itemsForKey(proposal.project, key).filter((item) => item.status === "current" && stateActiveAt(item, atMs));
      supersededIds = supersededItems.map((item) => item.id);
      for (const item of supersededItems) {
        this.store.saveContextItem({
          ...item,
          status: "superseded",
          validUntil: now
        });
      }
    }
    const promoted = parseStateItem({
      ...proposal,
      id: newId("ctx"),
      status: "current",
      validFrom: now,
      validUntil: void 0,
      supersedes: [.../* @__PURE__ */ new Set([...proposal.supersedes ?? [], ...supersededIds])].sort(),
      evidenceRefs: [.../* @__PURE__ */ new Set([...proposal.evidenceRefs ?? [], ...evidenceRefs])].sort(),
      provenance: {
        ...proposal.provenance,
        sourceRef: `promoted-by:${promoter}`
      }
    });
    this.store.saveContextItem({ ...proposal, status: "rejected", validUntil: now });
    this.store.saveContextItem(promoted);
    return promoted;
  }
  /** Which item superseded `id`, if any. */
  async supersededBy(project, id) {
    const scopedProject = requireNonEmpty(project, "project");
    const superseder = findSuperseder(this.projectState(scopedProject), id);
    return superseder ?? null;
  }
  /** Audit trail for one key: proposals, promotions, and supersessions in
   * deterministic order. */
  stateHistory(project, key) {
    return this.itemsForKey(project, key).sort(
      (left, right) => timestampMs(left.validFrom) - timestampMs(right.validFrom) || left.id.localeCompare(right.id)
    );
  }
  contradictions() {
    const projects = [...new Set([...this.store.contextItems.values()].map((item) => item.project))];
    return projects.flatMap((project) => detectStateContradictions(project, this.projectState(project), this.setValuedKeys));
  }
};
function requireNonEmpty(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProtocolError(400, `${field} cannot be empty`, "invalid_state_request");
  }
  return value.trim();
}
function requireIso(value, field) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ProtocolError(400, `${field} must be an ISO-8601 timestamp`, "invalid_state_request");
  }
  return parsed;
}
function boundedRefs(value, field) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_STATE_EVIDENCE_REFS) {
    throw new ProtocolError(
      400,
      `${field} must contain between 1 and ${MAX_STATE_EVIDENCE_REFS} references`,
      "state_promotion_invalid"
    );
  }
  return value.map((ref) => requireNonEmpty(ref, `${field} entry`));
}

// plugins/kxm/src/skills.ts
var import_yaml2 = __toESM(require_dist(), 1);
import { createHash as createHash3 } from "node:crypto";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readdirSync as readdirSync2, readFileSync as readFileSync2, renameSync, rmSync, statSync, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
var SKILL_CANDIDATE_SCHEMA = "kxm.skill-candidate.v1";
var SKILL_EVALUATION_SCHEMA = "kxm.skill-evaluation.v1";
var SKILL_DECISION_SCHEMA = "kxm.skill-decision.v1";
var MAX_SKILL_NAME_CHARS = 64;
var MAX_SKILL_CONTENT_CHARS = 32e3;
var MAX_SKILL_EVIDENCE_REFS = 32;
var MAX_SKILL_MODELS = 16;
var PROMOTION_REQUIRED_EVALUATIONS = [
  "static-review",
  "sandbox",
  "functional",
  "safety"
];
var SkillLifecycleError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "SkillLifecycleError";
    this.code = code;
  }
};
function skillContentSha256(content) {
  return createHash3("sha256").update(content, "utf8").digest("hex");
}
function skillIdFor(name, contentSha256) {
  const slug = name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!slug) throw new SkillLifecycleError("invalid_skill_name", "skill name must contain alphanumeric characters");
  return `${slug}.${contentSha256.slice(0, 12)}`;
}
function parseSkillFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: null, body: content };
  }
  const rawFm = match[1];
  const rawBody = match[2];
  if (rawFm === void 0 || rawBody === void 0) {
    return { frontmatter: null, body: content };
  }
  try {
    const parsed = (0, import_yaml2.parse)(rawFm);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { frontmatter: parsed, body: rawBody };
    }
  } catch {
  }
  return { frontmatter: null, body: content };
}
function ensureSkillFrontmatter(content, name, description) {
  const parsed = parseSkillFrontmatter(content);
  if (parsed.frontmatter) {
    const fmName = typeof parsed.frontmatter.name === "string" && parsed.frontmatter.name.trim() ? parsed.frontmatter.name.trim() : name;
    const fmDesc = typeof parsed.frontmatter.description === "string" && parsed.frontmatter.description.trim() ? parsed.frontmatter.description.trim() : description || `Governed skill for ${fmName}`;
    const rest2 = parsed.body.replace(/^(\r?\n)+/, "");
    return `---
name: ${fmName}
description: ${fmDesc}
---

${rest2}`;
  }
  const desc = description || `Governed skill for ${name}`;
  const rest = content.replace(/^(\r?\n)+/, "");
  return `---
name: ${name}
description: ${desc}
---

${rest}`;
}
function createUnifiedPatch(relativePath, content) {
  const lines = content.split("\n");
  const count = lines.length;
  const header = [
    `diff --git a/${relativePath} b/${relativePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${count} @@`
  ];
  const body = lines.map((l) => `+${l}`);
  return [...header, ...body, ""].join("\n");
}
var SkillLifecycle = class {
  root;
  now;
  allowOptimizationEvals;
  constructor(root, options = {}) {
    this.root = root;
    this.now = options.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
    this.allowOptimizationEvals = options.allowOptimizationEvals === true;
  }
  dir(state) {
    return join2(this.root, state === "candidate" ? "candidates" : `${state}s`.replace("rejecteds", "rejected").replace("promoteds", "promoted"));
  }
  historyFile(id) {
    return join2(this.root, "history", `${id}.jsonl`);
  }
  paths(state, id) {
    const dir = join2(this.dir(state), id);
    return { dir, metadata: join2(dir, "metadata.json"), skill: join2(dir, "SKILL.md") };
  }
  appendHistory(id, record) {
    mkdirSync2(join2(this.root, "history"), { recursive: true });
    const line = `${JSON.stringify(record)}
`;
    if (existsSync2(this.historyFile(id))) {
      const existing = readFileSync2(this.historyFile(id), "utf8");
      const lines = existing.split("\n").filter((entry) => entry.trim());
      writeFileSync2(this.historyFile(id), [...lines.slice(-499), line.trim()].join("\n") + "\n");
    } else {
      writeFileSync2(this.historyFile(id), line);
    }
  }
  history(id) {
    const file = this.historyFile(id);
    if (!existsSync2(file)) return [];
    return readFileSync2(file, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  }
  readMetadata(state, id) {
    const { metadata } = this.paths(state, id);
    if (!existsSync2(metadata)) {
      throw new SkillLifecycleError("skill_not_found", `skill ${id} not found in ${state}`);
    }
    return JSON.parse(readFileSync2(metadata, "utf8"));
  }
  move(from, to, id) {
    const fromDir = join2(this.dir(from), id);
    const toDir = join2(this.dir(to), id);
    if (!existsSync2(fromDir)) {
      throw new SkillLifecycleError("skill_not_found", `skill ${id} not found in ${from}`);
    }
    mkdirSync2(this.dir(to), { recursive: true });
    if (existsSync2(toDir)) rmSync(toDir, { recursive: true, force: true });
    renameSync(fromDir, toDir);
  }
  /** Submit a new skill candidate. Content is redacted of secret material at
   * creation; the ID is derived from name + content hash. */
  create(input) {
    const name = input.name?.trim();
    if (!name || name.length > MAX_SKILL_NAME_CHARS) {
      throw new SkillLifecycleError("invalid_skill_name", `skill name must be 1-${MAX_SKILL_NAME_CHARS} characters`);
    }
    const rawContent = redactSecrets(input.content ?? "");
    if (!rawContent.trim() || rawContent.length > MAX_SKILL_CONTENT_CHARS) {
      throw new SkillLifecycleError("invalid_skill_content", `skill content must be 1-${MAX_SKILL_CONTENT_CHARS} characters`);
    }
    const rawDesc = redactSecrets(input.description?.trim() ?? "");
    const content = ensureSkillFrontmatter(rawContent, name, rawDesc);
    if (content.length > MAX_SKILL_CONTENT_CHARS) {
      throw new SkillLifecycleError("invalid_skill_content", `skill content must be 1-${MAX_SKILL_CONTENT_CHARS} characters`);
    }
    const { frontmatter } = parseSkillFrontmatter(content);
    const description = typeof frontmatter?.description === "string" && frontmatter.description.trim() ? frontmatter.description.trim() : rawDesc || `Governed skill for ${name}`;
    const sources = {
      runIds: boundedList(input.sources?.runIds, "runIds"),
      journalEntryIds: boundedList(input.sources?.journalEntryIds, "journalEntryIds"),
      evidenceReceipts: boundedList(input.sources?.evidenceReceipts, "evidenceReceipts")
    };
    if (sources.runIds.length === 0 && sources.journalEntryIds.length === 0 && sources.evidenceReceipts.length === 0) {
      throw new SkillLifecycleError(
        "skill_sources_required",
        "a skill candidate must reference at least one source run, journal entry, or evidence receipt"
      );
    }
    const createdBy = input.createdBy?.trim();
    if (!createdBy) throw new SkillLifecycleError("invalid_skill_author", "createdBy is required");
    const models = boundedList(input.compatibility?.models, "compatibility.models");
    if (models.length === 0 || models.length > MAX_SKILL_MODELS) {
      throw new SkillLifecycleError("invalid_skill_compatibility", `compatibility.models must list 1-${MAX_SKILL_MODELS} models`);
    }
    const harness = input.compatibility?.harness?.trim();
    if (!harness) throw new SkillLifecycleError("invalid_skill_compatibility", "compatibility.harness is required");
    const contentSha256 = skillContentSha256(content);
    const id = skillIdFor(name, contentSha256);
    const { dir, metadata, skill } = this.paths("candidate", id);
    if (existsSync2(metadata)) {
      throw new SkillLifecycleError(
        "skill_candidate_exists",
        `identical candidate ${id} already exists; changed behavior requires changed content`
      );
    }
    const record = {
      schema: SKILL_CANDIDATE_SCHEMA,
      id,
      name,
      description,
      contentSha256,
      version: input.version ?? 1,
      sources,
      compatibility: { harness, models },
      createdBy,
      createdAt: this.now(),
      ...input.supersedes ? { supersedes: input.supersedes } : {}
    };
    mkdirSync2(dir, { recursive: true });
    writeFileSync2(skill, content);
    writeFileSync2(metadata, `${JSON.stringify(record, null, 2)}
`);
    this.appendHistory(id, { schema: "kxm.skill-history-event.v1", event: "candidate_created", by: createdBy, supersedes: input.supersedes, at: record.createdAt });
    return record;
  }
  /** Record a protected evaluation. A failed functional or safety evaluation
   * deterministically quarantines the candidate. */
  evaluate(candidateId, input) {
    if (input.kind === "optimization" && !this.allowOptimizationEvals) {
      throw new SkillLifecycleError(
        "skill_optimization_disabled",
        "optimization evaluations are disabled; enable them explicitly behind protected evals"
      );
    }
    const metadata = this.readMetadata("candidate", candidateId);
    const evaluatorVersion = input.evaluatorVersion?.trim();
    if (!evaluatorVersion) throw new SkillLifecycleError("invalid_skill_evaluation", "evaluatorVersion is required");
    const evaluation = {
      schema: SKILL_EVALUATION_SCHEMA,
      candidateId,
      kind: input.kind,
      evaluatorVersion,
      passed: input.passed === true,
      ...input.score !== void 0 ? { score: input.score } : {},
      ...input.details ? { details: redactSecrets(input.details.slice(0, 2e3)) } : {},
      evaluatedAt: this.now()
    };
    this.appendHistory(candidateId, evaluation);
    let quarantined = false;
    if (!evaluation.passed && (input.kind === "functional" || input.kind === "safety")) {
      const decision = {
        schema: SKILL_DECISION_SCHEMA,
        candidateId,
        decision: "quarantined",
        decidedBy: input.evaluatedBy?.trim() || `evaluator:${evaluatorVersion}`,
        reason: `automatic quarantine: ${input.kind} evaluation failed (${evaluatorVersion})`,
        evidenceRefs: [`evaluation:${input.kind}:${evaluatorVersion}`],
        decidedAt: this.now()
      };
      this.move("candidate", "quarantined", candidateId);
      this.appendHistory(candidateId, decision);
      quarantined = true;
    }
    return { evaluation, quarantined };
  }
  evaluationsFor(candidateId) {
    return this.history(candidateId).filter(
      (record) => record.schema === SKILL_EVALUATION_SCHEMA
    );
  }
  /** Promote a candidate that passed every protected evaluation. The
   * promoter must differ from the author, cite durable evidence, and the
   * promoted content is hash-pinned and immutable. Emits a unified diff patch
   * instead of moving the candidate directory. */
  promote(candidateId, decision) {
    const metadata = this.readMetadata("candidate", candidateId);
    const decidedBy = decision.decidedBy?.trim();
    if (!decidedBy) throw new SkillLifecycleError("invalid_skill_decision", "decidedBy is required");
    if (decidedBy === metadata.createdBy) {
      throw new SkillLifecycleError("skill_promotion_invalid", "the author of a skill candidate cannot promote it");
    }
    const evidenceRefs = boundedList(decision.evidenceRefs, "evidenceRefs");
    if (evidenceRefs.length === 0) {
      throw new SkillLifecycleError("skill_promotion_invalid", "promotion requires durable evidence references");
    }
    const evaluations = this.evaluationsFor(candidateId);
    const missing = [];
    for (const kind of PROMOTION_REQUIRED_EVALUATIONS) {
      const latest = [...evaluations].reverse().find((record2) => record2.kind === kind);
      if (!latest || !latest.passed) missing.push(kind);
    }
    if (missing.length > 0) {
      throw new SkillLifecycleError(
        "skill_evaluations_incomplete",
        `promotion requires passing ${missing.join(", ")} evaluations`
      );
    }
    this.verify("candidate", candidateId);
    const record = {
      schema: SKILL_DECISION_SCHEMA,
      candidateId,
      decision: "promoted",
      decidedBy,
      reason: decision.reason?.trim() || "passed protected evaluation",
      evidenceRefs,
      decidedAt: this.now()
    };
    const candidatePaths = this.paths("candidate", candidateId);
    const promotedPaths = this.paths("promoted", candidateId);
    mkdirSync2(promotedPaths.dir, { recursive: true });
    const skillContent = readFileSync2(candidatePaths.skill, "utf8");
    const metadataContent = readFileSync2(candidatePaths.metadata, "utf8");
    writeFileSync2(promotedPaths.skill, skillContent);
    writeFileSync2(promotedPaths.metadata, metadataContent);
    const patchesDir = join2(this.root, "patches");
    mkdirSync2(patchesDir, { recursive: true });
    const patchPath = join2(patchesDir, `${candidateId}.patch`);
    const relSkillPath = `.kxm/skills/promoted/${candidateId}/SKILL.md`;
    const relMetaPath = `.kxm/skills/promoted/${candidateId}/metadata.json`;
    const patch = `${createUnifiedPatch(relSkillPath, skillContent)}${createUnifiedPatch(relMetaPath, metadataContent)}`;
    writeFileSync2(patchPath, patch, "utf8");
    this.appendHistory(candidateId, record);
    return { ...metadata, patch, patchPath };
  }
  reject(candidateId, decision) {
    const metadata = this.readMetadata("candidate", candidateId);
    const record = {
      schema: SKILL_DECISION_SCHEMA,
      candidateId,
      decision: "rejected",
      decidedBy: decision.decidedBy?.trim() || "kxm-admin",
      reason: decision.reason?.trim() || "rejected",
      evidenceRefs: [],
      decidedAt: this.now()
    };
    this.move("candidate", "rejected", candidateId);
    this.appendHistory(candidateId, record);
    return metadata;
  }
  /** Verify content integrity of a stored skill (any state). Detects
   * out-of-band edits to promoted skills and verifies standard YAML frontmatter. */
  verify(state, id) {
    const metadata = this.readMetadata(state, id);
    const { skill } = this.paths(state, id);
    const content = readFileSync2(skill, "utf8");
    if (skillContentSha256(content) !== metadata.contentSha256) {
      throw new SkillLifecycleError(
        "skill_integrity_violation",
        `skill ${id} content does not match its pinned hash; promoted skills are immutable and require a new candidate/eval cycle`
      );
    }
    const { frontmatter } = parseSkillFrontmatter(content);
    if (!frontmatter || typeof frontmatter.name !== "string" || !frontmatter.name.trim() || typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
      throw new SkillLifecycleError(
        "invalid_skill_frontmatter",
        `skill ${id} must contain valid YAML frontmatter with 'name' and 'description'`
      );
    }
    return metadata;
  }
  list(state) {
    const dir = this.dir(state);
    if (!existsSync2(dir)) return [];
    const ids = readdirSorted(dir);
    return ids.map((id) => {
      try {
        return this.readMetadata(state, id);
      } catch {
        return void 0;
      }
    }).filter((metadata) => metadata !== void 0);
  }
  read(state, id) {
    const metadata = this.readMetadata(state, id);
    const { skill } = this.paths(state, id);
    return { metadata, content: readFileSync2(skill, "utf8") };
  }
};
function boundedList(value, field) {
  if (value === void 0) return [];
  if (!Array.isArray(value)) {
    throw new SkillLifecycleError("invalid_skill_input", `${field} must be an array of strings`);
  }
  const refs = value.map((ref) => String(ref).trim()).filter((ref) => ref.length > 0);
  if (refs.length > MAX_SKILL_EVIDENCE_REFS) {
    throw new SkillLifecycleError("invalid_skill_input", `${field} exceeds ${MAX_SKILL_EVIDENCE_REFS} references`);
  }
  return [...new Set(refs)];
}
function readdirSorted(dir) {
  return readdirSync2(dir).filter((entry) => statSync(join2(dir, entry)).isDirectory()).sort();
}

// plugins/kxm/src/wiki.ts
var WIKI_ROOT = ".kxm/knowledge/wiki";
var SECTION_BY_KIND = {
  knowledge: "architecture",
  decision: "decisions",
  episode: "incidents",
  skill: "patterns"
};
function wikiSectionFor(item) {
  if (SECTION_BY_KIND[item.kind]) return SECTION_BY_KIND[item.kind];
  if (item.provenance.sourceRef?.startsWith("journal:")) {
    return "incidents";
  }
  return "patterns";
}
function claimLine(item) {
  const refs = [`\`${item.id}\``];
  if (item.provenance.sourceRef) refs.push(`source: \`${item.provenance.sourceRef}\``);
  const lineage = item.provenance.derivedFrom ?? [];
  if (lineage.length > 0) refs.push(`derived from: ${lineage.map((id) => `\`${id}\``).join(", ")}`);
  const authority = item.authority === "policy" || item.authority === "instruction" ? ` (${item.authority})` : "";
  return `- ${redactSecrets(item.summary)}${authority} \u2014 ${refs.join(" \xB7 ")}`;
}
function page(title, heading, claims, footer) {
  const lines = [
    `# ${title}`,
    "",
    heading,
    "",
    ...claims.length > 0 ? claims.map(claimLine) : ["_No reviewed records yet._"],
    "",
    footer
  ];
  return `${lines.join("\n")}
`;
}
var GENERATED_FOOTER = "<!-- generated by kxm context wiki-compile; the wiki is a compiled view, not the authoritative database -->";
function compileKnowledgeWiki(pool) {
  const pages = /* @__PURE__ */ new Map();
  const live = pool.contextItems.filter(
    (item) => item.status !== "superseded" && item.status !== "rejected"
  );
  const superseded = pool.contextItems.filter((item) => item.status === "superseded");
  const sections = /* @__PURE__ */ new Map();
  for (const item of live) {
    const section = wikiSectionFor(item);
    const bucket = sections.get(section) ?? [];
    bucket.push(item);
    sections.set(section, bucket);
  }
  const indexLines = [
    `# ${pool.project} knowledge wiki`,
    "",
    "Compiled synthesis of durable journal evidence, temporal state, and governed records. Every claim links back to its evidence; open contradictions are listed, never silently resolved.",
    ""
  ];
  for (const section of [...sections.keys()].sort()) {
    const items = sections.get(section).sort((left, right) => left.id.localeCompare(right.id));
    const path = `${WIKI_ROOT}/${section}/${pool.project}.md`;
    pages.set(
      path,
      page(
        `${pool.project} \u2014 ${section}`,
        `Claims below are compiled from reviewed records. Each line links the record ID and source.`,
        items,
        GENERATED_FOOTER
      )
    );
    indexLines.push(`- [${section}](${section}/${pool.project}.md) \u2014 ${items.length} claim(s)`);
  }
  const currentState = pool.stateItems.filter((item) => item.status === "current");
  const supersededState = pool.stateItems.filter((item) => item.status === "superseded");
  const statePath = `${WIKI_ROOT}/architecture/${pool.project}-state.md`;
  const stateLines = [
    `# ${pool.project} \u2014 temporal state`,
    "",
    "Rendered from the authoritative state layer. Current values are live; superseded values are kept visible with their validity window and successor link.",
    "",
    "## Current",
    "",
    ...currentState.length > 0 ? currentState.sort((left, right) => (left.stateKey ?? "").localeCompare(right.stateKey ?? "")).map((item) => claimLine(item)) : ["_No current state records._"],
    "",
    "## Superseded",
    "",
    ...supersededState.length > 0 ? supersededState.sort((left, right) => (left.stateKey ?? "").localeCompare(right.stateKey ?? "")).map((item) => claimLine(item)) : ["_No superseded state records._"],
    "",
    GENERATED_FOOTER
  ];
  pages.set(statePath, `${stateLines.join("\n")}
`);
  indexLines.push(`- [temporal state](${pool.project}-state.md) \u2014 ${currentState.length} current, ${supersededState.length} superseded`);
  const decisions = live.filter((item) => item.kind === "knowledge" && item.provenance.sourceRef?.startsWith("journal:") === false);
  if (decisions.length > 0) {
    pages.set(
      `${WIKI_ROOT}/decisions/${pool.project}.md`,
      page(
        `${pool.project} \u2014 decisions`,
        "Decision records with their evidence links.",
        decisions.sort((left, right) => left.id.localeCompare(right.id)),
        GENERATED_FOOTER
      )
    );
    indexLines.push(`- [decisions (tracked records)](decisions/${pool.project}.md) \u2014 ${decisions.length}`);
  }
  const contradictionLines = [
    `# ${pool.project} \u2014 open contradictions`,
    "",
    "These remain unresolved by compilation. Resolution happens through evidence-backed state promotion or journal decisions, never through re-generating this page.",
    ""
  ];
  let contradictionCount = 0;
  for (const contradiction of [...pool.contradictions].sort((left, right) => left.stateKey.localeCompare(right.stateKey))) {
    contradictionCount += 1;
    contradictionLines.push(
      `## \`${contradiction.stateKey}\``,
      "",
      `- Competing current records: ${contradiction.competingCurrentIds.map((id) => `\`${id}\``).join(", ") || "none"}`,
      `- Competing proposals: ${contradiction.competingProposalIds.map((id) => `\`${id}\``).join(", ") || "none"}`,
      ""
    );
  }
  for (const id of [...pool.openContradictionItemIds].sort()) {
    contradictionCount += 1;
    contradictionLines.push(`- Unresolved journal contradiction: \`${id}\``);
  }
  if (contradictionCount === 0) contradictionLines.push("_No open contradictions._");
  contradictionLines.push("", GENERATED_FOOTER);
  pages.set(`${WIKI_ROOT}/contradictions/${pool.project}.md`, `${contradictionLines.join("\n")}
`);
  indexLines.push(`- [contradictions](contradictions/${pool.project}.md) \u2014 ${contradictionCount} open`);
  if (superseded.length > 0) {
    pages.set(
      `${WIKI_ROOT}/incidents/${pool.project}-history.md`,
      page(
        `${pool.project} \u2014 superseded knowledge history`,
        "Superseded records retained for learning. Never presented as current truth.",
        superseded.sort((left, right) => left.id.localeCompare(right.id)),
        GENERATED_FOOTER
      )
    );
    indexLines.push(`- [superseded history](incidents/${pool.project}-history.md) \u2014 ${superseded.length}`);
  }
  indexLines.push("", GENERATED_FOOTER);
  const index = `${indexLines.join("\n")}
`;
  pages.set(`${WIKI_ROOT}/index.md`, index);
  return {
    pages,
    index,
    audit: {
      project: pool.project,
      pages: [...pages.keys()].sort(),
      stateItems: pool.stateItems.length,
      contextItems: pool.contextItems.length,
      contradictions: contradictionCount,
      compiledAt: pool.compiledAt
    }
  };
}
function lintKnowledgeWiki(pages, pool) {
  const issues = [];
  const knownIds = /* @__PURE__ */ new Set([
    ...pool.stateItems.map((item) => item.id),
    ...pool.contextItems.map((item) => item.id)
  ]);
  const index = pages.get(`${WIKI_ROOT}/index.md`);
  for (const [path, content] of pages) {
    if (path.endsWith("index.md")) continue;
    for (const match of content.matchAll(/`((?:ctx|journal)_[A-Za-z0-9_]+)`/g)) {
      const id = match[1];
      if (!knownIds.has(id)) {
        issues.push({ severity: "error", rule: "broken_ref", path, message: `references unknown record ${id}` });
      }
    }
    if (index && !index.includes(path.split("/").pop())) {
      issues.push({ severity: "warning", rule: "orphan_page", path, message: "not linked from index.md" });
    }
    for (const item of pool.stateItems) {
      if (item.status !== "superseded" || !item.stateKey) continue;
      const claimPattern = new RegExp(`Current[\\s\\S]{0,400}\`${item.id}\``, "u");
      if (claimPattern.test(content)) {
        issues.push({
          severity: "error",
          rule: "stale_state_link",
          path,
          message: `renders superseded state item ${item.id} (key ${item.stateKey}) as current`
        });
      }
    }
  }
  const hasContradictions = pool.contradictions.length > 0 || pool.openContradictionItemIds.length > 0;
  if (hasContradictions && index && !index.includes("contradictions")) {
    issues.push({
      severity: "error",
      rule: "unresolved_contradiction",
      path: `${WIKI_ROOT}/index.md`,
      message: "open contradictions exist but the index does not surface them"
    });
  }
  return issues.sort((left, right) => left.path.localeCompare(right.path) || left.message.localeCompare(right.message));
}

// plugins/kxm/src/retrospective.ts
import { mkdirSync as mkdirSync3, renameSync as renameSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { resolve as resolve2 } from "node:path";
var MAX_RETROSPECTIVE_ENTRIES = 500;
var SAFE_RUN_ID = /^run_[A-Za-z0-9_-]{1,120}$/;
function durationMs(startedAt, completedAt) {
  if (!startedAt || !completedAt) return void 0;
  const value = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(value) && value >= 0 ? value : void 0;
}
function increment(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}
function classFromEvidence(evidence) {
  const match = evidence.find((item) => item.startsWith("class:"));
  return match?.slice("class:".length) || "unknown";
}
function buildEvidenceAudit(run) {
  const audit = [];
  for (const stage of run.stages) {
    const verifiedEvidence = normalizeVerifiedWorkflowEvidence(stage.verifiedEvidence);
    const degradedRequirements = new Set(
      (stage.degradedRequirements ?? []).map(canonicalWorkflowEvidenceKey)
    );
    const policies = Object.entries(stage.resolvedEvidencePolicies ?? {}).sort(([left], [right]) => left.localeCompare(right));
    for (const [rawRequirement, policy] of policies) {
      const requirementKey = canonicalWorkflowEvidenceKey(rawRequirement);
      const attempt = stage.status === "passed" || stage.status === "failed" ? Math.max(1, stage.attempts) : stage.attempts + 1;
      const verifiedMessages = [...verifiedEvidence[requirementKey] ?? []].filter((snapshot) => snapshot.context.runId === run.id && snapshot.context.stageId === stage.id && snapshot.context.requirementKey === requirementKey && snapshot.context.attempt === attempt).sort((left, right) => left.messageId.localeCompare(right.messageId)).map((snapshot) => ({
        schema: snapshot.schema,
        messageId: snapshot.messageId,
        producerId: snapshot.producerId,
        producerName: snapshot.producerName,
        context: {
          schema: snapshot.context.schema,
          runId: snapshot.context.runId,
          stageId: snapshot.context.stageId,
          requirementKey: snapshot.context.requirementKey,
          attempt: snapshot.context.attempt
        },
        status: snapshot.status,
        hashes: {
          requestSha256: snapshot.requestSha256,
          replySha256: snapshot.replySha256
        },
        timestamps: {
          createdAt: snapshot.createdAt,
          replyCreatedAt: snapshot.replyCreatedAt,
          repliedAt: snapshot.repliedAt,
          verifiedAt: snapshot.verifiedAt
        }
      }));
      const degradationApprovals = (stage.degradationApprovals ?? []).filter((approval) => approval.schema === "pi-mesh.workflow-degradation-approval.v1" && approval.requirementKey === requirementKey && approval.attempt === attempt).sort((left, right) => left.attempt - right.attempt || left.approvedAt.localeCompare(right.approvedAt) || left.id.localeCompare(right.id)).map((approval) => ({
        schema: approval.schema,
        id: approval.id,
        requirementKey: approval.requirementKey,
        attempt: approval.attempt,
        policyMinProducers: approval.policyMinProducers,
        approvedMinProducers: approval.approvedMinProducers,
        approvedBy: approval.approvedBy,
        reason: redactSecrets(approval.reason).replace(/\s+/gu, " ").trim(),
        approvedAt: approval.approvedAt
      }));
      const degraded = Boolean(stage.degraded && degradedRequirements.has(requirementKey));
      const appliedApproval = degradationApprovals.at(-1);
      audit.push({
        stageId: stage.id,
        requirementKey,
        attempt,
        policy: {
          kind: policy.kind,
          minProducers: policy.minProducers,
          effectiveMinProducers: appliedApproval?.approvedMinProducers ?? policy.minProducers,
          acceptedStatuses: ["replied"]
        },
        eligibleProducers: [...policy.eligibleProducers].sort((left, right) => left.id.localeCompare(right.id) || left.name.localeCompare(right.name)).map((producer) => ({ id: producer.id, name: producer.name })),
        verifiedProducerIds: [...new Set(verifiedMessages.map((snapshot) => snapshot.producerId))].sort(),
        verifiedMessages,
        degraded,
        degradationApprovals
      });
    }
  }
  return audit;
}
function buildRetrospective(run, journal, exportedAt = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!SAFE_RUN_ID.test(run.id)) throw new Error("invalid retrospective run id");
  const entries = journal.filter((entry) => entry.runId === run.id).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).slice(-MAX_RETROSPECTIVE_ENTRIES).map((entry) => {
    const promotionState = journalPromotionState(entry);
    const exported = {
      id: entry.id,
      category: entry.category,
      area: entry.area,
      severity: entry.severity,
      summary: redactSecrets(entry.summary),
      evidence: redactStringList(entry.evidence),
      relatedEntryIds: entry.relatedEntryIds.slice(0, 16),
      createdAt: entry.createdAt
    };
    if (entry.stageId !== void 0) exported.stageId = entry.stageId;
    if (entry.attempt !== void 0) exported.attempt = entry.attempt;
    if (promotionState !== void 0) exported.promotionState = promotionState;
    return exported;
  });
  const byCategory = {};
  const byArea = {};
  const byClass = {};
  for (const entry of entries) {
    increment(byCategory, entry.category);
    increment(byArea, entry.area);
    increment(byClass, classFromEvidence(entry.evidence));
  }
  const recurringErrorClasses = Object.entries(byClass).map(([errorClass, count]) => ({ class: errorClass, count })).sort((left, right) => right.count - left.count || left.class.localeCompare(right.class));
  const resolvedContradictions = new Set(entries.filter((entry) => entry.category === "decision" || entry.category === "lesson").flatMap((entry) => entry.relatedEntryIds));
  const openContradictions = entries.filter((entry) => entry.category === "contradiction" && !resolvedContradictions.has(entry.id)).map((entry) => ({ id: entry.id, summary: entry.summary, area: entry.area }));
  const decisions = entries.filter((entry) => entry.category === "decision").map((entry) => ({ id: entry.id, summary: entry.summary, area: entry.area }));
  const proposedImprovements = entries.filter((entry) => entry.category === "lesson" || entry.category === "error").slice(0, 12).map((entry) => ({
    area: entry.area,
    summary: entry.summary,
    successMeasure: "reduce recurrence of this class in the next comparable run",
    status: "proposed"
  }));
  const evidenceAudit = buildEvidenceAudit(run);
  const degradedStageIds = run.stages.filter((stage) => stage.degraded).map((stage) => stage.id);
  return {
    schema: "pi-mesh.retrospective.v1",
    runId: run.id,
    definitionId: run.definitionId,
    status: run.status,
    exportedAt,
    reviewDecision: "proposed",
    stages: run.stages.map((stage) => {
      const elapsed = durationMs(stage.startedAt, stage.completedAt);
      return { id: stage.id, ...stage.area ? { area: stage.area } : {}, status: stage.status, attempts: stage.attempts, ...stage.startedAt ? { startedAt: stage.startedAt } : {}, ...stage.completedAt ? { completedAt: stage.completedAt } : {}, ...elapsed !== void 0 ? { durationMs: elapsed } : {}, ...stage.updatedAt ? { updatedAt: stage.updatedAt } : {}, ...stage.summary ? { summary: redactSecrets(stage.summary) } : {} };
    }),
    counts: { byCategory, byArea, byClass },
    openContradictions,
    decisions,
    recurringErrorClasses,
    entries,
    proposedImprovements,
    ...evidenceAudit.length ? { evidenceAudit } : {},
    ...degradedStageIds.length ? { degradedStageIds } : {}
  };
}
function renderRetrospectiveMarkdown(doc) {
  const stageRows = doc.stages.map((stage) => `| ${stage.id} | ${stage.area ?? ""} | ${stage.status} | ${stage.attempts} | ${stage.durationMs ?? ""} |`).join("\n");
  const contradictionRows = doc.openContradictions.map((entry) => `- ${entry.id} (${entry.area}): ${entry.summary}`).join("\n") || "- none";
  const decisionRows = doc.decisions.map((entry) => `- ${entry.id} (${entry.area}): ${entry.summary}`).join("\n") || "- none";
  const classRows = doc.recurringErrorClasses.map((entry) => `- ${entry.class}: ${entry.count}`).join("\n") || "- none";
  const entryRows = doc.entries.map((entry) => {
    const related = entry.relatedEntryIds.length > 0 ? `; related: ${entry.relatedEntryIds.join(", ")}` : "";
    const evidence = entry.evidence.length > 0 ? `; evidence: ${entry.evidence.join(", ")}` : "";
    return `- ${entry.id} [${entry.category}/${entry.area}/${entry.severity}]: ${entry.summary}${related}${evidence}`;
  }).join("\n") || "- none";
  const evidenceAuditRows = (doc.evidenceAudit ?? []).flatMap((audit) => {
    const producerNames = audit.eligibleProducers.map((producer) => `${producer.name} (${producer.id})`).join(", ") || "none";
    const verified = audit.verifiedMessages.length ? audit.verifiedMessages.map((snapshot) => `  - ${snapshot.messageId}: producer ${snapshot.producerName} (${snapshot.producerId}), attempt ${snapshot.context.attempt}, request ${snapshot.hashes.requestSha256}, reply ${snapshot.hashes.replySha256}, replied ${snapshot.timestamps.repliedAt}, verified ${snapshot.timestamps.verifiedAt}`) : ["  - no verified messages"];
    const approvals = audit.degradationApprovals.map((approval) => `  - approval ${approval.id}: attempt ${approval.attempt}, ${approval.policyMinProducers} -> ${approval.approvedMinProducers} producers, ${approval.approvedBy}, ${approval.approvedAt}; reason: ${approval.reason}`);
    return [
      `- ${audit.stageId} / ${audit.requirementKey} / attempt ${audit.attempt}: ${audit.verifiedProducerIds.length}/${audit.policy.effectiveMinProducers} verified producers; policy minimum ${audit.policy.minProducers}; degraded: ${audit.degraded}`,
      `  - eligible: ${producerNames}`,
      ...verified,
      ...approvals.length ? ["  - degradation approvals:", ...approvals] : []
    ];
  });
  return [
    `# Workflow retrospective ${doc.runId}`,
    "",
    `- Definition: ${doc.definitionId}`,
    `- Status: ${doc.status}`,
    `- Exported: ${doc.exportedAt}`,
    `- Review decision: ${doc.reviewDecision}`,
    "",
    "## Stages",
    "",
    "| id | area | status | attempts | duration ms |",
    "|---|---|---|---|---|",
    stageRows,
    "",
    "## Decisions",
    "",
    decisionRows,
    "",
    "## Open contradictions",
    "",
    contradictionRows,
    "",
    "## Recurring error classes",
    "",
    classRows,
    "",
    "## Bounded journal evidence",
    "",
    entryRows,
    "",
    ...doc.evidenceAudit?.length ? [
      "## Peer-evidence audit",
      "",
      "This section contains immutable provenance metadata and content hashes only; prompt and reply bodies are excluded.",
      "",
      ...evidenceAuditRows,
      ""
    ] : [],
    "## Proposed improvements",
    "",
    ...doc.proposedImprovements.map((item) => `- [${item.status}] (${item.area}) ${item.summary}`),
    "",
    "Proposed improvements are evidence, not policy. Do not apply them until an explicit review decision.",
    ""
  ].join("\n");
}
function writeRetrospective(outDir, doc) {
  if (!SAFE_RUN_ID.test(doc.runId)) throw new Error("invalid retrospective run id");
  mkdirSync3(outDir, { recursive: true });
  const root = resolve2(outDir);
  const jsonPath = resolve2(root, `${doc.runId}.json`);
  const mdPath = resolve2(root, `${doc.runId}.md`);
  const prefix = `${root}${process.platform === "win32" ? "\\" : "/"}`;
  if (!jsonPath.startsWith(prefix) || !mdPath.startsWith(prefix)) throw new Error("retrospective path escaped output directory");
  const jsonTmp = `${jsonPath}.tmp`;
  const mdTmp = `${mdPath}.tmp`;
  writeFileSync3(jsonTmp, `${JSON.stringify(doc, null, 2)}
`, { encoding: "utf8", mode: 384 });
  writeFileSync3(mdTmp, renderRetrospectiveMarkdown(doc), { encoding: "utf8", mode: 384 });
  renameSync2(jsonTmp, jsonPath);
  renameSync2(mdTmp, mdPath);
  return { jsonPath, mdPath };
}

// plugins/kxm/src/store.ts
import { resolve as resolve5 } from "node:path";

// plugins/kxm/src/database.ts
import {
  chmodSync,
  copyFileSync,
  existsSync as existsSync4,
  lstatSync,
  mkdirSync as mkdirSync4,
  readdirSync as readdirSync3,
  readFileSync as readFileSync3,
  unlinkSync,
  writeFileSync as writeFileSync4
} from "node:fs";
import { basename as basename3, dirname as dirname4, join as join5, resolve as resolve4 } from "node:path";

// plugins/kxm/src/sqlite.ts
import { createRequire } from "node:module";
var requireFromHere = createRequire(import.meta.url);
function loadNative() {
  try {
    const mod = requireFromHere("node:sqlite");
    if (mod.DatabaseSync) return { Ctor: mod.DatabaseSync, bun: false };
  } catch {
  }
  try {
    const mod = requireFromHere("bun:sqlite");
    const Ctor = mod?.DatabaseSync ?? mod?.Database;
    if (Ctor) return { Ctor, bun: true };
  } catch {
  }
  throw new Error("kxm: no supported sqlite module found (need node:sqlite or bun:sqlite)");
}
var native = loadNative();
var DatabaseSync = class {
  inner;
  constructor(path, options) {
    let normalized = options;
    if (native.bun && options) {
      const { readOnly, ...rest } = options;
      normalized = readOnly === void 0 ? rest : { ...rest, readonly: readOnly };
    }
    this.inner = normalized === void 0 ? new native.Ctor(path) : new native.Ctor(path, normalized);
  }
  prepare(sql) {
    return this.inner.prepare(sql);
  }
  exec(sql) {
    return this.inner.exec(sql);
  }
  close() {
    this.inner.close();
  }
};

// plugins/kxm/src/project-config.ts
import { basename as basename2, dirname as dirname3, extname as extname2, isAbsolute, join as join4, relative, resolve as resolve3, sep } from "node:path";

// plugins/kxm/src/restricted-yaml.mjs
var import_yaml3 = __toESM(require_dist(), 1);
var KXM_YAML_LIMITS = Object.freeze({
  maxDocumentBytes: 256 * 1024,
  maxDepth: 32,
  maxScalarBytes: 64 * 1024,
  maxCollectionItems: 4096,
  maxTotalNodes: 16384,
  maxKeys: 8192
});

// plugins/kxm/src/template.ts
var import_yaml4 = __toESM(require_dist(), 1);

// plugins/kxm/src/repo-root.ts
import { existsSync as existsSync3 } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
import { fileURLToPath } from "node:url";
var ROOT_MARKERS = ["scripts/kxm-hub.mjs", "scripts/kxm.mjs"];
var MAX_WALK_DEPTH = 10;
function findKxmRepoRoot(fromUrl = import.meta.url) {
  let dir = dirname2(fileURLToPath(fromUrl));
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    if (ROOT_MARKERS.some((marker) => existsSync3(join3(dir, marker)))) return dir;
    const parent = dirname2(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `kxm: cannot locate the KXM repo root from ${fileURLToPath(fromUrl)} (walked ${MAX_WALK_DEPTH} levels looking for ${ROOT_MARKERS[0]})`
  );
}

// plugins/kxm/src/oneshot-process.ts
var OUTPUT_LIMIT = 8 * 1024 * 1024;

// plugins/kxm/src/harness.ts
var NATIVE_HARNESS_PROVIDERS = Object.freeze({
  claude: "anthropic",
  codex: "openai",
  grok: "xai",
  agy: "google",
  kimi: "moonshot",
  deepseek: "deepseek"
});
var PI_ALLOWED_PROVIDERS = Object.freeze([
  "openrouter",
  "nous-portal",
  "nous",
  "nous-proxy"
]);
var PI_NATIVE_BRAKE_PROVIDERS = Object.freeze([
  "anthropic",
  "openai",
  "xai",
  "moonshot",
  "google",
  "deepseek"
]);
function reportedModelId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:/-]{0,199}$/i.test(value) ? value : void 0;
}
function parseClaudeOneShotUsage(stdout, stderr, requestedModel) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {
      text: "",
      isError: true,
      errorMessage: stderr.trim() || "empty stdout from claude"
    };
  }
  try {
    const payload = JSON.parse(trimmed);
    const usage = payload.usage ?? {};
    const entries = payload.modelUsage && typeof payload.modelUsage === "object" && !Array.isArray(payload.modelUsage) ? Object.entries(payload.modelUsage).filter(([, value]) => value && typeof value === "object") : [];
    const matches = entries.filter(([model]) => model === requestedModel || requestedModel && (model.startsWith(`${requestedModel}-`) || model.startsWith(`claude-${requestedModel}-`)));
    const selected = matches.length === 1 ? matches[0] : entries.length === 1 ? entries[0] : void 0;
    const modelUsageDetail = selected?.[1];
    const effectiveModel = reportedModelId(payload.model) ?? reportedModelId(selected?.[0]);
    const tokensIn = (typeof usage.input_tokens === "number" ? usage.input_tokens : void 0) ?? (typeof modelUsageDetail?.inputTokens === "number" ? modelUsageDetail.inputTokens : null);
    const tokensOut = (typeof usage.output_tokens === "number" ? usage.output_tokens : void 0) ?? (typeof modelUsageDetail?.outputTokens === "number" ? modelUsageDetail.outputTokens : null);
    const cacheReadTokens = (typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : void 0) ?? (typeof modelUsageDetail?.cacheReadInputTokens === "number" ? modelUsageDetail.cacheReadInputTokens : null);
    const cacheWriteTokens = (typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : void 0) ?? (typeof modelUsageDetail?.cacheCreationInputTokens === "number" ? modelUsageDetail.cacheCreationInputTokens : null);
    const costUsd = typeof payload.total_cost_usd === "number" ? payload.total_cost_usd : typeof modelUsageDetail?.costUSD === "number" ? modelUsageDetail.costUSD : null;
    const isError = Boolean(payload.is_error || payload.error || ["error", "aborted", "failed", "max_tokens", "length"].includes(String(payload.stopReason ?? payload.stop_reason ?? "")));
    const text2 = typeof payload.result === "string" ? payload.result : typeof payload.text === "string" ? payload.text : "";
    const errorMessage = isError ? typeof payload.error === "string" ? payload.error : typeof payload.error?.message === "string" ? payload.error.message : text2 : void 0;
    return {
      text: text2,
      effectiveModel,
      isError,
      errorMessage,
      usage: {
        tokensIn,
        tokensOut,
        cacheReadTokens,
        cacheWriteTokens,
        contextTokens: null,
        costUsd
      }
    };
  } catch {
    return {
      text: trimmed,
      isError: true,
      errorMessage: "invalid Claude JSON response",
      usage: {}
    };
  }
}
function parseGrokOneShotUsage(stdout, stderr, requestedModel) {
  return parseClaudeOneShotUsage(stdout, stderr, requestedModel);
}
function parseCodexOneShotUsage(stdout, stderr) {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return {
      text: "",
      isError: true,
      errorMessage: stderr.trim() || "empty stdout from codex"
    };
  }
  const events = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") events.push(parsed);
    } catch {
    }
  }
  const messageTexts = [];
  let usage;
  let hasError = false;
  let errorMessage;
  for (const ev of events) {
    if (ev.type === "turn.failed" || ev.type === "error") {
      hasError = true;
      errorMessage = typeof ev.message === "string" ? ev.message : typeof ev.error?.message === "string" ? ev.error.message : "turn_failed";
    }
    if (ev.type === "item.completed" && ev.item && typeof ev.item === "object" && ev.item.type === "agent_message") {
      const t = ev.item.text;
      if (typeof t === "string") messageTexts.push(t);
    }
    if (ev.type === "turn.completed" && ev.usage && typeof ev.usage === "object") {
      usage = ev.usage;
    }
  }
  const text2 = (messageTexts.at(-1) ?? "").trim();
  if (!events.some((event) => event.type === "turn.completed") || !text2) hasError = true;
  const tokensIn = typeof usage?.input_tokens === "number" ? usage.input_tokens : null;
  const tokensOut = typeof usage?.output_tokens === "number" ? usage.output_tokens : null;
  const cacheReadTokens = typeof usage?.cached_input_tokens === "number" ? usage.cached_input_tokens : null;
  const cacheWriteTokens = typeof usage?.cache_write_input_tokens === "number" ? usage.cache_write_input_tokens : null;
  return {
    text: text2,
    isError: hasError,
    errorMessage,
    usage: {
      tokensIn,
      tokensOut,
      cacheReadTokens,
      cacheWriteTokens,
      contextTokens: null,
      costUsd: null
    }
  };
}
function parsePiOneShotUsage(stdout, _stderr) {
  let finalMessage;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event.type !== "message_end" && event.type !== "turn_end") continue;
      const message = event.message;
      if (!message || message.role !== "assistant") continue;
      finalMessage = message;
    } catch {
    }
  }
  if (!finalMessage) {
    return { text: "", isError: true, usage: {} };
  }
  const content = Array.isArray(finalMessage.content) ? finalMessage.content : [];
  const text2 = content.map((part) => part && typeof part === "object" && part.type === "text" ? String(part.text ?? "") : "").filter((part) => part.length > 0).join("\n");
  const effectiveModel = reportedModelId(finalMessage.model);
  const rawUsage = finalMessage.usage;
  const usage = rawUsage && typeof rawUsage === "object" ? {
    tokensIn: typeof rawUsage.input === "number" ? rawUsage.input : null,
    tokensOut: typeof rawUsage.output === "number" ? rawUsage.output : null,
    cacheReadTokens: typeof rawUsage.cacheRead === "number" ? rawUsage.cacheRead : null,
    cacheWriteTokens: typeof rawUsage.cacheWrite === "number" ? rawUsage.cacheWrite : null,
    contextTokens: null,
    costUsd: null
  } : {};
  const stopReason = typeof finalMessage.stopReason === "string" ? finalMessage.stopReason : void 0;
  const terminalError = stopReason === "error" || stopReason === "aborted";
  if (terminalError || text2.length === 0) {
    return { text: text2, isError: true, ...effectiveModel !== void 0 ? { effectiveModel } : {}, usage };
  }
  return { text: text2, ...effectiveModel !== void 0 ? { effectiveModel } : {}, usage };
}
function parseGenericOneShotUsage(stdout, _stderr) {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rec = parsed;
      const text2 = typeof rec.result === "string" ? rec.result : typeof rec.text === "string" ? rec.text : typeof rec.response === "string" ? rec.response : trimmed;
      const u = rec.usage && typeof rec.usage === "object" ? rec.usage : {};
      return { text: text2, effectiveModel: reportedModelId(rec.model), isError: Boolean(rec.is_error || rec.error || rec.success === false), usage: {
        tokensIn: typeof u.input_tokens === "number" ? u.input_tokens : null,
        tokensOut: typeof u.output_tokens === "number" ? u.output_tokens : null,
        cacheReadTokens: typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : null,
        cacheWriteTokens: typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : null,
        contextTokens: null,
        costUsd: typeof rec.total_cost_usd === "number" ? rec.total_cost_usd : null
      } };
    }
  } catch {
  }
  return { text: trimmed, usage: {} };
}
function parseKimiOneShotUsage(stdout, _stderr) {
  const trimmed = stdout.trim();
  const assistantTexts = [];
  let isError = false;
  let errorMessage;
  for (const line of trimmed.split("\n")) {
    const lineTrimmed = line.trim();
    if (!lineTrimmed) continue;
    try {
      const parsed = JSON.parse(lineTrimmed);
      if (parsed && typeof parsed === "object") {
        const rec = parsed;
        if (rec.role === "assistant" && typeof rec.content === "string") {
          assistantTexts.push(rec.content);
        } else if (rec.role === "error" || rec.type === "error") {
          isError = true;
          errorMessage = typeof rec.message === "string" ? rec.message : typeof rec.content === "string" ? rec.content : "kimi_error";
        }
      }
    } catch {
    }
  }
  const text2 = assistantTexts.length > 0 ? assistantTexts.join("\n") : trimmed;
  return {
    text: text2,
    isError,
    errorMessage,
    usage: {
      tokensIn: null,
      tokensOut: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      contextTokens: null,
      costUsd: null
    }
  };
}
function parseAgyOneShotUsage(stdout, _stderr) {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rec = parsed;
      const text2 = typeof rec.response === "string" ? rec.response : typeof rec.result === "string" ? rec.result : trimmed;
      const isError = rec.status === "ERROR";
      const rawError = rec.error;
      const errorMessage = isError ? typeof rawError === "string" ? rawError : typeof rawError?.message === "string" ? rawError.message : "agy_error" : void 0;
      const usageRec = rec.usage && typeof rec.usage === "object" ? rec.usage : {};
      const tokensIn = typeof usageRec.input_tokens === "number" ? usageRec.input_tokens : null;
      const tokensOut = typeof usageRec.output_tokens === "number" ? usageRec.output_tokens : null;
      const cacheReadTokens = typeof usageRec.cache_read_tokens === "number" ? usageRec.cache_read_tokens : null;
      const contextTokens = typeof usageRec.total_tokens === "number" ? usageRec.total_tokens : tokensIn;
      return {
        text: text2,
        isError,
        errorMessage,
        usage: {
          tokensIn,
          tokensOut,
          cacheReadTokens,
          cacheWriteTokens: null,
          contextTokens,
          costUsd: null
        }
      };
    }
  } catch {
  }
  return {
    text: trimmed,
    usage: {
      tokensIn: null,
      tokensOut: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      contextTokens: null
    }
  };
}
var READ_ONLY_ONESHOT_ARGS = Object.freeze({
  // pi: total containment for a one-shot witness — no tools (built-in, extension and
  // custom), no ambient extension/hook discovery, no skills, no prompt templates, no
  // AGENTS.md/CLAUDE.md context discovery, and an ephemeral session. `--no-tools` alone
  // is not enough: extensions and hooks can still run with their own permissions.
  pi: Object.freeze(["--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session"]),
  claude: Object.freeze(["--tools", "Read,Glob,Grep", "--restricted", "--safe-mode", "--permission-mode", "plan", "--permission-prompts", "none", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-session-persistence"]),
  codex: Object.freeze(["--sandbox", "read-only", "--ignore-user-config", "-c", 'approval_policy="never"']),
  grok: Object.freeze(["--sandbox", "read-only", "--permission-mode", "plan", "--tools", "Read,Glob,Grep", "--no-subagents", "--disable-web-search"]),
  agy: Object.freeze(["--mode", "plan", "--sandbox", "--disable-slash-commands"]),
  kimi: Object.freeze(["--plan"])
});
function oneShotReadOnlyArgs(harness) {
  return Object.hasOwn(READ_ONLY_ONESHOT_ARGS, harness) ? READ_ONLY_ONESHOT_ARGS[harness] : void 0;
}
var BUILTIN_HARNESSES = Object.freeze([
  {
    id: "pi",
    label: "Pi",
    default: true,
    mode: "headless",
    commands: ["pi"],
    versionArgs: ["--version"],
    update: {
      self: ["update", "--self"],
      extensions: ["update", "--extensions"],
      models: ["update", "--models"]
    },
    oneShot: {
      argv: ["-p", "--mode", "json"],
      promptVia: "arg",
      outputFormat: "json",
      usageParser: parsePiOneShotUsage
    }
  },
  {
    id: "claude",
    label: "Claude Code",
    default: false,
    mode: "either",
    commands: ["claude"],
    versionArgs: ["--version"],
    authArgs: ["auth", "status"],
    update: {
      self: ["update"],
      extensions: ["plugin", "update", "kxm", "-y"]
    },
    oneShot: {
      argv: ["-p", ...oneShotReadOnlyArgs("claude"), "--output-format", "json"],
      promptVia: "stdin",
      outputFormat: "json",
      usageParser: parseClaudeOneShotUsage
    }
  },
  {
    id: "kimi",
    label: "Kimi Code",
    default: false,
    mode: "either",
    commands: ["kimi"],
    versionArgs: ["--version"],
    authArgs: ["provider", "list"],
    update: { self: ["upgrade"] },
    oneShot: {
      argv: [...oneShotReadOnlyArgs("kimi"), "--output-format", "stream-json", "-p"],
      promptVia: "arg",
      outputFormat: "stream-json",
      usageParser: parseKimiOneShotUsage
    }
  },
  {
    id: "codex",
    label: "Codex",
    default: false,
    mode: "either",
    commands: ["codex"],
    versionArgs: ["--version"],
    authArgs: ["login", "status"],
    update: { self: ["update"] },
    oneShot: {
      argv: ["exec", ...oneShotReadOnlyArgs("codex"), "--json", "-"],
      promptVia: "stdin",
      outputFormat: "json",
      usageParser: parseCodexOneShotUsage
    }
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    default: false,
    mode: "either",
    commands: ["deepseek"],
    versionArgs: ["--version"],
    update: { self: ["update"] },
    oneShot: {
      argv: ["--json"],
      promptVia: "stdin",
      outputFormat: "json",
      usageParser: parseGenericOneShotUsage
    }
  },
  {
    id: "grok",
    label: "Grok CLI",
    default: false,
    mode: "either",
    commands: ["grok"],
    versionArgs: ["--version"],
    authArgs: ["models"],
    update: { self: ["update"] },
    oneShot: {
      argv: [...oneShotReadOnlyArgs("grok"), "--output-format", "json", "--single"],
      promptVia: "arg",
      outputFormat: "json",
      usageParser: parseGrokOneShotUsage
    }
  },
  {
    id: "agy",
    label: "Antigravity CLI",
    default: false,
    mode: "either",
    commands: ["agy"],
    versionArgs: ["--version"],
    authArgs: ["models"],
    update: { self: ["update"] },
    oneShot: {
      argv: [...oneShotReadOnlyArgs("agy"), "--output-format", "json", "-p"],
      promptVia: "arg",
      outputFormat: "json",
      usageParser: parseAgyOneShotUsage
    }
  }
]);
var BUILTIN_HARNESS_IDS = BUILTIN_HARNESSES.map((entry) => entry.id);
var WIN_NPM_INNER_EXE = Object.freeze({
  claude: Object.freeze(["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"])
});

// plugins/kxm/src/project-config.ts
var KxmConfigError = class extends Error {
  issues;
  constructor(issues) {
    const sorted = sortIssues(issues);
    super(sorted.map((issue) => `${issue.file}: ${issue.code}: ${issue.message}`).join("\n"));
    this.name = "KxmConfigError";
    this.issues = sorted;
  }
};
function defaultKxmSchemaDir() {
  return join4(findKxmRepoRoot(import.meta.url), "schemas");
}
var DEFAULT_SCHEMA_DIR = defaultKxmSchemaDir();
var RESOURCE_SCHEMA = Object.freeze({
  project: { identity: "kxm.project.v1", file: "project.schema.json" },
  repository: { identity: "kxm.repository.v1", file: "repository.schema.json" },
  agent: { identity: "kxm.agent.v1", file: "agent.schema.json" },
  model: { identity: "kxm.model.v1", file: "model.schema.json" },
  environment: { identity: "kxm.environment.v1", file: "environment.schema.json" },
  workflow: { identity: "kxm.workflow.v1", file: "workflow.schema.json" },
  "gate-registry": { identity: "kxm.gate-registry.v1", file: "gate-registry.schema.json" }
});
function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function sortIssues(issues) {
  return [...issues].sort((left, right) => compareCodeUnits(left.file, right.file) || compareCodeUnits(left.phase, right.phase) || compareCodeUnits(left.code, right.code) || compareCodeUnits(left.message, right.message));
}

// plugins/kxm/src/database.ts
function databaseError(code, file, message) {
  const issue = { phase: "semantic", code, file, message };
  return new KxmConfigError([issue]);
}
function checkedParent(path, description) {
  const parent = dirname4(path);
  if (!existsSync4(parent)) mkdirSync4(parent, { recursive: true, mode: 448 });
  const stat = lstatSync(parent, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw databaseError("runtime_path_invalid", description, `${description} parent must be a regular directory, not a link`);
  }
}
function userTables(database) {
  const rows = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all();
  return rows.map((row) => row.name);
}
function tableColumns(database, table) {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all();
  return rows.map((row) => row.name).sort();
}
function verifyExpectedTables(database, file, description, expected) {
  const present = new Set(userTables(database));
  for (const [table, columns] of Object.entries(expected)) {
    if (!present.has(table)) {
      throw databaseError("runtime_schema_shape_invalid", file, `${description} is missing table ${table}`);
    }
    const actual = tableColumns(database, table);
    const missing = columns.filter((column) => !actual.includes(column));
    if (missing.length > 0) {
      throw databaseError("runtime_schema_shape_invalid", file, `${description} table ${table} is missing columns ${missing.join(", ")}`);
    }
  }
}
function ensureWalJournalMode(database, file, description, timeoutMs = 5e3) {
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      const current = database.prepare("PRAGMA journal_mode").get();
      if (current?.journal_mode === "wal") {
        return;
      }
      const updated = database.prepare("PRAGMA journal_mode = WAL").get();
      if (updated?.journal_mode === "wal") {
        return;
      }
    } catch (error) {
      const sqliteError = error;
      if (sqliteError.code === "ERR_SQLITE_ERROR" && sqliteError.errcode === 5 && Date.now() < deadline) {
        Atomics.wait(sleeper, 0, 0, 10);
        continue;
      }
      throw error;
    }
    if (Date.now() >= deadline) {
      throw databaseError("runtime_timeout", file, `${description} timed out enabling WAL journal mode`);
    }
    Atomics.wait(sleeper, 0, 0, 10);
  }
}
function openDatabase(file, description, spec) {
  const isMemory = file === ":memory:";
  if (!isMemory) {
    checkedParent(file, description);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw databaseError("runtime_path_invalid", description, `${description} must be a regular file, not a link or directory`);
      }
    }
    for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
      const info = lstatSync(sidecar, { throwIfNoEntry: false });
      if (info?.isSymbolicLink()) {
        throw databaseError("runtime_path_invalid", description, `${description} sidecar must not be a link`);
      }
    }
  }
  const database = new DatabaseSync(file);
  let transaction = false;
  try {
    database.exec(`PRAGMA busy_timeout = ${spec.timeoutMs ?? 5e3}`);
    if (!isMemory) {
      ensureWalJournalMode(database, file, description, spec.timeoutMs);
    }
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("BEGIN IMMEDIATE");
    transaction = true;
    const row = database.prepare("PRAGMA user_version").get();
    const version = row?.user_version ?? 0;
    if (version > spec.version) {
      throw databaseError("runtime_schema_newer", file, `${description} schema version ${version} is newer than this runtime supports`);
    }
    if (version === 0) {
      const existing = userTables(database);
      if (existing.length > 0) {
        throw databaseError("runtime_schema_shape_invalid", file, `${description} has tables at schema version 0`);
      }
      database.exec(spec.schema);
      database.exec(`PRAGMA user_version = ${spec.version}`);
    } else if (version < spec.version) {
      throw databaseError(
        "runtime_schema_outdated",
        file,
        `${description} is schema version ${version}; this build requires ${spec.version}. Delete the state file to start fresh and let its owning process recreate it (\`kxm hub start\` for hub state, the Runtime for registry/event stores); \`kxm init\` is project-only and rebuilds no database \u2014 upgrading old state in place is deliberately unsupported`
      );
    }
    if (spec.tables) {
      verifyExpectedTables(database, file, description, spec.tables);
    }
    database.exec("COMMIT");
    transaction = false;
    return database;
  } catch (error) {
    if (transaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
      }
    }
    database.close();
    throw error;
  }
}
var activeTransactions = /* @__PURE__ */ new WeakSet();
var TRANSACTION_BUSY_BACKOFF_MS = 1e3;
function monotonicNowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}
var transactionThrottles = /* @__PURE__ */ new WeakMap();
function finiteNow(clock, label) {
  const now = clock();
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw databaseError(
      "runtime_transaction_clock_invalid",
      "transaction",
      `${label} must return a finite monotonic number; got ${String(now)}`
    );
  }
  return now;
}
var CONTENTION_PRIMARY_CODES = [5, 6, 15];
var CONTENTION_SYMBOLIC_NAMES = /^SQLITE_(?:BUSY|LOCKED|PROTOCOL)(?:_[A-Z0-9]+)?$/;
var SQLITE_RESULT_NAMES = /^SQLITE_[A-Z][A-Z0-9_]*$/;
var CONTENTION_MESSAGES = /^(?:database is locked|database table is locked|locking protocol|SQLITE_BUSY|SQLITE_LOCKED|SQLITE_PROTOCOL)(?:$|[\s.:])/i;
function isTransactionContention(error) {
  const carrier = error;
  for (const value of [carrier?.errcode, carrier?.errCode, carrier?.errno]) {
    if (typeof value === "number" && Number.isInteger(value)) return CONTENTION_PRIMARY_CODES.includes(value & 255);
  }
  for (const value of [carrier?.code, carrier?.name]) {
    if (typeof value === "string" && SQLITE_RESULT_NAMES.test(value)) {
      return CONTENTION_SYMBOLIC_NAMES.test(value);
    }
  }
  return CONTENTION_MESSAGES.test(error instanceof Error ? error.message : String(error));
}
function withDatabaseTransaction(database, work, mode = "IMMEDIATE", clock = monotonicNowMs) {
  if (activeTransactions.has(database)) {
    throw databaseError("runtime_transaction_nested", "transaction", "nested transactions are not allowed");
  }
  if (mode !== "DEFERRED") {
    const deadlines = transactionThrottles.get(database);
    const until = deadlines?.get(clock);
    if (until !== void 0) {
      const remaining = until - finiteNow(clock, "the transaction clock");
      if (remaining > 0) {
        throw databaseError(
          "runtime_transaction_busy",
          "transaction",
          `a previous BEGIN was blocked on this database; retry deferred ${String(remaining)}ms`
        );
      }
      deadlines?.delete(clock);
    }
  }
  try {
    database.exec(`BEGIN ${mode}`);
  } catch (error) {
    if (!isTransactionContention(error)) throw error;
    const now = finiteNow(clock, "the transaction clock");
    let deadlines = transactionThrottles.get(database);
    if (deadlines === void 0) {
      deadlines = /* @__PURE__ */ new WeakMap();
      transactionThrottles.set(database, deadlines);
    }
    deadlines.set(clock, now + TRANSACTION_BUSY_BACKOFF_MS);
    throw databaseError(
      "runtime_transaction_busy",
      "transaction",
      `BEGIN ${mode} blocked by another transaction: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  activeTransactions.add(database);
  if (mode !== "DEFERRED") transactionThrottles.get(database)?.delete(clock);
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
    }
    throw error;
  } finally {
    activeTransactions.delete(database);
  }
}

// plugins/kxm/src/store.ts
var HUB_STORE_SCHEMA_VERSION = 3;
var HUB_STORE_TABLES = Object.freeze({
  agents: Object.freeze(["id", "record"]),
  messages: Object.freeze(["id", "record"]),
  consumer_cursors: Object.freeze(["agent_id", "cursor"]),
  agent_sequences: Object.freeze(["agent_id", "next_seq"]),
  workflow_runs: Object.freeze(["id", "definition_id", "delivery_id", "record"]),
  workflow_journal: Object.freeze(["id", "run_id", "category", "area", "record"]),
  context_items: Object.freeze(["id", "project", "kind", "record"])
});
var HUB_STORE_SCHEMA_V3 = `
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    record TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    record TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS messages_from_idempotency
  ON messages(
    json_extract(record, '$.from'),
    json_extract(record, '$.idempotencyKey')
  ) WHERE json_extract(record, '$.idempotencyKey') IS NOT NULL;
  CREATE INDEX IF NOT EXISTS messages_to_seq
  ON messages(
    json_extract(record, '$.to'),
    COALESCE(json_extract(record, '$.seq'), 0)
  );
  CREATE TABLE IF NOT EXISTS consumer_cursors (
    agent_id TEXT PRIMARY KEY,
    cursor INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS agent_sequences (
    agent_id TEXT PRIMARY KEY,
    next_seq INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    definition_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    record TEXT NOT NULL,
    UNIQUE(definition_id, delivery_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS workflow_journal (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    category TEXT NOT NULL,
    area TEXT NOT NULL,
    record TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS workflow_journal_run_id ON workflow_journal(run_id);
  CREATE TABLE IF NOT EXISTS context_items (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    kind TEXT NOT NULL,
    record TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS context_items_project ON context_items(project);
`;
var HUB_STORE_SCHEMA_SPEC = Object.freeze({
  schema: HUB_STORE_SCHEMA_V3,
  version: HUB_STORE_SCHEMA_VERSION,
  tables: HUB_STORE_TABLES
});
var MessageMap = class extends Map {
  store;
  constructor(store) {
    super();
    this.store = store;
  }
  get(id) {
    const cached = super.get(id);
    if (cached) return cached;
    return this.store.loadMessageFromDb(id);
  }
  has(id) {
    if (super.has(id)) return true;
    return this.store.hasMessage(id);
  }
  delete(id) {
    this.store.deleteMessage(id);
    return super.delete(id);
  }
  get size() {
    return this.store.countMessages();
  }
  get cachedSize() {
    return super.size;
  }
};
var MeshStore = class {
  agents = /* @__PURE__ */ new Map();
  messages;
  workflowRuns = /* @__PURE__ */ new Map();
  journal = /* @__PURE__ */ new Map();
  contextItems = /* @__PURE__ */ new Map();
  path;
  database;
  agentSequences = /* @__PURE__ */ new Map();
  consumerCursors = /* @__PURE__ */ new Map();
  constructor(path) {
    this.messages = new MessageMap(this);
    if (!path) return;
    this.path = path === ":memory:" ? path : resolve5(path);
    this.database = openDatabase(this.path, "hub database", HUB_STORE_SCHEMA_SPEC);
    this.load();
  }
  get persistent() {
    return Boolean(this.database && this.path !== ":memory:");
  }
  saveAgent(agent) {
    this.agents.set(agent.id, agent);
    this.database?.prepare(`
      INSERT INTO agents (id, record) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET record = excluded.record
    `).run(agent.id, JSON.stringify(agent));
  }
  saveMessage(message) {
    Map.prototype.set.call(this.messages, message.id, message);
    this.database?.prepare(`
      INSERT INTO messages (id, record) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET record = excluded.record
    `).run(message.id, JSON.stringify(message));
  }
  deleteMessage(messageId) {
    Map.prototype.delete.call(this.messages, messageId);
    this.database?.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
  }
  loadMessageFromDb(id) {
    if (!this.database) return void 0;
    const row = this.database.prepare("SELECT record FROM messages WHERE id = ?").get(id);
    if (!row) return void 0;
    try {
      const msg = JSON.parse(row.record);
      Map.prototype.set.call(this.messages, msg.id, msg);
      return msg;
    } catch {
      return void 0;
    }
  }
  hasMessage(id) {
    if (Map.prototype.has.call(this.messages, id)) return true;
    if (!this.database) return false;
    const row = this.database.prepare("SELECT 1 AS ok FROM messages WHERE id = ?").get(id);
    return Boolean(row?.ok);
  }
  countMessages() {
    if (!this.database) return [...Map.prototype.keys.call(this.messages)].length;
    const row = this.database.prepare("SELECT COUNT(*) AS total FROM messages").get();
    return Number(row?.total ?? 0);
  }
  nextAgentSequence(agentId) {
    if (!this.database) {
      const current = this.agentSequences.get(agentId) ?? 0;
      const next = current + 1;
      this.agentSequences.set(agentId, next);
      return next;
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT next_seq FROM agent_sequences WHERE agent_id = ?").get(agentId);
      let next = row?.next_seq;
      if (next === void 0) {
        const maxRow = this.database.prepare(`
          SELECT COALESCE(MAX(json_extract(record, '$.seq')), 0) AS max_seq
          FROM messages WHERE json_extract(record, '$.to') = ?
        `).get(agentId);
        next = Number(maxRow?.max_seq ?? 0) + 1;
      }
      this.database.prepare(`
        INSERT INTO agent_sequences (agent_id, next_seq) VALUES (?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET next_seq = excluded.next_seq
      `).run(agentId, next + 1);
      this.database.exec("COMMIT");
      this.agentSequences.set(agentId, next + 1);
      return next;
    } catch (err) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
      }
      throw err;
    }
  }
  getConsumerCursor(agentId) {
    if (!this.database) {
      return this.consumerCursors.get(agentId) ?? 0;
    }
    const row = this.database.prepare("SELECT cursor FROM consumer_cursors WHERE agent_id = ?").get(agentId);
    const cursor = Number(row?.cursor ?? 0);
    this.consumerCursors.set(agentId, cursor);
    return cursor;
  }
  advanceCursor(agentId, seq) {
    if (!this.database) {
      const current = this.consumerCursors.get(agentId) ?? 0;
      const next = Math.max(current, seq);
      this.consumerCursors.set(agentId, next);
      return next;
    }
    this.database.prepare(`
      INSERT INTO consumer_cursors (agent_id, cursor) VALUES (?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET cursor = MAX(consumer_cursors.cursor, excluded.cursor)
    `).run(agentId, seq);
    return this.getConsumerCursor(agentId);
  }
  getPendingMessages(agentId, cursor = 0) {
    if (!this.database) {
      return [...Map.prototype.values.call(this.messages)].filter((m) => m.to === agentId && (m.status === "queued" || m.status === "delivered") && (m.seq ?? 0) > cursor).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    }
    const rows = this.database.prepare(`
      SELECT record FROM messages
      WHERE json_extract(record, '$.to') = ?
        AND json_extract(record, '$.status') IN ('queued', 'delivered')
        AND COALESCE(json_extract(record, '$.seq'), 0) > ?
      ORDER BY COALESCE(json_extract(record, '$.seq'), 0) ASC
    `).all(agentId, cursor);
    const result = [];
    for (const row of rows) {
      try {
        const msg = JSON.parse(row.record);
        Map.prototype.set.call(this.messages, msg.id, msg);
        result.push(msg);
      } catch {
      }
    }
    return result;
  }
  findMessageByIdempotency(fromId, idempotencyKey) {
    for (const m of Map.prototype.values.call(this.messages)) {
      if (m.from === fromId && m.idempotencyKey === idempotencyKey) return m;
    }
    if (!this.database) return void 0;
    const row = this.database.prepare(`
      SELECT record FROM messages
      WHERE json_extract(record, '$.from') = ? AND json_extract(record, '$.idempotencyKey') = ?
    `).get(fromId, idempotencyKey);
    if (!row) return void 0;
    try {
      const msg = JSON.parse(row.record);
      Map.prototype.set.call(this.messages, msg.id, msg);
      return msg;
    } catch {
      return void 0;
    }
  }
  getOpenMessages(project) {
    if (!this.database) {
      return [...Map.prototype.values.call(this.messages)].filter((m) => m.project === project && (m.status === "queued" || m.status === "delivered")).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    }
    const rows = this.database.prepare(`
      SELECT record FROM messages
      WHERE json_extract(record, '$.project') = ?
        AND json_extract(record, '$.status') IN ('queued', 'delivered')
      ORDER BY json_extract(record, '$.createdAt') DESC
    `).all(project);
    const result = [];
    for (const row of rows) {
      try {
        const msg = JSON.parse(row.record);
        Map.prototype.set.call(this.messages, msg.id, msg);
        result.push(msg);
      } catch {
      }
    }
    return result;
  }
  getExpiringMessages(nowMs = Date.now()) {
    const nowIso2 = new Date(nowMs).toISOString();
    if (!this.database) {
      return [...Map.prototype.values.call(this.messages)].filter((m) => (m.status === "queued" || m.status === "delivered") && Date.parse(m.expiresAt) <= nowMs);
    }
    const rows = this.database.prepare(`
      SELECT record FROM messages
      WHERE json_extract(record, '$.status') IN ('queued', 'delivered')
        AND json_extract(record, '$.expiresAt') <= ?
    `).all(nowIso2);
    const result = [];
    for (const row of rows) {
      try {
        const msg = JSON.parse(row.record);
        Map.prototype.set.call(this.messages, msg.id, msg);
        result.push(msg);
      } catch {
      }
    }
    return result;
  }
  deleteWorkflowRun(runId) {
    this.workflowRuns.delete(runId);
    this.database?.prepare("DELETE FROM workflow_runs WHERE id = ?").run(runId);
  }
  deleteJournalEntry(id) {
    this.journal.delete(id);
    this.database?.prepare("DELETE FROM workflow_journal WHERE id = ?").run(id);
  }
  deleteContextItem(id) {
    this.contextItems.delete(id);
    this.database?.prepare("DELETE FROM context_items WHERE id = ?").run(id);
  }
  sweepRetention(messageRetentionMs2, runRetentionMs = 7 * 864e5, nowMs = Date.now()) {
    const messageCutoffMs = nowMs - messageRetentionMs2;
    const messageCutoffIso = new Date(messageCutoffMs).toISOString();
    const runCutoffMs = nowMs - runRetentionMs;
    const purgedMessages = [];
    const purgedRuns = [];
    const purgedJournal = [];
    const purgedContextItems = [];
    if (!this.database) {
      for (const m of [...Map.prototype.values.call(this.messages)]) {
        const terminal = m.status === "replied" || m.status === "cancelled" || m.status === "expired" || m.status === "error";
        if (!terminal) continue;
        const terminalAt = m.repliedAt ?? m.cancelledAt ?? m.expiresAt ?? m.createdAt;
        if (Date.parse(terminalAt) <= messageCutoffMs) {
          Map.prototype.delete.call(this.messages, m.id);
          purgedMessages.push(m);
        }
      }
    } else {
      const rows = this.database.prepare(`
        SELECT record FROM messages
        WHERE json_extract(record, '$.status') IN ('replied', 'cancelled', 'expired', 'error')
          AND COALESCE(json_extract(record, '$.repliedAt'), json_extract(record, '$.cancelledAt'), json_extract(record, '$.expiresAt'), json_extract(record, '$.createdAt')) <= ?
      `).all(messageCutoffIso);
      for (const row of rows) {
        try {
          const msg = JSON.parse(row.record);
          Map.prototype.delete.call(this.messages, msg.id);
          this.database.prepare("DELETE FROM messages WHERE id = ?").run(msg.id);
          purgedMessages.push(msg);
        } catch {
        }
      }
    }
    const terminalRunsToPurge = [];
    for (const run of this.workflowRuns.values()) {
      const terminal = run.status === "completed" || run.status === "failed";
      if (!terminal) continue;
      const terminalAt = run.updatedAt ?? run.createdAt;
      if (Date.parse(terminalAt) <= runCutoffMs) {
        terminalRunsToPurge.push(run.id);
      }
    }
    for (const runId of terminalRunsToPurge) {
      this.deleteWorkflowRun(runId);
      purgedRuns.push(runId);
      const toDeleteJournal = [];
      for (const entry of this.journal.values()) {
        if (entry.runId === runId) toDeleteJournal.push(entry.id);
      }
      for (const jid of toDeleteJournal) {
        this.deleteJournalEntry(jid);
        purgedJournal.push(jid);
      }
    }
    const orphanJournal = [];
    for (const entry of this.journal.values()) {
      if (Date.parse(entry.createdAt) <= runCutoffMs && !this.workflowRuns.has(entry.runId)) {
        orphanJournal.push(entry.id);
      }
    }
    for (const jid of orphanJournal) {
      this.deleteJournalEntry(jid);
      purgedJournal.push(jid);
    }
    const contextItemsToPurge = [];
    for (const item of this.contextItems.values()) {
      const terminal = item.status === "superseded" || item.status === "rejected" || item.validUntil !== void 0 && Date.parse(item.validUntil) <= runCutoffMs;
      if (!terminal) continue;
      const terminalAt = item.validUntil ?? item.observedAt;
      if (terminalAt && Date.parse(terminalAt) <= runCutoffMs) {
        contextItemsToPurge.push(item.id);
      }
    }
    for (const id of contextItemsToPurge) {
      this.deleteContextItem(id);
      purgedContextItems.push(id);
    }
    return { purgedMessages, purgedRuns, purgedJournal, purgedContextItems };
  }
  saveWorkflowRun(run) {
    this.workflowRuns.set(run.id, run);
    this.database?.prepare(`
      INSERT INTO workflow_runs (id, definition_id, delivery_id, record) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET record = excluded.record
    `).run(run.id, run.definitionId, run.deliveryId, JSON.stringify(run));
  }
  saveJournalEntry(entry) {
    this.journal.set(entry.id, entry);
    this.database?.prepare(`
      INSERT INTO workflow_journal (id, run_id, category, area, record) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET record = excluded.record
    `).run(entry.id, entry.runId, entry.category, entry.area, JSON.stringify(entry));
  }
  saveContextItem(item) {
    this.contextItems.set(item.id, item);
    this.database?.prepare(`
      INSERT INTO context_items (id, project, kind, record) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET record = excluded.record
    `).run(item.id, item.project, item.kind, JSON.stringify(item));
  }
  getContextItem(id, project) {
    const item = this.contextItems.get(id);
    if (!item) return void 0;
    if (project !== void 0 && item.project !== project) return void 0;
    return item;
  }
  listContextItems(project, kinds) {
    const wanted = kinds ? new Set(kinds) : void 0;
    return [...this.contextItems.values()].filter((item) => item.project === project).filter((item) => wanted === void 0 || wanted.has(item.kind)).sort((left, right) => left.id.localeCompare(right.id));
  }
  saveWorkflowTransition(run, message, entry) {
    if (this.database) {
      withDatabaseTransaction(this.database, () => {
        if (message) {
          this.database.prepare(`
            INSERT INTO messages (id, record) VALUES (?, ?)
            ON CONFLICT(id) DO UPDATE SET record = excluded.record
          `).run(message.id, JSON.stringify(message));
        }
        if (entry) {
          this.database.prepare(`
            INSERT INTO workflow_journal (id, run_id, category, area, record) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET record = excluded.record
          `).run(entry.id, entry.runId, entry.category, entry.area, JSON.stringify(entry));
        }
        this.database.prepare(`
          INSERT INTO workflow_runs (id, definition_id, delivery_id, record) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET record = excluded.record
        `).run(run.id, run.definitionId, run.deliveryId, JSON.stringify(run));
      });
    }
    if (message) Map.prototype.set.call(this.messages, message.id, message);
    if (entry) this.journal.set(entry.id, entry);
    this.workflowRuns.set(run.id, run);
  }
  healthy() {
    if (!this.database) return true;
    return this.database.prepare("SELECT 1 AS ok").get() !== void 0;
  }
  close() {
    this.database?.close();
  }
  load() {
    if (!this.database) return;
    const agentRows = this.database.prepare("SELECT record FROM agents").all();
    const workflowRows = this.database.prepare("SELECT record FROM workflow_runs").all();
    const journalRows = this.database.prepare("SELECT record FROM workflow_journal").all();
    const contextRows = this.database.prepare("SELECT record FROM context_items").all();
    for (const row of agentRows) {
      const agent = JSON.parse(row.record);
      this.agents.set(agent.id, agent);
    }
    for (const row of workflowRows) {
      const run = JSON.parse(row.record);
      this.workflowRuns.set(run.id, run);
    }
    for (const row of journalRows) {
      const entry = JSON.parse(row.record);
      this.journal.set(entry.id, entry);
    }
    for (const row of contextRows) {
      const item = JSON.parse(row.record);
      this.contextItems.set(item.id, item);
    }
  }
};

// plugins/kxm/src/hub.ts
var DEFAULT_WORKFLOW_WAIT_TIMEOUT_MS = 24 * 60 * 6e4;
var MIN_WORKFLOW_WAIT_TIMEOUT_MS = 1e3;
var MAX_WORKFLOW_WAIT_TIMEOUT_MS = 30 * 24 * 60 * 6e4;
function isLoopback(host2) {
  if (host2 === "localhost" || host2 === "::1") return true;
  return isIP(host2) === 4 && host2.startsWith("127.");
}
function publicAgent(agent, staleAfterMs, now = Date.now()) {
  const { key: _key, ...identity } = agent;
  return toAgentRecord(identity, staleAfterMs, now);
}
function safeTokenEqual(actual, expected) {
  return timingSafeStringCompare(actual, expected);
}
function bearerToken(request) {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : void 0;
}
function json(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}
function text(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}
async function readBody(request) {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ProtocolError(415, "content-type must be application/json", "unsupported_media_type");
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) {
      throw new ProtocolError(413, "request body is too large", "payload_too_large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
function parseJsonBody(buffer) {
  if (buffer.length === 0) return {};
  try {
    const value = JSON.parse(buffer.toString("utf8"));
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      throw new Error("body must be an object");
    }
    return value;
  } catch {
    throw new ProtocolError(400, "request body must be valid JSON object", "invalid_json");
  }
}
async function readJson(request) {
  return parseJsonBody(await readBody(request));
}
function sameWorkflowMessageContext(left, right) {
  if (!left || !right) return left === right;
  return left.schema === right.schema && left.runId === right.runId && left.stageId === right.stageId && left.requirementKey === right.requirementKey && left.attempt === right.attempt;
}
function parseOptionalBoolean(value, field) {
  if (value === void 0 || value === null) return false;
  if (typeof value === "boolean") return value;
  throw new ProtocolError(400, `${field} must be a boolean`);
}
function sameIdempotentRequest(message, target, content, delivery, correlationId, replyTo, hops, maxHops, ttlMs, workflowContext) {
  return (message.to === target || message.toName.toLowerCase() === target.toLowerCase()) && message.content === content && message.delivery === delivery && message.correlationId === correlationId && message.replyTo === replyTo && message.hops === hops && message.maxHops === maxHops && sameWorkflowMessageContext(message.workflowContext, workflowContext) && Date.parse(message.expiresAt) - Date.parse(message.createdAt) === ttlMs;
}
function parseContextAuthority(value) {
  if (typeof value !== "string" || !CONTEXT_AUTHORITIES.includes(value)) {
    throw new ProtocolError(400, "authority must be one of policy, instruction, evidence, hypothesis", "invalid_context_request");
  }
  return value;
}
function parseContextConfidence(value) {
  if (typeof value !== "string" || !CONTEXT_CONFIDENCES.includes(value)) {
    throw new ProtocolError(400, "confidence must be one of verified, probable, uncertain", "invalid_context_request");
  }
  return value;
}
function boundedStringList(value, field, maxItems = 32) {
  if (value === void 0) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new ProtocolError(400, `${field} must be an array with at most ${maxItems} items`);
  }
  return value.map((item, index) => requireString(item, `${field}[${index}]`, { max: 1e3 }));
}
function boundedWorkflowEvidence(value, field = "evidence", maxItems = 64) {
  if (value === void 0) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, `${field} must be an object keyed by required evidence identity`, "invalid_workflow_evidence");
  }
  const entries = Object.entries(value);
  if (entries.length > maxItems) {
    throw new ProtocolError(400, `${field} must contain at most ${maxItems} keyed items`, "invalid_workflow_evidence");
  }
  const evidence = /* @__PURE__ */ new Map();
  for (const [rawRequirement, rawEvidence] of entries) {
    const requirement = canonicalWorkflowEvidenceKey(
      requireString(rawRequirement, `${field} requirement`, { max: 128 })
    );
    if (evidence.has(requirement)) {
      throw new ProtocolError(
        400,
        `${field} contains duplicate normalized requirement identity: ${requirement}`,
        "invalid_workflow_evidence"
      );
    }
    evidence.set(requirement, requireString(rawEvidence, `${field}.${requirement}`, { max: 1e3 }));
  }
  return Object.fromEntries(evidence);
}
function boundedWorkflowEvidenceReferences(value, field = "evidenceRefs", maxItems = 32) {
  if (value === void 0) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, `${field} must be an object keyed by required evidence identity`, "invalid_workflow_evidence_refs");
  }
  const entries = Object.entries(value);
  if (entries.length > maxItems) {
    throw new ProtocolError(400, `${field} must contain at most ${maxItems} requirements`, "invalid_workflow_evidence_refs");
  }
  const references = /* @__PURE__ */ new Map();
  for (const [rawRequirement, rawReference] of entries) {
    const requirement = canonicalWorkflowEvidenceKey(
      requireString(rawRequirement, `${field} requirement`, { max: 128 })
    );
    if (references.has(requirement)) {
      throw new ProtocolError(
        400,
        `${field} contains duplicate normalized requirement identity: ${requirement}`,
        "invalid_workflow_evidence_refs"
      );
    }
    if (!rawReference || typeof rawReference !== "object" || Array.isArray(rawReference)) {
      throw new ProtocolError(400, `${field}.${requirement} must be an object`, "invalid_workflow_evidence_refs");
    }
    const referenceObject = rawReference;
    if (Object.keys(referenceObject).some((key) => key !== "messageIds")) {
      throw new ProtocolError(
        400,
        `${field}.${requirement} may contain only messageIds; provenance is hub-derived`,
        "invalid_workflow_evidence_refs"
      );
    }
    const rawIds = referenceObject.messageIds;
    if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > 16) {
      throw new ProtocolError(
        400,
        `${field}.${requirement}.messageIds must contain between 1 and 16 IDs`,
        "invalid_workflow_evidence_refs"
      );
    }
    const messageIds = rawIds.map((candidate, index) => requireString(candidate, `${field}.${requirement}.messageIds[${index}]`, { max: 80 }));
    if (new Set(messageIds).size !== messageIds.length) {
      throw new ProtocolError(400, `${field}.${requirement}.messageIds must be unique`, "invalid_workflow_evidence_refs");
    }
    references.set(requirement, { messageIds });
  }
  return Object.fromEntries(references);
}
function requestedWorkflowMessageContext(value) {
  if (value === void 0) return void 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, "workflowContext must be an object", "invalid_workflow_context");
  }
  const context = value;
  if (Object.keys(context).some((key) => !["runId", "stageId", "requirementKey", "attempt"].includes(key))) {
    throw new ProtocolError(400, "workflowContext contains unsupported fields", "invalid_workflow_context");
  }
  if (context.attempt === void 0) {
    throw new ProtocolError(400, "workflowContext.attempt is required", "invalid_workflow_context");
  }
  return {
    runId: requireString(context.runId, "workflowContext.runId", { max: 80 }),
    stageId: requireString(context.stageId, "workflowContext.stageId", { max: 64 }),
    requirementKey: canonicalWorkflowEvidenceKey(
      requireString(context.requirementKey, "workflowContext.requirementKey", { max: 128 })
    ),
    attempt: parseBoundedInteger(context.attempt, "workflowContext.attempt", 1, 1, 20)
  };
}
function validateWorkflowSignalContext(evidence, runId, stageId, signalKey) {
  const expectedContext = {
    "workflow.run": runId,
    "workflow.stage": stageId,
    "workflow.signal": signalKey
  };
  for (const [contextKey, expectedValue] of Object.entries(expectedContext)) {
    const suppliedValue = evidence[contextKey];
    if (suppliedValue === void 0 || suppliedValue === expectedValue) continue;
    throw new ProtocolError(
      409,
      `evidence ${contextKey} does not match the workflow signal route and active wait`,
      "workflow_signal_context_mismatch",
      { contextKey }
    );
  }
}
function workflowSignalKey(value) {
  const key = requireString(value, "signalKey", { max: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(key)) {
    throw new ProtocolError(400, "signalKey may contain letters, numbers, dot, underscore, colon, and hyphen", "invalid_signal_key");
  }
  return key;
}
function createMeshHub(options = {}) {
  const host2 = options.host ?? "127.0.0.1";
  const port2 = options.port ?? 7331;
  const authToken2 = options.authToken?.trim();
  const projectTokens2 = Object.fromEntries(
    Object.entries(options.projectTokens ?? {}).map(([project, token]) => [project, token.trim()])
  );
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const defaultMessageTtlMs = options.messageTtlMs ?? DEFAULT_MESSAGE_TTL_MS;
  const messageRetentionMs2 = options.messageRetentionMs ?? DEFAULT_MESSAGE_RETENTION_MS;
  const cleanupIntervalMs = options.cleanupIntervalMs ?? Math.max(250, Math.floor(staleAfterMs / 3));
  const shutdownGraceMs = options.shutdownGraceMs ?? 5e3;
  const rateLimit = options.rateLimit === false ? void 0 : {
    windowMs: options.rateLimit?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
    maxRequests: options.rateLimit?.maxRequests ?? DEFAULT_RATE_LIMIT_MAX
  };
  const webhookWorkflows2 = new Map((options.webhookWorkflows ?? []).map((workflow) => [workflow.id, workflow]));
  const logger = options.logger ?? (() => void 0);
  const assetsDir2 = options.assetsDir;
  const hubRepoRoot = options.repoRoot ?? (options.dataPath && options.dataPath !== ":memory:" ? resolve6(dirname5(dirname5(options.dataPath))) : process.cwd());
  const store = new MeshStore(options.dataPath);
  const agents = store.agents;
  const messages = store.messages;
  function agentLogSide(id, fallbackName, side) {
    const agent = agents.get(id);
    return {
      [side]: id,
      [`${side}Name`]: agent?.name ?? fallbackName,
      [`${side}Online`]: Boolean(agent?.online),
      ...agent?.model ? { [`${side}Model`]: agent.model } : {}
    };
  }
  function messageLog(message, fromId, fromName, toId, toName) {
    return {
      project: message.project,
      status: message.status,
      delivery: message.delivery,
      ...agentLogSide(fromId, fromName, "from"),
      ...agentLogSide(toId, toName, "to")
    };
  }
  const workflowRuns = store.workflowRuns;
  const journal = store.journal;
  const stateProvider = new NativeStateProvider(store);
  const skillLifecycle = options.skillLifecycle ?? (options.skillsDir || existsSync5(join6(process.cwd(), ".kxm", "skills")) ? new SkillLifecycle(options.skillsDir ?? join6(process.cwd(), ".kxm", "skills")) : void 0);
  const streams = /* @__PURE__ */ new Map();
  const opsStreams = /* @__PURE__ */ new Set();
  const rateBuckets = /* @__PURE__ */ new Map();
  const counters = {
    requests: 0,
    errors: 0,
    registrations: 0,
    messagesSent: 0,
    messagesReplied: 0,
    messagesCancelled: 0,
    messagesExpired: 0,
    messagesPurged: 0,
    webhooksAccepted: 0,
    workflowCheckpoints: 0,
    workflowWaits: 0,
    workflowSignals: 0,
    workflowWaitTimeouts: 0,
    workflowDegradations: 0,
    journalEntries: 0,
    contextRequests: 0,
    attemptLatencySecondsTotal: 0,
    meteredCostUsdTotal: 0
  };
  let cleanupTimer;
  let closed = false;
  function exportTerminalRetrospective(run) {
    if (!assetsDir2 || run.status !== "completed" && run.status !== "failed") return;
    try {
      const entries = [...journal.values()].filter((entry) => entry.runId === run.id);
      const files = writeRetrospective(`${assetsDir2}${process.platform === "win32" ? "\\" : "/"}retrospectives`, buildRetrospective(run, entries, run.updatedAt));
      logger({ event: "workflow_retrospective_exported", workflowRunId: run.id, jsonPath: files.jsonPath, markdownPath: files.mdPath });
    } catch (error) {
      logger({ event: "workflow_retrospective_export_failed", workflowRunId: run.id, error: error instanceof Error ? error.message : "retrospective_export_failed" });
    }
  }
  if (!isLoopback(host2) && !authToken2) {
    store.close();
    throw new Error("KXM_AUTH_TOKEN is required when binding beyond localhost");
  }
  if (staleAfterMs < 100 || defaultMessageTtlMs < MIN_MESSAGE_TTL_MS || messageRetentionMs2 < MIN_MESSAGE_RETENTION_MS || shutdownGraceMs < 0) {
    store.close();
    throw new Error("stale and message TTL settings are below supported minimums");
  }
  if (rateLimit && (rateLimit.windowMs < 100 || rateLimit.maxRequests < 1)) {
    store.close();
    throw new Error("rate limit settings are invalid");
  }
  if (webhookWorkflows2.size !== (options.webhookWorkflows ?? []).length) {
    store.close();
    throw new Error("webhook workflow IDs must be unique");
  }
  for (const agent of agents.values()) {
    agent.online = false;
    store.saveAgent(agent);
  }
  function expectedProjectToken(project) {
    return projectTokens2[project] || authToken2;
  }
  function requireProjectAuth(request, project) {
    const expected = expectedProjectToken(project);
    if (!expected) return;
    if (!safeTokenEqual(bearerToken(request), expected)) {
      throw new ProtocolError(401, "invalid project authentication token", "invalid_auth", {
        operation: "other",
        nextAction: "check_project_token"
      });
    }
  }
  function contextCallerProject(request, requested) {
    const project = requireString(requested, "project", { max: 200 });
    const agentHeader = request.headers["x-kxm-agent-id"];
    if (typeof agentHeader === "string" && agentHeader.trim()) {
      const agent = requireAgent(request);
      requireProjectAuth(request, agent.project);
      if (agent.project !== project) {
        throw new ProtocolError(403, "context requests are limited to the agent's project", "context_isolation_violation");
      }
      return { project, caller: agent.id };
    }
    requireAdminAuth(request);
    const callerHeader = request.headers["x-kxm-caller-id"];
    const caller = typeof callerHeader === "string" && callerHeader.trim() ? callerHeader.trim() : "kxm-admin";
    return { project, caller };
  }
  function requireAdminAuth(request) {
    if (!authToken2 && isLoopback(host2)) return;
    if (!authToken2 || !safeTokenEqual(bearerToken(request), authToken2)) {
      throw new ProtocolError(401, "invalid administrative authentication token", "invalid_auth", {
        operation: "other",
        nextAction: "check_project_token"
      });
    }
  }
  function requireConfiguredAdminAuth(request, purpose = "workflow degradation approval") {
    if (!authToken2) {
      throw new ProtocolError(
        503,
        `KXM_AUTH_TOKEN must be configured for ${purpose}`,
        "admin_auth_not_configured"
      );
    }
    requireAdminAuth(request);
  }
  function requireAgent(request, expectedId) {
    const agentId = expectedId ?? String(request.headers["x-kxm-agent-id"] ?? "");
    const agentKey = String(request.headers["x-kxm-agent-key"] ?? "");
    const agent = agents.get(agentId);
    if (!agent || !agentKey || !safeTokenEqual(agentKey, agent.key)) {
      throw new ProtocolError(401, "invalid agent identity", "invalid_agent_identity", {
        operation: "other",
        nextAction: "reconnect_with_current_agent_key"
      });
    }
    const wasOffline = !agent.online;
    agent.lastSeenAt = nowIso();
    agent.online = true;
    store.saveAgent(agent);
    if (wasOffline) {
      broadcastPresence(agent);
      if ((streams.get(agent.id)?.size ?? 0) > 0) flushPending(agent.id);
    }
    return agent;
  }
  function checkRateLimit(request, response) {
    if (!rateLimit) return;
    const key = String(request.headers["x-kxm-agent-id"] ?? request.socket.remoteAddress ?? "unknown");
    const now = Date.now();
    const current = rateBuckets.get(key);
    const bucket = !current || now - current.startedAt >= rateLimit.windowMs ? { startedAt: now, count: 0 } : current;
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    const remaining = Math.max(0, rateLimit.maxRequests - bucket.count);
    response.setHeader("x-ratelimit-limit", String(rateLimit.maxRequests));
    response.setHeader("x-ratelimit-remaining", String(remaining));
    if (bucket.count > rateLimit.maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.startedAt + rateLimit.windowMs - now) / 1e3));
      response.setHeader("retry-after", String(retryAfterSeconds));
      throw new ProtocolError(429, "request rate limit exceeded", "rate_limited");
    }
  }
  function publish(agentId, event) {
    const clients = streams.get(agentId);
    if (!clients || clients.size === 0) return false;
    let frame;
    let published = false;
    for (const client of clients) {
      if (client.presenceOnly && event.type !== "presence") continue;
      frame ??= `event: ${event.type}
data: ${JSON.stringify(event)}

`;
      client.response.write(frame);
      published = true;
    }
    return published;
  }
  function publishOps(project, topic) {
    const frame = `event: ops
data: ${JSON.stringify({ type: "ops", project, topic, at: nowIso() })}

`;
    for (const client of opsStreams) {
      if (client.project === project) client.response.write(frame);
    }
  }
  function opsSnapshot(project) {
    const snapshotAt = Date.now();
    const projectAgents = [...agents.values()].filter((agent) => agent.project === project).map((agent) => publicAgent(agent, staleAfterMs, snapshotAt)).sort((left, right) => Number(right.online) - Number(left.online) || left.name.localeCompare(right.name));
    const open = store.getOpenMessages(project);
    const projectRuns = [...workflowRuns.values()].filter((run) => run.project === project).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return {
      project,
      fetchedAt: nowIso(),
      agents: projectAgents,
      openMessages: open.slice(0, 16).map((message) => ({
        id: message.id,
        status: message.status,
        fromName: message.fromName,
        toName: message.toName,
        delivery: message.delivery,
        createdAt: message.createdAt,
        ...message.correlationId ? { correlationId: message.correlationId } : {}
      })),
      openMessageTotal: open.length,
      runs: projectRuns.slice(0, 8).map((run) => {
        const stages = (run.stages ?? []).slice(0, 16).map((stage) => ({
          id: stage.id,
          label: stage.label,
          status: stage.status,
          ...stage.attempts ? { attempts: stage.attempts } : {}
        }));
        const done = stages.filter((stage) => stage.status === "passed" || stage.status === "failed" || stage.status === "warning").length;
        return {
          id: run.id,
          status: run.status,
          definitionId: run.definitionId,
          project: run.project,
          ...run.currentStage ? { currentStage: run.currentStage } : {},
          ...run.targetAgentName ? { targetAgentName: run.targetAgentName } : {},
          ...run.updatedAt ? { updatedAt: run.updatedAt } : {},
          ...stages.length > 0 ? { progress: { done, total: stages.length }, stages } : {}
        };
      }),
      runTotal: projectRuns.length,
      plans: [...journal.values()].filter((entry) => entry.category === "plan" && projectRuns.some((run) => run.id === entry.runId)).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)).slice(0, 16).map((entry) => ({
        id: entry.id,
        runId: entry.runId,
        summary: entry.summary.replace(/\s+/g, " ").trim().slice(0, 120),
        createdAt: entry.createdAt,
        ...entry.stageId ? { stageId: entry.stageId } : {},
        ...entry.severity ? { severity: entry.severity } : {}
      }))
    };
  }
  function broadcastPresence(agent) {
    for (const candidate of agents.values()) {
      if (candidate.project === agent.project && candidate.id !== agent.id && candidate.online) {
        publish(candidate.id, { type: "presence", agent: publicAgent(agent, staleAfterMs) });
      }
    }
    publishOps(agent.project, "agents");
  }
  function findTarget(project, target, allowOffline = false) {
    const byId = agents.get(target);
    if (byId?.project === project && (allowOffline || byId.online)) return byId;
    const byName = [...agents.values()].find(
      (agent) => agent.project === project && (allowOffline || agent.online) && agent.name.toLowerCase() === target.toLowerCase()
    );
    if (!byName) throw new ProtocolError(404, `online target not found: ${target}`, "target_not_found");
    return byName;
  }
  function findKnownTarget(project, target) {
    const byId = agents.get(target);
    if (byId?.project === project) return byId;
    const byName = [...agents.values()].find(
      (agent) => agent.project === project && agent.name.toLowerCase() === target.toLowerCase()
    );
    if (!byName) {
      throw new ProtocolError(409, `workflow target has not registered: ${target}`, "workflow_target_unavailable");
    }
    return byName;
  }
  function resolveStageEvidencePolicies(stage, project, coordinator) {
    if (!stage.evidencePolicies) return void 0;
    const resolved = /* @__PURE__ */ new Map();
    for (const [requirementKey, policy] of Object.entries(stage.evidencePolicies)) {
      const eligible = /* @__PURE__ */ new Map();
      for (const selector of policy.eligibleAgents) {
        const agent = findKnownTarget(project, selector);
        if (agent.id === coordinator.id) {
          throw new ProtocolError(
            409,
            `workflow evidence policy ${stage.id}/${requirementKey} cannot include the coordinator`,
            "workflow_evidence_policy_invalid"
          );
        }
        eligible.set(agent.id, { id: agent.id, name: agent.name });
      }
      if (eligible.size < policy.minProducers) {
        throw new ProtocolError(
          409,
          `workflow evidence policy ${stage.id}/${requirementKey} resolves to ${eligible.size} unique producers but requires ${policy.minProducers}`,
          "workflow_evidence_policy_unresolvable"
        );
      }
      resolved.set(requirementKey, {
        kind: "peer-reply",
        minProducers: policy.minProducers,
        eligibleProducers: [...eligible.values()],
        acceptedStatuses: ["replied"],
        ...policy.degradation ? { degradation: { ...policy.degradation } } : {}
      });
    }
    return Object.fromEntries(resolved);
  }
  function authorizeWorkflowMessageContext(sender, targetInput, requested) {
    const run = workflowRuns.get(requested.runId);
    if (!run || run.project !== sender.project || run.targetAgentId !== sender.id) {
      throw new ProtocolError(403, "workflow context is not assigned to this coordinator", "workflow_context_forbidden");
    }
    const stage = run.stages.find((candidate) => candidate.id === requested.stageId);
    if (!stage || run.currentStage !== stage.id || run.status !== "running" || stage.status !== "in_progress") {
      throw new ProtocolError(409, "workflow context does not reference the active stage", "workflow_context_inactive");
    }
    const requirementKey = canonicalWorkflowEvidenceKey(requested.requirementKey);
    const policy = stage.resolvedEvidencePolicies?.[requirementKey];
    if (!policy) {
      throw new ProtocolError(
        400,
        `workflow requirement ${requirementKey} does not accept peer evidence`,
        "workflow_evidence_policy_missing"
      );
    }
    if (requested.attempt !== stage.attempts + 1) {
      throw new ProtocolError(
        409,
        `workflow context attempt ${requested.attempt} does not match active attempt ${stage.attempts + 1}`,
        "workflow_context_attempt_mismatch"
      );
    }
    const normalizedTarget = targetInput.toLowerCase();
    const eligible = policy.eligibleProducers.find(
      (producer) => producer.id === targetInput || producer.name.toLowerCase() === normalizedTarget
    );
    if (!eligible) {
      throw new ProtocolError(
        403,
        `target ${targetInput} is not eligible for workflow evidence ${requirementKey}`,
        "workflow_evidence_producer_forbidden"
      );
    }
    return {
      schema: "pi-mesh.workflow-message-context.v1",
      runId: run.id,
      stageId: stage.id,
      requirementKey,
      attempt: requested.attempt
    };
  }
  function webhookEvent(request, payload) {
    const header = request.headers["x-github-event"];
    if (typeof header === "string" && header.trim()) return header.trim();
    const candidate = payload.webhookEvent ?? payload.event;
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : void 0;
  }
  function verifyWebhookSignature(request, body, secret) {
    const signature = request.headers["x-hub-signature-256"] ?? request.headers["x-hub-signature"];
    if (typeof signature !== "string") {
      throw new ProtocolError(401, "webhook signature is required", "webhook_signature_missing");
    }
    const separator = signature.indexOf("=");
    const algorithm = separator > 0 ? signature.slice(0, separator).toLowerCase() : "";
    if (algorithm !== "sha256") {
      throw new ProtocolError(401, "webhook signature must use sha256", "webhook_signature_unsupported");
    }
    const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    if (!safeTokenEqual(signature, expected)) {
      throw new ProtocolError(401, "webhook signature is invalid", "webhook_signature_invalid");
    }
  }
  function workflowPrompt(definition, runId, payload) {
    const rendered = renderWorkflowPrompt(definition.promptTemplate, payload);
    const stageList = definition.stages.map((stage, index) => {
      const peerPolicies = Object.entries(stage.evidencePolicies ?? {}).map(([requirement, policy]) => `   Peer evidence ${requirement}: ${policy.minProducers} unique replied producer(s) from ${policy.eligibleAgents.join(", ")}`);
      return [
        `${index + 1}. ${stage.label} (stageId: ${stage.id}, maxAttempts: ${stage.maxAttempts})`,
        `   ${stage.instructions}`,
        `   Required evidence keys: ${stage.requiredEvidence.join(", ") || "none"}`,
        ...peerPolicies
      ].join("\n");
    }).join("\n");
    return [
      `Durable workflow run: ${runId}`,
      `Workflow: ${definition.id}`,
      "",
      rendered,
      "",
      "Execute these stages in order:",
      stageList,
      "",
      "At every stage, record material plans, decisions, contradictions, errors, and lessons with kxm_workflow_record.",
      "Keep repository-local configuration in .kxm/config, logs in .kxm/logs, and durable workflow artifacts in .kxm/assets; never commit runtime logs, state, or secrets.",
      "Complete each stage with kxm_workflow_checkpoint. Supply evidence as an object whose keys exactly match the stage's required evidence keys. Unrelated keys never satisfy a requirement. A warning or failure must be corrected and checkpointed again until it passes or the attempt limit is reached.",
      "For a peer-evidence requirement, send or fan out with workflowContext containing this run ID, the exact stage ID, requirement key, and current 1-based attempt. At checkpoint, cite only the returned message IDs under evidenceRefs; the hub derives producer and reply provenance.",
      "When an external system must finish asynchronously, call kxm_workflow_wait with a stable signal key and any already-verified keyed evidence. That evidence is accumulated with the signed callback before the stage can pass; then settle the turn.",
      "For multi-agent planning, delegate to the requested peers, compare their proposals, record contradictions, and synthesize the strongest evidence-backed plan.",
      "Do not claim the workflow is complete until the checkpoint response reports completed=true."
    ].join("\n");
  }
  function createWorkflowResumeMessage(run, definition, deliveryId, signalKey, status, summary, evidence, retry) {
    const createdAt = nowIso();
    const ttlMs = parseBoundedInteger(
      definition.ttlMs,
      "workflow.ttlMs",
      defaultMessageTtlMs,
      MIN_MESSAGE_TTL_MS,
      MAX_MESSAGE_TTL_MS
    );
    const nextInstruction = retry ? `Correct the ${status} result, rerun the external check, then wait for a new signal or checkpoint the stage.` : `Continue with stage ${run.currentStage}.`;
    const content = requireString([
      `Resume durable workflow run: ${run.id}`,
      `Workflow: ${definition.id}`,
      `External signal: ${signalKey}`,
      `Result: ${status}`,
      `Summary: ${summary}`,
      `Evidence: ${workflowEvidenceStrings(evidence).join(", ") || "none supplied"}`,
      "",
      nextInstruction,
      "Review the run with kxm_workflow_get and keep recording material plans, decisions, contradictions, errors, and lessons.",
      "Do not claim the workflow is complete until the checkpoint response reports completed=true."
    ].join("\n"), "workflow resume prompt", { max: MAX_CONTENT_CHARS });
    const seq = store.nextAgentSequence(run.targetAgentId);
    const message = {
      id: newId("msg"),
      project: run.project,
      from: `workflow:${run.id}`,
      fromName: `signal:${definition.id}`,
      to: run.targetAgentId,
      toName: run.targetAgentName,
      content,
      delivery: definition.delivery,
      hops: 0,
      maxHops: DEFAULT_MAX_HOPS,
      seq,
      correlationId: run.id,
      workflowRunId: run.id,
      idempotencyKey: `${definition.id}:signal:${deliveryId}`,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
      status: "queued"
    };
    run.messageId = message.id;
    run.updatedAt = createdAt;
    return message;
  }
  function expireWorkflowWaits() {
    const timestamp = nowIso();
    const now = Date.parse(timestamp);
    for (const run of workflowRuns.values()) {
      if (run.status !== "waiting" || !run.waiting || Date.parse(run.waiting.expiresAt) > now) continue;
      const transition = structuredClone(run);
      const waiting = transition.waiting;
      const stage = transition.stages.find((candidate) => candidate.id === waiting.stageId);
      if (stage) {
        stage.status = "failed";
        stage.summary = `Timed out waiting for external signal ${waiting.signalKey}`;
        stage.updatedAt = timestamp;
      }
      transition.status = "failed";
      delete transition.currentStage;
      delete transition.waiting;
      transition.updatedAt = timestamp;
      const entry = {
        id: newId("journal"),
        runId: transition.id,
        agentId: transition.targetAgentId,
        category: "error",
        area: stage?.area ?? "harness",
        severity: "error",
        summary: `External workflow signal timed out: ${waiting.signalKey}`,
        evidence: [`wait-created:${waiting.createdAt}`, `wait-expired:${waiting.expiresAt}`],
        relatedEntryIds: [],
        createdAt: timestamp
      };
      const definition = webhookWorkflows2.get(transition.definitionId);
      const ttlMs = parseBoundedInteger(
        definition?.ttlMs,
        "workflow.ttlMs",
        defaultMessageTtlMs,
        MIN_MESSAGE_TTL_MS,
        MAX_MESSAGE_TTL_MS
      );
      const seq = store.nextAgentSequence(transition.targetAgentId);
      const message = {
        id: newId("msg"),
        project: transition.project,
        from: `workflow:${transition.id}`,
        fromName: `timeout:${transition.definitionId}`,
        to: transition.targetAgentId,
        toName: transition.targetAgentName,
        content: [
          `Durable workflow run ${transition.id} failed while waiting for external signal ${waiting.signalKey}.`,
          `Stage: ${waiting.stageId}`,
          `Expected: ${waiting.summary}`,
          `Deadline: ${waiting.expiresAt}`,
          "Review whether the external action completed, record any follow-up outside this terminal run, and escalate or start a new retry-safe workflow only when appropriate."
        ].join("\n"),
        delivery: definition?.delivery ?? "followUp",
        hops: 0,
        maxHops: DEFAULT_MAX_HOPS,
        seq,
        correlationId: transition.id,
        workflowRunId: transition.id,
        idempotencyKey: `${transition.definitionId}:timeout:${waiting.signalKey}:${waiting.expiresAt}`,
        createdAt: timestamp,
        expiresAt: new Date(Date.parse(timestamp) + ttlMs).toISOString(),
        status: "queued"
      };
      transition.messageId = message.id;
      store.saveWorkflowTransition(transition, message, entry);
      publishOps(transition.project, "workflows");
      publishOps(transition.project, "messages");
      exportTerminalRetrospective(transition);
      if (agents.get(transition.targetAgentId)?.online) {
        publish(transition.targetAgentId, { type: "message", message });
      }
      counters.workflowWaitTimeouts += 1;
      counters.journalEntries += 1;
      logger({
        event: "workflow_wait_timed_out",
        workflowRunId: transition.id,
        stageId: waiting.stageId,
        signalKey: waiting.signalKey,
        messageId: message.id
      });
    }
  }
  function flushPending(agentId) {
    expireMessages();
    const cursor = store.getConsumerCursor(agentId);
    const pending = store.getPendingMessages(agentId, cursor);
    for (const message of pending) {
      publish(agentId, { type: "message", message });
    }
  }
  function expireMessages() {
    const now = Date.now();
    for (const message of store.getExpiringMessages(now)) {
      if ((message.status === "queued" || message.status === "delivered") && Date.parse(message.expiresAt) <= now) {
        message.status = "expired";
        message.error = "message expired before a reply was received";
        store.saveMessage(message);
        publishOps(message.project, "messages");
        publish(message.from, { type: "expired", message });
        publish(message.to, { type: "expired", message });
        counters.messagesExpired += 1;
        logger({ event: "message_expired", messageId: message.id, ...messageLog(message, message.from, message.fromName, message.to, message.toName) });
        const run = [...workflowRuns.values()].find(
          (candidate) => candidate.messageId === message.id && candidate.status === "running"
        );
        if (run) {
          run.status = "failed";
          delete run.currentStage;
          run.updatedAt = nowIso();
          store.saveWorkflowRun(run);
          publishOps(run.project, "workflows");
          const entry = {
            id: newId("journal"),
            runId: run.id,
            agentId: run.targetAgentId,
            category: "error",
            area: "harness",
            severity: "error",
            summary: "Workflow coordinator prompt expired before completion",
            evidence: [`message:${message.id}`],
            relatedEntryIds: [],
            createdAt: run.updatedAt
          };
          store.saveJournalEntry(entry);
          counters.journalEntries += 1;
          exportTerminalRetrospective(run);
        }
      }
    }
  }
  function purgeTerminalMessages() {
    const swept = store.sweepRetention(messageRetentionMs2);
    for (const message of swept.purgedMessages) {
      publishOps(message.project, "messages");
      counters.messagesPurged += 1;
      logger({ event: "message_purged", messageId: message.id, ...messageLog(message, message.from, message.fromName, message.to, message.toName) });
    }
    for (const runId of swept.purgedRuns) {
      logger({ event: "workflow_run_purged", runId });
    }
  }
  function metricsBody() {
    const onlineAgents = [...agents.values()].filter((agent) => agent.online).length;
    return [
      "# HELP kxm_online_agents Current online agent count.",
      "# TYPE kxm_online_agents gauge",
      `kxm_online_agents ${onlineAgents}`,
      "# HELP kxm_messages Current retained message count.",
      "# TYPE kxm_messages gauge",
      `kxm_messages ${store.countMessages()}`,
      "# TYPE kxm_requests_total counter",
      `kxm_requests_total ${counters.requests}`,
      "# TYPE kxm_errors_total counter",
      `kxm_errors_total ${counters.errors}`,
      "# TYPE kxm_registrations_total counter",
      `kxm_registrations_total ${counters.registrations}`,
      "# TYPE kxm_messages_sent_total counter",
      `kxm_messages_sent_total ${counters.messagesSent}`,
      "# TYPE kxm_messages_replied_total counter",
      `kxm_messages_replied_total ${counters.messagesReplied}`,
      "# TYPE kxm_messages_cancelled_total counter",
      `kxm_messages_cancelled_total ${counters.messagesCancelled}`,
      "# TYPE kxm_messages_expired_total counter",
      `kxm_messages_expired_total ${counters.messagesExpired}`,
      "# TYPE kxm_messages_purged_total counter",
      `kxm_messages_purged_total ${counters.messagesPurged}`,
      "# TYPE kxm_webhooks_accepted_total counter",
      `kxm_webhooks_accepted_total ${counters.webhooksAccepted}`,
      "# TYPE kxm_workflow_checkpoints_total counter",
      `kxm_workflow_checkpoints_total ${counters.workflowCheckpoints}`,
      "# TYPE kxm_workflow_waits_total counter",
      `kxm_workflow_waits_total ${counters.workflowWaits}`,
      "# TYPE kxm_workflow_signals_total counter",
      `kxm_workflow_signals_total ${counters.workflowSignals}`,
      "# TYPE kxm_workflow_wait_timeouts_total counter",
      `kxm_workflow_wait_timeouts_total ${counters.workflowWaitTimeouts}`,
      "# TYPE kxm_workflow_degradations_total counter",
      `kxm_workflow_degradations_total ${counters.workflowDegradations}`,
      "# TYPE kxm_workflow_journal_entries_total counter",
      `kxm_workflow_journal_entries_total ${counters.journalEntries}`,
      "# TYPE kxm_context_requests_total counter",
      `kxm_context_requests_total ${counters.contextRequests}`,
      "# TYPE kxm_attempt_latency_seconds_total counter",
      `kxm_attempt_latency_seconds_total ${counters.attemptLatencySecondsTotal}`,
      "# TYPE kxm_metered_cost_usd_total counter",
      `kxm_metered_cost_usd_total ${counters.meteredCostUsdTotal}`,
      ""
    ].join("\n");
  }
  const server = createServer(async (request, response) => {
    const requestIdHeader = request.headers["x-request-id"];
    const requestId = typeof requestIdHeader === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(requestIdHeader) ? requestIdHeader : newId("req");
    response.setHeader("x-request-id", requestId);
    response.setHeader("referrer-policy", "no-referrer");
    counters.requests += 1;
    try {
      let projectContextPool2 = function(project, journalCategories) {
        const pool = store.listContextItems(project);
        try {
          const authored = loadAuthoredMemory(hubRepoRoot);
          for (const rec of authored) {
            pool.push(memoryRecordToContextItem(rec, project));
          }
        } catch {
        }
        const categoryFilter = journalCategories ? new Set(journalCategories) : void 0;
        const runIds = new Set(
          [...workflowRuns.values()].filter((run) => run.project === project).map((run) => run.id)
        );
        const contradictionIds = [];
        for (const entry of journal.values()) {
          if (!runIds.has(entry.runId)) continue;
          if (categoryFilter && !categoryFilter.has(entry.category)) continue;
          pool.push(journalEntryToContextItem(entry, project));
          if (entry.category === "contradiction") contradictionIds.push(`journal_${entry.id}`);
        }
        for (const contradiction of stateProvider.contradictions()) {
          if (contradiction.project !== project) continue;
          contradictionIds.push(...contradiction.competingCurrentIds, ...contradiction.competingProposalIds);
        }
        return { pool, contradictionIds };
      }, contextWikiPool2 = function(project, compiledAt) {
        const { pool, contradictionIds } = projectContextPool2(project);
        const stateItems = store.listContextItems(project, ["state"]);
        const contradictions = stateProvider.contradictions().filter((entry) => entry.project === project);
        return {
          project,
          stateItems,
          contextItems: pool,
          contradictions,
          openContradictionItemIds: contradictionIds,
          compiledAt
        };
      };
      var projectContextPool = projectContextPool2, contextWikiPool = contextWikiPool2;
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const method = request.method ?? "GET";
      if (method === "GET" && url.pathname === "/health") {
        json(response, 200, { ok: true, agents: [...agents.values()].filter((agent) => agent.online).length });
        return;
      }
      if (method === "GET" && url.pathname === "/ready") {
        const ready = store.healthy();
        json(response, ready ? 200 : 503, { ok: ready, storage: store.persistent ? "sqlite" : "memory" });
        return;
      }
      checkRateLimit(request, response);
      const signalMatch = url.pathname.match(/^\/v1\/webhooks\/([^/]+)\/runs\/([^/]+)\/signals\/([^/]+)$/);
      if (method === "POST" && signalMatch) {
        const definitionId = decodeURIComponent(signalMatch[1]);
        const runId = decodeURIComponent(signalMatch[2]);
        const signalKey = workflowSignalKey(decodeURIComponent(signalMatch[3]));
        const definition = webhookWorkflows2.get(definitionId);
        if (!definition) throw new ProtocolError(404, "webhook workflow not found", "webhook_not_found");
        const rawBody = await readBody(request);
        verifyWebhookSignature(request, rawBody, definition.signalSecret ?? definition.secret);
        const body = parseJsonBody(rawBody);
        const run = workflowRuns.get(runId);
        if (!run || run.definitionId !== definition.id) {
          throw new ProtocolError(404, "workflow run not found", "workflow_not_found");
        }
        const deliveryHeader = request.headers["x-atlassian-webhook-identifier"] ?? request.headers["x-github-delivery"] ?? request.headers["x-kxm-delivery-id"];
        const deliveryId = requireString(deliveryHeader, "webhook delivery identifier", { max: 128 });
        const payloadHash = createHash4("sha256").update(rawBody).digest("hex");
        const existingReceipt = run.signalReceipts?.find((receipt2) => receipt2.deliveryId === deliveryId);
        if (existingReceipt) {
          if (existingReceipt.signalKey !== signalKey || existingReceipt.payloadHash !== payloadHash) {
            throw new ProtocolError(
              409,
              "webhook delivery identifier was already used for a different signal",
              "workflow_signal_delivery_conflict"
            );
          }
          json(response, 200, {
            duplicate: true,
            status: existingReceipt.status,
            stageId: existingReceipt.stageId,
            signalKey: existingReceipt.signalKey,
            receivedAt: existingReceipt.receivedAt,
            degraded: existingReceipt.degraded === true,
            degradedRequirements: existingReceipt.degradedRequirements ?? [],
            resumed: Boolean(existingReceipt.messageId)
          });
          return;
        }
        expireWorkflowWaits();
        const status = requireString(body.status, "status", { max: 16 });
        if (status !== "passed" && status !== "warning" && status !== "failed") {
          throw new ProtocolError(400, "status must be passed, warning, or failed", "invalid_checkpoint_status");
        }
        const summary = requireString(body.summary, "summary", { max: 4e3 });
        const evidence = boundedWorkflowEvidence(body.evidence);
        const receivedAt = nowIso();
        const transition = structuredClone(workflowRuns.get(runId));
        if (transition.status === "waiting" && transition.waiting) {
          validateWorkflowSignalContext(
            evidence,
            runId,
            transition.waiting.stageId,
            signalKey
          );
        }
        const result = resumeWorkflowFromSignal(transition, signalKey, status, summary, evidence, receivedAt);
        const receipt = {
          deliveryId,
          payloadHash,
          signalKey,
          stageId: result.stageId,
          status,
          receivedAt
        };
        if (result.degraded) {
          const degradedStage = transition.stages.find((candidate) => candidate.id === result.stageId);
          receipt.degraded = true;
          receipt.degradedRequirements = [...degradedStage.degradedRequirements ?? []];
        }
        (transition.signalReceipts ??= []).push(receipt);
        let message;
        let entry;
        if (status !== "passed") {
          const stage = transition.stages.find((candidate) => candidate.id === result.stageId);
          entry = {
            id: newId("journal"),
            runId: transition.id,
            agentId: transition.targetAgentId,
            category: "error",
            area: stage.area ?? "gates",
            severity: status === "failed" ? "error" : "warning",
            summary: `${stage.label}: ${summary}`,
            evidence: workflowEvidenceStrings(evidence),
            relatedEntryIds: [],
            createdAt: receivedAt
          };
        } else if (result.degraded) {
          const stage = transition.stages.find((candidate) => candidate.id === result.stageId);
          entry = {
            id: newId("journal"),
            runId: transition.id,
            agentId: transition.targetAgentId,
            category: "decision",
            area: stage.area ?? "security",
            severity: "warning",
            summary: `${stage.label} passed from a signed callback using a previously approved degraded peer quorum`,
            evidence: [
              "class:workflow_quorum_degradation_used",
              ...(stage.degradedRequirements ?? []).map((requirement) => `requirement:${requirement}`)
            ],
            relatedEntryIds: [],
            createdAt: receivedAt
          };
        }
        if (transition.status === "running") {
          message = createWorkflowResumeMessage(
            transition,
            definition,
            deliveryId,
            signalKey,
            status,
            summary,
            evidence,
            result.retry
          );
          receipt.messageId = message.id;
        }
        store.saveWorkflowTransition(transition, message, entry);
        publishOps(transition.project, "workflows");
        if (message) publishOps(transition.project, "messages");
        exportTerminalRetrospective(transition);
        if (entry) counters.journalEntries += 1;
        if (message && agents.get(transition.targetAgentId)?.online) {
          publish(transition.targetAgentId, { type: "message", message });
        }
        counters.workflowSignals += 1;
        counters.workflowCheckpoints += 1;
        logger({
          event: "workflow_signal_received",
          workflowRunId: transition.id,
          deliveryId,
          signalKey,
          stageId: result.stageId,
          status,
          retry: result.retry,
          completed: result.completed,
          ...message ? { messageId: message.id } : {}
        });
        json(response, message ? 202 : 200, {
          duplicate: false,
          status,
          stageId: result.stageId,
          signalKey,
          retry: result.retry,
          completed: result.completed,
          degraded: result.degraded === true,
          degradedRequirements: receipt.degradedRequirements ?? [],
          resumed: Boolean(message)
        });
        return;
      }
      const webhookMatch = url.pathname.match(/^\/v1\/webhooks\/([^/]+)$/);
      if (method === "POST" && webhookMatch) {
        const definitionId = decodeURIComponent(webhookMatch[1]);
        const definition = webhookWorkflows2.get(definitionId);
        if (!definition) throw new ProtocolError(404, "webhook workflow not found", "webhook_not_found");
        const rawBody = await readBody(request);
        verifyWebhookSignature(request, rawBody, definition.secret);
        const payload = parseJsonBody(rawBody);
        const event = webhookEvent(request, payload);
        if (definition.event && event !== definition.event) {
          response.writeHead(204, { "cache-control": "no-store" }).end();
          return;
        }
        if (definition.filter && String(valueAtPath(payload, definition.filter.path) ?? "") !== definition.filter.equals) {
          response.writeHead(204, { "cache-control": "no-store" }).end();
          return;
        }
        const deliveryHeader = request.headers["x-atlassian-webhook-identifier"] ?? request.headers["x-github-delivery"] ?? request.headers["x-kxm-delivery-id"];
        const deliveryId = requireString(deliveryHeader, "webhook delivery identifier", { max: 128 });
        const existing = [...workflowRuns.values()].find(
          (run2) => run2.definitionId === definition.id && run2.deliveryId === deliveryId
        );
        if (existing) {
          json(response, 200, { run: existing, duplicate: true });
          return;
        }
        const target = findKnownTarget(definition.project, definition.target);
        const createdAt = nowIso();
        const runId = newId("run");
        const ttlMs = parseBoundedInteger(
          definition.ttlMs,
          "workflow.ttlMs",
          defaultMessageTtlMs,
          MIN_MESSAGE_TTL_MS,
          MAX_MESSAGE_TTL_MS
        );
        const content = requireString(workflowPrompt(definition, runId, payload), "workflow prompt", {
          max: MAX_CONTENT_CHARS
        });
        const seq = store.nextAgentSequence(target.id);
        const message = {
          id: newId("msg"),
          project: definition.project,
          from: `workflow:${runId}`,
          fromName: `webhook:${definition.id}`,
          to: target.id,
          toName: target.name,
          content,
          delivery: definition.delivery,
          hops: 0,
          maxHops: DEFAULT_MAX_HOPS,
          seq,
          correlationId: runId,
          workflowRunId: runId,
          idempotencyKey: `${definition.id}:${deliveryId}`,
          createdAt,
          expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
          status: "queued"
        };
        const stages = definition.stages.map((stage, index) => {
          const resolvedEvidencePolicies = resolveStageEvidencePolicies(stage, definition.project, target);
          return {
            ...stage,
            ...resolvedEvidencePolicies ? { resolvedEvidencePolicies } : {},
            status: index === 0 ? "in_progress" : "pending",
            attempts: 0,
            evidence: {},
            ...index === 0 ? { startedAt: createdAt, updatedAt: createdAt } : {}
          };
        });
        const run = {
          id: runId,
          definitionId: definition.id,
          source: definition.source,
          deliveryId,
          payloadHash: createHash4("sha256").update(rawBody).digest("hex"),
          definitionHash: workflowDefinitionHash(definition),
          ...event ? { event } : {},
          project: definition.project,
          targetAgentId: target.id,
          targetAgentName: target.name,
          messageId: message.id,
          status: "running",
          currentStage: stages[0].id,
          stages,
          ...definition.maxTransitions !== void 0 ? { maxTransitions: definition.maxTransitions } : {},
          ...definition.reproOracle ? { reproOracle: definition.reproOracle } : {},
          ...definition.planHash ? { planHashConfig: definition.planHash } : {},
          ...definition.requirePlanHash ? { requirePlanHash: definition.requirePlanHash } : {},
          createdAt,
          updatedAt: createdAt
        };
        store.saveMessage(message);
        store.saveWorkflowRun(run);
        publishOps(run.project, "messages");
        publishOps(run.project, "workflows");
        if (target.online) publish(target.id, { type: "message", message });
        counters.webhooksAccepted += 1;
        logger({
          event: "webhook_workflow_started",
          workflowId: definition.id,
          workflowRunId: run.id,
          deliveryId,
          project: definition.project,
          target: target.id
        });
        json(response, 202, { run, duplicate: false });
        return;
      }
      if (method === "GET" && url.pathname === "/metrics") {
        requireAdminAuth(request);
        text(response, 200, metricsBody(), "text/plain; version=0.0.4; charset=utf-8");
        return;
      }
      if (method === "GET" && url.pathname === "/v1/ops/snapshot") {
        requireConfiguredAdminAuth(request, "operations metadata");
        const project = requireString(url.searchParams.get("project"), "project", { max: 128 });
        expireMessages();
        expireWorkflowWaits();
        purgeTerminalMessages();
        json(response, 200, opsSnapshot(project));
        return;
      }
      if (method === "GET" && url.pathname === "/v1/ops/events") {
        requireConfiguredAdminAuth(request, "operations metadata");
        const project = requireString(url.searchParams.get("project"), "project", { max: 128 });
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          "x-content-type-options": "nosniff"
        });
        response.write(`event: ready
data: ${JSON.stringify({ type: "ops", project, topic: "agents", at: nowIso() })}

`);
        const client = {
          project,
          response,
          heartbeat: setInterval(() => response.write(": heartbeat\n\n"), 15e3)
        };
        client.heartbeat.unref();
        opsStreams.add(client);
        request.on("close", () => {
          clearInterval(client.heartbeat);
          opsStreams.delete(client);
        });
        return;
      }
      if (method === "GET" && url.pathname === "/v1/workflows") {
        expireWorkflowWaits();
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
        const runs = [...workflowRuns.values()].filter(
          (run) => run.project === agent.project && run.targetAgentId === agent.id
        );
        json(response, 200, { runs });
        return;
      }
      const workflowMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)$/);
      if (method === "GET" && workflowMatch) {
        expireWorkflowWaits();
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
        const run = workflowRuns.get(decodeURIComponent(workflowMatch[1]));
        if (!run) throw new ProtocolError(404, "workflow run not found", "workflow_not_found");
        if (run.project !== agent.project || run.targetAgentId !== agent.id) {
          throw new ProtocolError(
            403,
            "workflow run is not visible to this agent",
            "workflow_forbidden",
            workflowScopeExtras("get", run.targetAgentName)
          );
        }
        const entries = [...journal.values()].filter((entry) => entry.runId === run.id);
        json(response, 200, { run, journal: entries });
        return;
      }
      const degradationMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/degradations$/);
      if (method === "POST" && degradationMatch) {
        requireConfiguredAdminAuth(request);
        const body = await readJson(request);
        const run = workflowRuns.get(decodeURIComponent(degradationMatch[1]));
        if (!run) throw new ProtocolError(404, "workflow run not found", "workflow_not_found");
        const stageId = requireString(body.stageId, "stageId", { max: 64 });
        const requirementKey = canonicalWorkflowEvidenceKey(
          requireString(body.requirementKey, "requirementKey", { max: 128 })
        );
        const reason = requireString(body.reason, "reason", { max: 1e3 });
        const timestamp = nowIso();
        const transition = structuredClone(run);
        const result = approveWorkflowDegradation(
          transition,
          stageId,
          requirementKey,
          reason,
          newId("approval"),
          timestamp
        );
        if (result.created) {
          const stage = transition.stages.find((candidate) => candidate.id === stageId);
          const entry = {
            id: newId("journal"),
            runId: transition.id,
            agentId: "kxm-admin",
            category: "decision",
            area: stage.area ?? "security",
            severity: "warning",
            summary: `Approved degraded peer quorum for ${stageId}/${requirementKey} attempt ${result.approval.attempt}`,
            details: reason,
            evidence: [
              "class:workflow_quorum_degradation_approved",
              `approval:${result.approval.id}`,
              `policy-min:${result.approval.policyMinProducers}`,
              `approved-min:${result.approval.approvedMinProducers}`
            ],
            relatedEntryIds: [],
            createdAt: timestamp
          };
          store.saveWorkflowTransition(transition, void 0, entry);
          publishOps(transition.project, "workflows");
          counters.workflowDegradations += 1;
          counters.journalEntries += 1;
          logger({
            event: "workflow_degradation_approved",
            workflowRunId: transition.id,
            stageId,
            requirementKey,
            attempt: result.approval.attempt,
            approvalId: result.approval.id
          });
        }
        json(response, result.created ? 201 : 200, {
          run: result.created ? transition : run,
          approval: result.approval,
          duplicate: !result.created
        });
        return;
      }
      const contextGetMatch = url.pathname.match(/^\/v1\/context\/get$/);
      if (method === "POST" && contextGetMatch) {
        const body = await readJson(request);
        const { project: callerProject, caller: callerId } = contextCallerProject(request, body.project);
        const policy = rolePolicy(typeof body.role === "string" ? body.role : "");
        const { pool, contradictionIds } = projectContextPool2(callerProject, policy.journalCategories);
        const outcome = arbitrate(body, pool, {
          contradictionIds,
          ...skillLifecycle ? { skillLifecycle } : {}
        });
        counters.contextRequests += 1;
        logger({
          event: "context_packet_assembled",
          ...outcome.audit.request,
          selectedIds: outcome.audit.selectedIds,
          provenanceSummary: outcome.audit.provenanceSummary,
          estimatedTokens: outcome.audit.estimatedTokens,
          budgetTokens: outcome.audit.budgetTokens,
          candidateCount: outcome.audit.candidateCount,
          excludedSuperseded: outcome.audit.excludedSuperseded
        });
        json(response, 200, { packet: outcome.packet, audit: outcome.audit });
        return;
      }
      const contextRecallMatch = url.pathname.match(/^\/v1\/context\/recall$/);
      if (method === "POST" && contextRecallMatch) {
        const body = await readJson(request);
        const { project: callerProject, caller: callerId } = contextCallerProject(request, body.project);
        const query = requireString(body.query ?? "", "query", { max: 500, allowEmpty: true }).toLowerCase();
        const kinds = Array.isArray(body.kinds) ? body.kinds.filter((kind) => typeof kind === "string") : void 0;
        const limit = parseBoundedInteger(body.limit, "limit", 25, 1, 100);
        const { pool } = projectContextPool2(callerProject);
        const recalled = pool.filter((item) => item.status !== "superseded" && item.status !== "rejected").filter((item) => kinds === void 0 || kinds.includes(item.kind)).filter((item) => query === "" || item.summary.toLowerCase().includes(query) || (item.stateKey ?? "").toLowerCase().includes(query)).sort((left, right) => left.id.localeCompare(right.id)).slice(0, limit);
        counters.contextRequests += 1;
        logger({ event: "context_recall", project: callerProject, query, limit, results: recalled.length });
        json(response, 200, { items: recalled.map(contextItemAuditMetadata), unresolvedGaps: recalled.length === 0 ? ["no matching context records"] : [] });
        return;
      }
      const contextStateMatch = url.pathname.match(/^\/v1\/context\/state$/);
      if (method === "POST" && contextStateMatch) {
        const body = await readJson(request);
        const { project: callerProject, caller: callerId } = contextCallerProject(request, body.project);
        const key = requireString(body.key, "key", { max: 200 });
        const asOf = body.asOf === void 0 || body.asOf === null ? void 0 : requireString(body.asOf, "asOf", { max: 64 });
        const current = await stateProvider.get(callerProject, key, asOf);
        counters.contextRequests += 1;
        json(response, 200, { state: current, key });
        return;
      }
      const contextStateProposeMatch = url.pathname.match(/^\/v1\/context\/state\/propose$/);
      if (method === "POST" && contextStateProposeMatch) {
        const body = await readJson(request);
        const { project: callerProject, caller: callerId } = contextCallerProject(request, body.project);
        const proposalId = await stateProvider.propose({
          schema: "kxm.state-change-proposal.v1",
          project: callerProject,
          key: requireString(body.key, "key", { max: 200 }),
          summary: requireString(body.summary, "summary", { max: 4e3 }),
          authority: parseContextAuthority(body.authority),
          confidence: parseContextConfidence(body.confidence),
          evidenceRefs: boundedStringList(body.evidenceRefs, "evidenceRefs", 32),
          proposedBy: typeof body.proposedBy === "string" && body.proposedBy.trim() ? body.proposedBy.trim() : callerId
        });
        counters.contextRequests += 1;
        publishOps(callerProject, "workflows");
        logger({ event: "context_state_proposed", project: callerProject, proposalId, proposedBy: callerId });
        json(response, 201, { proposalId });
        return;
      }
      const contextStatePromoteMatch = url.pathname.match(/^\/v1\/context\/state\/promote$/);
      if (method === "POST" && contextStatePromoteMatch) {
        requireConfiguredAdminAuth(request, "state promotion");
        const body = await readJson(request);
        const proposalId = requireString(body.proposalId, "proposalId", { max: 128 });
        const project = requireString(body.project, "project", { max: 200 });
        const evidence = boundedStringList(body.evidence, "evidence", 32);
        const promoter = typeof body.promotedBy === "string" && body.promotedBy.trim() ? body.promotedBy.trim() : typeof body.caller === "string" && body.caller.trim() ? body.caller.trim() : typeof request.headers["x-kxm-caller-id"] === "string" && request.headers["x-kxm-caller-id"].trim() ? request.headers["x-kxm-caller-id"].trim() : "kxm-admin";
        const promoted = await stateProvider.promote(proposalId, evidence, promoter);
        counters.contextRequests += 1;
        publishOps(project, "workflows");
        logger({ event: "context_state_promoted", project, proposalId, promotedId: promoted.id, stateKey: promoted.stateKey, promotedBy: promoter });
        json(response, 200, { state: promoted });
        return;
      }
      const contextEpisodeMatch = url.pathname.match(/^\/v1\/context\/episode$/);
      if (method === "POST" && contextEpisodeMatch) {
        const body = await readJson(request);
        const { project: callerProject, caller: callerId } = contextCallerProject(request, body.project);
        const runId = body.workflowRunId === void 0 || body.workflowRunId === null ? void 0 : requireString(body.workflowRunId, "workflowRunId", { max: 128 });
        const runIds = new Set(
          [...workflowRuns.values()].filter((run) => run.project === callerProject && (runId === void 0 || run.id === runId)).map((run) => run.id)
        );
        const episodes = [...journal.values()].filter((entry) => runIds.has(entry.runId)).filter((entry) => entry.category === "error" || entry.category === "lesson" || entry.category === "observation" || entry.category === "experiment").sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).map((entry) => journalEntryToContextItem(entry, callerProject)).slice(0, 50);
        counters.contextRequests += 1;
        json(response, 200, { episodes });
        return;
      }
      const contextExplainMatch = url.pathname.match(/^\/v1\/context\/explain$/);
      if (method === "POST" && contextExplainMatch) {
        const body = await readJson(request);
        const { project: callerProject, caller: callerId } = contextCallerProject(request, body.project);
        const id = requireString(body.id, "id", { max: 128 });
        const { pool } = projectContextPool2(callerProject);
        const explanation = explainContextItem(id, pool);
        counters.contextRequests += 1;
        json(response, 200, {
          found: explanation.item !== void 0,
          lineage: explanation.lineage,
          evidenceRefs: explanation.evidenceRefs,
          sources: explanation.sources
        });
        return;
      }
      const contextWikiCompileMatch = url.pathname.match(/^\/v1\/context\/wiki\/compile$/);
      if (method === "POST" && contextWikiCompileMatch) {
        const body = await readJson(request);
        const { project: callerProject } = contextCallerProject(request, body.project);
        const wikiPool = contextWikiPool2(callerProject, nowIso());
        const wiki = compileKnowledgeWiki(wikiPool);
        counters.contextRequests += 1;
        logger({
          event: "context_wiki_compiled",
          project: callerProject,
          pages: wiki.audit.pages.length,
          contradictions: wiki.audit.contradictions
        });
        json(response, 200, {
          audit: wiki.audit,
          lint: lintKnowledgeWiki(wiki.pages, wikiPool),
          pages: [...wiki.pages].sort(([left], [right]) => left.localeCompare(right)).map(([path, content]) => ({ path, content }))
        });
        return;
      }
      const journalPromotionMatch = url.pathname.match(/^\/v1\/journal\/([^/]+)\/promotion$/);
      if (method === "POST" && journalPromotionMatch) {
        requireAdminAuth(request);
        const body = await readJson(request);
        const entryId = decodeURIComponent(journalPromotionMatch[1]);
        const entry = journal.get(entryId);
        if (!entry) throw new ProtocolError(404, "journal entry not found", "journal_not_found");
        const to = requireString(body.to, "to", { max: 24 });
        if (to !== "approved" && to !== "rejected" && to !== "quarantined") {
          throw new ProtocolError(
            400,
            "journal promotion target must be approved, rejected, or quarantined",
            "invalid_journal_promotion"
          );
        }
        const evidenceRefs = boundedStringList(body.evidenceRefs, "evidenceRefs", 32);
        const updated = applyJournalPromotion(
          entry,
          {
            to,
            evidenceRefs,
            decidedBy: "kxm-admin",
            reason: requireString(body.reason, "reason", { max: 1e3 })
          },
          nowIso()
        );
        store.saveJournalEntry(updated);
        publishOps(entry.runId, "workflows");
        logger({
          event: "journal_promotion_recorded",
          journalEntryId: entry.id,
          workflowRunId: entry.runId,
          category: entry.category,
          to
        });
        json(response, 200, { entry: updated });
        return;
      }
      const waitMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/waits$/);
      if (method === "POST" && waitMatch) {
        expireWorkflowWaits();
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
        const body = await readJson(request);
        const run = workflowRuns.get(decodeURIComponent(waitMatch[1]));
        if (!run) throw new ProtocolError(404, "workflow run not found", "workflow_not_found");
        if (run.project !== agent.project || run.targetAgentId !== agent.id) {
          throw new ProtocolError(
            403,
            "only the assigned coordinator can wait this workflow",
            "workflow_forbidden",
            workflowScopeExtras("wait", run.targetAgentName)
          );
        }
        const stageId = requireString(body.stageId, "stageId", { max: 64 });
        const signalKey = workflowSignalKey(body.signalKey);
        const summary = requireString(body.summary, "summary", { max: 4e3 });
        const evidence = boundedWorkflowEvidence(body.evidence);
        const evidenceRefs = boundedWorkflowEvidenceReferences(body.evidenceRefs);
        const timeoutMs = parseBoundedInteger(
          body.timeoutMs,
          "timeoutMs",
          DEFAULT_WORKFLOW_WAIT_TIMEOUT_MS,
          MIN_WORKFLOW_WAIT_TIMEOUT_MS,
          MAX_WORKFLOW_WAIT_TIMEOUT_MS
        );
        const createdAt = nowIso();
        const transition = structuredClone(run);
        const stage = transition.stages.find((candidate) => candidate.id === stageId);
        const verifiedEvidence = stage && Object.keys(evidenceRefs).length ? verifyWorkflowEvidenceReferences(
          transition,
          stage,
          evidenceRefs,
          { getMessage: (messageId) => messages.get(messageId) },
          createdAt
        ) : {};
        waitForWorkflowSignal(
          transition,
          stageId,
          signalKey,
          summary,
          createdAt,
          new Date(Date.parse(createdAt) + timeoutMs).toISOString(),
          evidence,
          verifiedEvidence
        );
        store.saveWorkflowTransition(transition);
        publishOps(transition.project, "workflows");
        counters.workflowWaits += 1;
        logger({
          event: "workflow_wait_started",
          workflowRunId: transition.id,
          stageId,
          signalKey,
          expiresAt: transition.waiting?.expiresAt
        });
        json(response, 202, {
          run: transition,
          instruction: "The agent may now settle this turn. A signed external signal will checkpoint the stage and resume the coordinator when more work is required."
        });
        return;
      }
      const checkpointMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/checkpoints$/);
      if (method === "POST" && checkpointMatch) {
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
        const body = await readJson(request);
        const run = workflowRuns.get(decodeURIComponent(checkpointMatch[1]));
        if (!run) throw new ProtocolError(404, "workflow run not found", "workflow_not_found");
        if (run.project !== agent.project || run.targetAgentId !== agent.id) {
          throw new ProtocolError(
            403,
            "only the assigned coordinator can checkpoint this workflow",
            "workflow_forbidden",
            workflowScopeExtras("checkpoint", run.targetAgentName)
          );
        }
        const stageId = requireString(body.stageId, "stageId", { max: 64 });
        const status = requireString(body.status, "status", { max: 16 });
        if (status !== "passed" && status !== "warning" && status !== "failed") {
          throw new ProtocolError(400, "status must be passed, warning, or failed", "invalid_checkpoint_status");
        }
        const summary = requireString(body.summary, "summary", { max: 4e3 });
        const evidence = boundedWorkflowEvidence(body.evidence);
        const evidenceRefs = boundedWorkflowEvidenceReferences(body.evidenceRefs);
        if (status !== "passed" && Object.keys(evidenceRefs).length) {
          throw new ProtocolError(
            400,
            "evidenceRefs are accepted only for a passing checkpoint or workflow wait",
            "invalid_workflow_evidence_refs"
          );
        }
        const timestamp = nowIso();
        const transition = structuredClone(run);
        const stage = transition.stages.find((candidate) => candidate.id === stageId);
        const verifiedEvidence = stage && Object.keys(evidenceRefs).length ? verifyWorkflowEvidenceReferences(
          transition,
          stage,
          evidenceRefs,
          { getMessage: (messageId) => messages.get(messageId) },
          timestamp
        ) : {};
        const result = checkpointRun(
          transition,
          stageId,
          status,
          summary,
          evidence,
          timestamp,
          verifiedEvidence,
          typeof body.outcome === "string" && body.outcome.trim() ? requireString(body.outcome, "outcome", { max: 64 }) : void 0
        );
        const checkpointStage = transition.stages.find((candidate) => candidate.id === stageId);
        if (result.transition) {
          const transitionEntry = {
            id: newId("journal"),
            runId: transition.id,
            agentId: agent.id,
            category: "state-change",
            area: checkpointStage?.area ?? "workflow",
            severity: "info",
            summary: `typed transition ${result.transition.fromStage} -> ${result.transition.toStage} (${result.transition.outcome})`,
            evidence: result.transition.evidenceKeys.map((key) => `requirement:${key}`),
            relatedEntryIds: [],
            createdAt: timestamp
          };
          store.saveWorkflowTransition(transition, void 0, transitionEntry);
          counters.journalEntries += 1;
        }
        if (result.exhausted) {
          const exhaustEntry = {
            id: newId("journal"),
            runId: transition.id,
            agentId: agent.id,
            category: "error",
            area: checkpointStage?.area ?? "workflow",
            severity: "error",
            summary: `transition budget exhausted at ${stageId} (outcome ${body.outcome ?? status}); run failed safely`,
            evidence: [`class:transition_budget_exhausted`, `stage:${stageId}`],
            relatedEntryIds: [],
            createdAt: timestamp
          };
          store.saveWorkflowTransition(transition, void 0, exhaustEntry);
          counters.journalEntries += 1;
        }
        let entry;
        if (status !== "passed") {
          entry = {
            id: newId("journal"),
            runId: transition.id,
            agentId: agent.id,
            category: "error",
            area: checkpointStage.area ?? "workflow",
            severity: status === "failed" ? "error" : "warning",
            summary: `${checkpointStage.label}: ${summary}`,
            evidence: workflowEvidenceStrings(evidence),
            relatedEntryIds: [],
            createdAt: transition.updatedAt
          };
        } else if (result.degraded) {
          entry = {
            id: newId("journal"),
            runId: transition.id,
            agentId: agent.id,
            category: "decision",
            area: checkpointStage.area ?? "security",
            severity: "warning",
            summary: `${checkpointStage.label} passed using an explicitly approved degraded peer quorum`,
            evidence: [
              "class:workflow_quorum_degradation_used",
              ...(checkpointStage.degradedRequirements ?? []).map((requirement) => `requirement:${requirement}`)
            ],
            relatedEntryIds: [],
            createdAt: transition.updatedAt
          };
        }
        store.saveWorkflowTransition(transition, void 0, entry);
        publishOps(transition.project, "workflows");
        counters.workflowCheckpoints += 1;
        if (entry) counters.journalEntries += 1;
        exportTerminalRetrospective(transition);
        logger({
          event: "workflow_checkpoint",
          workflowRunId: transition.id,
          stageId,
          status,
          attempt: transition.stages.find((candidate) => candidate.id === stageId)?.attempts,
          retry: result.retry,
          completed: result.completed
        });
        json(response, 200, {
          run: transition,
          retry: result.retry,
          completed: result.completed,
          instruction: result.retry ? "Correct the warning or failure, record what changed, rerun the relevant checks, and checkpoint this stage again." : result.completed ? "Workflow checkpoints are complete. Return the final outcome with links and evidence." : `Continue with stage ${transition.currentStage}.`
        });
        return;
      }
      const journalMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/journal$/);
      if (method === "POST" && journalMatch) {
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
        const body = await readJson(request);
        const run = workflowRuns.get(decodeURIComponent(journalMatch[1]));
        if (!run) throw new ProtocolError(404, "workflow run not found", "workflow_not_found");
        if (run.project !== agent.project || run.targetAgentId !== agent.id) {
          throw new ProtocolError(
            403,
            "only the assigned coordinator can journal this workflow",
            "workflow_forbidden",
            workflowScopeExtras("journal", run.targetAgentName)
          );
        }
        const category = parseJournalCategory(body.category);
        const area = requireString(body.area, "area", { max: 24 });
        if (!["harness", "gates", "implementation", "workflow", "documentation", "security", "other"].includes(area)) {
          throw new ProtocolError(400, "invalid improvement area", "invalid_improvement_area");
        }
        const severity = requireString(body.severity ?? "info", "severity", { max: 16 });
        if (severity !== "info" && severity !== "warning" && severity !== "error") {
          throw new ProtocolError(400, "severity must be info, warning, or error", "invalid_journal_severity");
        }
        const relatedEntryIds = boundedStringList(body.relatedEntryIds, "relatedEntryIds", 16);
        if (relatedEntryIds.some((id) => journal.get(id)?.runId !== run.id)) {
          throw new ProtocolError(
            400,
            "relatedEntryIds must reference journal entries in the same workflow run",
            "invalid_journal_relation"
          );
        }
        const evidence = boundedStringList(body.evidence, "evidence");
        if (journalEvidenceRequired(category) && evidence.length < 1) {
          throw new ProtocolError(
            400,
            `journal category ${category} requires at least one durable evidence reference`,
            "journal_evidence_required"
          );
        }
        let stageId;
        let attempt;
        if (body.stageId !== void 0 && body.stageId !== null) {
          stageId = requireString(body.stageId, "stageId", { max: 128 });
          const stage = run.stages.find((candidate) => candidate.id === stageId);
          if (!stage) {
            throw new ProtocolError(400, `stageId ${stageId} is not part of this workflow run`, "invalid_journal_relation");
          }
          attempt = stage.attempts + 1;
        }
        const entry = {
          id: newId("journal"),
          runId: run.id,
          agentId: agent.id,
          category,
          area,
          severity,
          summary: requireString(body.summary, "summary", { max: 1e3 }),
          ...body.details ? { details: requireString(body.details, "details", { max: 8e3 }) } : {},
          evidence,
          relatedEntryIds,
          createdAt: nowIso(),
          ...stageId !== void 0 ? { stageId } : {},
          ...attempt !== void 0 ? { attempt } : {}
        };
        store.saveJournalEntry(entry);
        counters.journalEntries += 1;
        logger({
          event: "workflow_journal_recorded",
          workflowRunId: run.id,
          journalEntryId: entry.id,
          category,
          area,
          severity
        });
        json(response, 201, { entry });
        return;
      }
      if (method === "GET" && url.pathname === "/v1/improvements") {
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
        const visibleRuns = new Set(
          [...workflowRuns.values()].filter((run) => run.project === agent.project).map((run) => run.id)
        );
        const entries = [...journal.values()].filter((entry) => visibleRuns.has(entry.runId));
        json(response, 200, { reports: improvementReport(entries), entries: entries.length });
        return;
      }
      if (method === "POST" && url.pathname === "/v1/agents/register") {
        const body = await readJson(request);
        const name = requireString(body.name, "name", { max: 64 });
        const purpose = requireString(body.purpose ?? "General-purpose Pi agent", "purpose", { max: 256 });
        const project = requireString(body.project, "project", { max: 128 });
        requireProjectAuth(request, project);
        const model = optionalString(body.model, "model", 128);
        const hostLabel = optionalString(body.host, "host", MAX_AGENT_HOST_CHARS);
        const existing = [...agents.values()].find(
          (agent2) => agent2.project === project && agent2.name.toLowerCase() === name.toLowerCase()
        );
        if (existing?.online) {
          throw new ProtocolError(409, `agent name already active in project: ${name}`, "duplicate_agent_name");
        }
        const timestamp = nowIso();
        const agent = existing ?? {
          id: newId("agt"),
          key: newId("key"),
          name,
          purpose,
          project,
          connectedAt: timestamp,
          lastSeenAt: timestamp,
          online: true
        };
        agent.key = newId("key");
        agent.name = name;
        agent.purpose = purpose;
        agent.project = project;
        agent.connectedAt = timestamp;
        agent.lastSeenAt = timestamp;
        agent.online = true;
        if (model) agent.model = model;
        else delete agent.model;
        if (hostLabel) agent.host = hostLabel;
        else delete agent.host;
        store.saveAgent(agent);
        counters.registrations += 1;
        logger({
          event: existing ? "agent_resumed" : "agent_registered",
          agentId: agent.id,
          name,
          project,
          ...hostLabel ? { host: hostLabel } : {}
        });
        broadcastPresence(agent);
        json(response, existing ? 200 : 201, { agent: publicAgent(agent, staleAfterMs), agentKey: agent.key, resumed: Boolean(existing) });
        return;
      }
      if (method === "GET" && url.pathname === "/v1/agents") {
        const current = requireAgent(request);
        requireProjectAuth(request, current.project);
        const includeOffline = url.searchParams.get("includeOffline") === "true";
        const listedAt = Date.now();
        const result = [...agents.values()].filter((agent) => agent.project === current.project && (agent.online || includeOffline)).map((agent) => publicAgent(agent, staleAfterMs, listedAt));
        json(response, 200, { agents: result });
        return;
      }
      const heartbeatMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/heartbeat$/);
      if (method === "POST" && heartbeatMatch) {
        const current = requireAgent(request, decodeURIComponent(heartbeatMatch[1]));
        requireProjectAuth(request, current.project);
        await readJson(request);
        json(response, 200, { agent: publicAgent(current, staleAfterMs) });
        return;
      }
      const agentMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)$/);
      if (method === "DELETE" && agentMatch) {
        const current = requireAgent(request, decodeURIComponent(agentMatch[1]));
        requireProjectAuth(request, current.project);
        current.online = false;
        current.lastSeenAt = nowIso();
        store.saveAgent(current);
        broadcastPresence(current);
        logger({ event: "agent_unregistered", agentId: current.id, project: current.project });
        response.writeHead(204, { "cache-control": "no-store" }).end();
        return;
      }
      if (method === "GET" && url.pathname === "/v1/events") {
        const agentId = requireString(url.searchParams.get("agentId"), "agentId", { max: 80 });
        const current = requireAgent(request, agentId);
        requireProjectAuth(request, current.project);
        const presenceOnly = url.searchParams.get("presenceOnly") === "true";
        if (presenceOnly && current.model !== "tui") {
          throw new ProtocolError(403, "presence-only streams are reserved for metadata observers", "presence_stream_forbidden");
        }
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          "x-content-type-options": "nosniff",
          ...presenceOnly ? { "x-kxm-events-mode": "presence" } : {}
        });
        response.write(`event: ready
data: ${JSON.stringify({ agent: publicAgent(current, staleAfterMs) })}

`);
        const client = {
          response,
          heartbeat: setInterval(() => response.write(": heartbeat\n\n"), 15e3),
          ...presenceOnly ? { presenceOnly: true } : {}
        };
        client.heartbeat.unref();
        const clients = streams.get(agentId) ?? /* @__PURE__ */ new Set();
        clients.add(client);
        streams.set(agentId, clients);
        if (!presenceOnly) flushPending(agentId);
        request.on("close", () => {
          clearInterval(client.heartbeat);
          clients.delete(client);
          if (clients.size === 0) streams.delete(agentId);
        });
        return;
      }
      if (method === "POST" && url.pathname === "/v1/messages") {
        const sender = requireAgent(request);
        requireProjectAuth(request, sender.project);
        const body = await readJson(request);
        const targetInput = requireString(body.target, "target", { max: 80 });
        const content = requireString(body.content, "content", { max: MAX_CONTENT_CHARS });
        const delivery = parseDeliveryMode(body.delivery);
        const requestedContext = requestedWorkflowMessageContext(body.workflowContext);
        const workflowContext = requestedContext ? authorizeWorkflowMessageContext(sender, targetInput, requestedContext) : void 0;
        const callerCorrelationId = optionalString(body.correlationId, "correlationId", 128);
        if (workflowContext && callerCorrelationId && callerCorrelationId !== workflowContext.runId) {
          throw new ProtocolError(
            409,
            "correlationId must match workflowContext.runId",
            "workflow_context_correlation_mismatch"
          );
        }
        const correlationId = workflowContext?.runId ?? callerCorrelationId;
        const replyTo = optionalString(body.replyTo, "replyTo", 80);
        const hops = parseBoundedInteger(body.hops, "hops", 0, 0, 100);
        const maxHops = parseBoundedInteger(body.maxHops, "maxHops", DEFAULT_MAX_HOPS, 1, 20);
        if (hops >= maxHops) {
          throw new ProtocolError(400, `hop limit reached (${hops}/${maxHops})`, "hop_limit_reached");
        }
        const ttlMs = parseBoundedInteger(
          body.ttlMs,
          "ttlMs",
          defaultMessageTtlMs,
          MIN_MESSAGE_TTL_MS,
          MAX_MESSAGE_TTL_MS
        );
        const allowOffline = parseOptionalBoolean(body.allowOffline, "allowOffline");
        const idempotencyKey = optionalString(body.idempotencyKey, "idempotencyKey", 128);
        if (idempotencyKey) {
          const existing = store.findMessageByIdempotency(sender.id, idempotencyKey);
          if (existing) {
            if (!sameIdempotentRequest(
              existing,
              targetInput,
              content,
              delivery,
              correlationId,
              replyTo,
              hops,
              maxHops,
              ttlMs,
              workflowContext
            )) {
              throw new ProtocolError(409, "idempotency key was already used for another request", "idempotency_conflict");
            }
            json(response, 200, { message: existing, idempotent: true });
            return;
          }
        }
        const target = findTarget(sender.project, targetInput, allowOffline);
        if (target.id === sender.id) {
          throw new ProtocolError(400, "cannot send a request to yourself", "self_target");
        }
        const createdAt = nowIso();
        const seq = store.nextAgentSequence(target.id);
        const message = {
          id: newId("msg"),
          project: sender.project,
          from: sender.id,
          fromName: sender.name,
          to: target.id,
          toName: target.name,
          content,
          delivery,
          hops,
          maxHops,
          seq,
          ...correlationId ? { correlationId } : {},
          ...replyTo ? { replyTo } : {},
          ...idempotencyKey ? { idempotencyKey } : {},
          ...workflowContext ? { workflowRunId: workflowContext.runId, workflowContext } : {},
          createdAt,
          expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
          status: "queued"
        };
        store.saveMessage(message);
        publishOps(message.project, "messages");
        if (target.online) publish(target.id, { type: "message", message });
        counters.messagesSent += 1;
        logger({ event: "message_sent", messageId: message.id, hops, ...messageLog(message, sender.id, sender.name, target.id, target.name) });
        json(response, 202, { message, idempotent: false });
        return;
      }
      const ackMatch = url.pathname.match(/^\/v1\/messages\/([^/]+)\/ack$/);
      if (method === "POST" && ackMatch) {
        const receiver = requireAgent(request);
        requireProjectAuth(request, receiver.project);
        await readJson(request);
        expireMessages();
        expireWorkflowWaits();
        purgeTerminalMessages();
        const message = messages.get(decodeURIComponent(ackMatch[1]));
        if (!message) throw new ProtocolError(404, "message not found", "message_not_found");
        if (message.to !== receiver.id) {
          throw new ProtocolError(403, "only the recipient can acknowledge this message", "message_forbidden");
        }
        if (message.status !== "queued" && message.status !== "delivered") {
          throw new ProtocolError(409, `cannot acknowledge a ${message.status} message`, "invalid_message_state");
        }
        if (message.status === "queued") {
          message.status = "delivered";
          message.deliveredAt = nowIso();
          store.saveMessage(message);
          publishOps(message.project, "messages");
        }
        if (typeof message.seq === "number") {
          store.advanceCursor(receiver.id, message.seq);
        }
        json(response, 200, { message });
        return;
      }
      const replyMatch = url.pathname.match(/^\/v1\/messages\/([^/]+)\/reply$/);
      if (method === "POST" && replyMatch) {
        const receiver = requireAgent(request);
        requireProjectAuth(request, receiver.project);
        const body = await readJson(request);
        expireMessages();
        const message = messages.get(decodeURIComponent(replyMatch[1]));
        if (!message) throw new ProtocolError(404, "message not found", "message_not_found");
        if (message.to !== receiver.id) {
          throw new ProtocolError(403, "only the recipient can reply to this message", "message_forbidden");
        }
        if (message.status === "replied") {
          throw new ProtocolError(409, "message already has a reply", "duplicate_reply");
        }
        if (message.status === "cancelled" || message.status === "expired" || message.status === "error") {
          throw new ProtocolError(409, `cannot reply to a ${message.status} message`, "invalid_message_state");
        }
        message.reply = {
          content: requireString(body.content, "content", { max: MAX_CONTENT_CHARS }),
          createdAt: nowIso()
        };
        message.repliedAt = message.reply.createdAt;
        message.status = "replied";
        store.saveMessage(message);
        publishOps(message.project, "messages");
        const workflowRun = [...workflowRuns.values()].find((run) => run.messageId === message.id);
        if (workflowRun?.status === "running") {
          workflowRun.status = "failed";
          delete workflowRun.currentStage;
          workflowRun.updatedAt = message.repliedAt;
          store.saveWorkflowRun(workflowRun);
          publishOps(workflowRun.project, "workflows");
          const entry = {
            id: newId("journal"),
            runId: workflowRun.id,
            agentId: receiver.id,
            category: "error",
            area: "workflow",
            severity: "error",
            summary: "Coordinator settled before all required workflow checkpoints passed",
            evidence: [`message:${message.id}`],
            relatedEntryIds: [],
            createdAt: message.repliedAt
          };
          store.saveJournalEntry(entry);
          counters.journalEntries += 1;
          exportTerminalRetrospective(workflowRun);
        }
        publish(message.from, { type: "reply", message });
        counters.messagesReplied += 1;
        logger({ event: "message_replied", messageId: message.id, ...messageLog(message, receiver.id, receiver.name, message.from, message.fromName) });
        json(response, 200, { message });
        return;
      }
      const messageMatch = url.pathname.match(/^\/v1\/messages\/([^/]+)$/);
      if (method === "DELETE" && messageMatch) {
        const current = requireAgent(request);
        requireProjectAuth(request, current.project);
        expireMessages();
        const message = messages.get(decodeURIComponent(messageMatch[1]));
        if (!message) throw new ProtocolError(404, "message not found", "message_not_found");
        if (message.from !== current.id) {
          throw new ProtocolError(403, "only the sender can cancel this message", "message_forbidden");
        }
        if (message.status === "cancelled") {
          json(response, 200, { message });
          return;
        }
        if (message.status !== "queued" && message.status !== "delivered") {
          throw new ProtocolError(409, `cannot cancel a ${message.status} message`, "invalid_message_state");
        }
        message.status = "cancelled";
        message.cancelledAt = nowIso();
        message.error = "message cancelled by sender";
        store.saveMessage(message);
        publishOps(message.project, "messages");
        publish(message.to, { type: "cancelled", message });
        counters.messagesCancelled += 1;
        logger({ event: "message_cancelled", messageId: message.id, ...messageLog(message, current.id, current.name, message.to, message.toName) });
        json(response, 200, { message });
        return;
      }
      if (method === "GET" && messageMatch) {
        const current = requireAgent(request);
        requireProjectAuth(request, current.project);
        expireMessages();
        const message = messages.get(decodeURIComponent(messageMatch[1]));
        if (!message) throw new ProtocolError(404, "message not found", "message_not_found");
        if (message.from !== current.id && message.to !== current.id) {
          throw new ProtocolError(403, "message is not visible to this agent", "message_forbidden");
        }
        json(response, 200, { message });
        return;
      }
      throw new ProtocolError(404, "route not found", "route_not_found");
    } catch (error) {
      const statusCode = error instanceof ProtocolError ? error.statusCode : 500;
      const code = error instanceof ProtocolError ? error.code : "internal_error";
      const internalMessage = error instanceof Error ? error.message : "unknown error";
      const publicMessage = statusCode >= 500 ? "internal server error" : internalMessage;
      counters.errors += 1;
      logger({ event: "request_error", requestId, statusCode, code, ...statusCode >= 500 ? { message: internalMessage } : {} });
      if (!response.headersSent) {
        json(response, statusCode, {
          error: publicMessage,
          code,
          requestId,
          ...error instanceof ProtocolError && error.extras ? error.extras : {}
        });
      } else response.end();
    }
  });
  return {
    server,
    state: { agents, messages, workflowRuns, journal, persistent: store.persistent },
    async start() {
      if (closed) throw new Error("hub is closed");
      await new Promise((resolve8, reject) => {
        server.once("error", reject);
        server.listen(port2, host2, () => {
          server.off("error", reject);
          resolve8();
        });
      });
      cleanupTimer = setInterval(() => {
        const cutoff = Date.now() - staleAfterMs;
        for (const agent of agents.values()) {
          if (agent.online && Date.parse(agent.lastSeenAt) < cutoff) {
            agent.online = false;
            store.saveAgent(agent);
            broadcastPresence(agent);
            logger({ event: "agent_stale", agentId: agent.id, project: agent.project });
          }
        }
        expireMessages();
        expireWorkflowWaits();
        purgeTerminalMessages();
        const rateCutoff = Date.now() - (rateLimit?.windowMs ?? 0);
        for (const [key, bucket] of rateBuckets) {
          if (bucket.startedAt < rateCutoff) rateBuckets.delete(key);
        }
      }, cleanupIntervalMs);
      cleanupTimer.unref();
      const address2 = server.address();
      if (!address2 || typeof address2 === "string") throw new Error("hub did not expose a TCP address");
      return { host: host2, port: address2.port, url: `http://${host2}:${address2.port}` };
    },
    async close() {
      if (closed) return;
      closed = true;
      if (cleanupTimer) clearInterval(cleanupTimer);
      const serverClosed = server.listening ? new Promise((resolve8, reject) => server.close((error) => error ? reject(error) : resolve8())) : Promise.resolve();
      const forceClose = setTimeout(() => server.closeAllConnections(), shutdownGraceMs);
      forceClose.unref();
      for (const clients of streams.values()) {
        for (const client of clients) {
          clearInterval(client.heartbeat);
          client.response.end();
        }
      }
      streams.clear();
      for (const client of opsStreams) {
        clearInterval(client.heartbeat);
        client.response.end();
      }
      opsStreams.clear();
      server.closeIdleConnections();
      try {
        await serverClosed;
      } finally {
        clearTimeout(forceClose);
      }
      store.close();
    }
  };
}

// plugins/kxm/src/server.ts
import { mkdirSync as mkdirSync6, readFileSync as readFileSync4 } from "node:fs";
import { dirname as dirname7, join as join7, resolve as resolve7 } from "node:path";

// plugins/kxm/src/logger.ts
import { appendFileSync, existsSync as existsSync6, mkdirSync as mkdirSync5, renameSync as renameSync3, statSync as statSync2, unlinkSync as unlinkSync2 } from "node:fs";
import { dirname as dirname6 } from "node:path";
var LOG_LEVEL_PRIORITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};
var DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
var DEFAULT_LOG_MAX_FILES = 3;
var SENSITIVE_KEY_PATTERN = /(?:^|_)(?:token|secret|password|apiKey|api_key|authorization|bearer)(?:$|_)/i;
var ALLOWED_EXACT_KEYS = /* @__PURE__ */ new Set(["auth", "authType", "authMethod", "authArgs", "canUpdate", "status"]);
function redactLogValue(val, key) {
  if (val === null || val === void 0) return val;
  if (typeof val === "string") {
    if (key && SENSITIVE_KEY_PATTERN.test(key) && !ALLOWED_EXACT_KEYS.has(key)) {
      return "[redacted]";
    }
    return redactSecrets(val);
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => redactLogValue(item, key));
  }
  if (typeof val === "object") {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = redactLogValue(v, k);
    }
    return out;
  }
  return String(val);
}
function rotateLogFiles(filePath, maxFiles) {
  for (let i = maxFiles; i >= 1; i--) {
    const current = `${filePath}.${i}`;
    if (existsSync6(current)) {
      if (i >= maxFiles) {
        try {
          unlinkSync2(current);
        } catch {
        }
      } else {
        try {
          renameSync3(current, `${filePath}.${i + 1}`);
        } catch {
        }
      }
    }
  }
  if (existsSync6(filePath)) {
    try {
      renameSync3(filePath, `${filePath}.1`);
    } catch {
    }
  }
}
function createLogger(options) {
  const component = options.component;
  const filePath = options.path;
  const maxBytes = Math.max(100, options.maxBytes ?? DEFAULT_LOG_MAX_BYTES);
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_LOG_MAX_FILES);
  const configuredLevel = options.level ?? "info";
  const isDaemon = Boolean(options.daemon ?? (process.env.KXM_DAEMON === "1" || process.env.KXM_DAEMON === "true"));
  const shouldStdout = options.stdout ?? !isDaemon;
  const correlationDefaults = options.correlation ?? {};
  let currentSize = 0;
  if (filePath && existsSync6(filePath)) {
    try {
      currentSize = statSync2(filePath).size;
    } catch {
      currentSize = 0;
    }
  }
  function emit(level, entryOrEvent, extra) {
    const minPriority = LOG_LEVEL_PRIORITY[configuredLevel] ?? LOG_LEVEL_PRIORITY.info;
    const currentPriority = LOG_LEVEL_PRIORITY[level] ?? LOG_LEVEL_PRIORITY.info;
    if (currentPriority < minPriority) return;
    let base;
    if (typeof entryOrEvent === "string") {
      base = { event: entryOrEvent, ...extra };
    } else {
      base = { ...entryOrEvent, ...extra };
    }
    const timestamp = typeof base.timestamp === "string" ? base.timestamp : (/* @__PURE__ */ new Date()).toISOString();
    delete base.timestamp;
    delete base.level;
    delete base.component;
    const payload = {
      timestamp,
      level,
      component,
      ...correlationDefaults,
      ...base
    };
    const sanitized = redactLogValue(payload);
    const line = `${JSON.stringify(sanitized)}
`;
    if (filePath) {
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (currentSize + lineBytes > maxBytes) {
        rotateLogFiles(filePath, maxFiles);
        currentSize = 0;
      }
      try {
        mkdirSync5(dirname6(filePath), { recursive: true });
        appendFileSync(filePath, line, { encoding: "utf8", mode: 384 });
        currentSize += lineBytes;
      } catch {
      }
    }
    if (shouldStdout) {
      process.stdout.write(line);
    }
  }
  const logFn = ((entryOrEvent, extra) => {
    let lvl = "info";
    if (typeof entryOrEvent === "object" && entryOrEvent !== null && typeof entryOrEvent.level === "string") {
      const candidate = entryOrEvent.level.toLowerCase();
      if (candidate === "debug" || candidate === "info" || candidate === "warn" || candidate === "error") {
        lvl = candidate;
      }
    }
    emit(lvl, entryOrEvent, extra);
  });
  logFn.info = (entryOrEvent, extra) => emit("info", entryOrEvent, extra);
  logFn.warn = (entryOrEvent, extra) => emit("warn", entryOrEvent, extra);
  logFn.error = (entryOrEvent, extra) => emit("error", entryOrEvent, extra);
  logFn.debug = (entryOrEvent, extra) => emit("debug", entryOrEvent, extra);
  logFn.child = (sub) => {
    return createLogger({
      ...options,
      component: sub.component ? `${component}.${sub.component}` : component,
      correlation: { ...correlationDefaults, ...sub.correlation }
    });
  };
  logFn.close = () => {
  };
  Object.defineProperty(logFn, "options", {
    value: Object.freeze({ ...options }),
    writable: false,
    enumerable: true
  });
  return logFn;
}

// plugins/kxm/src/server.ts
var host = process.env.KXM_HOST ?? "127.0.0.1";
var port = Number.parseInt(process.env.KXM_PORT ?? String(DEFAULT_PORT), 10);
var authToken = process.env.KXM_AUTH_TOKEN;
var workspaceDir = resolve7(process.env.KXM_WORKSPACE_DIR?.trim() || ".kxm");
var configDir = resolve7(process.env.KXM_CONFIG_DIR?.trim() || join7(workspaceDir, "config"));
var logsDir = resolve7(process.env.KXM_LOGS_DIR?.trim() || join7(workspaceDir, "logs"));
var assetsDir = resolve7(process.env.KXM_ASSETS_DIR?.trim() || join7(workspaceDir, "assets"));
var stateDir = resolve7(process.env.KXM_STATE_DIR?.trim() || join7(workspaceDir, "state"));
var dataPathValue = process.env.KXM_DATA_PATH?.trim();
var dataPath = dataPathValue === ":memory:" ? dataPathValue : resolve7(dataPathValue || join7(stateDir, "kxm.db"));
var logPath = resolve7(process.env.KXM_LOG_PATH?.trim() || join7(logsDir, "kxm-hub.jsonl"));
var messageTtlMs = Number.parseInt(process.env.KXM_MESSAGE_TTL_MS ?? String(DEFAULT_MESSAGE_TTL_MS), 10);
var messageRetentionMs = Number.parseInt(
  process.env.KXM_MESSAGE_RETENTION_MS ?? String(DEFAULT_MESSAGE_RETENTION_MS),
  10
);
var rateLimitMax = Number.parseInt(process.env.KXM_RATE_LIMIT_MAX ?? String(DEFAULT_RATE_LIMIT_MAX), 10);
var rateLimitWindowMs = Number.parseInt(
  process.env.KXM_RATE_LIMIT_WINDOW_MS ?? String(DEFAULT_RATE_LIMIT_WINDOW_MS),
  10
);
for (const directory of [configDir, logsDir, assetsDir, stateDir, dirname7(logPath)]) {
  mkdirSync6(directory, { recursive: true });
}
var structuredLog = createLogger({
  component: "hub",
  path: logPath
});
function projectTokens() {
  const raw = process.env.KXM_PROJECT_TOKENS?.trim();
  if (!raw) return void 0;
  const value = JSON.parse(raw);
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("KXM_PROJECT_TOKENS must be a JSON object of project names to tokens");
  }
  const entries = Object.entries(value);
  if (entries.some(([project, token]) => !project.trim() || typeof token !== "string" || !token.trim())) {
    throw new Error("KXM_PROJECT_TOKENS must contain non-empty project names and token strings");
  }
  return Object.fromEntries(entries);
}
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("KXM_PORT must be an integer between 0 and 65535");
}
if (![messageTtlMs, messageRetentionMs, rateLimitMax, rateLimitWindowMs].every(Number.isInteger)) {
  throw new Error("message TTL and rate limit settings must be integers");
}
var configuredProjectTokens = projectTokens();
var inlineWorkflows = process.env.KXM_WEBHOOK_WORKFLOWS?.trim();
var workflowFile = process.env.KXM_WEBHOOK_WORKFLOWS_FILE?.trim();
if (inlineWorkflows && workflowFile) {
  throw new Error("configure only one of KXM_WEBHOOK_WORKFLOWS or KXM_WEBHOOK_WORKFLOWS_FILE");
}
var webhookWorkflows = parseWorkflowDefinitions(
  workflowFile ? readFileSync4(resolve7(workflowFile), "utf8") : inlineWorkflows
);
var hub = createMeshHub({
  host,
  port,
  dataPath,
  assetsDir,
  messageTtlMs,
  messageRetentionMs,
  rateLimit: { maxRequests: rateLimitMax, windowMs: rateLimitWindowMs },
  ...authToken ? { authToken } : {},
  ...configuredProjectTokens ? { projectTokens: configuredProjectTokens } : {},
  ...webhookWorkflows.length ? { webhookWorkflows } : {},
  logger: structuredLog
});
var address = await hub.start();
var auth = authToken ? "token" : "none";
if (auth === "none") {
  process.stderr.write("kxm hub: auth=none; every loopback caller is trusted. Set KXM_AUTH_TOKEN before relying on this hub.\n");
}
structuredLog({ event: "hub_started", url: address.url, workspaceDir, configDir, logsDir, assetsDir, stateDir, dataPath, logPath, auth });
process.stdout.write(`kxm hub listening at ${address.url}; storage=${dataPath}; auth=${auth}
`);
var shutdownPromise;
function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    structuredLog({ event: "hub_stopping", signal });
    await hub.close();
    structuredLog.close();
    process.exit(0);
  })();
  return shutdownPromise;
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("message", (message) => {
  if (message && typeof message === "object" && message.type === "shutdown") {
    const signal = message.signal;
    void shutdown(typeof signal === "string" ? signal : "parent");
  }
});
