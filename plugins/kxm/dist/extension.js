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
    var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
    var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
    var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
    var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
    var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
    var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
    function isCollection(node) {
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
    var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;
    exports.ALIAS = ALIAS;
    exports.DOC = DOC;
    exports.MAP = MAP;
    exports.NODE_TYPE = NODE_TYPE;
    exports.PAIR = PAIR;
    exports.SCALAR = SCALAR;
    exports.SEQ = SEQ;
    exports.hasAnchor = hasAnchor;
    exports.isAlias = isAlias;
    exports.isCollection = isCollection;
    exports.isDocument = isDocument;
    exports.isMap = isMap;
    exports.isNode = isNode;
    exports.isPair = isPair;
    exports.isScalar = isScalar;
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
    function visit(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        visit_(null, node, visitor_, Object.freeze([]));
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
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
    exports.visit = visit;
    exports.visitAsync = visitAsync;
  }
});

// node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS({
  "node_modules/yaml/dist/doc/directives.js"(exports) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
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
          visit.visit(doc.contents, (_key, node) => {
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
    var visit = require_visit();
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
      visit.visit(root, {
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
    var visit = require_visit();
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
          visit.visit(doc, {
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
        return found;
      }
      toJSON(_arg, ctx) {
        if (!ctx)
          return { source: this.source };
        const { anchors: anchors2, doc, maxAliasCount } = ctx;
        const source = this.resolve(doc, ctx);
        if (!source) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new ReferenceError(msg);
        }
        let data = anchors2.get(source);
        if (!data) {
          toJS.toJS(source, null, ctx);
          data = anchors2.get(source);
        }
        if (data?.res === void 0) {
          const msg = "This should not happen: Alias anchor was not resolved?";
          throw new ReferenceError(msg);
        }
        if (maxAliasCount >= 0) {
          data.count += 1;
          if (data.aliasCount === 0)
            data.aliasCount = getAliasCount(doc, source, anchors2);
          if (data.count * data.aliasCount > maxAliasCount) {
            const msg = "Excessive alias count indicates a resource exhaustion attack";
            throw new ReferenceError(msg);
          }
        }
        return data.res;
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
    function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
      if (!lineWidth || lineWidth < 0)
        return text;
      if (lineWidth < minContentWidth)
        minContentWidth = 0;
      const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
      if (text.length <= endStep)
        return text;
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
        i = consumeMoreIndentedLines(text, i, indent.length);
        if (i !== -1)
          end = i + endStep;
      }
      for (let ch; ch = text[i += 1]; ) {
        if (mode === FOLD_QUOTED && ch === "\\") {
          escStart = i;
          switch (text[i + 1]) {
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
            i = consumeMoreIndentedLines(text, i, indent.length);
          end = i + indent.length + endStep;
          split = void 0;
        } else {
          if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
            const next = text[i + 1];
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
                ch = text[i += 1];
                overflow = true;
              }
              const j = i > escEnd + 1 ? i - 2 : escStart - 1;
              if (escapedFolds[j])
                return text;
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
        return text;
      if (onFold)
        onFold();
      let res = text.slice(0, folds[0]);
      for (let i2 = 0; i2 < folds.length; ++i2) {
        const fold = folds[i2];
        const end2 = folds[i2 + 1] || text.length;
        if (fold === 0)
          res = `
${indent}${text.slice(0, end2)}`;
        else {
          if (mode === FOLD_QUOTED && escapedFolds[fold])
            res += `${text[fold]}\\`;
          res += `
${indent}${text.slice(fold + 1, end2)}`;
        }
      }
      return res;
    }
    function consumeMoreIndentedLines(text, i, indent) {
      let end = i;
      let start = i + 1;
      let ch = text[start];
      while (ch === " " || ch === "	") {
        if (i < start + indent) {
          ch = text[++i];
        } else {
          do {
            ch = text[++i];
          } while (ch && ch !== "\n");
          end = i;
          start = i + 1;
          ch = text[start];
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
      const json = JSON.stringify(value);
      if (ctx.options.doubleQuotedAsJSON)
        return json;
      const { implicitKey } = ctx;
      const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      let str = "";
      let start = 0;
      for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
        if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
          str += json.slice(start, i) + "\\ ";
          i += 1;
          start = i;
          ch = "\\";
        }
        if (ch === "\\")
          switch (json[i + 1]) {
            case "u":
              {
                str += json.slice(start, i);
                const code = json.substr(i + 2, 4);
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
                      str += json.substr(i, 6);
                }
                i += 5;
                start = i + 1;
              }
              break;
            case "n":
              if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
                i += 1;
              } else {
                str += json.slice(start, i) + "\n\n";
                while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
                  str += "\n";
                  i += 2;
                }
                str += indent;
                if (json[i + 2] === " ")
                  str += "\\";
                i += 1;
                start = i + 1;
              }
              break;
            default:
              i += 1;
          }
      }
      str = start ? str + json.slice(start) : json;
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
    function stringify2(item, ctx, onComment, onChompKeep) {
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
    exports.stringify = stringify2;
  }
});

// node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyPair.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var stringify2 = require_stringify();
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
      let str = stringify2.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
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
      const valueStr = stringify2.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
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
    var stringify2 = require_stringify();
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
        const strCtx = stringify2.createStringifyContext(ctx.doc, {});
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
    var stringify2 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyCollection(collection, ctx, options) {
      const flow = ctx.inFlow ?? collection.flow;
      const stringify3 = flow ? stringifyFlowCollection : stringifyBlockCollection;
      return stringify3(collection, ctx, options);
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
        let str2 = stringify2.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
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
        let str = stringify2.stringify(item, itemCtx, () => comment = null);
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
    var stringify2 = require_stringify();
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
      const ctx = stringify2.createStringifyContext(doc, options);
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
        let body = stringify2.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
        if (contentComment)
          body += stringifyComment.lineComment(body, "", commentString(contentComment));
        if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
          lines[lines.length - 1] = `--- ${body}`;
        } else
          lines.push(body);
      } else {
        lines.push(stringify2.stringify(doc.contents, ctx));
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
      toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc: this,
          keep: !json,
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
        const { start, key, sep, value } = collItem;
        const keyProps = resolveProps.resolveProps(start, {
          indicator: "explicit-key-ind",
          next: key ?? sep?.[0],
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
          if (!keyProps.anchor && !keyProps.tag && !sep) {
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
        const valueProps = resolveProps.resolveProps(sep ?? [], {
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
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep, null, valueProps, onError);
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
        let sep = "";
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
                comment += sep + cb;
              sep = "";
              break;
            }
            case "newline":
              if (comment)
                sep += source;
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
      const isMap = fc.start.source === "{";
      const fcName = isMap ? "flow map" : "flow sequence";
      const NodeClass = tag?.nodeClass ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
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
        const { start, key, sep, value } = collItem;
        const props = resolveProps.resolveProps(start, {
          flow: fcName,
          indicator: "explicit-key-ind",
          next: key ?? sep?.[0],
          offset,
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (!props.found) {
          if (!props.anchor && !props.tag && !sep && !value) {
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
          if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key))
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
        if (!isMap && !sep && !props.found) {
          const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep, null, props, onError);
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
          const valueProps = resolveProps.resolveProps(sep ?? [], {
            flow: fcName,
            indicator: "map-value-ind",
            next: value,
            offset: keyNode.range[2],
            onError,
            parentIndent: fc.indent,
            startOnNewline: false
          });
          if (valueProps.found) {
            if (!isMap && !props.found && ctx.options.strict) {
              if (sep)
                for (const st of sep) {
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
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep, null, valueProps, onError) : null;
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
          if (isMap) {
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
      const expectedEnd = isMap ? "}" : "]";
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
      let sep = "";
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
          value += sep + indent.slice(trimIndent) + content;
          sep = "\n";
        } else if (indent.length > trimIndent || content[0] === "	") {
          if (sep === " ")
            sep = "\n";
          else if (!prevMoreIndented && sep === "\n")
            sep = "\n\n";
          value += sep + indent.slice(trimIndent) + content;
          sep = "\n";
          prevMoreIndented = true;
        } else if (content === "") {
          if (sep === "\n")
            value += "\n";
          else
            sep = "\n";
        } else {
          value += sep + content;
          sep = " ";
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
      return foldLines(source);
    }
    function singleQuotedValue(source, onError) {
      if (source[source.length - 1] !== "'" || source.length === 1)
        onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
      return foldLines(source.slice(1, -1)).replace(/''/g, "'");
    }
    function foldLines(source) {
      let first, line;
      try {
        first = new RegExp("(.*?)(?<![ 	])[ 	]*\r?\n", "sy");
        line = new RegExp("[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?\n", "sy");
      } catch {
        first = /(.*?)[ \t]*\r?\n/sy;
        line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
      }
      let match = first.exec(source);
      if (!match)
        return source;
      let res = match[1];
      let sep = " ";
      let pos = first.lastIndex;
      line.lastIndex = pos;
      while (match = line.exec(source)) {
        if (match[1] === "") {
          if (sep === "\n")
            res += sep;
          else
            sep = "\n";
        } else {
          res += sep + match[1];
          sep = " ";
        }
        pos = line.lastIndex;
      }
      const last = /[ \t]*(.*)/sy;
      last.lastIndex = pos;
      match = last.exec(source);
      return res + sep + (match?.[1] ?? "");
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
    var stringify2 = (cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst);
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
    function stringifyItem({ start, key, sep, value }) {
      let res = "";
      for (const st of start)
        res += st.source;
      if (key)
        res += stringifyToken(key);
      if (sep)
        for (const st of sep)
          res += st.source;
      if (value)
        res += stringifyToken(value);
      return res;
    }
    exports.stringify = stringify2;
  }
});

// node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS({
  "node_modules/yaml/dist/parse/cst-visit.js"(exports) {
    "use strict";
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove item");
    function visit(cst, visitor) {
      if ("type" in cst && cst.type === "document")
        cst = { start: cst.start, value: cst.value };
      _visit(Object.freeze([]), cst, visitor);
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    visit.itemAtPath = (cst, path) => {
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
    visit.parentCollection = (cst, path) => {
      const parent = visit.itemAtPath(cst, path.slice(0, -1));
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
    exports.visit = visit;
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
    var isCollection = (token) => !!token && "items" in token;
    var isScalar = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
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
    exports.isCollection = isCollection;
    exports.isScalar = isScalar;
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
          let sep;
          if (scalar.end) {
            sep = scalar.end;
            sep.push(this.sourceToken);
            delete scalar.end;
          } else
            sep = [this.sourceToken];
          const map = {
            type: "block-map",
            offset: scalar.offset,
            indent: scalar.indent,
            items: [{ start, key: scalar, sep }]
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
                  const sep = it.sep;
                  sep.push(this.sourceToken);
                  delete it.key;
                  delete it.sep;
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key, sep }]
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
            const sep = fc.end.splice(1, fc.end.length);
            sep.push(this.sourceToken);
            const map = {
              type: "block-map",
              offset: fc.offset,
              indent: fc.indent,
              items: [{ start, key: fc, sep }]
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
    function parseDocument(source, options = {}) {
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
    function parse2(src, reviver, options) {
      let _reviver = void 0;
      if (typeof reviver === "function") {
        _reviver = reviver;
      } else if (options === void 0 && reviver && typeof reviver === "object") {
        options = reviver;
      }
      const doc = parseDocument(src, options);
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
    function stringify2(value, replacer, options) {
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
    exports.parse = parse2;
    exports.parseAllDocuments = parseAllDocuments;
    exports.parseDocument = parseDocument;
    exports.stringify = stringify2;
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
    var visit = require_visit();
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
    exports.visit = visit.visit;
    exports.visitAsync = visit.visitAsync;
  }
});

// plugins/kxm/src/extension.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { existsSync as existsSync7, mkdirSync as mkdirSync6, readFileSync as readFileSync9, renameSync as renameSync4, rmSync as rmSync3, writeFileSync as writeFileSync5 } from "node:fs";
import { basename, dirname as dirname5, join as join10 } from "node:path";

// plugins/kxm/src/commands.ts
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// plugins/kxm/src/client.ts
import { createHash } from "node:crypto";

// plugins/kxm/src/protocol.ts
var DEFAULT_MESSAGE_TTL_MS = 24 * 60 * 6e4;
var MAX_MESSAGE_TTL_MS = 7 * 24 * 60 * 6e4;
var DEFAULT_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 6e4;
var MAX_BODY_BYTES = 256 * 1024;
var MAX_CONTENT_CHARS = 32e3;

// plugins/kxm/src/workflow.ts
function canonicalWorkflowEvidenceKey(value) {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

// plugins/kxm/src/client.ts
var MeshWaitError = class extends Error {
  waitStatus;
  constructor(waitStatus, messageId) {
    super(waitStatus === "aborted" ? "await cancelled" : `timed out waiting for ${messageId}`);
    this.name = "MeshWaitError";
    this.waitStatus = waitStatus;
  }
};
function completedFanoutResult(target, message) {
  if (message.status === "queued" || message.status === "delivered") {
    throw new Error(`message ${message.id} is not complete`);
  }
  return {
    target,
    messageId: message.id,
    status: message.status,
    ...message.reply ? { reply: message.reply.content } : {},
    ...message.error ? { error: message.error } : {}
  };
}
function fanoutIdempotencyKey(prefix, target, correlationId, workflowContext) {
  const scope = JSON.stringify(workflowContext ? {
    prefix,
    correlationId: correlationId ?? null,
    target: target.toLowerCase(),
    workflowContext: {
      runId: workflowContext.runId,
      stageId: workflowContext.stageId,
      requirementKey: canonicalWorkflowEvidenceKey(workflowContext.requirementKey),
      attempt: workflowContext.attempt
    }
  } : {
    prefix,
    correlationId: correlationId ?? null,
    target: target.toLowerCase()
  });
  return `fanout:${createHash("sha256").update(scope).digest("hex")}`;
}
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
var HubClient = class {
  options;
  agent;
  agentKey;
  heartbeatTimer;
  eventsAbort;
  stopped = true;
  onEvent;
  registration;
  eventLoop;
  constructor(options) {
    this.options = { heartbeatMs: 1e4, reconnectMs: 1e3, requestTimeoutMs: 15e3, ...options };
  }
  async start(onEvent) {
    if (!this.stopped) throw new Error("hub client is already started");
    this.stopped = false;
    this.onEvent = onEvent;
    try {
      await this.register();
    } catch (error) {
      this.stopped = true;
      throw error;
    }
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.options.heartbeatMs);
    this.heartbeatTimer.unref();
    this.eventLoop = this.runEventLoop();
    return this.agent;
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.eventsAbort?.abort();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.eventLoop;
    if (this.agent) {
      try {
        await this.request(`/v1/agents/${encodeURIComponent(this.agent.id)}`, { method: "DELETE" });
      } catch {
      }
    }
    this.agent = void 0;
    this.agentKey = void 0;
    this.onEvent = void 0;
    this.eventLoop = void 0;
  }
  async listAgents() {
    const result2 = await this.request("/v1/agents");
    return result2.agents;
  }
  async send(options) {
    const result2 = await this.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify(options)
    });
    return result2.message;
  }
  async fanout(options) {
    const targets = [...new Set(options.targets.map((target) => target.trim().toLowerCase()).filter(Boolean))];
    if (targets.length < 1 || targets.length > 3) throw new Error("fanout requires between one and three unique targets");
    return await Promise.all(targets.map(async (target) => {
      let message;
      try {
        message = await this.send({
          target,
          content: options.content,
          delivery: "followUp",
          ...options.correlationId ? { correlationId: options.correlationId } : {},
          ...options.workflowContext ? { workflowContext: options.workflowContext } : {},
          ...options.idempotencyKeyPrefix ? {
            idempotencyKey: fanoutIdempotencyKey(
              options.idempotencyKeyPrefix,
              target,
              options.correlationId,
              options.workflowContext
            )
          } : {},
          ...options.ttlMs ? { ttlMs: options.ttlMs } : {}
        });
        const completed = await this.awaitResponse(
          message.id,
          options.timeoutMs ?? 30 * 6e4,
          options.signal
        );
        return completedFanoutResult(target, completed);
      } catch (error) {
        if (message && error instanceof MeshWaitError) {
          try {
            const current = await this.getMessage(message.id);
            if (current.status === "queued" || current.status === "delivered") {
              return {
                target,
                messageId: current.id,
                status: "pending",
                messageStatus: current.status,
                expiresAt: current.expiresAt,
                waitStatus: error.waitStatus
              };
            }
            return completedFanoutResult(target, current);
          } catch (finalError) {
            return {
              target,
              messageId: message.id,
              status: "error",
              error: finalError instanceof Error ? finalError.message : String(finalError)
            };
          }
        }
        return {
          target,
          ...message ? { messageId: message.id } : {},
          status: "error",
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }));
  }
  async getMessage(messageId) {
    const result2 = await this.request(`/v1/messages/${encodeURIComponent(messageId)}`);
    return result2.message;
  }
  async acknowledge(messageId) {
    const result2 = await this.request(
      `/v1/messages/${encodeURIComponent(messageId)}/ack`,
      { method: "POST", body: "{}" }
    );
    return result2.message;
  }
  async reply(messageId, content) {
    const result2 = await this.request(
      `/v1/messages/${encodeURIComponent(messageId)}/reply`,
      { method: "POST", body: JSON.stringify({ content }) }
    );
    return result2.message;
  }
  async cancel(messageId) {
    const result2 = await this.request(
      `/v1/messages/${encodeURIComponent(messageId)}`,
      { method: "DELETE" }
    );
    return result2.message;
  }
  async listWorkflows() {
    const result2 = await this.request("/v1/workflows");
    return result2.runs;
  }
  async getWorkflow(runId) {
    return await this.request(`/v1/workflows/${encodeURIComponent(runId)}`);
  }
  async checkpointWorkflow(runId, input) {
    return await this.request(`/v1/workflows/${encodeURIComponent(runId)}/checkpoints`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }
  async waitForWorkflowSignal(runId, input) {
    return await this.request(`/v1/workflows/${encodeURIComponent(runId)}/waits`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }
  async recordWorkflowEntry(runId, input) {
    const result2 = await this.request(
      `/v1/workflows/${encodeURIComponent(runId)}/journal`,
      { method: "POST", body: JSON.stringify(input) }
    );
    return result2.entry;
  }
  async improvementReport() {
    return await this.request("/v1/improvements");
  }
  // ----- Context operating-system API (v0.5, issue #34) -----
  async contextGet(input) {
    return await this.request("/v1/context/get", { method: "POST", body: JSON.stringify(input) });
  }
  async contextRecall(input) {
    return await this.request("/v1/context/recall", { method: "POST", body: JSON.stringify(input) });
  }
  async contextState(input) {
    return await this.request("/v1/context/state", { method: "POST", body: JSON.stringify(input) });
  }
  async contextStatePropose(input) {
    return await this.request("/v1/context/state/propose", { method: "POST", body: JSON.stringify(input) });
  }
  async contextStatePromote(input) {
    return await this.request("/v1/context/state/promote", { method: "POST", body: JSON.stringify(input) });
  }
  async contextEpisode(input) {
    return await this.request("/v1/context/episode", { method: "POST", body: JSON.stringify(input) });
  }
  async contextExplain(input) {
    return await this.request("/v1/context/explain", { method: "POST", body: JSON.stringify(input) });
  }
  async contextWikiCompile(input) {
    return await this.request("/v1/context/wiki/compile", { method: "POST", body: JSON.stringify(input) });
  }
  async awaitResponse(messageId, timeoutMs = 30 * 6e4, signal) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new MeshWaitError("aborted", messageId);
      const message = await this.getMessage(messageId);
      if (["replied", "cancelled", "expired", "error"].includes(message.status)) return message;
      await new Promise((resolve5, reject) => {
        const onAbort = () => {
          signal?.removeEventListener("abort", onAbort);
          clearTimeout(timer);
          reject(new MeshWaitError("aborted", messageId));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve5();
        }, Math.min(500, Math.max(1, deadline - Date.now())));
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        timer.unref();
      });
    }
    throw new MeshWaitError("timed_out", messageId);
  }
  async heartbeat() {
    if (this.stopped || !this.agent) return;
    try {
      await this.request(`/v1/agents/${encodeURIComponent(this.agent.id)}/heartbeat`, {
        method: "POST",
        body: "{}"
      });
    } catch (error) {
      if (error instanceof HubHttpError && error.statusCode === 401) void this.recoverRegistration();
    }
  }
  async runEventLoop() {
    while (!this.stopped && this.agent) {
      this.eventsAbort = new AbortController();
      try {
        const response = await fetch(
          `${this.options.serverUrl.replace(/\/$/, "")}/v1/events?agentId=${encodeURIComponent(this.agent.id)}`,
          {
            headers: this.headers(),
            signal: this.eventsAbort.signal
          }
        );
        if (response.status === 401) {
          await response.body?.cancel();
          await this.recoverRegistration();
          continue;
        }
        if (!response.ok || !response.body) throw new Error(`event stream failed with HTTP ${response.status}`);
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
          if (this.stopped) break;
          buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
            if (!data) continue;
            const parsed = JSON.parse(data);
            if ("type" in parsed) await this.onEvent?.(parsed);
          }
        }
      } catch (error) {
        if (this.stopped || error instanceof Error && error.name === "AbortError") return;
      }
      if (!this.stopped) await new Promise((resolve5) => setTimeout(resolve5, this.options.reconnectMs));
    }
  }
  headers(includeIdentity = true) {
    const headers = { "content-type": "application/json" };
    if (this.options.authToken) headers.authorization = `Bearer ${this.options.authToken}`;
    if (includeIdentity && this.agent && this.agentKey) {
      headers["x-kxm-agent-id"] = this.agent.id;
      headers["x-kxm-agent-key"] = this.agentKey;
    }
    return headers;
  }
  async register() {
    if (this.registration) return this.registration;
    this.registration = (async () => {
      const registration = await this.request("/v1/agents/register", {
        method: "POST",
        body: JSON.stringify({
          name: this.options.name,
          purpose: this.options.purpose,
          project: this.options.project,
          model: this.options.model
        })
      }, false);
      this.agent = registration.agent;
      this.agentKey = registration.agentKey;
      return registration.agent;
    })();
    try {
      return await this.registration;
    } finally {
      this.registration = void 0;
    }
  }
  async recoverRegistration() {
    if (this.stopped) return;
    this.agent = void 0;
    this.agentKey = void 0;
    await this.register();
  }
  async request(path, init = {}, includeIdentity = true) {
    const requestTimeoutMs = this.options.requestTimeoutMs ?? 15e3;
    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    let response;
    try {
      response = await fetch(`${this.options.serverUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        signal,
        headers: { ...this.headers(includeIdentity), ...init.headers ?? {} }
      });
    } catch (error) {
      if (timeoutSignal.aborted) throw new Error(`request timed out after ${requestTimeoutMs}ms`);
      throw error;
    }
    const text = await response.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`hub returned invalid JSON with HTTP ${response.status}`);
      }
    }
    if (!response.ok) {
      const extras = {};
      for (const key of ["operation", "nextAction", "assignedCoordinatorName"]) {
        if (typeof body[key] === "string") extras[key] = body[key];
      }
      throw new HubHttpError(
        response.status,
        String(body.error ?? `HTTP ${response.status}`),
        typeof body.code === "string" ? body.code : void 0,
        response.headers.get("x-request-id") ?? void 0,
        Object.keys(extras).length > 0 ? extras : void 0
      );
    }
    return body;
  }
};

// plugins/kxm/src/commands.ts
function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}
function optionalString(value) {
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
  const proj = optionalString(projectArg) ?? client.agent?.project;
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
    description: "List online peer agents in this project's hub pool, including their names and purposes.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    async execute(client) {
      return { agents: await client.listAgents() };
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
        ttlMs: { type: "number", minimum: 1e3, maximum: 6048e5, description: "Message TTL in milliseconds" }
      },
      required: ["target", "content"],
      additionalProperties: false
    },
    async execute(client, args) {
      const delivery = optionalString(args.delivery);
      const correlationId = optionalString(args.correlationId);
      const idempotencyKey = optionalString(args.idempotencyKey);
      const workflowContext = optionalWorkflowContext(args.workflowContext);
      const message = await client.send({
        target: requiredString(args.target, "target"),
        content: requiredString(args.content, "content"),
        ...delivery ? { delivery } : {},
        ...correlationId ? { correlationId } : {},
        ...idempotencyKey ? { idempotencyKey } : {},
        ...workflowContext ? { workflowContext } : {},
        ...typeof args.ttlMs === "number" ? { ttlMs: args.ttlMs } : {}
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
          ...optionalString(args.correlationId) ? { correlationId: optionalString(args.correlationId) } : {},
          ...optionalString(args.idempotencyKeyPrefix) ? { idempotencyKeyPrefix: optionalString(args.idempotencyKeyPrefix) } : {},
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
        ...optionalString(args.severity) ? { severity: optionalString(args.severity) } : {},
        summary: requiredString(args.summary, "summary"),
        ...optionalString(args.details) ? { details: optionalString(args.details) } : {},
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
        ...optionalString(args.workflowRunId) ? { workflowRunId: optionalString(args.workflowRunId) } : {},
        ...optionalString(args.stageId) ? { stageId: optionalString(args.stageId) } : {},
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
        ...optionalString(args.query) ? { query: optionalString(args.query) } : {},
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
        ...optionalString(args.asOf) ? { asOf: optionalString(args.asOf) } : {}
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
        ...optionalString(args.workflowRunId) ? { workflowRunId: optionalString(args.workflowRunId) } : {}
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
function parseAttemptToken(token) {
  try {
    const raw = Buffer.from(token.trim(), "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.schema === "kxm.attempt-token.v1" && typeof parsed.runId === "string") {
      return parsed;
    }
  } catch {
    return void 0;
  }
  return void 0;
}
function parseSessionToken(token) {
  try {
    const raw = Buffer.from(token.trim(), "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.schema === "kxm.session-token.v1" && typeof parsed.sessionId === "string") {
      if (parsed.expiresAt) {
        const expiryTime = new Date(parsed.expiresAt).getTime();
        if (!Number.isNaN(expiryTime) && Date.now() >= expiryTime) {
          return void 0;
        }
      }
      return parsed;
    }
  } catch {
    return void 0;
  }
  return void 0;
}
function resolveUserConfigDirectory(overrideDir) {
  if (overrideDir) return resolve(overrideDir);
  return resolve(process.env.KXM_USER_CONFIG_DIR?.trim() || join(homedir(), ".config", "kxm"));
}
function sessionTokenPath(userConfigDir) {
  return join(resolveUserConfigDirectory(userConfigDir), "session.token");
}
function matchToolPattern(pattern, toolName) {
  if (pattern === "*" || pattern === toolName) return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }
  return false;
}
function isToolAllowed(commandName, policy) {
  if (!policy) return true;
  const canonical = commandName.startsWith("kxm_") ? commandName : `kxm_${commandName}`;
  const bare = commandName.replace(/^kxm_/, "");
  const denyList = policy.deny ?? policy.deniedTools;
  if (Array.isArray(denyList)) {
    for (const d of denyList) {
      if (d === canonical || d === commandName || d === bare || matchToolPattern(d, canonical)) {
        return false;
      }
    }
  }
  const allowList = policy.allow ?? policy.allowedTools;
  if (Array.isArray(allowList) && allowList.length > 0) {
    const matched = allowList.some(
      (a) => a === canonical || a === commandName || a === bare || a === "*" || matchToolPattern(a, canonical)
    );
    if (!matched) return false;
  }
  if (policy.preset === "read-only") {
    const mutating = [
      "kxm_send",
      "kxm_reply",
      "kxm_cancel",
      "kxm_fanout",
      "kxm_workflow_checkpoint",
      "kxm_workflow_record",
      "kxm_workflow_wait",
      "kxm_promote"
    ];
    if (mutating.includes(canonical)) return false;
  }
  return true;
}
function enforceToolPolicy(commandName, env = process.env, options) {
  const attemptTokenRaw = env.KXM_ATTEMPT_TOKEN?.trim();
  if (attemptTokenRaw) {
    const attempt = parseAttemptToken(attemptTokenRaw);
    if (!attempt) {
      return { allowed: false, error: "attempt_token_invalid", detail: "KXM_ATTEMPT_TOKEN is malformed" };
    }
    if (!isToolAllowed(commandName, attempt.toolPolicy)) {
      return {
        allowed: false,
        error: "tool_policy_denied",
        detail: `command ${commandName} is denied by attempt tool policy`
      };
    }
    if (commandName === "kxm_promote" || commandName === "promote") {
      const explicitAllow = attempt.toolPolicy?.allow ?? attempt.toolPolicy?.allowedTools;
      if (!Array.isArray(explicitAllow) || !explicitAllow.includes("kxm_promote") && !explicitAllow.includes("promote") && !explicitAllow.includes("*")) {
        return {
          allowed: false,
          error: "attempt_token_admin_denied",
          detail: "AttemptToken worker cannot perform operator state promotion without explicit policy grant"
        };
      }
    }
    if (options?.runId && attempt.runId && options.runId !== attempt.runId) {
      return {
        allowed: false,
        error: "attempt_token_scope_violation",
        detail: `attempt token runId ${attempt.runId} does not match request runId ${options.runId}`
      };
    }
    return { allowed: true };
  }
  const envSessionRaw = env.KXM_SESSION_TOKEN?.trim();
  if (envSessionRaw) {
    const session = parseSessionToken(envSessionRaw);
    if (!session) {
      return { allowed: false, error: "session_token_invalid", detail: "KXM_SESSION_TOKEN is malformed or expired" };
    }
    if (!isToolAllowed(commandName, session.toolPolicy)) {
      return {
        allowed: false,
        error: "tool_policy_denied",
        detail: `command ${commandName} is denied by session tool policy`
      };
    }
    return { allowed: true };
  }
  const tokenFile = sessionTokenPath(env.KXM_USER_CONFIG_DIR);
  if (existsSync(tokenFile)) {
    let tokenRaw;
    try {
      tokenRaw = readFileSync(tokenFile, "utf8").trim();
    } catch {
      return { allowed: false, error: "session_token_invalid", detail: "Session token file on disk could not be read" };
    }
    const session = tokenRaw ? parseSessionToken(tokenRaw) : void 0;
    if (!session) {
      return { allowed: false, error: "session_token_invalid", detail: "Session token on disk is malformed or expired" };
    }
    if (!isToolAllowed(commandName, session.toolPolicy)) {
      return {
        allowed: false,
        error: "tool_policy_denied",
        detail: `command ${commandName} is denied by session tool policy`
      };
    }
    return { allowed: true };
  }
  return { allowed: true };
}

// plugins/kxm/src/nous-pi.ts
import { readFile } from "node:fs/promises";

// plugins/kxm/src/nous-provider.ts
import { createHash as createHash2 } from "node:crypto";

// plugins/kxm/src/redact.ts
var SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\bKXM_[A-Z0-9_]*(TOKEN|SECRET|KEY)[A-Z0-9_]*=\S+/gi,
  /\b(GITHUB_TOKEN|GH_TOKEN|KXM_AUTH_TOKEN|KXM_WORKFLOW_SIGNAL_SECRET)=\S+/gi,
  /\b[A-Fa-f0-9]{64}\b/g
];
function redactSecrets(value) {
  let result2 = value;
  for (const pattern of SECRET_PATTERNS) {
    result2 = result2.replace(pattern, "[redacted]");
  }
  return result2;
}

// plugins/kxm/src/nous-provider.ts
var NOUS_DIRECT_ID = "nous";
var NOUS_PROXY_ID = "nous-proxy";
var NOUS_DIRECT_BASE_URL = "https://inference-api.nousresearch.com/v1";
var NOUS_PROXY_DEFAULT_BASE_URL = "http://127.0.0.1:8645/v1";
var NOUS_PROXY_PLACEHOLDER_KEY = "kxm-nous-proxy";
var NOUS_CATALOG_SCHEMA = "kxm.nous-catalog.v1";
var NOUS_PRICE_UNITS = "usd_per_million_tokens";
var DEFAULT_DISCOVERY_TIMEOUT_MS = 5e3;
var NOUS_CATALOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1e3;
var LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["127.0.0.1", "localhost", "::1"]);
var PROVIDER_TOKENS = /* @__PURE__ */ new Set(["direct", "proxy"]);
var PER_TOKEN_TO_USD_PER_M = 1e6;
var PI_INPUT_ORDER = ["text", "image"];
function parseNousEnv(env = process.env) {
  const raw = env.KXM_NOUS_PROVIDERS?.trim() ?? "";
  const timeoutMs = parseTimeout(env.KXM_NOUS_DISCOVERY_TIMEOUT_MS);
  if (!raw) {
    return { status: "unset", providers: [], timeoutMs };
  }
  const tokens = raw.split(",").map((part) => part.trim()).filter(Boolean);
  const unknownTokens = [...new Set(tokens.filter((token) => !PROVIDER_TOKENS.has(token)))];
  if (unknownTokens.length > 0) {
    return {
      status: "invalid",
      providers: [],
      unknownTokens,
      timeoutMs,
      error: `unknown KXM_NOUS_PROVIDERS token(s): ${unknownTokens.join(", ")}; expected direct and/or proxy`
    };
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      status: "invalid",
      providers: [],
      unknownTokens: [],
      timeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS,
      error: "KXM_NOUS_DISCOVERY_TIMEOUT_MS must be a positive finite number of milliseconds"
    };
  }
  const providers = [...new Set(tokens)];
  const catalogFile = env.KXM_NOUS_CATALOG_FILE?.trim();
  const proxyOverride = env.KXM_NOUS_PROXY_URL?.trim();
  return {
    status: "ready",
    providers,
    timeoutMs,
    proxyUrl: proxyOverride && proxyOverride.length > 0 ? proxyOverride : NOUS_PROXY_DEFAULT_BASE_URL,
    ...catalogFile ? { catalogFile } : {}
  };
}
function parseTimeout(raw) {
  if (raw === void 0 || raw.trim() === "") return DEFAULT_DISCOVERY_TIMEOUT_MS;
  const value = Number(raw);
  return value;
}
function isLoopbackUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTS.has(host);
}
function modelsUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}
function sanitizeNousText(value) {
  const stripped = value.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]").replace(/\b(NOUS_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]");
  return redactSecrets(stripped).slice(0, 500);
}
function catalogCanonicalPayload(pin) {
  return canonicalJson({
    recordedAt: pin.recordedAt,
    source: pin.source,
    units: pin.units,
    models: pin.models
  });
}
function catalogHash(pin) {
  return `sha256:${createHash2("sha256").update(catalogCanonicalPayload(pin)).digest("hex")}`;
}
function parseCatalogPin(raw, nowMs = Date.now()) {
  if (!isRecord(raw)) return { ok: false, reason: "catalog is not an object" };
  if (raw.schema !== NOUS_CATALOG_SCHEMA) {
    return { ok: false, reason: `catalog schema must be ${NOUS_CATALOG_SCHEMA}` };
  }
  if (typeof raw.recordedAt !== "string" || Number.isNaN(Date.parse(raw.recordedAt))) {
    return { ok: false, reason: "catalog recordedAt must be an ISO-8601 timestamp" };
  }
  if (typeof raw.source !== "string" || raw.source.trim().length === 0) {
    return { ok: false, reason: "catalog source is required" };
  }
  if (raw.units !== NOUS_PRICE_UNITS) {
    return { ok: false, reason: `catalog units must be ${NOUS_PRICE_UNITS}` };
  }
  if (typeof raw.hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(raw.hash)) {
    return { ok: false, reason: "catalog hash must be sha256:<64 hex>" };
  }
  if (!isRecord(raw.models)) return { ok: false, reason: "catalog models must be an object" };
  const expected = catalogHash({
    recordedAt: raw.recordedAt,
    source: raw.source.trim(),
    units: NOUS_PRICE_UNITS,
    models: raw.models
  });
  if (raw.hash !== expected) {
    return { ok: false, reason: "catalog hash does not match recordedAt/source/units/models" };
  }
  const models = {};
  for (const [id, entry] of Object.entries(raw.models)) {
    const parsed = parsePinModel(id, entry);
    if (!parsed.ok) return parsed;
    models[id] = parsed.model;
  }
  const pin = {
    schema: NOUS_CATALOG_SCHEMA,
    recordedAt: raw.recordedAt,
    source: raw.source.trim(),
    units: NOUS_PRICE_UNITS,
    hash: raw.hash,
    models
  };
  const recordedAtMs = Date.parse(pin.recordedAt);
  if (recordedAtMs > nowMs + 6e4) {
    return { ok: false, reason: "catalog recordedAt is in the future" };
  }
  if (nowMs - recordedAtMs > NOUS_CATALOG_MAX_AGE_MS) {
    return { ok: false, reason: "catalog is stale (recordedAt older than 30 days)" };
  }
  return { ok: true, pin };
}
function parsePinModel(id, entry) {
  if (!id.trim()) return { ok: false, reason: "catalog model id is empty" };
  if (!isRecord(entry)) return { ok: false, reason: `catalog model ${id} is not an object` };
  const contextWindow = asPositiveInt(entry.contextWindow);
  const maxTokens = asPositiveInt(entry.maxTokens);
  if (contextWindow === void 0 || maxTokens === void 0) {
    return { ok: false, reason: `catalog model ${id} is missing positive contextWindow/maxTokens` };
  }
  if (entry.priceBasis !== "list" && entry.priceBasis !== "upper-bound") {
    return { ok: false, reason: `catalog model ${id} priceBasis must be list or upper-bound` };
  }
  if (entry.billing !== "metered" && entry.billing !== "subscription" && entry.billing !== "subscription_plus_usage") {
    return { ok: false, reason: `catalog model ${id} billing must be metered, subscription, or subscription_plus_usage` };
  }
  if (typeof entry.verified !== "boolean") {
    return { ok: false, reason: `catalog model ${id} verified must be a boolean` };
  }
  const rates = parseRates(entry.cost);
  if (!rates) return { ok: false, reason: `catalog model ${id} cost rates must be finite nonnegative numbers` };
  let cost = rates;
  let priceBasis = entry.priceBasis;
  if (entry.tiers !== void 0) {
    if (!Array.isArray(entry.tiers) || entry.tiers.length === 0) {
      return { ok: false, reason: `catalog model ${id} tiers must be a nonempty array when present` };
    }
    const tierRates = [rates];
    for (const tier of entry.tiers) {
      if (!isRecord(tier)) return { ok: false, reason: `catalog model ${id} has a malformed tier` };
      const parsedTier = parseRates(tier);
      if (!parsedTier) return { ok: false, reason: `catalog model ${id} tier rates must be finite nonnegative numbers` };
      if (asNonnegInt(tier.inputTokensAbove) === void 0) {
        return { ok: false, reason: `catalog model ${id} tier is missing inputTokensAbove` };
      }
      tierRates.push(parsedTier);
    }
    cost = upperBoundRates(tierRates);
    priceBasis = "upper-bound";
  }
  if (!entry.verified && hasZeroRate(cost)) {
    return { ok: false, reason: `catalog model ${id} has unverified zero rates` };
  }
  return {
    ok: true,
    model: {
      contextWindow,
      maxTokens,
      cost,
      priceBasis,
      billing: entry.billing,
      verified: entry.verified,
      ...typeof entry.name === "string" && entry.name.trim() ? { name: entry.name.trim() } : {}
    }
  };
}
function parseModelsResponse(raw) {
  if (!isRecord(raw) || !Array.isArray(raw.data)) {
    return { ok: false, error: "invalid", reason: "models response is not an object with a data array" };
  }
  const models = [];
  for (const item of raw.data) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) {
      return { ok: false, error: "invalid", reason: "models response contains an entry without an id" };
    }
    const model = { id: item.id.trim() };
    if (typeof item.name === "string" && item.name.trim()) model.name = item.name.trim();
    const topProvider = isRecord(item.top_provider) ? item.top_provider : void 0;
    const contextWindow = asPositiveInt(item.contextWindow ?? item.context_window ?? item.context_length);
    const maxTokens = asPositiveInt(
      item.maxTokens ?? item.max_tokens ?? item.max_output_tokens ?? topProvider?.max_completion_tokens
    );
    if (contextWindow !== void 0) model.contextWindow = contextWindow;
    if (maxTokens !== void 0) model.maxTokens = maxTokens;
    if (typeof item.units === "string") model.units = item.units;
    if (typeof item.verified === "boolean") model.verified = item.verified;
    const architecture = isRecord(item.architecture) ? item.architecture : void 0;
    if (architecture && "input_modalities" in architecture) {
      const input = parseInputModalities(architecture.input_modalities);
      if (!input) model.capabilityIssue = "unknown input modalities";
      else model.input = input;
    }
    const supported = parseSupportedParameters(item.supported_parameters);
    if (supported) {
      model.reasoning = supported.reasoning;
      model.tools = supported.tools;
    }
    if (isRecord(item.pricing)) {
      const live = parseLivePricing(item.pricing);
      if (!live) {
        model.pricingIssue = "malformed or incomplete live pricing; costly tiers are not dropped and zeros are not guessed";
      } else {
        model.cost = live.cost;
        model.units = NOUS_PRICE_UNITS;
        if (live.tiers.length > 0) model.tiers = live.tiers;
      }
    } else {
      const cost = isRecord(item.cost) ? parseRates(item.cost) : void 0;
      if (cost) model.cost = cost;
      if (Array.isArray(item.tiers)) {
        const tiers = [];
        for (const tier of item.tiers) {
          if (!isRecord(tier)) {
            model.pricingIssue = "malformed assumed-shape tier";
            break;
          }
          const rates = parseRates(tier);
          const above = asNonnegInt(tier.inputTokensAbove ?? tier.input_tokens_above);
          if (!rates || above === void 0) {
            model.pricingIssue = "incomplete assumed-shape tier";
            break;
          }
          tiers.push({ ...rates, inputTokensAbove: above });
        }
        if (!model.pricingIssue && tiers.length > 0) model.tiers = tiers;
        if (model.pricingIssue) {
          delete model.cost;
          delete model.tiers;
        }
      }
    }
    models.push(model);
  }
  return { ok: true, models };
}
async function fetchNousModels(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const headers = { Accept: "application/json" };
    if (options.authorization) headers.Authorization = `Bearer ${options.authorization}`;
    const response = await fetchImpl(options.url, { method: "GET", headers, signal: controller.signal });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: "auth", status: response.status, reason: `HTTP ${response.status}` };
    }
    if (!response.ok) {
      return { ok: false, error: "http", status: response.status, reason: `HTTP ${response.status}` };
    }
    let text;
    try {
      text = await response.text();
    } catch {
      return { ok: false, error: "invalid", reason: "models response is not JSON" };
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, error: "invalid", reason: "models response is not JSON" };
    }
    const parsed = parseModelsResponse(payload);
    if (!parsed.ok) return parsed;
    return {
      ...parsed,
      provenance: {
        source: options.url,
        fetchedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
        rawSha256: `sha256:${createHash2("sha256").update(text).digest("hex")}`
      }
    };
  } catch (error) {
    if (isAbortError(error)) {
      return { ok: false, error: "timeout", reason: `discovery timed out after ${options.timeoutMs}ms` };
    }
    if (isConnectionRefused(error)) {
      return { ok: false, error: "connection-refused", reason: "connection refused" };
    }
    return { ok: false, error: "http", reason: sanitizeNousText(error instanceof Error ? error.message : "discovery failed") };
  } finally {
    clearTimeout(timer);
  }
}
function buildModelConfigs(discovered, pin, route) {
  const registered = [];
  const skipped = [];
  const requiredBilling = route === "direct" ? ["metered"] : ["subscription", "subscription_plus_usage"];
  for (const item of discovered) {
    if (item.capabilityIssue) {
      skipped.push({ id: item.id, reason: `excluded: ${item.capabilityIssue}` });
      continue;
    }
    const fromPin = pin?.models[item.id];
    if (item.pricingIssue && !fromPin) {
      skipped.push({ id: item.id, reason: `unpriced, not registered: ${item.pricingIssue}` });
      continue;
    }
    const capacity = {
      contextWindow: fromPin?.contextWindow ?? item.contextWindow,
      maxTokens: fromPin?.maxTokens ?? item.maxTokens
    };
    if (capacity.contextWindow === void 0 || capacity.maxTokens === void 0) {
      skipped.push({ id: item.id, reason: "unpriced, not registered: missing contextWindow or maxTokens" });
      continue;
    }
    let cost;
    let priceBasis = "list";
    let verified = false;
    let tiers;
    if (fromPin) {
      cost = fromPin.cost;
      priceBasis = fromPin.priceBasis;
      verified = fromPin.verified;
    } else {
      const rateSources = [];
      if (item.cost) rateSources.push(item.cost);
      if (item.tiers && item.tiers.length > 0) rateSources.push(...item.tiers);
      if (rateSources.length === 0) {
        skipped.push({ id: item.id, reason: "unpriced, not registered: no numeric cost rates and no catalog pin" });
        continue;
      }
      if (item.units !== NOUS_PRICE_UNITS) {
        skipped.push({ id: item.id, reason: `unpriced, not registered: units must be ${NOUS_PRICE_UNITS}` });
        continue;
      }
      if (item.tiers && item.tiers.length > 0) {
        priceBasis = "upper-bound";
        cost = upperBoundRates(rateSources);
        tiers = item.tiers;
      } else {
        cost = item.cost;
      }
      verified = item.verified === true;
    }
    if (!cost) {
      skipped.push({ id: item.id, reason: "unpriced, not registered" });
      continue;
    }
    if (hasZeroRate(cost) && !verified) {
      skipped.push({ id: item.id, reason: "unpriced, not registered: unverified zero rates" });
      continue;
    }
    const billing = fromPin?.billing ?? (route === "direct" ? "metered" : "subscription");
    if (!requiredBilling.includes(billing)) {
      skipped.push({ id: item.id, reason: `excluded: billing ${billing} is not valid for ${route}` });
      continue;
    }
    const display = labeledModelName(fromPin?.name ?? item.name ?? item.id, route, priceBasis);
    registered.push({
      id: item.id,
      name: display,
      contextWindow: capacity.contextWindow,
      maxTokens: capacity.maxTokens,
      cost,
      priceBasis,
      billing,
      verified,
      ...item.input ? { input: item.input } : {},
      ...item.reasoning !== void 0 ? { reasoning: item.reasoning } : {},
      ...item.tools !== void 0 ? { tools: item.tools } : {},
      ...tiers ? { tiers } : {}
    });
  }
  return { registered, skipped };
}
function guidanceFor(input) {
  const messages = [];
  if (input.parsed.status === "invalid") {
    messages.push({ message: input.parsed.error, level: "error" });
    return messages;
  }
  if (input.parsed.status !== "ready") return messages;
  if (input.parsed.providers.includes("direct") && !input.directHasKey) {
    messages.push({
      message: "Nous direct API is opted in but NOUS_API_KEY is unset. Set NOUS_API_KEY. This slice does not use stored Pi /login credentials.",
      level: "info"
    });
  }
  if (input.proxyUrlInvalid) {
    messages.push({
      message: "KXM_NOUS_PROXY_URL must be a loopback http(s) URL (127.0.0.1, localhost, or ::1). Failing closed.",
      level: "error"
    });
  }
  if (input.proxyDiscovery?.ok === false && input.proxyDiscovery.error === "connection-refused") {
    messages.push({
      message: "Nous proxy is not reachable. Start it with `hermes proxy start` and check `hermes proxy status`. KXM does not install, spawn, or log in for you.",
      level: "info"
    });
  }
  if (input.proxyDiscovery?.ok === false && input.proxyDiscovery.error === "auth") {
    messages.push({
      message: "Nous proxy returned unauthorized. Log in with `hermes login --provider nous`. Newer docs also mention `hermes setup --portal` (not verified on this CLI).",
      level: "info"
    });
  }
  if (input.directDiscovery?.ok === false && input.directDiscovery.error === "timeout") {
    messages.push({ message: `Nous direct discovery ${input.directDiscovery.reason}.`, level: "info" });
  }
  if (input.proxyDiscovery?.ok === false && input.proxyDiscovery.error === "timeout") {
    messages.push({ message: `Nous proxy discovery ${input.proxyDiscovery.reason}.`, level: "info" });
  }
  if (input.catalogError) {
    messages.push({ message: `Nous catalog pin not used: ${input.catalogError}.`, level: "error" });
  }
  if (input.skipped && input.skipped.length > 0) {
    const preview = input.skipped.slice(0, 8).map((item) => `${item.id} (${item.reason})`).join("; ");
    messages.push({
      message: `Skipped ${input.skipped.length} Nous model(s) as unpriced or invalid: ${preview}.`,
      level: "info"
    });
  }
  return messages.map((item) => ({ ...item, message: sanitizeNousText(item.message) }));
}
function labeledModelName(base, route, priceBasis) {
  if (route === "proxy") {
    return priceBasis === "upper-bound" ? `${base} (subscription proxy, market ref; upper-bound)` : `${base} (subscription proxy, market ref)`;
  }
  return priceBasis === "upper-bound" ? `${base} (upper-bound market ref)` : base;
}
function parseLivePricing(pricing) {
  const cost = parseLiveRates(pricing);
  if (!cost) return void 0;
  if (!("overrides" in pricing) || pricing.overrides === void 0) {
    return { cost, tiers: [] };
  }
  if (!Array.isArray(pricing.overrides)) return void 0;
  const tiers = [];
  for (const override of pricing.overrides) {
    if (!isRecord(override)) return void 0;
    const rates = parseLiveRates(override);
    const above = asNonnegInt(override.min_prompt_tokens ?? override.minPromptTokens);
    if (!rates || above === void 0) return void 0;
    tiers.push({ ...rates, inputTokensAbove: above });
  }
  return { cost, tiers };
}
function parseLiveRates(value) {
  const input = perTokenToUsdPerM(value.prompt);
  const output = perTokenToUsdPerM(value.completion);
  const cacheRead = perTokenToUsdPerM(value.input_cache_read ?? value.inputCacheRead);
  const cacheWrite = perTokenToUsdPerM(value.input_cache_write ?? value.inputCacheWrite);
  if (input === void 0 || output === void 0 || cacheRead === void 0 || cacheWrite === void 0) return void 0;
  return { input, output, cacheRead, cacheWrite };
}
function perTokenToUsdPerM(value) {
  let perToken;
  if (typeof value === "number") perToken = value;
  else if (typeof value === "string" && value.trim() !== "") perToken = Number(value);
  if (perToken === void 0 || !Number.isFinite(perToken) || perToken < 0) return void 0;
  const usdPerM = Number((perToken * PER_TOKEN_TO_USD_PER_M).toFixed(8));
  if (!Number.isFinite(usdPerM) || usdPerM < 0) return void 0;
  return usdPerM;
}
function parseInputModalities(value) {
  if (!Array.isArray(value)) return void 0;
  const present = new Set(value.filter((item) => item === "text" || item === "image"));
  const mapped = PI_INPUT_ORDER.filter((item) => present.has(item));
  return mapped.length > 0 ? mapped : void 0;
}
function parseSupportedParameters(value) {
  if (!Array.isArray(value)) return void 0;
  const params = new Set(value.filter((item) => typeof item === "string"));
  return {
    reasoning: params.has("reasoning") || params.has("include_reasoning"),
    tools: params.has("tools") || params.has("tool_choice")
  };
}
function parseRates(value) {
  if (!isRecord(value)) return void 0;
  const input = asFiniteNonneg(value.input);
  const output = asFiniteNonneg(value.output);
  const cacheRead = asFiniteNonneg(value.cacheRead ?? value.cache_read ?? value.cache_input);
  const cacheWrite = asFiniteNonneg(value.cacheWrite ?? value.cache_write);
  if (input === void 0 || output === void 0 || cacheRead === void 0 || cacheWrite === void 0) return void 0;
  return { input, output, cacheRead, cacheWrite };
}
function upperBoundRates(list) {
  return {
    input: Math.max(...list.map((item) => item.input)),
    output: Math.max(...list.map((item) => item.output)),
    cacheRead: Math.max(...list.map((item) => item.cacheRead)),
    cacheWrite: Math.max(...list.map((item) => item.cacheWrite))
  };
}
function hasZeroRate(cost) {
  return cost.input === 0 || cost.output === 0 || cost.cacheRead === 0 || cost.cacheWrite === 0;
}
function asFiniteNonneg(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return void 0;
  return value;
}
function asPositiveInt(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return void 0;
  return value;
}
function asNonnegInt(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return void 0;
  return value;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function isAbortError(error) {
  if (!error || typeof error !== "object") return false;
  const name = error.name;
  return name === "AbortError" || name === "TimeoutError";
}
function isConnectionRefused(error) {
  const codes = [];
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = current.code;
    if (typeof code === "string") codes.push(code);
    const message = current.message;
    if (typeof message === "string" && /ECONNREFUSED/i.test(message)) return true;
    current = current.cause;
  }
  return codes.includes("ECONNREFUSED");
}

// plugins/kxm/src/nous-pi.ts
var emptySide = (id) => ({ id, registered: 0, skipped: 0 });
function emptyNousReport() {
  return {
    optedIn: false,
    direct: emptySide(NOUS_DIRECT_ID),
    proxy: emptySide(NOUS_PROXY_ID),
    guidance: [],
    registeredProviders: []
  };
}
function nousFactoryWork(pi, onReport, deps = {}) {
  const env = deps.env ?? process.env;
  const parsed = parseNousEnv(env);
  if (parsed.status === "unset") {
    onReport(emptyNousReport());
    return;
  }
  if (parsed.status === "invalid") {
    onReport({
      ...emptyNousReport(),
      optedIn: true,
      guidance: guidanceFor({ parsed })
    });
    return;
  }
  return registerNousProviders(pi, deps).then(onReport);
}
async function registerNousProviders(pi, deps = {}) {
  const env = deps.env ?? process.env;
  const parsed = parseNousEnv(env);
  if (parsed.status === "unset") return emptyNousReport();
  if (parsed.status === "invalid") {
    return { ...emptyNousReport(), optedIn: true, guidance: guidanceFor({ parsed }) };
  }
  const report = emptyNousReport();
  report.optedIn = true;
  let pin;
  let catalogError;
  if (parsed.catalogFile) {
    const loaded = await loadCatalog(parsed.catalogFile, deps);
    if (loaded.ok) pin = loaded.pin;
    else catalogError = loaded.reason;
  }
  const skipped = [];
  let directDiscovery;
  let proxyDiscovery;
  let proxyUrlInvalid = false;
  const directHasKey = hasDirectKey(env);
  if (parsed.providers.includes("direct")) {
    const result2 = await registerRoute({
      pi,
      route: "direct",
      env,
      parsed,
      pin,
      hasKey: directHasKey,
      ...deps.fetch ? { fetchImpl: deps.fetch } : {},
      ...deps.nowMs !== void 0 ? { nowMs: deps.nowMs } : {}
    });
    report.direct = result2.side;
    directDiscovery = result2.discovery;
    skipped.push(...result2.skipped);
    if (result2.registered) report.registeredProviders.push(NOUS_DIRECT_ID);
  }
  if (parsed.providers.includes("proxy")) {
    if (!isLoopbackUrl(parsed.proxyUrl)) {
      proxyUrlInvalid = true;
      report.proxy = {
        id: NOUS_PROXY_ID,
        registered: 0,
        skipped: 0,
        error: "non-loopback",
        reason: "proxy URL is not loopback http(s)"
      };
    } else {
      const result2 = await registerRoute({
        pi,
        route: "proxy",
        env,
        parsed,
        pin,
        hasKey: true,
        ...deps.fetch ? { fetchImpl: deps.fetch } : {},
        ...deps.nowMs !== void 0 ? { nowMs: deps.nowMs } : {}
      });
      report.proxy = result2.side;
      proxyDiscovery = result2.discovery;
      skipped.push(...result2.skipped);
      if (result2.registered) report.registeredProviders.push(NOUS_PROXY_ID);
    }
  }
  report.guidance = guidanceFor({
    parsed,
    directHasKey,
    proxyUrlInvalid,
    skipped,
    ...directDiscovery ? { directDiscovery } : {},
    ...proxyDiscovery ? { proxyDiscovery } : {},
    ...catalogError ? { catalogError } : {}
  });
  return report;
}
async function registerRoute(input) {
  const providerId = input.route === "direct" ? NOUS_DIRECT_ID : NOUS_PROXY_ID;
  const baseUrl = input.route === "direct" ? NOUS_DIRECT_BASE_URL : input.parsed.proxyUrl;
  const side = { id: providerId, registered: 0, skipped: 0 };
  if (input.route === "direct" && !input.hasKey) {
    registerLegacy(input.pi, providerId, baseUrl, "$NOUS_API_KEY", []);
    return { side, skipped: [], registered: true };
  }
  const authorization = input.route === "direct" ? input.env.NOUS_API_KEY : NOUS_PROXY_PLACEHOLDER_KEY;
  const discovery = await fetchNousModels({
    url: modelsUrl(baseUrl),
    timeoutMs: input.parsed.timeoutMs,
    ...authorization ? { authorization } : {},
    ...input.fetchImpl ? { fetchImpl: input.fetchImpl } : {},
    ...input.nowMs !== void 0 ? { nowMs: input.nowMs } : {}
  });
  if (!discovery.ok) {
    side.error = discovery.error;
    side.reason = discovery.reason;
    registerLegacy(input.pi, providerId, baseUrl, apiKeyRef(input.route), []);
    return { side, discovery, skipped: [], registered: true };
  }
  if (discovery.provenance) side.provenance = discovery.provenance;
  const built = buildModelConfigs(discovery.models, input.pin, input.route);
  side.registered = built.registered.length;
  side.skipped = built.skipped.length;
  registerLegacy(input.pi, providerId, baseUrl, apiKeyRef(input.route), built.registered);
  return { side, discovery, skipped: built.skipped, registered: true };
}
function apiKeyRef(route) {
  return route === "direct" ? "$NOUS_API_KEY" : NOUS_PROXY_PLACEHOLDER_KEY;
}
function registerLegacy(pi, id, baseUrl, apiKey, models) {
  if (typeof pi.registerProvider !== "function") {
    throw new Error("Pi registerProvider is unavailable");
  }
  pi.registerProvider(id, {
    name: id === NOUS_DIRECT_ID ? "Nous" : "Nous subscription proxy",
    baseUrl,
    apiKey,
    api: "openai-completions",
    authHeader: true,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning === true,
      input: model.input && model.input.length > 0 ? model.input : ["text"],
      // Upper-bound rates only: Pi cost.tiers uses strict > and can underquote.
      cost: {
        input: model.cost.input,
        output: model.cost.output,
        cacheRead: model.cost.cacheRead,
        cacheWrite: model.cost.cacheWrite
      },
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens
    }))
  });
}
function hasDirectKey(env) {
  const key = env.NOUS_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}
async function loadCatalog(path, deps) {
  try {
    const read = deps.readFile ?? ((filePath) => readFile(filePath, "utf8"));
    const text = await read(path);
    return parseCatalogPin(JSON.parse(text), deps.nowMs ?? Date.now());
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false, reason: "catalog file is not valid JSON" };
    }
    return { ok: false, reason: sanitizeNousText(error instanceof Error ? error.message : "catalog file could not be read") };
  }
}

// plugins/kxm/src/diagnostics.ts
var NEXT_ACTIONS = [
  "use_assigned_coordinator",
  "wait_then_checkpoint",
  "record_journal_as_coordinator",
  "reconnect_with_current_agent_key",
  "check_project_token",
  "export_retrospective",
  "post_signal",
  "restart_fresh_session",
  "switch_model_or_retry"
];
var CODE_TO_CLASS = {
  workflow_forbidden: "workflow_scope",
  invalid_agent_identity: "invalid_identity",
  invalid_auth: "invalid_auth",
  workflow_signal_mismatch: "signal_mismatch",
  workflow_not_waiting: "not_waiting",
  workflow_terminal: "not_waiting",
  workflow_not_running: "not_waiting",
  unresumable_session: "unresumable_session",
  provider_quota: "quota",
  provider_error: "provider_error"
};
function operationForTool(toolName) {
  switch (toolName) {
    case "kxm_workflow_get":
    case "kxm_workflow_list":
      return "get";
    case "kxm_workflow_wait":
      return "wait";
    case "kxm_workflow_checkpoint":
      return "checkpoint";
    case "kxm_workflow_record":
      return "journal";
    case "kxm_await":
      return "await";
    default:
      return "other";
  }
}
function areaForTool(toolName) {
  if (toolName?.startsWith("kxm_workflow_")) return "workflow";
  if (toolName?.startsWith("kxm_")) return "harness";
  return "implementation";
}
function nextActionForCode(code, operation) {
  if (code === "workflow_forbidden") return "use_assigned_coordinator";
  if (code === "invalid_agent_identity") return "reconnect_with_current_agent_key";
  if (code === "invalid_auth") return "check_project_token";
  if (code === "workflow_not_waiting" || code === "workflow_terminal" || code === "workflow_not_running") {
    return operation === "checkpoint" ? "wait_then_checkpoint" : "export_retrospective";
  }
  if (code === "workflow_signal_mismatch") return "post_signal";
  if (code === "unresumable_session") return "restart_fresh_session";
  if (code === "provider_quota" || code === "provider_error") return "switch_model_or_retry";
  return void 0;
}
function classFromTokens(text) {
  const value = text.toLowerCase();
  if (/\b(enoent|not recognized|command not found|is not recognized)\b/.test(value)) return "command_not_found";
  if (/\b(ts\d{3,4}|typecheck|type error)\b/.test(value)) return "typecheck_error";
  if (/\b(test failed|assertionerror|not equal)\b/.test(value)) return "test_failure";
  if (/\b(timed out|timeout|deadline)\b/.test(value)) return "timeout";
  if (/\b(aborted|cancelled|canceled|sigint|sigterm)\b/.test(value)) return "cancelled";
  if (/\b(econnrefused|enotfound|fetch failed|network)\b/.test(value)) return "network";
  if (/\b(invalid json|unexpected token|parse error)\b/.test(value)) return "parse_error";
  if (/\b(invalid_request_error|missing_tool_result|unresumable)\b/.test(value)) return "unresumable_session";
  if (/\b(quota reached|quota exceeded|rate limit(?:ed)?|too many requests|resource exhausted|http 429)\b/.test(value)) return "quota";
  if (/\b(not visible|only the assigned coordinator)\b/.test(value)) return "workflow_scope";
  return void 0;
}
function classifyFailure(input) {
  const tool = input.toolName?.trim() || "unknown";
  const operation = operationForTool(input.toolName);
  const fromCode = input.code ? CODE_TO_CLASS[input.code] : void 0;
  const fromTokens = input.message ? classFromTokens(input.message) : void 0;
  const diagnosticClass = fromCode ?? fromTokens ?? "unknown";
  const messageCoordinator = input.message?.match(/assignedCoordinator=([A-Za-z0-9_.-]{1,64})/)?.[1];
  const messageAction = input.message?.match(/nextAction=([a-z_]{1,64})/)?.[1];
  const parsedAction = NEXT_ACTIONS.includes(messageAction) ? messageAction : void 0;
  const nextAction = input.nextAction ?? parsedAction ?? nextActionForCode(input.code, operation);
  const assignedCoordinatorName = input.assignedCoordinatorName ?? messageCoordinator;
  return {
    class: diagnosticClass,
    tool,
    operation,
    ...input.statusCode !== void 0 ? { httpStatus: input.statusCode } : {},
    ...input.code ? { code: input.code } : {},
    ...assignedCoordinatorName ? { assignedCoordinatorName } : {},
    ...nextAction ? { nextAction } : {},
    ...input.exitCode !== void 0 ? { exitCode: input.exitCode } : {},
    ...input.durationMs !== void 0 ? { durationMs: input.durationMs } : {}
  };
}
function diagnosticEvidence(diagnostic, toolCallId) {
  return [
    `tool:${diagnostic.tool}`,
    ...toolCallId ? [`tool-call:${toolCallId}`] : [],
    `class:${diagnostic.class}`,
    `operation:${diagnostic.operation}`,
    ...diagnostic.code ? [`code:${diagnostic.code}`] : [],
    ...diagnostic.nextAction ? [`nextAction:${diagnostic.nextAction}`] : [],
    ...diagnostic.assignedCoordinatorName ? [`assignedCoordinator:${diagnostic.assignedCoordinatorName}`] : []
  ];
}
function diagnosticSummary(diagnostic) {
  const coordinator = diagnostic.assignedCoordinatorName ? `; assigned coordinator: ${diagnostic.assignedCoordinatorName}` : "";
  const next = diagnostic.nextAction ? `; next action: ${diagnostic.nextAction}` : "";
  return `Tool ${diagnostic.tool} failed: ${diagnostic.class}${coordinator}${next}`;
}

// plugins/kxm/src/recovery.ts
import { createHash as createHash3 } from "node:crypto";
import { lstatSync, readFileSync as readFileSync2, renameSync, rmSync } from "node:fs";
import { join as join2 } from "node:path";
function workerStateKey(project, agentName) {
  const safeProject = project.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 24) || "project";
  const safeName = agentName.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 32) || "agent";
  const digest = createHash3("sha256").update(JSON.stringify({ project, agentName })).digest("hex").slice(0, 24);
  return `${safeProject}-${safeName}-${digest}`;
}
function legacyRecoveryEnvelopePath(stateDir, agentName) {
  const safeName = agentName.replace(/[^A-Za-z0-9_.-]/g, "_");
  return join2(stateDir, `worker-recovery-${safeName}.json`);
}
function recoveryEnvelopePath(stateDir, agentName, project) {
  return project ? join2(stateDir, `worker-recovery-${workerStateKey(project, agentName)}.json`) : legacyRecoveryEnvelopePath(stateDir, agentName);
}
var recoveryReasons = /* @__PURE__ */ new Set([
  "missing_tool_result",
  "unresumable_session",
  "provider_error",
  "tool_timeout",
  "worker_signal"
]);
var recoveryRunId = /^run_[a-f0-9]{32}$/;
var recoveryMessageId = /^msg_[a-f0-9]{32}$/;
function validBoundedStrings(value, maxItems, pattern) {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 2048 && !/[\0\r\n]/.test(item) && (!pattern || pattern.test(item)));
}
function parseRecoveryEnvelope(value, agentName, project) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("recovery envelope must be an object");
  const parsed = value;
  if (parsed.version !== 1 || !recoveryReasons.has(parsed.reason) || parsed.agentName !== agentName || typeof parsed.project !== "string" || parsed.project.length < 1 || parsed.project.length > 128 || project !== void 0 && parsed.project !== project || typeof parsed.previousContinue !== "boolean" || typeof parsed.freshSession !== "boolean" || typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt))) throw new Error("recovery envelope identity or schema is invalid");
  if (parsed.runId !== void 0 && parsed.runId !== null && !recoveryRunId.test(parsed.runId)) {
    throw new Error("recovery envelope run identity is invalid");
  }
  if (parsed.stageId !== void 0 && parsed.stageId !== null && (typeof parsed.stageId !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(parsed.stageId))) {
    throw new Error("recovery envelope stage identity is invalid");
  }
  if (parsed.activeMessageIds !== void 0 && !validBoundedStrings(parsed.activeMessageIds, 3, recoveryMessageId)) {
    throw new Error("recovery envelope active messages are invalid");
  }
  if (parsed.pendingMessageIds !== void 0 && !validBoundedStrings(parsed.pendingMessageIds, 16, recoveryMessageId)) {
    throw new Error("recovery envelope pending messages are invalid");
  }
  if (parsed.artifactPointers !== void 0 && !validBoundedStrings(parsed.artifactPointers, 16)) {
    throw new Error("recovery envelope artifact pointers are invalid");
  }
  if (parsed.failureClass !== void 0 && parsed.failureClass !== "quota" && parsed.failureClass !== "provider_error" && parsed.failureClass !== "timeout") {
    throw new Error("recovery envelope failure class is invalid");
  }
  if (parsed.signal !== void 0 && (typeof parsed.signal !== "string" || parsed.signal.length > 64 || /[\0\r\n]/.test(parsed.signal))) {
    throw new Error("recovery envelope signal is invalid");
  }
  if (parsed.sessionBinding !== void 0) {
    const binding = parsed.sessionBinding;
    if (!binding || typeof binding !== "object" || binding.kind === "default" && Object.keys(binding).some((key) => key !== "kind") || binding.kind === "workflow" && !recoveryRunId.test(binding.runId) || binding.kind !== "default" && binding.kind !== "workflow") throw new Error("recovery envelope session binding is invalid");
  }
  return parsed;
}
function findWorkerRecoveryEnvelope(stateDir, agentName, project) {
  const candidates = project ? [
    { path: recoveryEnvelopePath(stateDir, agentName, project), quarantineInvalid: true },
    { path: legacyRecoveryEnvelopePath(stateDir, agentName), quarantineInvalid: false }
  ] : [{ path: legacyRecoveryEnvelopePath(stateDir, agentName), quarantineInvalid: false }];
  for (const candidate of candidates) {
    try {
      const stats = lstatSync(candidate.path);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 128 * 1024) {
        throw new Error("recovery envelope is not a bounded regular file");
      }
      const envelope = parseRecoveryEnvelope(JSON.parse(readFileSync2(candidate.path, "utf8")), agentName, project);
      return { envelope, path: candidate.path };
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (candidate.quarantineInvalid) {
        try {
          renameSync(candidate.path, `${candidate.path}.corrupt-${Date.now()}`);
        } catch {
        }
      }
    }
  }
  return void 0;
}
async function consumeWorkerRecoveryEnvelope(client, stateDir, agentName, project) {
  const found = findWorkerRecoveryEnvelope(stateDir, agentName, project);
  if (!found) return void 0;
  const { envelope, path } = found;
  let runId = envelope.runId ?? void 0;
  let stageId = envelope.stageId ?? void 0;
  let scopeMismatch = false;
  if (envelope.sessionBinding) {
    const boundRunId = envelope.sessionBinding.kind === "workflow" ? envelope.sessionBinding.runId : void 0;
    if (runId !== boundRunId) {
      scopeMismatch = true;
      runId = void 0;
      stageId = void 0;
    }
  }
  if (!runId) {
    rmSync(path, { force: true });
    return scopeMismatch ? { ...envelope, runId: null, stageId: null } : envelope;
  }
  const providerRecovery = envelope.reason === "provider_error";
  const diagnostic = classifyFailure({
    toolName: providerRecovery ? "provider" : envelope.reason === "tool_timeout" ? "tool" : "kxm_await",
    ...providerRecovery ? { code: envelope.failureClass === "quota" ? "provider_quota" : "provider_error" } : envelope.reason === "tool_timeout" ? {} : { code: "unresumable_session" },
    message: envelope.reason === "tool_timeout" ? "timed out" : envelope.reason
  });
  try {
    await client.recordWorkflowEntry(runId, {
      category: "error",
      area: "harness",
      severity: "error",
      summary: `Worker recovered with ${envelope.reason}`,
      evidence: [
        ...diagnosticEvidence(diagnostic),
        `recovery:v1`,
        `reason:${envelope.reason}`,
        ...envelope.sessionBinding?.kind === "workflow" ? [`session-scope:${envelope.sessionBinding.runId}`] : [],
        ...stageId ? [`stage:${stageId}`] : [],
        ...(envelope.pendingMessageIds ?? []).slice(0, 8).map((id) => `message:${id}`),
        ...(envelope.artifactPointers ?? []).slice(0, 16).map((pointer) => pointer.startsWith("artifact:") ? pointer : `artifact:${pointer}`)
      ]
    });
    rmSync(path, { force: true });
    return { ...envelope, runId, ...stageId ? { stageId } : {} };
  } catch (error) {
    if (error instanceof HubHttpError && error.statusCode === 403 && error.code === "workflow_forbidden") {
      rmSync(path, { force: true });
      return { ...envelope, runId, ...stageId ? { stageId } : {}, peerLocal: true };
    }
    return void 0;
  }
}

// plugins/kxm/src/session-work.ts
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync as existsSync5, mkdirSync as mkdirSync5, readFileSync as readFileSync7, renameSync as renameSync3, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join7 } from "node:path";

// plugins/kxm/src/local-snapshot.ts
import { existsSync as existsSync2, readdirSync, readFileSync as readFileSync4 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { isAbsolute, join as join4, resolve as resolve2 } from "node:path";
import { DatabaseSync } from "node:sqlite";

// plugins/kxm/src/telemetry.ts
import { appendFileSync, mkdirSync as mkdirSync2, readFileSync as readFileSync3 } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
function telemetryPath(logsDir) {
  return join3(logsDir, "telemetry.jsonl");
}
function readRoutingRecords(path) {
  const records = [];
  try {
    const raw = readFileSync3(path, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        let routingObj;
        const recordedAt = typeof parsed.recordedAt === "string" ? parsed.recordedAt : typeof parsed.timestamp === "string" ? parsed.timestamp : (/* @__PURE__ */ new Date()).toISOString();
        if (parsed.schema === "kxm.routing-record.v2" || parsed.schema === "kxm.routing-record.v1") {
          routingObj = parsed;
        } else if (parsed.routing && typeof parsed.routing === "object") {
          routingObj = parsed.routing;
        } else if (parsed.envelope && typeof parsed.envelope === "object" && parsed.envelope.routing) {
          routingObj = parsed.envelope.routing;
        } else if (parsed.eventType === "routing.attempt.recorded" && parsed.payload && typeof parsed.payload === "object") {
          routingObj = parsed.payload.routing;
        }
        if (routingObj && typeof routingObj === "object") {
          const r = routingObj;
          if (r.schema === "kxm.routing-record.v2" || r.schema === "kxm.routing-record.v1") {
            records.push({ recordedAt, routing: r });
          }
        }
      } catch {
      }
    }
  } catch {
  }
  return records;
}

// plugins/kxm/src/local-snapshot.ts
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function readJsonRows(database, sql) {
  const rows = database.prepare(sql).all();
  const out = [];
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.record));
    } catch {
    }
  }
  return out;
}
var DONE_STAGE_STATUSES = /* @__PURE__ */ new Set(["passed", "failed", "warning"]);
function summarizeMeshRun(run) {
  const stages = (run.stages ?? []).map((stage) => ({
    id: stage.id,
    ...stage.label ? { label: stage.label } : {},
    status: stage.status,
    ...stage.attempts ? { attempts: stage.attempts } : {}
  }));
  const total = stages.length;
  const done = stages.filter((stage) => DONE_STAGE_STATUSES.has(stage.status)).length;
  return {
    id: run.id,
    status: run.status,
    definitionId: run.definitionId,
    project: run.project,
    ...run.currentStage ? { currentStage: run.currentStage } : {},
    ...run.targetAgentName ? { targetAgentName: run.targetAgentName } : {},
    ...run.updatedAt ? { updatedAt: run.updatedAt } : {},
    ...total > 0 ? { progress: { done, total }, stages } : {}
  };
}
function summarizeMeshPlan(entry) {
  if (entry.category && entry.category !== "plan") return void 0;
  const summary = entry.summary.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!summary) return void 0;
  return {
    id: entry.id,
    runId: entry.runId,
    summary,
    createdAt: entry.createdAt,
    ...entry.stageId ? { stageId: entry.stageId } : {},
    ...entry.severity ? { severity: entry.severity } : {}
  };
}
function readPlanMetadata(database) {
  try {
    const rows = database.prepare(`
      SELECT record FROM workflow_journal
      WHERE category = 'plan'
      ORDER BY rowid DESC
      LIMIT 16
    `).all();
    const plans = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.record);
        if (typeof parsed.id !== "string" || typeof parsed.runId !== "string" || typeof parsed.summary !== "string" || typeof parsed.createdAt !== "string") continue;
        const plan = summarizeMeshPlan({
          id: parsed.id,
          runId: parsed.runId,
          summary: parsed.summary,
          createdAt: parsed.createdAt,
          ...parsed.category ? { category: parsed.category } : {},
          ...parsed.stageId ? { stageId: parsed.stageId } : {},
          ...parsed.severity ? { severity: parsed.severity } : {}
        });
        if (plan) plans.push(plan);
      } catch {
      }
    }
    return plans;
  } catch {
    return [];
  }
}
function countRows(database, table, where = "") {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}${where}`).get();
  return Number(row?.count ?? 0);
}
function readOpenMessageMetadata(database) {
  const rows = database.prepare(`
    SELECT
      json_extract(record, '$.id') AS id,
      json_extract(record, '$.status') AS status,
      COALESCE(json_extract(record, '$.fromName'), json_extract(record, '$.from')) AS fromName,
      COALESCE(json_extract(record, '$.toName'), json_extract(record, '$.to')) AS toName,
      json_extract(record, '$.delivery') AS delivery,
      json_extract(record, '$.createdAt') AS createdAt,
      json_extract(record, '$.correlationId') AS correlationId
    FROM messages
    WHERE json_extract(record, '$.status') IN ('queued', 'delivered')
    ORDER BY json_extract(record, '$.createdAt') DESC
    LIMIT 16
  `).all();
  const messages = [];
  for (const row of rows) {
    if (typeof row.id !== "string" || row.status !== "queued" && row.status !== "delivered" || typeof row.fromName !== "string" || typeof row.toName !== "string" || row.delivery !== "steer" && row.delivery !== "followUp" && row.delivery !== "nextTurn" || typeof row.createdAt !== "string") continue;
    messages.push({
      id: row.id,
      status: row.status,
      fromName: row.fromName,
      toName: row.toName,
      delivery: row.delivery,
      createdAt: row.createdAt,
      ...typeof row.correlationId === "string" ? { correlationId: row.correlationId } : {}
    });
  }
  return messages;
}
function resolveKxmSnapshotPaths(cwd, env = process.env) {
  const stateDir = env.KXM_STATE_DIR?.trim() || join4(cwd, ".kxm", "state");
  const configured = env.KXM_DATA_PATH?.trim();
  const dataPath = configured ? resolve2(cwd, configured) : join4(stateDir, "kxm.db");
  return { dataPath, stateDir };
}
function resolveVnextStateRoot(stateDir, options) {
  if (options?.vnextStateRoot && existsSync2(options.vnextStateRoot)) {
    return resolve2(options.vnextStateRoot);
  }
  if (existsSync2(join4(stateDir, "runtime", "registry.db")) || existsSync2(join4(stateDir, "runtime", "projects"))) {
    return stateDir;
  }
  const env = options?.env ?? process.env;
  const explicit = env.KXM_STATE_HOME?.trim() || env.KXM_USER_STATE_DIR?.trim() || env.KXM_STATE_ROOT?.trim();
  if (explicit && isAbsolute(explicit) && existsSync2(resolve2(explicit))) {
    return resolve2(explicit);
  }
  let base;
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    base = localAppData && isAbsolute(localAppData) ? localAppData : join4(homedir2(), "AppData", "Local");
    base = resolve2(base, "KXM");
  } else if (process.platform === "darwin") {
    base = resolve2(homedir2(), "Library", "Application Support", "KXM");
  } else {
    const xdgState = env.XDG_STATE_HOME?.trim();
    base = xdgState && isAbsolute(xdgState) ? xdgState : join4(homedir2(), ".local", "state");
    base = resolve2(base, "kxm");
  }
  if (existsSync2(base)) return base;
  return void 0;
}
function loadLocalMeshSnapshot(dataPath, stateDir, options) {
  let hasLegacy = false;
  let agents = [];
  let openMessages = [];
  let openMessageTotal = 0;
  let legacyRuns = [];
  let legacyRunTotal = 0;
  let plans = [];
  if (existsSync2(dataPath)) {
    hasLegacy = true;
    const database = new DatabaseSync(dataPath, { readOnly: true });
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      agents = readJsonRows(database, "SELECT record FROM agents");
      openMessages = readOpenMessageMetadata(database);
      openMessageTotal = countRows(database, "messages", " WHERE json_extract(record, '$.status') IN ('queued', 'delivered')");
      legacyRuns = readJsonRows(database, "SELECT record FROM workflow_runs ORDER BY rowid DESC LIMIT 8");
      legacyRunTotal = countRows(database, "workflow_runs");
      plans = readPlanMetadata(database);
    } finally {
      database.close();
    }
  }
  let hasVnext = false;
  const vnextRuns = [];
  let vnextRunTotal = 0;
  const vnextStateRoot = resolveVnextStateRoot(stateDir, options);
  if (vnextStateRoot) {
    const runtimeDir = join4(vnextStateRoot, "runtime");
    const registryDbPath = join4(runtimeDir, "registry.db");
    const projectsDir = join4(runtimeDir, "projects");
    const projectKeys = /* @__PURE__ */ new Set();
    if (existsSync2(registryDbPath)) {
      hasVnext = true;
      try {
        const regDb = new DatabaseSync(registryDbPath, { readOnly: true });
        try {
          regDb.exec("PRAGMA busy_timeout = 5000");
          const pRows = regDb.prepare("SELECT project_key FROM projects").all();
          for (const row of pRows) {
            if (row.project_key) projectKeys.add(row.project_key);
          }
        } finally {
          regDb.close();
        }
      } catch {
      }
    }
    if (existsSync2(projectsDir)) {
      try {
        for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            projectKeys.add(entry.name);
          }
        }
      } catch {
      }
    }
    for (const key of projectKeys) {
      const eventDbPath = join4(projectsDir, key, "run-events.db");
      if (existsSync2(eventDbPath)) {
        hasVnext = true;
        try {
          const eventDb = new DatabaseSync(eventDbPath, { readOnly: true });
          try {
            eventDb.exec("PRAGMA busy_timeout = 5000");
            const runRows = eventDb.prepare(`
              SELECT run_id, project_id, workflow_id, status, created_at, updated_at
              FROM runs ORDER BY created_at DESC, run_id DESC LIMIT 8
            `).all();
            const countRow = eventDb.prepare("SELECT COUNT(*) AS total FROM runs").get();
            vnextRunTotal += Number(countRow?.total ?? runRows.length);
            for (const r of runRows) {
              vnextRuns.push({
                id: r.run_id,
                status: r.status,
                definitionId: r.workflow_id,
                project: r.project_id,
                updatedAt: r.updated_at || r.created_at
              });
            }
          } finally {
            eventDb.close();
          }
        } catch {
        }
      }
    }
  }
  const pids = [];
  if (existsSync2(stateDir)) {
    for (const file of readdirSync(stateDir).filter((name) => name.endsWith(".pid"))) {
      try {
        const record = JSON.parse(readFileSync4(join4(stateDir, file), "utf8"));
        pids.push({
          file,
          ...record.role ? { role: record.role } : {},
          ...record.pid !== void 0 ? { pid: record.pid } : {},
          live: Number.isInteger(record.pid) && record.pid > 0 && processExists(record.pid)
        });
      } catch {
        pids.push({ file, live: false });
      }
    }
  }
  const combinedRuns = [
    ...legacyRuns.map((run) => summarizeMeshRun(run)),
    ...vnextRuns
  ];
  const seenIds = /* @__PURE__ */ new Set();
  const uniqueRuns = [];
  for (const run of combinedRuns) {
    if (!seenIds.has(run.id)) {
      seenIds.add(run.id);
      uniqueRuns.push(run);
    }
  }
  uniqueRuns.sort((a, b) => {
    const at = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return bt - at;
  });
  const runs = uniqueRuns.slice(0, 16);
  const runTotal = legacyRunTotal + vnextRunTotal;
  let source;
  if (hasLegacy && hasVnext) {
    source = "both";
  } else if (hasVnext) {
    source = "vnext";
  } else {
    source = "legacy";
  }
  const telemetryFile = join4(stateDir, "telemetry.jsonl");
  const spend = existsSync2(telemetryFile) ? readRoutingRecords(telemetryFile) : [];
  return {
    source,
    agents: agents.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
    openMessages,
    openMessageTotal,
    runs,
    runTotal,
    plans,
    pids,
    spend
  };
}

// plugins/kxm/src/kxm-update.ts
import { existsSync as existsSync3, readFileSync as readFileSync5, writeFileSync as writeFileSync2, mkdirSync as mkdirSync3 } from "node:fs";
import { join as join5 } from "node:path";
var KXM_UPDATE_CACHE = "update-check.json";
var CACHE_TTL_MS = 6 * 60 * 60 * 1e3;
function readUpdateCache(stateDir, now = Date.now()) {
  const path = join5(stateDir, KXM_UPDATE_CACHE);
  if (!existsSync3(path)) return void 0;
  try {
    const row = JSON.parse(readFileSync5(path, "utf8"));
    if (typeof row.checkedAt !== "number" || !row.notice || now - row.checkedAt > CACHE_TTL_MS) return void 0;
    if (typeof row.notice.current !== "string" || typeof row.notice.available !== "boolean") return void 0;
    return row.notice;
  } catch {
    return void 0;
  }
}

// plugins/kxm/src/hub-binding.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync4, readFileSync as readFileSync6, renameSync as renameSync2, rmSync as rmSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { dirname as dirname3, isAbsolute as isAbsolute2, join as join6, resolve as resolve3 } from "node:path";
var HUB_BINDING_SCHEMA = "kxm.hub-binding.v1";
var HUB_HEALTH_PROBE_MS = 300;
var HubBindingError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "HubBindingError";
  }
};
function resolveUserStateRoot(env) {
  const explicit = env.KXM_STATE_HOME?.trim();
  if (explicit) {
    if (!isAbsolute2(explicit)) throw new HubBindingError("local_state_root_not_absolute");
    return resolve3(explicit);
  }
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    const base2 = localAppData && isAbsolute2(localAppData) ? localAppData : join6(homedir3(), "AppData", "Local");
    return resolve3(base2, "KXM");
  }
  if (process.platform === "darwin") return resolve3(homedir3(), "Library", "Application Support", "KXM");
  const xdgState = env.XDG_STATE_HOME?.trim();
  const base = xdgState && isAbsolute2(xdgState) ? xdgState : join6(homedir3(), ".local", "state");
  return resolve3(base, "kxm");
}
function hubBindingFile(env = process.env) {
  return join6(resolveUserStateRoot(env), "hub-binding.json");
}
function validateHubUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HubBindingError("hub_url_invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" || raw.includes("?") || raw.includes("#")) {
    throw new HubBindingError("hub_url_invalid");
  }
  return parsed.href.replace(/\/$/, "");
}
function isIsoTimestamp(value) {
  if (Number.isNaN(Date.parse(value))) return false;
  return value === new Date(value).toISOString();
}
function isAbortError2(error) {
  return Boolean(
    error && typeof error === "object" && ("name" in error && error.name === "AbortError" || "code" in error && error.code === "ABORT_ERR")
  );
}
function readHubBinding(env = process.env) {
  const file = hubBindingFile(env);
  if (!existsSync4(file)) return void 0;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync6(file, "utf8"));
  } catch {
    throw new HubBindingError(`malformed hub binding at ${file}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HubBindingError(`malformed hub binding at ${file}`);
  }
  const row = parsed;
  const keys = Object.keys(row);
  if (keys.length !== 3 || row.schema !== HUB_BINDING_SCHEMA || typeof row.url !== "string" || typeof row.boundAt !== "string" || !isIsoTimestamp(row.boundAt)) {
    throw new HubBindingError(`malformed hub binding at ${file}`);
  }
  let url;
  try {
    url = validateHubUrl(row.url);
  } catch {
    throw new HubBindingError(`malformed hub binding at ${file}`);
  }
  return { schema: HUB_BINDING_SCHEMA, url, boundAt: row.boundAt };
}
async function probeHubHealth(url, fetchImpl, timeoutMs = HUB_HEALTH_PROBE_MS) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${url}/health`, { signal: controller.signal });
    if (!response.ok) return { health: "unknown", probeMs: Date.now() - started };
    let body;
    try {
      body = await response.json();
    } catch {
      return { health: "unknown", probeMs: Date.now() - started };
    }
    if (body && typeof body === "object" && body.ok === true) {
      return { health: "on", probeMs: Date.now() - started };
    }
    return { health: "unknown", probeMs: Date.now() - started };
  } catch (error) {
    return { health: isAbortError2(error) ? "unknown" : "off", probeMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// plugins/kxm/src/session-work.ts
var SESSION_BRIEF_SKIP_LABEL = "Skip \u2014 start a fresh session";
var MAX_SESSION_BRIEF_TASKS = 5;
var MAX_SESSION_BRIEF_PLANS = 5;
var SESSION_BRIEF_SCHEMA = "kxm.session-brief.v1";
var DEFAULT_SESSION_BRIEF_STALE_SECONDS = 5;
function hubPrefix(hub) {
  if (hub?.state === "on" || hub?.state === void 0 && hub?.online === true) return "kxm hub:on";
  if (hub?.state === "off" || hub?.state === void 0 && hub?.online === false) return "kxm hub:off";
  if (hub?.state === "unknown") return "kxm hub:unknown";
  return "kxm";
}
function truncate(value, width) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}\u2026`;
}
function uniqueLabels(items) {
  const seen = /* @__PURE__ */ new Set();
  return items.map((item) => {
    let label = item.label;
    if (seen.has(label)) label = truncate(`${label} \xB7 ${item.id.slice(-6)}`, 72);
    seen.add(label);
    return label === item.label ? item : { ...item, label };
  });
}
function taskItem(run) {
  const stage = run.currentStage ?? "-";
  const progress = run.progress ? ` ${run.progress.done}/${run.progress.total}` : "";
  const detail = `${run.definitionId}/${stage}${progress}`.trim();
  const label = truncate(`Task  ${run.definitionId}  ${run.status}  ${stage}${progress}`, 72);
  const prompt = `Continue KXM task \`${run.definitionId}\` (run ${run.id}) at stage ${stage}${run.progress ? ` (${run.progress.done}/${run.progress.total})` : ""}. Load the run, then proceed without repeating completed work.`;
  return { kind: "task", id: run.id, runId: run.id, label, detail, prompt };
}
function planItem(plan) {
  const label = truncate(`Plan  ${plan.summary}`, 72);
  const prompt = `Continue from KXM plan: ${plan.summary} (run ${plan.runId}). Load that run and proceed.`;
  return { kind: "plan", id: plan.id, runId: plan.runId, label, detail: plan.summary, prompt };
}
function recentTasks(runs) {
  const active = runs.filter(
    (run) => run.status === "running" || run.status === "waiting" || run.status === "created" || run.status === "preparing"
  );
  const rest = runs.filter(
    (run) => run.status !== "running" && run.status !== "waiting" && run.status !== "created" && run.status !== "preparing"
  );
  return [...active, ...rest].slice(0, MAX_SESSION_BRIEF_TASKS);
}
function formatShipLine(ship) {
  if (!ship) return "ship verify \xB7 PR=CI";
  if (ship.dirty) return "ship dirty \xB7 commit after verify";
  if (ship.ahead > 0) return `ship ${ship.ahead} local \xB7 PR after CI`;
  return "ship clean \xB7 PR after CI";
}
function readGitShip(cwd) {
  try {
    const dirty = spawnSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8", windowsHide: true });
    if (dirty.status !== 0) return void 0;
    const isDirty = dirty.stdout.trim().length > 0;
    const upstream = spawnSync("git", ["-C", cwd, "rev-list", "--count", "@{u}..HEAD"], { encoding: "utf8", windowsHide: true });
    if (upstream.status === 0) {
      return {
        dirty: isDirty,
        ahead: Number.parseInt(upstream.stdout.trim(), 10) || 0
      };
    }
    for (const baseRef of ["origin/HEAD", "main", "origin/main", "master", "origin/master"]) {
      const mb = spawnSync("git", ["-C", cwd, "merge-base", baseRef, "HEAD"], { encoding: "utf8", windowsHide: true });
      if (mb.status === 0 && mb.stdout.trim()) {
        const count = spawnSync("git", ["-C", cwd, "rev-list", "--count", `${mb.stdout.trim()}..HEAD`], { encoding: "utf8", windowsHide: true });
        if (count.status === 0) {
          return {
            dirty: isDirty,
            ahead: Number.parseInt(count.stdout.trim(), 10) || 0
          };
        }
      }
    }
    return {
      dirty: isDirty,
      ahead: 0
    };
  } catch {
    return void 0;
  }
}
function formatSessionStatusLine(stats, current, hub, ship, updateLatest, cost) {
  const head = hubPrefix(hub);
  if (!current && stats.activeTasks === 0 && stats.planCount === 0 && stats.inbox === 0) {
    const idle = hub?.online === void 0 && hub?.state === void 0 ? "kxm idle" : `${head} \xB7 idle`;
    const withShip = ship?.dirty ? `${idle} \xB7 dirty` : ship && ship.ahead > 0 ? `${idle} \xB7 ${ship.ahead} local` : idle;
    const withCost = cost ? `${withShip} \xB7 ${cost}` : withShip;
    const finalLine = updateLatest ? `${withCost} \xB7 upd ${updateLatest}` : withCost;
    return finalLine.length <= 80 ? finalLine : `${finalLine.slice(0, 79)}\u2026`;
  }
  const parts = [];
  if (current?.kind === "task") parts.push(`${head} ${current.detail}`);
  else if (current?.kind === "plan") parts.push(`${head} plan ${truncate(current.detail, 36)}`);
  else parts.push(head);
  parts.push(`${stats.activeTasks} task${stats.activeTasks === 1 ? "" : "s"}`);
  if (stats.waitingTasks > 0) parts.push(`${stats.waitingTasks} waiting`);
  parts.push(`${stats.planCount} plan${stats.planCount === 1 ? "" : "s"}`);
  if (stats.inbox > 0) parts.push(`inbox ${stats.inbox}`);
  if (ship?.dirty) parts.push("dirty");
  else if (ship && ship.ahead > 0) parts.push(`${ship.ahead} local`);
  if (cost) parts.push(cost);
  if (updateLatest) parts.push(`upd ${updateLatest}`);
  const line = parts.join(" \xB7 ");
  return line.length <= 80 ? line : `${line.slice(0, 79)}\u2026`;
}
function formatSessionWidget(stats, current, hub, ship, updateLatest, cost) {
  const hubMark = hub?.state === "on" || hub?.online === true ? "hub:on  " : hub?.state === "off" || hub?.online === false ? "hub:off  " : hub?.state === "unknown" ? "hub:unknown  " : "";
  const lines = [
    `KXM  ${hubMark}${stats.activeTasks} tasks  ${stats.waitingTasks} waiting  ${stats.planCount} plans  inbox ${stats.inbox}`
  ];
  if (current) lines.push(`now  ${current.kind}  ${truncate(current.detail, 56)}`);
  else if (stats.latestPlan) lines.push(`plan ${truncate(stats.latestPlan, 60)}`);
  else lines.push("now  no selected work");
  lines.push(formatShipLine(ship));
  if (cost) lines.push(`cost  ${cost}`);
  if (updateLatest) lines.push(`update  ${updateLatest} available \xB7 kxm update --kxm`);
  return lines;
}
function buildSessionBrief(snapshot, current, hub, ship, updateLatest, cost, sessionToken, source, staleSeconds = DEFAULT_SESSION_BRIEF_STALE_SECONDS) {
  const resolvedSource = source ?? snapshot.source ?? "legacy";
  const active = snapshot.runs.filter(
    (run) => run.status === "running" || run.status === "waiting" || run.status === "created" || run.status === "preparing"
  );
  const stats = {
    activeTasks: active.length,
    waitingTasks: snapshot.runs.filter((run) => run.status === "waiting").length,
    planCount: snapshot.plans.length,
    inbox: snapshot.openMessageTotal,
    runTotal: snapshot.runTotal,
    ...snapshot.plans[0]?.summary ? { latestPlan: snapshot.plans[0].summary } : {}
  };
  const tasks = uniqueLabels(recentTasks(snapshot.runs).map(taskItem));
  const plans = uniqueLabels(snapshot.plans.slice(0, MAX_SESSION_BRIEF_PLANS).map(planItem));
  const resolvedHub = hub ?? { state: "off", evidence: "unconfigured", online: false };
  const statusLine = formatSessionStatusLine(stats, current, resolvedHub, ship, updateLatest, cost);
  const widgetLines = formatSessionWidget(stats, current, resolvedHub, ship, updateLatest, cost);
  return {
    schema: SESSION_BRIEF_SCHEMA,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    staleSeconds,
    source: resolvedSource,
    hub: resolvedHub,
    stats,
    tasks,
    plans,
    statusLine,
    widgetLines,
    ...cost ? { cost } : {},
    ...sessionToken ? { sessionToken } : {}
  };
}
function readCachedSessionBrief(stateDir) {
  const file = join7(stateDir, "session-brief.json");
  try {
    if (!existsSync5(file)) return void 0;
    const raw = readFileSync7(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.schema === "kxm.session-brief.v1" && typeof parsed.generatedAt === "string") {
      const ageMs = Date.now() - Date.parse(parsed.generatedAt);
      const ttlMs = (parsed.staleSeconds ?? DEFAULT_SESSION_BRIEF_STALE_SECONDS) * 1e3;
      if (ageMs >= 0 && ageMs < ttlMs) {
        return parsed;
      }
    }
  } catch {
  }
  return void 0;
}
function writeCachedSessionBrief(stateDir, brief) {
  try {
    mkdirSync5(stateDir, { recursive: true, mode: 448 });
    const file = join7(stateDir, "session-brief.json");
    const tmp = `${file}.tmp.${randomUUID().slice(0, 8)}`;
    writeFileSync4(tmp, JSON.stringify(brief, null, 2), { encoding: "utf8", mode: 384 });
    renameSync3(tmp, file);
  } catch {
  }
}
function estimateSessionCost(stateDir) {
  try {
    const telemetryFile = join7(stateDir, "telemetry.jsonl");
    if (!existsSync5(telemetryFile)) return void 0;
    const records = readRoutingRecords(telemetryFile);
    if (records.length === 0) return void 0;
    let totalCost = 0;
    let hasMetered = false;
    let latestModel;
    let latestHarness;
    for (const { routing } of records) {
      const r = routing;
      const costBasis = r.costBasis ?? (typeof r.costUsd === "number" ? "metered" : "unmetered");
      if (costBasis === "metered" && typeof r.costUsd === "number") {
        totalCost += r.costUsd;
        hasMetered = true;
      }
      latestModel = r.effectiveModel ?? r.requestedModel ?? latestModel;
      latestHarness = r.harness ?? latestHarness;
    }
    if (!hasMetered) return "unknown";
    const route = latestHarness && latestModel ? `${latestHarness}/${latestModel}` : latestModel;
    return `$${totalCost.toFixed(2)} sess${route ? ` \xB7 ${route}` : ""}`;
  } catch {
    return void 0;
  }
}
async function resolveSessionHubStatus(url, fetchImpl = fetch, timeoutMs = 300) {
  if (!url || !url.trim()) {
    return { state: "off", evidence: "unconfigured", online: false };
  }
  try {
    const { health } = await probeHubHealth(url.trim(), fetchImpl, timeoutMs);
    if (health === "on") {
      return { state: "on", evidence: "probed", online: true, url: url.trim() };
    }
    if (health === "off") {
      return { state: "off", evidence: "probed", online: false, url: url.trim() };
    }
    return { state: "unknown", evidence: "timeout", online: false, url: url.trim() };
  } catch {
    return { state: "unknown", evidence: "timeout", online: false, url: url.trim() };
  }
}
function loadSessionBrief(cwd, env = process.env, current, hub, options = {}) {
  const paths = resolveKxmSnapshotPaths(cwd, env);
  if (!options.force) {
    const cached = readCachedSessionBrief(paths.stateDir);
    if (cached) {
      if (current || hub || options.cost) {
        const effectiveHub = hub ?? cached.hub;
        const effectiveCost = options.cost ?? cached.cost;
        const statusLine = formatSessionStatusLine(
          cached.stats,
          current,
          effectiveHub,
          options.ship,
          options.updateLatest,
          effectiveCost
        );
        const widgetLines = formatSessionWidget(
          cached.stats,
          current,
          effectiveHub,
          options.ship,
          options.updateLatest,
          effectiveCost
        );
        return {
          ...cached,
          hub: effectiveHub,
          ...effectiveCost ? { cost: effectiveCost } : {},
          statusLine,
          widgetLines
        };
      }
      return cached;
    }
  }
  const ship = options.ship ?? readGitShip(cwd);
  let brief;
  try {
    const cachedUpdate = readUpdateCache(paths.stateDir);
    const updateLatest = options.updateLatest ?? (cachedUpdate?.available ? cachedUpdate.latest : void 0);
    const cost = options.cost ?? estimateSessionCost(paths.stateDir);
    const snapshot = loadLocalMeshSnapshot(paths.dataPath, paths.stateDir, { env });
    brief = buildSessionBrief(
      snapshot,
      current,
      hub,
      ship,
      updateLatest,
      cost,
      options.sessionToken,
      snapshot.source
    );
  } catch {
    brief = buildSessionBrief(
      { runs: [], plans: [], openMessageTotal: 0, runTotal: 0 },
      current,
      hub,
      ship,
      options.updateLatest,
      options.cost,
      options.sessionToken
    );
  }
  writeCachedSessionBrief(paths.stateDir, brief);
  return brief;
}
async function loadSessionBriefAsync(cwd, env = process.env, current, hub, options = {}) {
  const paths = resolveKxmSnapshotPaths(cwd, env);
  if (!options.force) {
    const cached = readCachedSessionBrief(paths.stateDir);
    if (cached) {
      if (current || hub || options.cost) {
        const effectiveHub = hub ?? cached.hub;
        const effectiveCost = options.cost ?? cached.cost;
        const statusLine = formatSessionStatusLine(
          cached.stats,
          current,
          effectiveHub,
          options.ship,
          void 0,
          effectiveCost
        );
        const widgetLines = formatSessionWidget(
          cached.stats,
          current,
          effectiveHub,
          options.ship,
          void 0,
          effectiveCost
        );
        return {
          ...cached,
          hub: effectiveHub,
          ...effectiveCost ? { cost: effectiveCost } : {},
          statusLine,
          widgetLines
        };
      }
      return cached;
    }
  }
  let resolvedHub = hub;
  if (!resolvedHub) {
    const serverUrl = env.KXM_SERVER_URL?.trim() || readHubBinding(env)?.url;
    resolvedHub = await resolveSessionHubStatus(serverUrl, options.fetchImpl, 300);
  }
  return loadSessionBrief(cwd, env, current, resolvedHub, options);
}
function sessionBriefChoices(brief) {
  return [SESSION_BRIEF_SKIP_LABEL, ...brief.tasks.map((item) => item.label), ...brief.plans.map((item) => item.label)];
}
function itemFromChoice(brief, choice) {
  if (!choice || choice === SESSION_BRIEF_SKIP_LABEL) return void 0;
  return [...brief.tasks, ...brief.plans].find((item) => item.label === choice);
}
function sessionBriefPickerEnabled(input) {
  if (input.env?.KXM_SESSION_BRIEF?.trim() === "off") return false;
  if (input.mode !== "tui") return false;
  const reason = input.reason ?? "startup";
  return reason === "startup" || reason === "new" || reason === "fork";
}
var KXM_SLASH_SUBCOMMANDS = ["status", "hub", "memory", "progress", "workflow", "help"];
function parseKxmSlashArgs(args) {
  const raw = String(args ?? "").trim().toLowerCase();
  if (raw === "" || raw === "brief") return "brief";
  if (raw === "status" || raw === "hub" || raw === "memory" || raw === "progress" || raw === "workflow" || raw === "help") return raw;
  return "help";
}
function kxmSlashCompletions(prefix) {
  const p = prefix.trim().toLowerCase();
  return KXM_SLASH_SUBCOMMANDS.filter((name) => name.startsWith(p)).map((name) => ({ value: name, label: name }));
}

