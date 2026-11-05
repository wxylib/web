// OGR vector VRT (OGRVRTDataSource XML) read in the browser.
//
// A vector VRT is a short XML file that says which layers of which files
// make up a dataset, and how: fields kept and renamed, points built from
// two columns, geometry parsed from WKT or WKB, an SQL filter, a spatial
// region, a reprojection, several layers unioned into one. Each element
// is read here as GDAL's OGR_VRT driver reads it (the source is GDAL
// 3.12's ogrvrtlayer.cpp and ogrvrtdatasource.cpp), for a subset of the
// elements and of the source formats; the page says which, and anything
// else in a VRT is reported, not silently dropped.
//
// Nothing here fetches libraries: the caller passes them in (`libs`):
// proj4 for coordinate transforms, flatgeobuf's geojson deserializer, and
// hyparquet with its compressors. So the same code runs in the page and
// under node for the tests (scripts/vrt-test.mjs), which compare it with
// GDAL's reading of the same files (scripts/vrt-oracle.json).

import { wkbToGeoJSON } from "./wkb.js";

// ---------------------------------------------------------------------
// XML: a small parser, enough for VRT files (elements, attributes, text,
// comments, CDATA, the five named entities and numeric references).

export function parseXML(text) {
  let pos = 0;
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const ent = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === "#") return String.fromCodePoint(k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[k];
  });
  while (pos < text.length) {
    const lt = text.indexOf("<", pos);
    const top = stack[stack.length - 1];
    if (lt < 0) { top.text += ent(text.slice(pos)); break; }
    if (lt > pos) top.text += ent(text.slice(pos, lt));
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      if (end < 0) throw new Error("XML: unclosed comment");
      pos = end + 3;
    } else if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      if (end < 0) throw new Error("XML: unclosed CDATA");
      top.text += text.slice(lt + 9, end);
      pos = end + 3;
    } else if (text.startsWith("<?", lt) || text.startsWith("<!", lt)) {
      const end = text.indexOf(">", lt);
      pos = end < 0 ? text.length : end + 1;
    } else if (text[lt + 1] === "/") {
      const end = text.indexOf(">", lt);
      const name = text.slice(lt + 2, end).trim();
      if (stack.length < 2 || top.name !== name) throw new Error(`XML: </${name}> does not close <${top.name}>`);
      stack.pop();
      pos = end + 1;
    } else {
      const m = /^<([A-Za-z_][\w.:-]*)/.exec(text.slice(lt, lt + 200));
      if (!m) throw new Error(`XML: bad tag at character ${lt}`);
      const el = { name: m[1], attrs: {}, children: [], text: "" };
      pos = lt + m[0].length;
      const attr = /\s*([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')|\s*(\/?)>/y;
      for (;;) {
        attr.lastIndex = pos;
        const a = attr.exec(text);
        if (!a) throw new Error(`XML: bad attribute in <${el.name}>`);
        pos = attr.lastIndex;
        if (a[1]) { el.attrs[a[1]] = ent(a[3] !== undefined ? a[3] : a[4]); continue; }
        top.children.push(el);
        if (a[5] !== "/") stack.push(el);
        break;
      }
    }
  }
  if (stack.length > 1) throw new Error(`XML: <${stack[stack.length - 1].name}> is not closed`);
  return root;
}

// Lookups are case-insensitive, as GDAL's (CPLGetXMLValue, EQUAL).
const lc = (s) => String(s).toLowerCase();
const kids = (el, name) => el.children.filter((c) => !name || lc(c.name) === lc(name));
const kid = (el, name) => kids(el, name)[0] || null;
const textOf = (el, name) => { const c = kid(el, name); return c ? c.text.trim() : null; };
function attrOf(el, name, dflt = null) {
  if (!el) return dflt;
  for (const k of Object.keys(el.attrs)) if (lc(k) === lc(name)) return el.attrs[k];
  return dflt;
}
const truthy = (v) => /^(1|yes|true|on)$/i.test(String(v).trim());

// ---------------------------------------------------------------------
// OGR SQL, the subset a SrcSQL needs: SELECT * or a field list (with AS),
// FROM one layer, WHERE, ORDER BY, LIMIT and OFFSET. The WHERE grammar:
// AND, OR, NOT, = <> != < > <= >=, IN, BETWEEN, LIKE and ILIKE (with % and
// _; LIKE is case-sensitive, as in GDAL since 3.1), IS [NOT] NULL, + - * /
// and parentheses. Field names are matched without regard to case.

function tokenize(s) {
  const out = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)|'((?:[^']|'')*)'|"((?:[^"]|"")*)"|([A-Za-z_][\w]*)|(<=|>=|<>|!=|==|[=<>(),*+\-/%.]))/y;
  let pos = 0;
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) {
      if (/^\s*$/.test(s.slice(pos))) break;
      throw new Error(`SQL: cannot read "${s.slice(pos, pos + 20)}"`);
    }
    pos = re.lastIndex;
    if (m[1] !== undefined) out.push({ t: "num", v: Number(m[1]) });
    else if (m[2] !== undefined) out.push({ t: "str", v: m[2].replace(/''/g, "'") });
    else if (m[3] !== undefined) out.push({ t: "id", v: m[3].replace(/""/g, '"'), quoted: true });
    else if (m[4] !== undefined) out.push({ t: "id", v: m[4] });
    else if (m[5] !== undefined) out.push({ t: "op", v: m[5] });
  }
  return out;
}

const KEYWORDS = new Set(["select", "from", "where", "and", "or", "not", "in", "like", "ilike", "is", "null",
  "between", "order", "by", "asc", "desc", "limit", "offset", "as", "distinct"]);

function parser(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const kw = (w) => { const t = tokens[i]; return t && t.t === "id" && !t.quoted && lc(t.v) === w; };
  const eatKw = (w) => { if (kw(w)) { i++; return true; } return false; };
  const op = (o) => { const t = tokens[i]; return t && t.t === "op" && t.v === o; };
  const eatOp = (o) => { if (op(o)) { i++; return true; } return false; };
  const expect = (o) => { if (!eatOp(o)) throw new Error(`SQL: expected "${o}"`); };

  function primary() {
    const t = tokens[i++];
    if (!t) throw new Error("SQL: the expression ends early");
    if (t.t === "num") return { k: "lit", v: t.v };
    if (t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "op" && t.v === "(") { const e = or(); expect(")"); return e; }
    if (t.t === "op" && t.v === "-") return { k: "neg", a: primary() };
    if (t.t === "id") {
      if (!t.quoted && lc(t.v) === "null") return { k: "lit", v: null };
      if (!t.quoted && KEYWORDS.has(lc(t.v))) throw new Error(`SQL: unexpected ${t.v}`);
      if (op("(")) throw new Error(`SQL: functions such as ${t.v}() are not supported here`);
      let name = t.v;
      // table.field: keep the field
      if (op(".") && tokens[i + 1] && tokens[i + 1].t === "id") { i++; name = tokens[i++].v; }
      return { k: "field", name };
    }
    throw new Error(`SQL: unexpected "${t.v}"`);
  }
  function mul() {
    let a = primary();
    for (;;) {
      const t = peek();
      if (t && t.t === "op" && (t.v === "*" || t.v === "/" || t.v === "%")) { i++; a = { k: "bin", o: t.v, a, b: primary() }; } else return a;
    }
  }
  function add() {
    let a = mul();
    for (;;) {
      const t = peek();
      if (t && t.t === "op" && (t.v === "+" || t.v === "-")) { i++; a = { k: "bin", o: t.v, a, b: mul() }; } else return a;
    }
  }
  function cmp() {
    const a = add();
    const t = peek();
    if (t && t.t === "op" && ["=", "==", "<>", "!=", "<", ">", "<=", ">="].includes(t.v)) {
      i++;
      return { k: "cmp", o: t.v === "==" ? "=" : t.v === "!=" ? "<>" : t.v, a, b: add() };
    }
    if (eatKw("is")) {
      const neg = eatKw("not");
      if (!eatKw("null")) throw new Error("SQL: expected NULL after IS");
      return { k: "isnull", a, neg };
    }
    const neg = eatKw("not");
    if (eatKw("in")) {
      expect("(");
      const list = [add()];
      while (eatOp(",")) list.push(add());
      expect(")");
      return { k: "in", a, list, neg };
    }
    if (kw("like") || kw("ilike")) {
      const ci = lc(tokens[i++].v) === "ilike";
      return { k: "like", a, b: add(), ci, neg };
    }
    if (eatKw("between")) {
      const lo = add();
      if (!eatKw("and")) throw new Error("SQL: expected AND in BETWEEN");
      return { k: "between", a, lo, hi: add(), neg };
    }
    if (neg) throw new Error("SQL: NOT here must be followed by IN, LIKE or BETWEEN");
    return a;
  }
  function not() { return eatKw("not") ? { k: "not", a: not() } : cmp(); }
  function and() { let a = not(); while (eatKw("and")) a = { k: "and", a, b: not() }; return a; }
  function or() { let a = and(); while (eatKw("or")) a = { k: "or", a, b: and() }; return a; }

  return { or, peek, kw, eatKw, eatOp, op, expect, next: () => tokens[i++], done: () => i >= tokens.length };
}

export function parseWhere(text) {
  const p = parser(tokenize(text));
  const e = p.or();
  if (!p.done()) throw new Error(`SQL: unexpected "${p.peek().v}" after the expression`);
  return e;
}

export function parseSelect(text) {
  const p = parser(tokenize(text));
  if (!p.eatKw("select")) throw new Error("SQL: only SELECT statements are supported");
  if (p.kw("distinct")) throw new Error("SQL: SELECT DISTINCT is not supported here");
  const columns = [];
  if (p.eatOp("*")) columns.push("*");
  else {
    do {
      const t = p.next();
      if (!t || t.t !== "id") throw new Error("SQL: expected a field name in the SELECT list");
      if (p.op("(")) throw new Error(`SQL: functions such as ${t.v}() are not supported here`);
      let alias = t.v;
      if (p.eatKw("as")) alias = p.next().v;
      columns.push({ name: t.v, alias });
    } while (p.eatOp(","));
  }
  if (!p.eatKw("from")) throw new Error("SQL: expected FROM");
  const ft = p.next();
  if (!ft || ft.t !== "id") throw new Error("SQL: expected a layer name after FROM");
  const q = { columns, from: ft.v, where: null, order: [], limit: null, offset: 0 };
  if (p.eatKw("where")) q.where = p.or();
  if (p.eatKw("order")) {
    if (!p.eatKw("by")) throw new Error("SQL: expected BY after ORDER");
    do {
      const t = p.next();
      let desc = false;
      if (p.eatKw("desc")) desc = true; else p.eatKw("asc");
      q.order.push({ name: t.v, desc });
    } while (p.eatOp(","));
  }
  if (p.eatKw("limit")) q.limit = p.next().v;
  if (p.eatKw("offset")) q.offset = p.next().v;
  if (!p.done()) throw new Error(`SQL: "${p.peek().v}" is not supported here`);
  return q;
}

function getField(props, name) {
  if (Object.prototype.hasOwnProperty.call(props, name)) return props[name];
  const l = lc(name);
  for (const k of Object.keys(props)) if (lc(k) === l) return props[k];
  if (l === "fid") return props["#fid"];
  throw new Error(`SQL: no field called "${name}"`);
}

// Strings that are numbers compare as numbers with numbers, as when a
// CSV column is compared with a number.
function compare(x, y) {
  if (typeof x === "number" && typeof y === "string" && y.trim() !== "" && !isNaN(+y)) y = +y;
  if (typeof y === "number" && typeof x === "string" && x.trim() !== "" && !isNaN(+x)) x = +x;
  return x < y ? -1 : x > y ? 1 : 0;
}