// plugins/kxm/src/workflow-tui.ts
import { existsSync as existsSync6, readFileSync as readFileSync8 } from "node:fs";
import { join as join9 } from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// plugins/kxm/src/config.ts
var import_yaml = __toESM(require_dist(), 1);
import { dirname as dirname4, join as join8, resolve as resolve4 } from "node:path";
function repoConfigDirectory(repoRoot) {
  return resolve4(repoRoot, ".kxm");
}

// plugins/kxm/src/workflow-tui.ts
function loadActiveWorkflowProgress(repoRoot = process.cwd(), targetRunId) {
  const dbPath = join9(repoConfigDirectory(repoRoot), "state", "kxm.db");
  if (!existsSync6(dbPath)) return void 0;
  let db;
  try {
    db = new DatabaseSync2(dbPath, { readOnly: true });
    let row;
    if (targetRunId) {
      row = db.prepare("SELECT record FROM workflow_runs WHERE id = ?").get(targetRunId);
    } else {
      row = db.prepare(
        "SELECT record FROM workflow_runs ORDER BY CASE json_extract(record, '$.status') WHEN 'running' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END, json_extract(record, '$.updatedAt') DESC LIMIT 1"
      ).get();
    }
    if (!row) return void 0;
    const raw = JSON.parse(row.record);
    const runId = raw.id || targetRunId;
    const workflowId = raw.definitionId || raw.workflowId || "workflow";
    const status = raw.status || "running";
    const currentStage = raw.currentStage || void 0;
    const updatedAt = raw.updatedAt || void 0;
    const stages = [];
    const rawStages = Array.isArray(raw.stages) ? raw.stages : [];
    for (const s of rawStages) {
      if (s && typeof s === "object") {
        stages.push({
          id: String(s.id || ""),
          label: s.label,
          kind: s.kind,
          status: s.status || "pending",
          role: s.role,
          attempts: typeof s.attempts === "number" ? s.attempts : void 0
        });
      }
    }
    let metrics;
    try {
      const logsDir = join9(repoConfigDirectory(repoRoot), "logs");
      const telemFile = telemetryPath(logsDir);
      if (existsSync6(telemFile)) {
        const records = readRoutingRecords(telemFile);
        let matching = records.filter((r) => r.routing.runId === runId);
        if (matching.length === 0) {
          const rawLines = readFileSync8(telemFile, "utf8").split(/\r?\n/);
          for (const line of rawLines) {
            if (!line.trim()) continue;
            try {
              const p = JSON.parse(line);
              const rt = p.routing || p;
              if (rt && (rt.runId === runId || p.runId === runId)) {
                matching.push({ recordedAt: p.timestamp || (/* @__PURE__ */ new Date()).toISOString(), routing: rt });
              }
            } catch {
            }
          }
        }
        if (matching.length > 0) {
          const latest = matching[matching.length - 1].routing;
          let totalSpend = 0;
          let totalIn = 0;
          let totalOut = 0;
          let totalCache = 0;
          let totalLatency = 0;
          for (const m of matching) {
            const rt = m.routing;
            if (typeof rt.costUsd === "number") totalSpend += rt.costUsd;
            if (rt.tokens) {
              totalIn += rt.tokens.input ?? 0;
              totalOut += rt.tokens.output ?? 0;
              totalCache += rt.tokens.cacheRead ?? 0;
            }
            if (typeof rt.latencyMs === "number") totalLatency += rt.latencyMs;
          }
          metrics = {
            totalSpendUsd: totalSpend,
            inputTokens: totalIn,
            outputTokens: totalOut,
            cacheReadTokens: totalCache,
            latencyMs: totalLatency,
            harness: latest.harness,
            model: latest.model,
            effort: latest.thinking
          };
        }
      }
    } catch {
    }
    const activeStageObj = stages.find((s) => s.id === currentStage);
    const currentRole = activeStageObj?.role || raw.targetAgentName || void 0;
    const attempt = activeStageObj?.attempts || 1;
    return {
      runId,
      workflowId,
      status,
      currentStage,
      currentRole,
      attempt,
      stages,
      metrics,
      updatedAt
    };
  } catch {
    return void 0;
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}
function formatStageStepper(stages, currentStage) {
  if (stages.length === 0) {
    return currentStage ? `[\u25B6 ${currentStage}]` : "[idle]";
  }
  const parts = stages.map((s) => {
    let icon = "\u25CB";
    if (s.status === "passed" || s.status === "completed") icon = "\u2714";
    else if (s.id === currentStage || s.status === "running") icon = "\u25B6";
    else if (s.status === "waiting") icon = "\u29D7";
    else if (s.status === "failed") icon = "\u2716";
    else if (s.status === "cancelled") icon = "\u2298";
    return `[${icon} ${s.id}]`;
  });
  return parts.join(" \u2500\u2500> ");
}
function formatTokenK(tokens) {
  if (tokens === void 0 || tokens === null) return "0";
  if (tokens >= 1e3) {
    return `${(tokens / 1e3).toFixed(1)}k`;
  }
  return String(tokens);
}
function renderWorkflowWidgetLines(state) {
  if (!state || !state.runId) {
    return [
      "\u250C\u2500 KXM Workflow \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510",
      "\u2502 No active workflow running. Use 'kxm workflow start <id>'                   \u2502",
      "\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518"
    ];
  }
  const shortRun = state.runId ? state.runId.slice(0, 16) : "-";
  const header = `\u250C\u2500 KXM Workflow: ${state.workflowId} (${shortRun}) \u2500`;
  const topBorder = header + "\u2500".repeat(Math.max(2, 79 - header.length)) + "\u2510";
  const stepper = formatStageStepper(state.stages, state.currentStage);
  const statusStr = state.status.toUpperCase();
  const attemptStr = state.attempt ? ` (Attempt ${state.attempt})` : "";
  const roleStr = state.currentRole ? ` \xB7 Role: ${state.currentRole}` : "";
  const lines = [topBorder];
  lines.push(`\u2502 Stage: ${stepper}`);
  lines.push(`\u2502 Status: ${statusStr}${attemptStr}${roleStr}`);
  if (state.metrics) {
    const costStr = state.metrics.totalSpendUsd !== void 0 ? `$${state.metrics.totalSpendUsd.toFixed(2)}` : "unmetered";
    const routeStr = state.metrics.model ? `${state.metrics.harness ?? "pi"}:${state.metrics.model}` : "harness";
    const effortStr = state.metrics.effort ? ` (${state.metrics.effort})` : "";
    const inTokens = formatTokenK(state.metrics.inputTokens);
    const outTokens = formatTokenK(state.metrics.outputTokens);
    const cacheTokens = formatTokenK(state.metrics.cacheReadTokens);
    lines.push(`\u2502 Model: ${routeStr}${effortStr} \xB7 Spend: ${costStr}`);
    lines.push(`\u2502 Tokens: In: ${inTokens} | Out: ${outTokens} | Cache: ${cacheTokens}`);
  }
  lines.push("\u2514" + "\u2500".repeat(78) + "\u2518");
  return lines;
}
function renderWorkflowTuiText(state) {
  return renderWorkflowWidgetLines(state).join("\n");
}

// plugins/kxm/src/extension.ts
var SETTLEMENT_RETRY_BASE_MS = 250;
var SETTLEMENT_RETRY_MAX_MS = 3e4;
function boundedPeerReply(reply) {
  if (reply.length <= MAX_CONTENT_CHARS) return reply;
  const suffix = `

[kxm: response truncated from ${reply.length} characters to fit the message limit; the full output may remain in the replying agent's local session or worker log]`;
  return reply.slice(0, MAX_CONTENT_CHARS - suffix.length) + suffix;
}
function isTerminalMessage2(message) {
  return message.status === "replied" || message.status === "cancelled" || message.status === "expired" || message.status === "error";
}
function isTerminalMessageError2(error) {
  return error instanceof HubHttpError && (error.statusCode === 409 || error.statusCode === 404 && error.code === "message_not_found");
}
var WORKFLOW_RUN_ID = /^run_[a-f0-9]{32}$/;
var PI_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function workflowRunIdForMessage(message) {
  if (message.workflowRunId !== void 0) {
    if (!WORKFLOW_RUN_ID.test(message.workflowRunId)) return void 0;
    if (message.workflowContext?.runId && message.workflowContext.runId !== message.workflowRunId) return void 0;
    return message.workflowRunId;
  }
  if (message.workflowContext?.runId && WORKFLOW_RUN_ID.test(message.workflowContext.runId)) {
    return message.workflowContext.runId;
  }
  if (message.correlationId && WORKFLOW_RUN_ID.test(message.correlationId) && message.from === `workflow:${message.correlationId}`) return message.correlationId;
  return void 0;
}
function bindingForMessage(message) {
  const runId = workflowRunIdForMessage(message);
  if (message.workflowRunId !== void 0 && !runId) {
    throw new Error("hub workflow affinity is malformed or conflicts with workflow context");
  }
  if (message.workflowContext?.runId && !WORKFLOW_RUN_ID.test(message.workflowContext.runId)) {
    throw new Error("hub workflow context contains a malformed run identity");
  }
  return runId ? { kind: "workflow", runId } : { kind: "default" };
}
function bindingFromEnvironment() {
  if (process.env.KXM_WORKER_SESSION_ISOLATION !== "workflow") return { kind: "default" };
  const scope = process.env.KXM_WORKER_SESSION_SCOPE?.trim();
  if (scope === "default") return { kind: "default" };
  if (scope?.startsWith("workflow:")) {
    const runId = scope.slice("workflow:".length);
    if (WORKFLOW_RUN_ID.test(runId)) return { kind: "workflow", runId };
  }
  throw new Error("KXM_WORKER_SESSION_SCOPE must be default or workflow:<canonical-run-id>");
}
function sameBinding(left, right) {
  return left.kind === right.kind && (left.kind === "default" || right.kind === "workflow" && left.runId === right.runId);
}
function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: value
  };
}
function latestAssistantMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return messages[index];
  }
  return void 0;
}
function assistantText(messages) {
  const message = latestAssistantMessage(messages);
  if (!message) return void 0;
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return void 0;
  const text = message.content.map((item) => {
    const part = item;
    return part.type === "text" ? part.text ?? "" : "";
  }).join("").trim();
  return text || void 0;
}
function assistantFailure(messages) {
  const message = latestAssistantMessage(messages);
  if (!message || message.stopReason !== "error" && message.stopReason !== "aborted") return void 0;
  if (message.stopReason === "aborted") {
    return classifyFailure({
      toolName: "provider",
      message: "cancelled"
    });
  }
  const failureMessage = typeof message.errorMessage === "string" ? message.errorMessage : "provider error";
  const quota = /\b(quota reached|quota exceeded|rate limit(?:ed)?|too many requests|resource exhausted|http 429)\b/i.test(failureMessage);
  return classifyFailure({
    toolName: "provider",
    code: quota ? "provider_quota" : "provider_error",
    message: failureMessage
  });
}
function piMeshExtension(pi) {
  let client;
  let nousReport;
  let pending = [];
  let activatingInbound;
  let awaitingActivation;
  let activeInbound;
  let activationInProgress = false;
  let activationPromise;
  let activationRetryTimer;
  let activationRetryAttempt = 0;
  let activationStartTimer;
  let activationStartMessageId;
  let requestWorkerRestart;
  let activeReply;
  let settlementReply;
  let activeTurnSettled = false;
  let settlementInProgress = false;
  let settlementRetryAttempt = 0;
  let settlementRetryTimer;
  let activeFailure;
  let activeFailureRecorded = false;
  let shuttingDown = false;
  let notify;
  let stateDir = process.env.KXM_STATE_DIR ?? "";
  let agentName = process.env.KXM_AGENT_NAME ?? "";
  let projectName = process.env.KXM_PROJECT ?? "";
  let recoveryStageId;
  let recoveryArtifacts = [];
  let currentPiSessionId;
  let currentSessionBinding = { kind: "default" };
  function recoveryContextPath() {
    if (!stateDir || !agentName || !projectName) return void 0;
    return join10(stateDir, `worker-context-${workerStateKey(projectName, agentName)}.json`);
  }
  function sessionRouteRequestPath() {
    const workerKey = process.env.KXM_WORKER_IDENTITY_KEY?.trim();
    if (!stateDir || !workerKey) return void 0;
    return join10(stateDir, `worker-session-request-${workerKey}.json`);
  }
  function requestSessionRoute(message, target) {
    if (process.env.KXM_WORKER_SESSION_ISOLATION !== "workflow" || sameBinding(currentSessionBinding, target)) {
      return false;
    }
    const path = sessionRouteRequestPath();
    const workerKey = process.env.KXM_WORKER_IDENTITY_KEY?.trim();
    const generation = process.env.KXM_WORKER_GENERATION?.trim();
    const childIncarnation = Number(process.env.KXM_WORKER_CHILD_INCARCATION);
    if (!path || !workerKey || !generation || !Number.isInteger(childIncarnation) || childIncarnation < 1 || !currentPiSessionId || !PI_SESSION_ID.test(currentPiSessionId)) {
      throw new Error("supervised workflow session routing is missing a valid worker generation, child incarnation, or Pi session identity");
    }
    const request = {
      version: 1,
      agentName,
      project: projectName,
      workerKey,
      generation,
      childIncarnation,
      from: currentSessionBinding,
      to: target,
      sourceSessionId: currentPiSessionId,
      messageId: message.id,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    mkdirSync6(dirname5(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync5(tmp, `${JSON.stringify(request)}
`, { encoding: "utf8", mode: 384 });
    renameSync4(tmp, path);
    return true;
  }
  function removeMatchingLegacyRecoveryContext() {
    if (!stateDir || !agentName || !projectName) return;
    const legacy = join10(stateDir, `worker-context-${agentName.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
    if (legacy === recoveryContextPath()) return;
    try {
      const candidate = JSON.parse(readFileSync9(legacy, "utf8"));
      if (candidate.version === 1 && candidate.agentName === agentName && candidate.project === projectName) {
        rmSync3(legacy, { force: true });
      }
    } catch {
    }
  }
  function persistRecoveryContext() {
    const path = recoveryContextPath();
    if (!path) return;
    const recoveryMessage = [activeInbound, awaitingActivation, activatingInbound].find((message) => message && workflowRunIdForMessage(message));
    const runId = recoveryMessage ? workflowRunIdForMessage(recoveryMessage) : void 0;
    const activeMessageIds = [activeInbound?.id, awaitingActivation?.id, activatingInbound?.id].filter((id) => Boolean(id)).slice(0, 3);
    const pendingMessageIds = [...activeMessageIds, ...pending.map((message) => message.id)].filter((id, index, values) => Boolean(id) && values.indexOf(id) === index).slice(0, 16);
    if (!runId && pendingMessageIds.length === 0) {
      rmSync3(path, { force: true });
      removeMatchingLegacyRecoveryContext();
      return;
    }
    mkdirSync6(dirname5(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync5(tmp, `${JSON.stringify({ version: 1, agentName, project: projectName, runId: runId ?? null, stageId: recoveryStageId ?? null, activeMessageIds, pendingMessageIds, artifactPointers: recoveryArtifacts.slice(0, 16), updatedAt: (/* @__PURE__ */ new Date()).toISOString() })}
`, { encoding: "utf8", mode: 384 });
    renameSync4(tmp, path);
    removeMatchingLegacyRecoveryContext();
  }
  async function workflowCall(operation) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof HubHttpError)) throw error;
      const assigned = typeof error.extras?.assignedCoordinatorName === "string" ? ` assignedCoordinator=${error.extras.assignedCoordinatorName}` : "";
      const nextAction = typeof error.extras?.nextAction === "string" ? ` nextAction=${error.extras.nextAction}` : "";
      const operationName = typeof error.extras?.operation === "string" ? ` operation=${error.extras.operation}` : "";
      throw new Error(`${error.message} [code=${error.code ?? "http_error"}${operationName}${assigned}${nextAction}]`);
    }
  }
  function requireClient() {
    if (!client?.agent) throw new Error("kxm hub is not connected; check KXM_SERVER_URL and /kxm hub");
    return client;
  }
  let currentWork;
  async function applySessionChrome(ctx, event, offerPicker) {
    const cwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
    const hub = client?.agent ? { state: "on", evidence: "process", online: true } : void 0;
    const brief = await loadSessionBriefAsync(cwd, process.env, currentWork, hub);
    ctx.ui.setStatus?.("kxm", brief.statusLine);
    ctx.ui.setWidget?.("kxm-work", brief.widgetLines);
    const progress = loadActiveWorkflowProgress(cwd);
    if (progress) {
      ctx.ui.setWidget?.("kxm-progress", renderWorkflowWidgetLines(progress));
    }
    if (!offerPicker || !sessionBriefPickerEnabled({
      env: process.env,
      ...ctx.mode ? { mode: ctx.mode } : {},
      ...event.reason ? { reason: event.reason } : {}
    })) return;
    if (brief.tasks.length === 0 && brief.plans.length === 0) return;
    if (typeof ctx.ui.select !== "function") return;
    const choice = await ctx.ui.select("Continue KXM work?", sessionBriefChoices(brief));
    const item = itemFromChoice(brief, choice);
    if (!item) return;
    currentWork = item;
    const selected = await loadSessionBriefAsync(cwd, process.env, item, hub);
    ctx.ui.setStatus?.("kxm", selected.statusLine);
    ctx.ui.setWidget?.("kxm-work", selected.widgetLines);
    ctx.ui.setEditorText?.(item.prompt);
  }
  async function showKxmHub(ctx) {
    const url = (process.env.KXM_SERVER_URL ?? "http://127.0.0.1:7331").replace(/\/$/, "");
    let health = "unreachable";
    try {
      const response = await fetch(`${url}/health`);
      health = response.ok ? "ok" : `http_${response.status}`;
    } catch {
      health = "unreachable";
    }
    if (!client?.agent) {
      ctx.ui.notify(`kxm hub view: health=${health}; no agent connected`, "warning");
      return;
    }
    const peers = await client.listAgents();
    ctx.ui.notify(`kxm hub view: health=${health}; ${client.agent.name}; ${peers.length} online agent(s)`, "info");
  }
  function clearActivationWatchdog(messageId) {
    if (messageId && activationStartMessageId !== messageId) return;
    if (activationStartTimer) clearTimeout(activationStartTimer);
    activationStartTimer = void 0;
    activationStartMessageId = void 0;
  }
  function startActivationWatchdog(messageId) {
    clearActivationWatchdog();
    if (!process.env.KXM_WORKER_IDENTITY_KEY) return;
    const configured = Number(process.env.KXM_WORKER_ACTIVATION_TIMEOUT_MS?.trim() || 6e4);
    const timeoutMs = Number.isInteger(configured) && configured >= 1e3 && configured <= 6e5 ? configured : 6e4;
    activationStartMessageId = messageId;
    activationStartTimer = setTimeout(() => {
      activationStartTimer = void 0;
      if (shuttingDown || activeInbound || awaitingActivation?.id !== messageId) return;
      notify?.(
        `kxm worker is stuck: delivered message ${messageId} did not start a model turn within ${timeoutMs}ms; requesting supervised restart`,
        "error"
      );
      persistRecoveryContext();
      requestWorkerRestart?.();
    }, timeoutMs);
    activationStartTimer.unref?.();
  }
  function enqueue(message, front = false) {
    if (front) {
      pending.unshift(message);
      return;
    }
    const priority = (delivery) => delivery === "steer" ? 0 : delivery === "followUp" ? 1 : 2;
    const messagePriority = priority(message.delivery);
    const firstLowerPriority = pending.findIndex((candidate) => priority(candidate.delivery) > messagePriority);
    if (firstLowerPriority < 0) pending.push(message);
    else pending.splice(firstLowerPriority, 0, message);
  }
  function requestActivation() {
    if (activationPromise || shuttingDown) return;
    const task = activateNext();
    activationPromise = task;
    void task.finally(() => {
      if (activationPromise === task) activationPromise = void 0;
      if (!shuttingDown && !activationRetryTimer && !activatingInbound && !awaitingActivation && !activeInbound && pending.length > 0) requestActivation();
    });
  }
  function scheduleActivationRetry(error) {
    if (shuttingDown || activationRetryTimer) return;
    const delayMs = Math.min(
      SETTLEMENT_RETRY_BASE_MS * 2 ** Math.min(activationRetryAttempt, 7),
      SETTLEMENT_RETRY_MAX_MS
    );
    activationRetryAttempt += 1;
    notify?.(
      `kxm could not activate the next hub message; it remains durable and activation will retry in ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}`,
      "error"
    );
    activationRetryTimer = setTimeout(() => {
      activationRetryTimer = void 0;
      requestActivation();
    }, delayMs);
    activationRetryTimer.unref?.();
  }
  async function activateNext() {
    if (shuttingDown || !client || activationInProgress || activationRetryTimer || activatingInbound || awaitingActivation || activeInbound) return;
    activationInProgress = true;
    try {
      let message = pending.shift();
      while (message && (isTerminalMessage2(message) || Date.parse(message.expiresAt) <= Date.now())) {
        message = pending.shift();
      }
      if (!message) {
        persistRecoveryContext();
        return;
      }
      try {
        const targetBinding = bindingForMessage(message);
        if (requestSessionRoute(message, targetBinding)) {
          enqueue(message, true);
          persistRecoveryContext();
          shuttingDown = true;
          queueMicrotask(() => requestWorkerRestart?.());
          return;
        }
      } catch (error) {
        enqueue(message, true);
        persistRecoveryContext();
        scheduleActivationRetry(error);
        return;
      }
      activatingInbound = message;
      persistRecoveryContext();
      let acknowledged;
      try {
        acknowledged = await client.acknowledge(message.id);
      } catch (error) {
        if (isTerminalMessageError2(error)) {
          activatingInbound = void 0;
          activationRetryAttempt = 0;
          persistRecoveryContext();
          return;
        }
        if (activatingInbound?.id === message.id) {
          activatingInbound = void 0;
          enqueue(message, true);
          persistRecoveryContext();
        }
        scheduleActivationRetry(error);
        return;
      }
      if (activatingInbound?.id !== message.id || shuttingDown) return;
      activationRetryAttempt = 0;
      activatingInbound = void 0;
      awaitingActivation = acknowledged;
      persistRecoveryContext();
      startActivationWatchdog(acknowledged.id);
      try {
        pi.sendMessage({
          customType: "kxm-inbound",
          content: [
            `Peer request from ${acknowledged.fromName} (message ${acknowledged.id}):`,
            "",
            acknowledged.content,
            "",
            "Respond directly to the peer request. Your settled final response will be returned automatically."
          ].join("\n"),
          display: true,
          details: { messageId: acknowledged.id, from: acknowledged.fromName }
        }, {
          // Pi's nextTurn mode deliberately waits for a future human prompt. An
          // autonomous worker has no such prompt, so its durable next item is
          // normalized to an immediately-triggered follow-up turn.
          triggerTurn: true,
          deliverAs: acknowledged.delivery === "nextTurn" ? "followUp" : acknowledged.delivery
        });
      } catch (error) {
        clearActivationWatchdog(acknowledged.id);
        awaitingActivation = void 0;
        enqueue(acknowledged, true);
        persistRecoveryContext();
        scheduleActivationRetry(error);
      }
    } finally {
      activationInProgress = false;
    }
  }
  async function receive(event) {
    if (shuttingDown) return;
    if (event.type === "message") {
      if (activeInbound?.id === event.message.id || awaitingActivation?.id === event.message.id || activatingInbound?.id === event.message.id) return;
      if (pending.some((message) => message.id === event.message.id)) {
        requestActivation();
        return;
      }
      if (isTerminalMessage2(event.message) || Date.parse(event.message.expiresAt) <= Date.now()) return;
      if (shuttingDown) return;
      enqueue(event.message);
      persistRecoveryContext();
      requestActivation();
      return;
    }
    if (event.type !== "cancelled" && event.type !== "expired" && event.type !== "reply") return;
    const messageId = event.message.id;
    const pendingLength = pending.length;
    pending = pending.filter((message) => message.id !== messageId);
    let changed = pending.length !== pendingLength;
    if (activatingInbound?.id === messageId) {
      activatingInbound = void 0;
      changed = true;
    }
    if (awaitingActivation?.id === messageId) {
      clearActivationWatchdog(messageId);
      awaitingActivation = void 0;
      changed = true;
    }
    if (activeInbound?.id === messageId) {
      activeInbound = event.message;
      changed = true;
    }
    if (!changed) return;
    persistRecoveryContext();
    if (activeInbound?.id === messageId && activeTurnSettled && !settlementInProgress) {
      finishActiveInbound(messageId);
      return;
    }
    requestActivation();
  }
  function finishActiveInbound(messageId) {
    if (activeInbound?.id !== messageId) return;
    if (settlementRetryTimer) clearTimeout(settlementRetryTimer);
    settlementRetryTimer = void 0;
    settlementRetryAttempt = 0;
    clearActivationWatchdog(messageId);
    activeInbound = void 0;
    activeReply = void 0;
    settlementReply = void 0;
    activeTurnSettled = false;
    activeFailure = void 0;
    activeFailureRecorded = false;
    recoveryStageId = void 0;
    recoveryArtifacts = [];
    persistRecoveryContext();
    if (!shuttingDown) requestActivation();
  }
  function scheduleSettlementRetry(messageId, error) {
    if (shuttingDown || !client || activeInbound?.id !== messageId || settlementRetryTimer) return;
    const delayMs = Math.min(
      SETTLEMENT_RETRY_BASE_MS * 2 ** Math.min(settlementRetryAttempt, 7),
      SETTLEMENT_RETRY_MAX_MS
    );
    settlementRetryAttempt += 1;
    persistRecoveryContext();
    notify?.(
      `kxm could not return reply for ${messageId}; recovery state was retained and settlement will retry in ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}`,
      "error"
    );
    settlementRetryTimer = setTimeout(() => {
      settlementRetryTimer = void 0;
      void settleActiveInbound(messageId);
    }, delayMs);
    settlementRetryTimer.unref?.();
  }
  async function settleActiveInbound(messageId) {
    if (!activeInbound || activeInbound.id !== messageId || !client || settlementInProgress) return;
    settlementInProgress = true;
    const message = activeInbound;
    const activeClient = client;
    const reply = settlementReply ?? boundedPeerReply(activeReply ?? "The peer agent completed without a textual response.");
    try {
      let current;
      try {
        current = await activeClient.getMessage(message.id);
      } catch (error) {
        if (isTerminalMessageError2(error)) {
          finishActiveInbound(message.id);
          return;
        }
        throw error;
      }
      if (isTerminalMessage2(current)) {
        finishActiveInbound(message.id);
        return;
      }
      await activeClient.reply(message.id, reply);
      finishActiveInbound(message.id);
    } catch (error) {
      if (isTerminalMessageError2(error)) {
        finishActiveInbound(message.id);
        return;
      }
      scheduleSettlementRetry(message.id, error);
    } finally {
      settlementInProgress = false;
    }
  }
  pi.on("session_start", async (event, ctx) => {
    shuttingDown = false;
    if (nousReport?.guidance.length) {
      for (const item of nousReport.guidance) {
        ctx.ui.notify(item.message, item.level);
      }
    }
    await client?.stop();
    client = void 0;
    try {
      currentSessionBinding = bindingFromEnvironment();
    } catch (error) {
      await applySessionChrome(ctx, event, false);
      ctx.ui.notify(`kxm session routing configuration failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      void ctx.shutdown();
      return;
    }
    currentPiSessionId = ctx.sessionManager?.getSessionId();
    const serverUrl = process.env.KXM_SERVER_URL ?? "http://127.0.0.1:7331";
    const project = process.env.KXM_PROJECT ?? basename(ctx.cwd);
    const name = process.env.KXM_AGENT_NAME ?? pi.getSessionName() ?? `pi-${process.pid}`;
    agentName = name;
    projectName = project;
    stateDir = process.env.KXM_STATE_DIR ?? stateDir;
    removeMatchingLegacyRecoveryContext();
    const purpose = process.env.KXM_AGENT_PURPOSE ?? "General-purpose coding agent";
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : void 0;
    client = new HubClient({
      serverUrl,
      name,
      purpose,
      project,
      ...process.env.KXM_AUTH_TOKEN ? { authToken: process.env.KXM_AUTH_TOKEN } : {},
      ...model ? { model } : {}
    });
    notify = (message, type) => ctx.ui.notify(message, type);
    requestWorkerRestart = () => {
      void ctx.shutdown();
    };
    try {
      const agent = await client.start(receive);
      ctx.ui.notify(`Connected to the KXM hub as ${agent.name}`, "info");
      const recovered = stateDir ? await consumeWorkerRecoveryEnvelope(client, stateDir, agent.name, project) : void 0;
      const recoveryReplayIds = recovered?.activeMessageIds ?? recovered?.pendingMessageIds ?? [];
      const replayCandidates = await Promise.all(recoveryReplayIds.slice(0, 16).map(async (messageId) => {
        try {
          const message = await client.getMessage(messageId);
          return message.status === "queued" || message.status === "delivered";
        } catch {
          return false;
        }
      }));
      const durableInboundWillReplay = replayCandidates.some(Boolean);
      const recoveryMatchesSession = process.env.KXM_WORKER_SESSION_ISOLATION !== "workflow" || currentSessionBinding.kind === "workflow" && recovered?.runId === currentSessionBinding.runId;
      if (recovered?.freshSession && recovered.runId && !recovered.peerLocal && recoveryMatchesSession && !durableInboundWillReplay) {
        pi.sendMessage({ customType: "kxm-recovery", content: [`Resume durable workflow run ${recovered.runId} after a fresh-session worker recovery.`, recovered.stageId ? `Last recorded stage: ${recovered.stageId}.` : "Resolve the current stage from kxm_workflow_get.", `Recovery reason: ${recovered.reason}.`, "Call kxm_workflow_get, inspect its journal and stage evidence, then continue the current stage without repeating completed work.", "Record the recovery decision and checkpoint only after the required evidence is satisfied."].join("\n"), display: true, details: { runId: recovered.runId, stageId: recovered.stageId, reason: recovered.reason } }, { triggerTurn: true, deliverAs: "followUp" });
        await applySessionChrome(ctx, event, false);
        return;
      }
    } catch (error) {
      client = void 0;
      ctx.ui.notify(`kxm connection failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
    await applySessionChrome(ctx, event, true);
  });
  pi.on("message_start", (event) => {
    const message = event.message;
    if (message.customType !== "kxm-inbound" || !awaitingActivation) return;
    if (message.details?.messageId !== awaitingActivation.id) return;
    clearActivationWatchdog(awaitingActivation.id);
    activeInbound = awaitingActivation;
    awaitingActivation = void 0;
    activeReply = void 0;
    settlementReply = void 0;
    activeTurnSettled = false;
    activeFailure = void 0;
    activeFailureRecorded = false;
    settlementRetryAttempt = 0;
    recoveryStageId = void 0;
    recoveryArtifacts = [];
    persistRecoveryContext();
  });
  pi.on("agent_end", (event) => {
    if (!activeInbound || activeTurnSettled) return;
    const latest = latestAssistantMessage(event.messages);
    if (!latest) return;
    const failure = assistantFailure(event.messages);
    if (failure) {
      activeFailure = failure;
      activeFailureRecorded = false;
      activeReply = void 0;
      persistRecoveryContext();
      return;
    }
    activeFailure = void 0;
    activeFailureRecorded = false;
    activeReply = assistantText(event.messages) ?? activeReply;
  });
  pi.on("tool_result", async (event) => {
    const activeRunId = activeInbound ? workflowRunIdForMessage(activeInbound) : void 0;
    if (!activeRunId || !client) return;
    const resultEvent = event;
    const serializedDetails = JSON.stringify(resultEvent.details ?? {});
    const stageMatch = serializedDetails.match(/"(?:currentStage|stageId)"\s*:\s*"([A-Za-z0-9_.-]{1,64})"/);
    if (stageMatch?.[1]) recoveryStageId = stageMatch[1];
    recoveryArtifacts = [.../* @__PURE__ */ new Set([...recoveryArtifacts, ...serializedDetails.match(/(?:artifact:|\.kxm[\\/]assets[\\/])[A-Za-z0-9_./\\:-]{1,240}/g) ?? []])].slice(0, 16);
    persistRecoveryContext();
    if (!resultEvent.isError) return;
    const diagnostic = classifyFailure({
      ...resultEvent.toolName ? { toolName: resultEvent.toolName } : {},
      ...resultEvent.error ?? resultEvent.text ? { message: resultEvent.error ?? resultEvent.text } : {},
      ...resultEvent.code ? { code: resultEvent.code } : {},
      ...resultEvent.statusCode !== void 0 ? { statusCode: resultEvent.statusCode } : {}
    });
    try {
      await client.recordWorkflowEntry(activeRunId, {
        category: "error",
        area: areaForTool(resultEvent.toolName),
        severity: "error",
        summary: diagnosticSummary(diagnostic),
        evidence: diagnosticEvidence(diagnostic, resultEvent.toolCallId)
      });
    } catch {
    }
  });
  pi.on("agent_settled", async () => {
    if (!activeInbound || !client || settlementInProgress) return;
    if (activeFailure) {
      persistRecoveryContext();
      if (!activeFailureRecorded) {
        try {
          const activeRunId = workflowRunIdForMessage(activeInbound);
          if (activeRunId) {
            await client.recordWorkflowEntry(activeRunId, {
              category: "error",
              area: "harness",
              severity: "error",
              summary: diagnosticSummary(activeFailure),
              evidence: diagnosticEvidence(activeFailure)
            });
          }
          activeFailureRecorded = true;
        } catch {
        }
      }
      notify?.(
        `kxm retained ${activeInbound.id} after ${activeFailure.class}; switch the model or let the supervised worker recover it`,
        "error"
      );
      return;
    }
    if (!activeTurnSettled) {
      settlementReply = boundedPeerReply(
        activeReply ?? "The peer agent completed without a textual response."
      );
    }
    activeTurnSettled = true;
    await settleActiveInbound(activeInbound.id);
  });
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    clearActivationWatchdog();
    persistRecoveryContext();
    if (activationRetryTimer) clearTimeout(activationRetryTimer);
    activationRetryTimer = void 0;
    activationRetryAttempt = 0;
    await activationPromise?.catch(() => void 0);
    if (settlementRetryTimer) clearTimeout(settlementRetryTimer);
    settlementRetryTimer = void 0;
    await client?.stop();
    client = void 0;
    notify = void 0;
    requestWorkerRestart = void 0;
  });
  pi.on("turn_end", async (_event, ctx) => {
    await applySessionChrome(ctx, { reason: "turn_end" }, false);
  });
  for (const cmd of AGENT_COMMANDS) {
    pi.registerTool({
      name: cmd.name,
      label: cmd.label,
      description: cmd.description,
      parameters: cmd.parameters,
      async execute(_toolCallId, params, signal) {
        const policy = enforceToolPolicy(cmd.name);
        if (!policy.allowed) {
          throw new Error(`tool_policy_denied: ${policy.detail ?? policy.error}`);
        }
        return result(
          await workflowCall(
            () => cmd.execute(requireClient(), params ?? {}, { signal })
          )
        );
      }
    });
  }
  pi.registerCommand("kxm", {
    description: "Hub session brief, status line, and hub view",
    getArgumentCompletions: (prefix) => {
      const items = kxmSlashCompletions(prefix);
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const command = parseKxmSlashArgs(typeof args === "string" ? args : void 0);
      if (command === "hub") {
        await showKxmHub(ctx);
        return;
      }
      if (command === "status") {
        const cwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
        const hub = client?.agent ? { state: "on", evidence: "process", online: true } : void 0;
        const brief = await loadSessionBriefAsync(cwd, process.env, currentWork, hub);
        ctx.ui.setStatus?.("kxm", brief.statusLine);
        ctx.ui.setWidget?.("kxm-work", brief.widgetLines);
        ctx.ui.notify(brief.statusLine, "info");
        return;
      }
      if (command === "progress" || command === "workflow") {
        const cwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
        const progress = loadActiveWorkflowProgress(cwd);
        if (progress) {
          const lines = renderWorkflowWidgetLines(progress);
          ctx.ui.setWidget?.("kxm-progress", lines);
          ctx.ui.notify(renderWorkflowTuiText(progress), "info");
        } else {
          ctx.ui.notify("kxm: no active workflow run found in state.", "info");
        }
        return;
      }
      if (command === "help") {
        ctx.ui.notify("kxm: /kxm | /kxm status | /kxm progress | /kxm workflow | /kxm hub | /kxm memory | /kxm help. CLI: kxm session brief, kxm hub view, kxm memory brief", "info");
        return;
      }
      if (command === "memory") {
        const cwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
        const kxmBin = process.env.KXM_BIN || "kxm";
        const res = spawnSync2(kxmBin, ["memory", "brief"], { cwd, encoding: "utf8", windowsHide: true });
        let memText = res.status === 0 && res.stdout ? res.stdout.trim() : "";
        if (!memText) {
          const script = join10(cwd, "scripts", "kxm.mjs");
          if (existsSync7(script)) {
            const scriptRes = spawnSync2(process.execPath, [script, "memory", "brief"], { cwd, encoding: "utf8", windowsHide: true });
            if (scriptRes.status === 0 && scriptRes.stdout) memText = scriptRes.stdout.trim();
          }
        }
        ctx.ui.notify(memText || "No active project memory facts.", "info");
        return;
      }
      await applySessionChrome(ctx, { reason: "new" }, command === "brief");
    }
  });
  pi.registerCommand("workflow", {
    description: "Display active KXM workflow stage progress, assigned roles, and model metrics",
    handler: async (_args, ctx) => {
      const cwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
      const progress = loadActiveWorkflowProgress(cwd);
      if (progress) {
        ctx.ui.setWidget?.("kxm-progress", renderWorkflowWidgetLines(progress));
        ctx.ui.notify(renderWorkflowTuiText(progress), "info");
      } else {
        ctx.ui.notify("kxm: no active workflow run found in state.", "info");
      }
    }
  });
  return nousFactoryWork(pi, (report) => {
    nousReport = report;
  });
}
export {
  assistantFailure,
  bindingForMessage,
  piMeshExtension as default,
  workflowRunIdForMessage
};