function likeRegex(pattern, ci) {
  const body = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${body}$`, ci ? "is" : "s");
}

export function evaluate(e, props) {
  switch (e.k) {
    case "lit": return e.v;
    case "field": return getField(props, e.name);
    case "neg": { const v = evaluate(e.a, props); return v === null ? null : -v; }
    case "bin": {
      const a = evaluate(e.a, props);
      const b = evaluate(e.b, props);
      if (a === null || b === null) return null;
      if (e.o === "+") return typeof a === "string" || typeof b === "string" ? String(a) + String(b) : a + b;
      if (e.o === "-") return a - b;
      if (e.o === "*") return a * b;
      if (e.o === "/") return a / b;
      return a % b;
    }
    case "cmp": {
      const a = evaluate(e.a, props);
      const b = evaluate(e.b, props);
      if (a === null || b === null) return null;
      const c = compare(a, b);
      return { "=": c === 0, "<>": c !== 0, "<": c < 0, ">": c > 0, "<=": c <= 0, ">=": c >= 0 }[e.o];
    }
    case "isnull": { const v = evaluate(e.a, props) === null; return e.neg ? !v : v; }
    case "in": {
      const a = evaluate(e.a, props);
      if (a === null) return null;
      const hit = e.list.some((x) => { const v = evaluate(x, props); return v !== null && compare(a, v) === 0; });
      return e.neg ? !hit : hit;
    }
    case "like": {
      const a = evaluate(e.a, props);
      const b = evaluate(e.b, props);
      if (a === null || b === null) return null;
      const hit = likeRegex(b, e.ci).test(String(a));
      return e.neg ? !hit : hit;
    }
    case "between": {
      const a = evaluate(e.a, props);
      const lo = evaluate(e.lo, props);
      const hi = evaluate(e.hi, props);
      if (a === null || lo === null || hi === null) return null;
      const hit = compare(a, lo) >= 0 && compare(a, hi) <= 0;
      return e.neg ? !hit : hit;
    }
    case "not": { const v = evaluate(e.a, props); return v === null ? null : !v; }
    case "and": {
      const a = evaluate(e.a, props);
      if (a === false) return false;
      const b = evaluate(e.b, props);
      if (b === false) return false;
      return a === null || b === null ? null : true;
    }
    case "or": {
      const a = evaluate(e.a, props);
      if (a === true) return true;
      const b = evaluate(e.b, props);
      if (b === true) return true;
      return a === null || b === null ? null : false;
    }
    default: throw new Error(`SQL: ${e.k}`);
  }
}

// ---------------------------------------------------------------------
// WKT to GeoJSON geometry. Z is kept, M is dropped.

export function parseWKT(text) {
  const s = String(text).trim();
  let pos = 0;
  const ws = () => { while (pos < s.length && /\s/.test(s[pos])) pos++; };
  const word = () => { ws(); const m = /^[A-Za-z]+/.exec(s.slice(pos)); if (!m) return ""; pos += m[0].length; return m[0].toUpperCase(); };
  const eat = (c) => { ws(); if (s[pos] === c) { pos++; return true; } return false; };
  const need = (c) => { if (!eat(c)) throw new Error(`WKT: expected "${c}" at ${pos}`); };
  let keepZ = true;
  let dropM = false;
  function coord() {
    ws();
    const m = /^[-+0-9.eE\s]+?(?=[,)])/.exec(s.slice(pos));
    if (!m) throw new Error(`WKT: bad coordinate at ${pos}`);
    pos += m[0].length;
    const v = m[0].trim().split(/\s+/).map(Number);
    if (v.length < 2 || v.some(isNaN)) throw new Error("WKT: bad coordinate");
    if (dropM) v.splice(v.length === 4 ? 3 : 2, 1);
    return keepZ ? v.slice(0, 3) : v.slice(0, 2);
  }
  const list = (item) => { need("("); const out = [item()]; while (eat(",")) out.push(item()); need(")"); return out; };
  const pointList = () => list(() => {
    // MULTIPOINT ((1 2), (3 4)) or MULTIPOINT (1 2, 3 4)
    if (eat("(")) { const c = coord(); need(")"); return c; }
    return coord();
  });
  function geom() {
    const type = word();
    let mod = word();
    if (mod === "ZM") { dropM = true; } else if (mod === "M") { dropM = true; } else if (mod === "Z") { /* kept */ } else if (mod) {
      if (mod === "EMPTY") return null;
      throw new Error(`WKT: unexpected ${mod}`);
    }
    ws();
    if (/^EMPTY/i.test(s.slice(pos))) { pos += 5; return null; }
    switch (type) {
      case "POINT": { need("("); const c = coord(); need(")"); return { type: "Point", coordinates: c }; }
      case "LINESTRING": return { type: "LineString", coordinates: list(coord) };
      case "POLYGON": return { type: "Polygon", coordinates: list(() => list(coord)) };
      case "MULTIPOINT": return { type: "MultiPoint", coordinates: pointList() };
      case "MULTILINESTRING": return { type: "MultiLineString", coordinates: list(() => list(coord)) };
      case "MULTIPOLYGON": return { type: "MultiPolygon", coordinates: list(() => list(() => list(coord))) };
      case "GEOMETRYCOLLECTION": return { type: "GeometryCollection", geometries: list(geom).filter(Boolean) };
      default: throw new Error(`WKT: ${type || "nothing"} is not a geometry type read here`);
    }
  }
  // An EWKT SRID prefix is skipped.
  if (/^SRID=\d+;/i.test(s)) pos = s.indexOf(";") + 1;
  const g = geom();
  return g;
}

function hexToBytes(h) {
  const s = String(h).trim();
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error("WKB: not a hex string");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

// ---------------------------------------------------------------------
// Geometry: walk, bounds, intersects (for SrcRegion and the view filter).

export function mapCoords(g, f) {
  if (!g) return g;
  const deep = (c, d) => (d === 0 ? f(c) : c.map((x) => deep(x, d - 1)));
  const depth = { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 }[g.type];
  if (g.type === "GeometryCollection") return { type: g.type, geometries: g.geometries.map((x) => mapCoords(x, f)) };
  return { type: g.type, coordinates: deep(g.coordinates, depth) };
}

function parts(g, out = { points: [], lines: [], polys: [] }) {
  if (!g) return out;
  switch (g.type) {
    case "Point": out.points.push(g.coordinates); break;
    case "MultiPoint": out.points.push(...g.coordinates); break;
    case "LineString": out.lines.push(g.coordinates); break;
    case "MultiLineString": out.lines.push(...g.coordinates); break;
    case "Polygon": out.polys.push(g.coordinates); break;
    case "MultiPolygon": out.polys.push(...g.coordinates); break;
    case "GeometryCollection": for (const x of g.geometries) parts(x, out); break;
    default: break;
  }
  return out;
}

export function bounds(g) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  mapCoords(g, (c) => {
    if (c[0] < b[0]) b[0] = c[0];
    if (c[1] < b[1]) b[1] = c[1];
    if (c[0] > b[2]) b[2] = c[0];
    if (c[1] > b[3]) b[3] = c[1];
    return c;
  });
  return b;
}

function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPoly = (p, poly) => inRing(p, poly[0]) && !poly.slice(1).some((h) => inRing(p, h));

function orient(a, b, c) {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}
function onSeg(a, b, p) {
  return Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
}
function segsCross(a, b, c, d) {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSeg(a, b, c)) || (o2 === 0 && onSeg(a, b, d)) ||
    (o3 === 0 && onSeg(c, d, a)) || (o4 === 0 && onSeg(c, d, b));
}

// Does geometry a meet geometry b (DE-9IM intersects), for points, lines
// and polygons in the same plane?
export function intersects(a, b) {
  const ba = bounds(a), bb = bounds(b);
  if (ba[0] > bb[2] || bb[0] > ba[2] || ba[1] > bb[3] || bb[1] > ba[3]) return false;
  const A = parts(a), B = parts(b);
  const segs = (P) => {
    const out = [];
    for (const l of P.lines) for (let i = 1; i < l.length; i++) out.push([l[i - 1], l[i]]);
    for (const poly of P.polys) for (const r of poly) for (let i = 1; i < r.length; i++) out.push([r[i - 1], r[i]]);
    return out;
  };
  const verts = (P) => [...P.points, ...P.lines.flat(), ...P.polys.map((p) => p[0]).flat()];
  const sa = segs(A), sb = segs(B);
  for (const p of A.points) {
    if (B.points.some((q) => q[0] === p[0] && q[1] === p[1])) return true;
    if (sb.some(([c, d]) => orient(c, d, p) === 0 && onSeg(c, d, p))) return true;
  }
  for (const p of B.points) if (sa.some(([c, d]) => orient(c, d, p) === 0 && onSeg(c, d, p))) return true;
  for (const [p, q] of sa) for (const [c, d] of sb) if (segsCross(p, q, c, d)) return true;
  for (const p of verts(A)) if (B.polys.some((poly) => inPoly(p, poly))) return true;
  for (const p of verts(B)) if (A.polys.some((poly) => inPoly(p, poly))) return true;
  return false;
}

export const bboxPolygon = (b) => ({ type: "Polygon", coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]] });

// ---------------------------------------------------------------------
// Coordinate reference systems. What GDAL's SetFromUserInput takes is far
// more than a page can know; here: EPSG codes from a short table (with
// every UTM zone), OGC:CRS84 and WGS84, PROJ strings, and WKT or PROJJSON
// handed to proj4. Axis order is longitude, latitude (GDAL's VRT driver
// sets the traditional GIS order).

const GDA94 = "+ellps=GRS80 +towgs84=0,0,0,0,0,0,0";
const POLAR = (lat0, latTs, lon0, datum = "+datum=WGS84") =>
  `+proj=stere +lat_0=${lat0} +lat_ts=${latTs} +lon_0=${lon0} +k=1 +x_0=0 +y_0=0 ${datum} +units=m +no_defs`;
const EPSG = {
  4326: "+proj=longlat +datum=WGS84 +no_defs",
  4269: "+proj=longlat +datum=NAD83 +no_defs",
  4258: "+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs",
  4283: `+proj=longlat ${GDA94} +no_defs`,
  7844: `+proj=longlat ${GDA94} +no_defs`,
  4167: `+proj=longlat ${GDA94} +no_defs`,
  3857: "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs",
  3031: POLAR(-90, -71, 0),
  3976: POLAR(-90, -70, 0),
  3412: POLAR(-90, -70, 0, "+a=6378273 +b=6356889.449"),
  3413: POLAR(90, 70, -45),
  3995: POLAR(90, 71, 0),
  3411: POLAR(90, 70, -45, "+a=6378273 +b=6356889.449"),
  3577: `+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 ${GDA94} +units=m +no_defs`,
  9473: `+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 ${GDA94} +units=m +no_defs`,
  3112: `+proj=lcc +lat_0=0 +lon_0=134 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 ${GDA94} +units=m +no_defs`,
  2193: "+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
  6933: "+proj=cea +lat_ts=30 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  8857: "+proj=eqearth +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  54009: "+proj=moll +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  27700: "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs",
};
function epsgDef(code) {
  if (EPSG[code]) return EPSG[code];
  const utm = (zone, south, datum) => `+proj=utm +zone=${zone}${south ? " +south" : ""} ${datum} +units=m +no_defs`;
  if (code > 32600 && code <= 32660) return utm(code - 32600, false, "+datum=WGS84");
  if (code > 32700 && code <= 32760) return utm(code - 32700, true, "+datum=WGS84");
  if (code >= 28348 && code <= 28358) return utm(code - 28300, true, GDA94);
  if (code >= 7846 && code <= 7859) return utm(code - 7800, true, GDA94);
  if (code >= 26901 && code <= 26923) return utm(code - 26900, false, "+datum=NAD83");
  return null;
}

const LONLAT = { label: "EPSG:4326", def: EPSG[4326], lonlat: true };
export const WGS84 = LONLAT;

// A user's SRS text (or a PROJJSON object) to {label, def, lonlat}, or
// null for "NULL"; throws when the page cannot know it.
export function crsFrom(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === "object") {
    const id = input.id || (input.ids && input.ids[0]);
    if (id && /^epsg$/i.test(id.authority)) return crsFrom(`EPSG:${id.code}`);
    if (id && /^ogc$/i.test(id.authority) && /crs84/i.test(String(id.code))) return LONLAT;
    return { label: input.name || "PROJJSON", def: input, lonlat: /geographic/i.test(input.type || "") };
  }
  const s = String(input).trim();
  if (/^null$/i.test(s)) return null;
  if (/^(wgs84|wgs 84|crs84|ogc:crs84|urn:ogc:def:crs:ogc:1\.3:crs84|epsg:4326)$/i.test(s)) return LONLAT;
  let m = /^(?:epsg:|urn:ogc:def:crs:epsg:[\d.]*:|https?:\/\/www\.opengis\.net\/def\/crs\/epsg\/0\/)(\d+)$/i.exec(s);
  if (m) {
    const def = epsgDef(+m[1]);
    if (!def) throw new Error(`EPSG:${m[1]} is not in this page's short list of CRSs: give it as a PROJ string (+proj=...) or WKT`);
    return { label: `EPSG:${m[1]}`, def, lonlat: /\+proj=longlat/.test(def) };
  }
  if (/^\+proj=/.test(s)) return { label: s, def: s, lonlat: /\+proj=(longlat|latlong|lonlat)/.test(s) };
  if (/^(PROJCS|GEOGCS|PROJCRS|GEOGCRS|GEODCRS|PROJECTEDCRS|GEOGRAPHICCRS)\s*\[/i.test(s)) {
    m = /(?:AUTHORITY\["EPSG",\s*"?(\d+)"?\]|ID\["EPSG",\s*(\d+)\])\s*\]\s*$/i.exec(s);
    if (m && epsgDef(+(m[1] || m[2]))) return crsFrom(`EPSG:${m[1] || m[2]}`);
    return { label: (/^\w+\s*\[\s*"([^"]*)"/.exec(s) || [])[1] || "WKT", def: s, lonlat: /^GEOG/i.test(s) };
  }
  if (/^\{/.test(s)) return crsFrom(JSON.parse(s));
  throw new Error(`cannot read the SRS "${s.slice(0, 60)}": give EPSG:n, a PROJ string or WKT`);
}

function sameCRS(a, b) {
  if (!a || !b) return a === b;
  if (a === b || a.label === b.label) return true;
  return typeof a.def === "string" && a.def === b.def;
}

// A function [x, y(, z)] -> [x, y(, z)] from one CRS to another.
export function transformer(proj4, from, to) {
  if (!from || !to || sameCRS(from, to)) return null;
  if (from.lonlat && to.lonlat && /WGS84|GRS80|NAD83/.test(from.def + to.def) && !/towgs84=[1-9-]/.test(from.def + to.def)) {
    return null; // WGS 84, GDA94, GDA2020, NAD83 and ETRS89 as one, as at a web map's scale
  }
  const t = proj4(from.def, to.def);
  return (c) => {
    const p = t.forward([c[0], c[1]]);
    return c.length > 2 ? [p[0], p[1], c[2]] : [p[0], p[1]];
  };
}

// A box in one CRS to the box that covers it in another, by its densified
// edges (the view in longitude and latitude to a source's own CRS).
export function transformBox(proj4, box, from, to) {
  const t = transformer(proj4, from, to);
  if (!t) return box.slice();
  const out = [Infinity, Infinity, -Infinity, -Infinity];
  const n = 20;
  for (let i = 0; i <= n; i++) {
    const fx = box[0] + ((box[2] - box[0]) * i) / n;
    const fy = box[1] + ((box[3] - box[1]) * i) / n;
    for (const c of [[fx, box[1]], [fx, box[3]], [box[0], fy], [box[2], fy]]) {
      const p = t(c);
      if (!isFinite(p[0]) || !isFinite(p[1])) continue;
      out[0] = Math.min(out[0], p[0]); out[1] = Math.min(out[1], p[1]);
      out[2] = Math.max(out[2], p[0]); out[3] = Math.max(out[3], p[1]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Sources. A SrcDataSource names a file; /vsicurl/ and a few other GDAL
// virtual file system prefixes are turned back into https URLs.

export function sourceURL(text, relative, base) {
  let s = String(text).trim();
  let format = null;
  const pre = /^(CSV|GeoJSON|FlatGeobuf|Parquet):/i.exec(s);
  if (pre && !/^[a-z]+:\/\//i.test(s)) { format = pre[1].toLowerCase(); s = s.slice(pre[0].length); }
  s = s.replace(/^\/vsicurl(_streaming)?\//, "");
  let m = /^\/vsis3\/([^/]+)\/(.*)$/.exec(s);
  if (m) s = `https://${m[1]}.s3.amazonaws.com/${m[2]}`;
  m = /^\/vsigs\/([^/]+)\/(.*)$/.exec(s);
  if (m) s = `https://storage.googleapis.com/${m[1]}/${m[2]}`;
  if (/^\/vsi/.test(s)) throw new Error(`${s.split("/")[1]} paths cannot be read from a web page`);
  // relativeToVRT="0" means relative to GDAL's working directory; a page
  // has none but its own address, which serves as both.
  void relative;
  const url = new URL(s, base).href;
  if (!format) {
    const path = new URL(url).pathname.toLowerCase();
    if (/\.(geo)?json$/.test(path)) format = "geojson";
    else if (/\.fgb$/.test(path)) format = "flatgeobuf";
    else if (/\.csv$/.test(path)) format = "csv";
    else if (/\.(geo)?parquet$/.test(path)) format = "parquet";
    else throw new Error(`cannot tell the format of ${url}: GeoJSON, FlatGeobuf, CSV and (Geo)Parquet are read here, by file extension`);
  }
  return { url, format };
}

const baseName = (url) => decodeURIComponent(new URL(url).pathname.split("/").pop()).replace(/\.[^.]*$/, "");

async function fetchOK(fetchFn, url) {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

// RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. Values stay
// strings, as GDAL's CSV driver reads them without a .csvt file.
export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function fieldType(values) {
  let t = null;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const vt = typeof v === "number" ? (Number.isInteger(v) ? "Integer" : "Real") : typeof v === "boolean" ? "Integer" : "String";
    if (t === null) t = vt;
    else if (t !== vt) t = t === "String" || vt === "String" ? "String" : "Real";
  }
  return t || "String";
}

async function readGeoJSON(src, ctx) {
  const res = await fetchOK(ctx.fetch, src.url);
  const fc = await res.json();
  const feats = fc.type === "FeatureCollection" ? fc.features : fc.type === "Feature" ? [fc] : [{ type: "Feature", properties: {}, geometry: fc }];
  const names = [];
  const seen = new Set();
  for (const f of feats) for (const k of Object.keys(f.properties || {})) if (!seen.has(k)) { seen.add(k); names.push(k); }
  const intIds = feats.every((f) => Number.isInteger(f.id));
  const rows = feats.map((f, i) => ({
    fid: intIds ? f.id : i,
    props: Object.fromEntries(names.map((k) => [k, f.properties && f.properties[k] !== undefined ? f.properties[k] : null])),
    geom: f.geometry || null,
  }));
  let srs = LONLAT;
  const crsName = fc.crs && fc.crs.properties && fc.crs.properties.name;
  if (crsName) srs = crsFrom(crsName);
  return {
    name: fc.name || baseName(src.url),
    fields: names.map((k) => ({ name: k, type: fieldType(rows.map((r) => r.props[k])) })),
    rows, srs, geometry: true,
  };
}

async function readCSV(src, ctx) {
  const res = await fetchOK(ctx.fetch, src.url);
  const table = parseCSV(await res.text());
  const header = table.shift() || [];
  const rows = table.map((r, i) => ({
    fid: i + 1,
    props: Object.fromEntries(header.map((k, j) => [k, r[j] !== undefined ? r[j] : null])),
    geom: null,
  }));
  return { name: baseName(src.url), fields: header.map((k) => ({ name: k, type: "String" })), rows, srs: null, geometry: false };
}

async function readFlatGeobuf(src, ctx, want) {
  const { deserialize } = ctx.libs.flatgeobuf;
  let header = null;
  const rows = [];
  const opts = { headerMetaFn: (h) => { header = h; } };
  if (want.rect) opts.rect = { minX: want.rect[0], minY: want.rect[1], maxX: want.rect[2], maxY: want.rect[3] };
  let i = 0;
  let truncated = false;
  for await (const f of deserialize(src.url, opts)) {
    if (rows.length >= ctx.limit) { truncated = true; break; }
    rows.push({ fid: f.id !== undefined ? f.id : i, props: { ...f.properties }, geom: f.geometry || null });
    i++;
  }
  const cols = (header && header.columns) || [];
  const TYPES = { 0: "Integer", 1: "Integer", 2: "Integer", 3: "Integer", 4: "Integer", 5: "Integer", 6: "Integer64", 7: "Integer64",
    8: "Real", 9: "Real", 10: "Real", 11: "String", 12: "String", 13: "DateTime", 14: "Binary" };
  let srs = null;
  if (header && header.crs) {
    const c = header.crs;
    if (c.code && (!c.org || /^epsg$/i.test(c.org))) srs = crsFrom(`EPSG:${c.code}`);
    else if (c.wkt) srs = crsFrom(c.wkt);
  }
  return {
    name: null, // the FlatGeobuf reader does not hand on the header's layer name
    fields: cols.map((c) => ({ name: c.name, type: TYPES[c.type] || "String" })),
    rows, srs, geometry: true, truncated, total: header ? Number(header.featuresCount) : null,
    byView: !!want.rect,
    envelope: header && header.envelope && header.envelope.length >= 4 ? Array.from(header.envelope).slice(0, 4) : null,
  };
}

async function readParquet(src, ctx) {
  const hp = ctx.libs.hyparquet;
  const file = hp.cachedAsyncBuffer(await hp.asyncBufferFromUrl({ url: src.url, fetch: ctx.fetch }));
  const metadata = await hp.parquetMetadataAsync(file);
  const kv = Object.fromEntries((metadata.key_value_metadata || []).map((x) => [x.key, x.value]));
  const geo = kv.geo ? JSON.parse(kv.geo) : null;
  const gcol = geo ? geo.primary_column : null;
  const gmeta = geo && gcol ? geo.columns[gcol] : null;
  const total = Number(metadata.num_rows);
  const rowEnd = Math.min(total, ctx.limit);
  const objs = await hp.parquetReadObjects({ file, metadata, compressors: ctx.libs.compressors, rowStart: 0, rowEnd, utf8: false });
  const schema = hp.parquetSchema ? hp.parquetSchema(metadata).children.map((c) => c.element) : [];
  const names = schema.length ? schema.map((e) => e.name) : Object.keys(objs[0] || {});
  const plain = (v) => (typeof v === "bigint" ? (Number.isSafeInteger(Number(v)) ? Number(v) : String(v)) : v);
  const rows = objs.map((o, i) => {
    let geom = null;
    if (gcol && o[gcol]) {
      if (gmeta && gmeta.encoding && !/^wkb$/i.test(gmeta.encoding)) throw new Error(`GeoParquet ${gmeta.encoding} encoding is not read here (WKB is)`);
      const v = o[gcol];
      // Parquet's own GEOMETRY type comes back from hyparquet as GeoJSON
      geom = v instanceof Uint8Array ? wkbToGeoJSON(v) : typeof v === "string" ? parseWKT(v) : v;
    }
    const props = {};
    for (const k of names) if (k !== gcol) props[k] = plain(o[k] === undefined ? null : o[k]);
    return { fid: i, props, geom };
  });
  const TYPE = (e) => {
    const t = e.type;
    if (t === "INT32" || t === "BOOLEAN") return "Integer";
    if (t === "INT64") return "Integer64";
    if (t === "FLOAT" || t === "DOUBLE") return "Real";
    return "String";
  };
  return {
    name: baseName(src.url),
    fields: (schema.length ? schema : names.map((name) => ({ name }))).filter((e) => e.name !== gcol)
      .map((e) => ({ name: e.name, type: e.type ? TYPE(e) : "String" })),
    rows, srs: gcol ? (gmeta && gmeta.crs ? crsFrom(gmeta.crs) : LONLAT) : null,
    geometry: !!gcol, truncated: rowEnd < total, total,
  };
}

async function loadSource(src, ctx, want) {
  // Whole-file sources are kept between reads; FlatGeobuf is read again
  // for each view, through its spatial index.
  const key = `${src.format} ${src.url}`;
  if (src.format !== "flatgeobuf" && ctx.cache && ctx.cache.has(key)) return ctx.cache.get(key);
  let p;
  if (src.format === "geojson") p = readGeoJSON(src, ctx);
  else if (src.format === "csv") p = readCSV(src, ctx);
  else if (src.format === "flatgeobuf") p = readFlatGeobuf(src, ctx, want);
  else if (src.format === "parquet") p = readParquet(src, ctx);
  else throw new Error(`format ${src.format}`);
  if (src.format !== "flatgeobuf" && ctx.cache) {
    ctx.cache.set(key, p);
    p.catch(() => ctx.cache.delete(key));
  }
  return p;
}

// ---------------------------------------------------------------------
// The VRT: XML to a layer tree.

const LAYER_TAGS = ["OGRVRTLayer", "OGRVRTWarpedLayer", "OGRVRTUnionLayer"].map(lc);
const LAYER_KNOWN = new Set(["srcdatasource", "srclayer", "srcsql", "fid", "style", "geometrytype", "layersrs",
  "geometryfield", "field", "srcregion", "extentxmin", "extentymin", "extentxmax", "extentymax", "featurecount",
  "attrfilterpassthrough", "xyresolution", "zresolution", "mresolution"]);
const GEOMFIELD_KNOWN = new Set(["geometrytype", "srs", "srcregion", "extentxmin", "extentymin", "extentxmax",
  "extentymax", "xyresolution", "zresolution", "mresolution"]);

function extentOf(el) {
  const v = ["ExtentXMin", "ExtentYMin", "ExtentXMax", "ExtentYMax"].map((k) => textOf(el, k));
  return v.every((x) => x !== null) ? v.map(Number) : null;
}

function parseLayer(el, base, notes, path) {
  const tag = lc(el.name);
  if (tag === "ogrvrtlayer") {
    const name = attrOf(el, "name");
    if (!name) throw new Error(`${path}: an OGRVRTLayer needs a name attribute`);
    const where = `${path}${name}`;
    for (const c of el.children) if (!LAYER_KNOWN.has(lc(c.name))) notes.push(`${where}: <${c.name}> is not read here, and is ignored`);
    const ds = kid(el, "SrcDataSource");
    if (!ds || !ds.text.trim()) throw new Error(`${where}: no SrcDataSource`);
    const sqlEl = kid(el, "SrcSQL");
    const geomEls = kids(el, "GeometryField");
    if (geomEls.length > 1) notes.push(`${where}: only the first of ${geomEls.length} GeometryField elements is read`);
    const g = geomEls[0] || null;
    if (g) for (const c of g.children) if (!GEOMFIELD_KNOWN.has(lc(c.name))) notes.push(`${where}: <GeometryField><${c.name}> is ignored`);
    const regionEl = (g && kid(g, "SrcRegion")) || kid(el, "SrcRegion");
    const fidEl = kid(el, "FID");
    return {
      kind: "layer", name,
      src: sourceURL(ds.text, truthy(attrOf(ds, "relativeToVRT", "0")), base),
      srcLayer: textOf(el, "SrcLayer"),
      sql: sqlEl ? sqlEl.text.trim() : null,
      dialect: sqlEl ? attrOf(sqlEl, "dialect") : null,
      fid: fidEl ? { src: fidEl.text.trim(), name: attrOf(fidEl, "name", fidEl.text.trim()) } : null,
      style: textOf(el, "Style"),
      geometryType: (g && textOf(g, "GeometryType")) || textOf(el, "GeometryType"),
      srs: (g && textOf(g, "SRS")) || textOf(el, "LayerSRS"),
      geom: {
        encoding: lc(attrOf(g, "encoding", "direct")),
        x: attrOf(g, "x"), y: attrOf(g, "y"), z: attrOf(g, "z"), m: attrOf(g, "m"),
        field: attrOf(g, "field"),
        name: attrOf(g, "name"),
        reportSrcColumn: truthy(attrOf(g, "reportSrcColumn", "YES")),
      },
      region: regionEl ? { wkt: regionEl.text.trim(), clip: truthy(attrOf(regionEl, "clip", "FALSE")) } : null,
      extent: (g && extentOf(g)) || extentOf(el),
      fields: kids(el, "Field").map((f) => ({
        name: attrOf(f, "name"), src: attrOf(f, "src"), type: attrOf(f, "type", "String"),
      })),
    };
  }
  if (tag === "ogrvrtwarpedlayer") {
    const inner = el.children.find((c) => LAYER_TAGS.includes(lc(c.name)));
    if (!inner) throw new Error(`${path}: an OGRVRTWarpedLayer needs a layer inside it`);
    const target = textOf(el, "TargetSRS");
    if (!target) throw new Error(`${path}: Missing TargetSRS element within OGRVRTWarpedLayer`);
    if (textOf(el, "WarpedGeomFieldName")) notes.push(`${path}: WarpedGeomFieldName is ignored (one geometry field is read)`);
    return { kind: "warped", layer: parseLayer(inner, base, notes, path), srcSRS: textOf(el, "SrcSRS"), targetSRS: target, extent: extentOf(el) };
  }
  if (tag === "ogrvrtunionlayer") {
    const name = attrOf(el, "name");
    if (!name) throw new Error(`${path}: Missing name attribute on OGRVRTUnionLayer`);
    const layers = el.children.filter((c) => LAYER_TAGS.includes(lc(c.name))).map((c) => parseLayer(c, base, notes, `${path}${name} > `));
    if (kids(el, "GeometryField").length) notes.push(`${path}${name}: <GeometryField> of a union layer is ignored`);
    return {
      kind: "union", name, layers,
      sourceLayerFieldName: textOf(el, "SourceLayerFieldName"),
      fieldStrategy: lc(textOf(el, "FieldStrategy") || (kids(el, "Field").length ? "specified" : "union")),
      preserveSrcFID: truthy(textOf(el, "PreserveSrcFID") || "OFF"),
      srs: textOf(el, "LayerSRS"),
      geometryType: textOf(el, "GeometryType"),
      fields: kids(el, "Field").map((f) => ({ name: attrOf(f, "name"), type: attrOf(f, "type", "String") })),
      extent: extentOf(el),
    };
  }
  throw new Error(`${path}<${el.name}> is not a layer element`);
}

export function parseVRT(text, base) {
  const doc = parseXML(text);
  const root = doc.children.find((c) => lc(c.name) === "ogrvrtdatasource");
  if (!root) throw new Error("not a vector VRT: there is no <OGRVRTDataSource>");
  const notes = [];
  const layers = [];
  for (const c of root.children) {
    if (LAYER_TAGS.includes(lc(c.name))) layers.push(parseLayer(c, base, notes, ""));
    else if (lc(c.name) !== "metadata") notes.push(`<${c.name}> in the data source is ignored`);
  }
  return { layers, notes };
}

export const layerName = (spec) => (spec.kind === "warped" ? layerName(spec.layer) : spec.name);

// ---------------------------------------------------------------------
// Reading a layer.

function cast(v, type) {
  if (v === null || v === undefined) return null;
  const t = lc(type || "String");
  if (t === "integer" || t === "integer64") {
    if (typeof v === "number") return Math.trunc(v);
    const s = String(v).trim();
    if (s === "") return null;
    const n = parseInt(s, 10);
    return isNaN(n) ? 0 : n;
  }
  if (t === "real") {
    if (typeof v === "number") return v;
    const s = String(v).trim();
    if (s === "") return null;
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }
  if (t === "string") {
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(+v.toPrecision(15));
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }
  return v; // dates and lists are passed through
}

function findName(names, want) {
  if (names.includes(want)) return want;
  return names.find((n) => lc(n) === lc(want)) || null;
}

function applySQL(table, sql, notes, where) {
  const q = parseSelect(sql);
  if (table.name && lc(q.from) !== lc(table.name)) {
    notes.push(`${where}: SrcSQL reads FROM ${q.from}; this source's one layer is ${table.name}, read as that`);
  }
  let rows = table.rows;
  if (q.where) rows = rows.filter((r) => evaluate(q.where, { ...r.props, "#fid": r.fid }) === true);
  if (q.order.length) {
    rows = rows.slice().sort((a, b) => {
      for (const o of q.order) {
        const c = compare(getField(a.props, o.name), getField(b.props, o.name));
        if (c) return o.desc ? -c : c;
      }
      return 0;
    });
  }
  if (q.offset) rows = rows.slice(q.offset);
  if (q.limit !== null) rows = rows.slice(0, q.limit);
  let fields = table.fields;
  if (q.columns[0] !== "*") {
    const names = table.fields.map((f) => f.name);
    fields = q.columns.map((c) => {
      const n = findName(names, c.name);
      if (!n) throw new Error(`${where}: SrcSQL: no field called "${c.name}"`);
      return { name: c.alias, type: table.fields.find((f) => f.name === n).type, from: n };
    });
    rows = rows.map((r) => ({ ...r, props: Object.fromEntries(fields.map((f) => [f.name, r.props[f.from]])) }));
  }
  return { ...table, fields, rows };
}

async function readVRTLayer(spec, ctx, notes) {
  const where = spec.name;
  if (spec.sql && spec.dialect && !/^(ogrsql)?$/i.test(spec.dialect)) {
    notes.push(`${where}: SrcSQL dialect ${spec.dialect} is read as OGR SQL`);
  }
  let declared = null;
  if (spec.srs) declared = crsFrom(spec.srs);
  const want = {};
  // A FlatGeobuf source is read by the view: the view, in the layer's CRS.
  if (spec.src.format === "flatgeobuf" && ctx.view && spec.geom.encoding === "direct") {
    want.rect = transformBox(ctx.libs.proj4, ctx.view, LONLAT, declared || LONLAT);
  }
  let table = await loadSource(spec.src, ctx, want);
  if (want.rect && !declared && table.srs && !table.srs.lonlat) {
    // The source's own CRS is only known once its header is read.
    want.rect = transformBox(ctx.libs.proj4, ctx.view, LONLAT, table.srs);
    table = await loadSource(spec.src, ctx, want);
  }
  if (!spec.sql && table.name && spec.srcLayer && spec.srcLayer !== table.name) {
    notes.push(`${where}: SrcLayer is ${spec.srcLayer}; this source's one layer is ${table.name}, read as that`);
  }
  if (!spec.sql && table.name && !spec.srcLayer && spec.name !== table.name) {
    notes.push(`${where}: no SrcLayer, so GDAL would look for a source layer named ${spec.name}; this source's one layer is ${table.name}, read as that`);
  }
  if (spec.sql) table = applySQL(table, spec.sql, notes, where);

  const srcNames = table.fields.map((f) => f.name);
  const need = (n, what) => {
    const k = findName(srcNames, n);
    if (!k) throw new Error(`${where}: Unable to find ${what} field '${n}'`);
    return k;
  };

  // Geometry
  const g = spec.geom;
  const noGeom = g.encoding === "none" || /^wkbnone$/i.test(spec.geometryType || "");
  let build;
  const skip = new Set();
  if (noGeom) build = () => null;
  else if (g.encoding === "direct") {
    if (!table.geometry && !spec.geometryType) build = () => null;
    else build = (r) => r.geom;
  } else if (g.encoding === "pointfromcolumns") {
    if (!g.x || !g.y) throw new Error(`${where}: PointFromColumns needs x and y`);
    const kx = need(g.x, "x"), ky = need(g.y, "y");
    const kz = g.z ? findName(srcNames, g.z) : null;
    const km = g.m ? findName(srcNames, g.m) : null;
    [kx, ky, kz, km].forEach((k) => k && skip.add(k));
    const num = (v) => (v === null || v === undefined || String(v).trim() === "" ? NaN : +v);
    build = (r) => {
      const x = num(r.props[kx]), y = num(r.props[ky]);
      if (isNaN(x) || isNaN(y)) return null;
      const c = [x, y];
      if (kz) { const z = num(r.props[kz]); if (!isNaN(z)) c.push(z); }
      return { type: "Point", coordinates: c };
    };
  } else if (g.encoding === "wkt" || g.encoding === "wkb") {
    const k = need(g.field || "missing", "geometry");
    skip.add(k);
    build = (r) => {
      const v = r.props[k];
      if (v === null || v === undefined || v === "") return null;
      if (g.encoding === "wkt") return parseWKT(v);
      return wkbToGeoJSON(typeof v === "string" ? hexToBytes(v) : v);
    };
  } else throw new Error(`${where}: geometry encoding "${g.encoding}" is not read here (Direct, None, PointFromColumns, WKT and WKB are)`);

  const srs = declared || (spec.srs && /^null$/i.test(spec.srs) ? null : table.srs);

  let region = null;
  if (spec.region) {
    region = parseWKT(spec.region.wkt);
    if (spec.region.clip) notes.push(`${where}: SrcRegion clip="true": features that meet the region are kept whole, not clipped to it`);
  }
  const viewPoly = want.rect && table.byView ? bboxPolygon(want.rect) : null;

  // Fields
  let outFields;
  let pick;
  if (spec.fields.length) {
    outFields = spec.fields.map((f) => {
      if (!f.name) throw new Error(`${where}: Unable to identify Field name.`);
      let src = findName(srcNames, f.name);
      if (f.src) src = need(f.src, "source");
      return { name: f.name, type: f.type, src };
    });
    pick = (r) => Object.fromEntries(outFields.map((f) => [f.name, f.src ? cast(r.props[f.src], f.type) : null]));
  } else {
    outFields = table.fields.filter((f) => g.reportSrcColumn || !skip.has(f.name)).map((f) => ({ name: f.name, type: f.type, src: f.name }));
    pick = (r) => Object.fromEntries(outFields.map((f) => [f.name, r.props[f.src]]));
  }
  const fidKey = spec.fid && spec.fid.src ? need(spec.fid.src, "FID") : null;
  const styleKey = spec.style ? need(spec.style, "Style") : null;

  const features = [];
  for (const r of table.rows) {
    const geom = build(r);
    if (region && (!geom || !intersects(geom, region))) continue;
    if (viewPoly && geom && !intersects(geom, viewPoly)) continue;
    features.push({
      fid: fidKey ? cast(r.props[fidKey], "Integer64") : r.fid,
      properties: pick(r),
      geometry: geom,
      style: styleKey ? r.props[styleKey] : null,
    });
  }
  return {
    name: spec.name, fields: outFields.map(({ name, type }) => ({ name, type })), features, srs,
    geometryType: spec.geometryType, format: spec.src.format, url: spec.src.url,
    truncated: !!table.truncated, total: table.total, byView: !!table.byView,
    extent: spec.extent || table.envelope || null,
  };
}

async function readWarped(spec, ctx, notes) {
  const inner = await readSpec(spec.layer, ctx, notes);
  const from = spec.srcSRS ? crsFrom(spec.srcSRS) : inner.srs;
  if (!from) throw new Error(`${inner.name}: Failed to import source SRS (the warped layer's source has none)`);
  const to = crsFrom(spec.targetSRS);
  const t = transformer(ctx.libs.proj4, from, to);
  return {
    ...inner,
    srs: to,
    features: t ? inner.features.map((f) => ({ ...f, geometry: mapCoords(f.geometry, t) })) : inner.features,
    extent: spec.extent || (inner.extent ? transformBox(ctx.libs.proj4, inner.extent, from, to) : null),
    warped: { from: from.label, to: to.label },
  };
}

async function readUnion(spec, ctx, notes) {
  const parts = [];
  for (const l of spec.layers) parts.push(await readSpec(l, ctx, notes));
  let names = [];
  const types = new Map();
  if (spec.fieldStrategy === "specified") {
    names = spec.fields.map((f) => f.name);
    spec.fields.forEach((f) => types.set(f.name, f.type));
  } else if (spec.fieldStrategy === "firstlayer") {
    if (parts[0]) parts[0].fields.forEach((f) => { names.push(f.name); types.set(f.name, f.type); });
  } else if (spec.fieldStrategy === "intersection") {
    if (parts[0]) {
      for (const f of parts[0].fields) {
        if (parts.every((p) => p.fields.some((x) => lc(x.name) === lc(f.name)))) { names.push(f.name); types.set(f.name, f.type); }
      }
    }
  } else {
    for (const p of parts) for (const f of p.fields) if (!names.some((n) => lc(n) === lc(f.name))) { names.push(f.name); types.set(f.name, f.type); }
  }
  const fields = names.map((n) => ({ name: n, type: types.get(n) || "String" }));
  if (spec.sourceLayerFieldName) fields.unshift({ name: spec.sourceLayerFieldName, type: "String" });
  const srs = spec.srs ? crsFrom(spec.srs) : parts.length ? parts[0].srs : null;
  for (const p of parts) {
    if (p.srs && srs && !sameCRS(p.srs, srs)) {
      notes.push(`${spec.name}: ${p.name} is in ${p.srs.label} and the union in ${srs.label}; a union layer does not reproject (wrap a layer in an OGRVRTWarpedLayer to do so)`);
    }
  }
  const features = [];
  let next = 0;
  for (const p of parts) {
    for (const f of p.features) {
      const props = {};
      if (spec.sourceLayerFieldName) props[spec.sourceLayerFieldName] = p.name;
      for (const n of names) {
        const k = Object.keys(f.properties).find((x) => lc(x) === lc(n));
        props[n] = k === undefined ? null : cast(f.properties[k], types.get(n));
      }
      features.push({ fid: spec.preserveSrcFID ? f.fid : next++, properties: props, geometry: f.geometry, style: f.style });
    }
  }
  return {
    name: spec.name, fields, features, srs, geometryType: spec.geometryType, format: "union",
    parts: parts.map((p) => ({ name: p.name, format: p.format, url: p.url, count: p.features.length, warped: p.warped })),
    truncated: parts.some((p) => p.truncated), byView: parts.some((p) => p.byView), extent: spec.extent,
  };
}

export function readSpec(spec, ctx, notes) {
  if (spec.kind === "layer") return readVRTLayer(spec, ctx, notes);
  if (spec.kind === "warped") return readWarped(spec, ctx, notes);
  return readUnion(spec, ctx, notes);
}

// One layer of a parsed VRT, read. ctx: {libs, fetch, view (lon/lat box or
// null), limit (features per source), cache (a Map, kept between reads)}.
export async function readLayer(spec, ctx) {
  const notes = [];
  const c = { limit: 20000, fetch: globalThis.fetch.bind(globalThis), cache: null, view: null, ...ctx };
  const result = await readSpec(spec, c, notes);
  return { ...result, notes };
}

// GeoJSON in longitude and latitude, for a map.
export function toLonLat(result, proj4) {
  const t = transformer(proj4, result.srs, LONLAT);
  return {
    type: "FeatureCollection",
    features: result.features.map((f) => ({
      type: "Feature", id: f.fid, properties: f.properties,
      geometry: t ? mapCoords(f.geometry, t) : f.geometry,
      ...(f.style ? { style: f.style } : {}),
    })),
  };
}

// OGR feature style strings (PEN, BRUSH, SYMBOL) to map styles: colours,
// line width and dashes; the rest of the style language is ignored.
export function styleFrom(s) {
  if (!s) return null;
  const out = {};
  const tool = (name) => { const m = new RegExp(`${name}\\(([^)]*)\\)`, "i").exec(s); return m ? m[1] : null; };
  const param = (body, k) => { const m = new RegExp(`(?:^|,)\\s*${k}:\\s*("[^"]*"|[^,]*)`, "i").exec(body); return m ? m[1].replace(/"/g, "").trim() : null; };
  const colour = (c) => {
    if (!c) return null;
    const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
    if (!m) return null;
    return { hex: `#${m[1]}`, alpha: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  };
  const width = (w) => { if (!w) return null; const m = /^([\d.]+)\s*(px|pt|mm|g)?$/.exec(w); if (!m) return null; const v = +m[1]; return m[2] === "pt" ? v * 1.333 : m[2] === "mm" ? v * 3.78 : v; };
  const pen = tool("PEN");
  if (pen) {
    const c = colour(param(pen, "c"));
    if (c) { out.color = c.hex; out.opacity = c.alpha; }
    const w = width(param(pen, "w"));
    if (w) out.weight = w;
    const p = param(pen, "p");
    if (p) out.dashArray = p.replace(/(px|pt|mm|g)/g, "").trim().split(/\s+/).join(" ");
  }
  const brush = tool("BRUSH");
  if (brush) {
    const c = colour(param(brush, "fc"));
    if (c) { out.fillColor = c.hex; out.fillOpacity = c.alpha; }
  }
  const sym = tool("SYMBOL");
  if (sym) {
    const c = colour(param(sym, "c"));
    if (c) { out.color = c.hex; out.fillColor = c.hex; out.fillOpacity = 0.85; }
    const sz = width(param(sym, "s"));
    if (sz) out.radius = Math.max(2, sz / 2);
  }
  return Object.keys(out).length ? out : null;
}
