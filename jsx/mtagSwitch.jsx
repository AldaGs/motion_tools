// jsx/mtagSwitch.jsx — MTAG Switch host-side bridge (Stage 2 POC).
//
// Two entry points, host-specific:
//   mtagSwitchAiExport() -> JSON string  (Illustrator)
//   mtagSwitchAeImport(jsonString) -> JSON string  (After Effects)
//
// Both wrap results in {ok:true, data} / {ok:false, error} so the panel can
// distinguish evalScript failures (which return "EvalScript error.") from
// real host-side errors.

// Load the gradient .ffx preset helper (AE 2026 gradient workaround). It lives
// beside this file; resolve via $.fileName so it works from the shared CEP ext
// folder. Guarded + optional: if it's missing, gradient import silently keeps
// the older Gradient Ramp fallback.
try {
    if (typeof _mtagBuildGradFfxString === "undefined") {
        var _mtagSelfFile = new File($.fileName);
        var _mtagGradFfxFile = new File(_mtagSelfFile.parent.fsName + "/mtagGradFfx.jsx");
        if (_mtagGradFfxFile.exists) { $.evalFile(_mtagGradFfxFile); }
    }
} catch (e) {}

// Illustrator's ExtendScript does NOT ship a native JSON object (only After
// Effects, InDesign, and Photoshop CS4+ do). Provide a tiny stringify/parse
// pair guarded by a feature check so this file loads in either host. Only
// stringify is used on the AI side (export), only parse on the AE side
// (import). Both are included for symmetry.
if (typeof JSON === "undefined") {
    JSON = {};
}
if (typeof JSON.stringify !== "function") {
    JSON.stringify = (function () {
        function esc(s) {
            var r = "", i, c, code;
            for (i = 0; i < s.length; i++) {
                c = s.charAt(i); code = s.charCodeAt(i);
                if (c === '"' || c === '\\') r += '\\' + c;
                else if (c === '\n') r += '\\n';
                else if (c === '\r') r += '\\r';
                else if (c === '\t') r += '\\t';
                else if (c === '\b') r += '\\b';
                else if (c === '\f') r += '\\f';
                else if (code < 0x20) {
                    var hex = code.toString(16);
                    while (hex.length < 4) hex = '0' + hex;
                    r += '\\u' + hex;
                } else r += c;
            }
            return '"' + r + '"';
        }
        function ser(v) {
            if (v === null || v === undefined) return "null";
            var t = typeof v;
            if (t === "number") return isFinite(v) ? String(v) : "null";
            if (t === "boolean") return v ? "true" : "false";
            if (t === "string") return esc(v);
            if (v instanceof Array) {
                var parts = [];
                for (var i = 0; i < v.length; i++) parts.push(ser(v[i]));
                return "[" + parts.join(",") + "]";
            }
            if (t === "object") {
                var kv = [];
                for (var k in v) {
                    if (v.hasOwnProperty(k)) {
                        var sv = ser(v[k]);
                        if (sv !== undefined) kv.push(esc(k) + ":" + sv);
                    }
                }
                return "{" + kv.join(",") + "}";
            }
            return "null";
        }
        return function (val) { return ser(val); };
    })();
}
if (typeof JSON.parse !== "function") {
    // Only used on the AE side, but AE already has JSON.parse. Provide
    // eval-based fallback in case a future host lacks it.
    JSON.parse = function (s) { return eval("(" + s + ")"); };
}

function _mtagOk(data) {
    return JSON.stringify({ ok: true, data: data });
}
function _mtagErr(msg) {
    return JSON.stringify({ ok: false, error: String(msg) });
}

// ---------------- BridgeTalk transport helpers ----------------
// The BridgeTalk path lets the SENDER app hand a payload to the target Adobe
// app without any CEP panel being open there. The payload travels via a shared
// temp file (avoids giant escaped script bodies); the tiny BridgeTalk body just
// re-evals this same file in the target and calls the receiver entry point.

var _MTAG_BEAM_FILE = "mtag_switch_beam.json";
var _MTAG_RESULT_FILE = "mtag_switch_result.json";

function _mtagTempPath(name) {
    return Folder.temp.fsName.replace(/\\/g, "/") + "/" + name;
}
function _mtagWriteFile(path, text) {
    var f = new File(path);
    f.encoding = "UTF-8";
    f.open("w");
    f.write(text);
    f.close();
    return f.fsName;
}
function _mtagReadFile(path) {
    var f = new File(path);
    if (!f.exists) return null;
    f.encoding = "UTF-8";
    f.open("r");
    var c = f.read();
    f.close();
    return c;
}
// Produce a safe double-quoted ExtendScript string literal.
function _mtagQuote(s) {
    return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// Sender side. targetLogical: "ae" | "ai". scriptPath: absolute path to THIS
// file (mtagSwitch.jsx), passed from the panel. payloadJson: the ArtworkPayload
// as a JSON string. Fire-and-forget; the receiver writes its result to a temp
// file that the panel polls via mtagSwitchReadBeamResult().
function mtagSwitchBeam(targetLogical, scriptPath, payloadJson) {
    try {
        if (typeof BridgeTalk === "undefined") {
            return _mtagErr("BridgeTalk is unavailable in this host.");
        }
        var appName = (targetLogical === "ai") ? "illustrator" : "aftereffects";
        var spec = BridgeTalk.getSpecifier(appName);
        if (!spec) return _mtagErr("Target app '" + appName + "' not installed / not found.");

        var beamPath = _mtagTempPath(_MTAG_BEAM_FILE);
        var resultPath = _mtagTempPath(_MTAG_RESULT_FILE);

        _mtagWriteFile(beamPath, payloadJson);
        // Clear any stale result so the panel's poll can't read an old one.
        var rf = new File(resultPath);
        if (rf.exists) rf.remove();

        var recv = (targetLogical === "ai") ? "mtagSwitchReceiveBeamAi" : "mtagSwitchReceiveBeamAe";
        var body =
            "$.evalFile(" + _mtagQuote(scriptPath) + ");" +
            recv + "(" + _mtagQuote(beamPath) + "," + _mtagQuote(resultPath) + ");";

        var running = BridgeTalk.isRunning(spec);
        var bt = new BridgeTalk();
        bt.target = spec;
        bt.body = body;
        // If the target throws before it can write its own result file (app not
        // scriptable, syntax error in the body, etc.), surface it to the poller
        // by writing an error result here. Runs asynchronously in THIS app after
        // mtagSwitchBeam has already returned — the panel's poll picks it up.
        bt.onError = function (errMsg) {
            var m = "BridgeTalk error";
            try { m = errMsg.body || String(errMsg); } catch (e) { m = String(errMsg); }
            try { _mtagWriteFile(resultPath, _mtagErr("target-side failure: " + m)); } catch (e2) {}
        };
        bt.send();

        return _mtagOk({
            sent: true,
            target: spec,
            targetRunning: running,
            beamFile: beamPath,
            resultFile: resultPath
        });
    } catch (e) {
        return _mtagErr(e.toString());
    }
}

// Receiver side (runs in the TARGET app via BridgeTalk). Reads the beam file,
// runs the appropriate import, and writes the import's JSON result string to
// the result file for the sender to pick up.
function mtagSwitchReceiveBeamAe(beamPath, resultPath) {
    var res;
    try {
        var input = _mtagReadFile(beamPath);
        if (input == null) { res = _mtagErr("Beam file missing: " + beamPath); }
        else { res = mtagSwitchAeImport(input); }
    } catch (e) {
        res = _mtagErr(e.toString());
    }
    try { _mtagWriteFile(resultPath, res); } catch (e2) {}
    return res;
}
function mtagSwitchReceiveBeamAi(beamPath, resultPath) {
    // AE → AI import is Stage 6 (round-trip). Stub so the target doesn't throw.
    var res = _mtagErr("AE→AI round-trip not implemented yet (Stage 6).");
    try { _mtagWriteFile(resultPath, res); } catch (e2) {}
    return res;
}

// Sender side. Polled by the panel after a beam. Returns {pending:true} until
// the receiver has written a result, then {pending:false, result:<jsonString>}.
function mtagSwitchReadBeamResult() {
    try {
        var c = _mtagReadFile(_mtagTempPath(_MTAG_RESULT_FILE));
        if (c == null) return _mtagOk({ pending: true });
        return _mtagOk({ pending: false, result: c });
    } catch (e) {
        return _mtagErr(e.toString());
    }
}

// Fire a BridgeTalk body at a target app, clearing the shared result file first
// so the panel's poll can't read a stale one. Returns the resolved specifier or
// null when the app isn't found. Shared by the query/set folder round-trips.
function _mtagBeamCall(targetAppName, body, resultPath) {
    var spec = BridgeTalk.getSpecifier(targetAppName);
    if (!spec) return null;
    var rf = new File(resultPath);
    if (rf.exists) rf.remove();
    var bt = new BridgeTalk();
    bt.target = spec;
    bt.body = body;
    bt.onError = function (errMsg) {
        var m = "BridgeTalk error";
        try { m = errMsg.body || String(errMsg); } catch (e) { m = String(errMsg); }
        try { _mtagWriteFile(resultPath, _mtagErr("target-side failure: " + m)); } catch (e2) {}
    };
    bt.send();
    return spec;
}

// Sender (AI/PS): ask AE to report its per-project image-folder status. Result
// (via the shared result file, polled with mtagSwitchReadBeamResult) is
// { imageDirSet, imageDir, projectSaved, aepDir }.
function mtagSwitchQueryAeImageDir(scriptPath) {
    try {
        if (typeof BridgeTalk === "undefined") return _mtagErr("BridgeTalk unavailable.");
        var resultPath = _mtagTempPath(_MTAG_RESULT_FILE);
        var body = "$.evalFile(" + _mtagQuote(scriptPath) + ");" +
            "mtagSwitchReportImageDir(" + _mtagQuote(resultPath) + ");";
        var spec = _mtagBeamCall("aftereffects", body, resultPath);
        if (!spec) return _mtagErr("After Effects not found.");
        return _mtagOk({ sent: true, resultFile: resultPath });
    } catch (e) {
        return _mtagErr(e.toString());
    }
}

// Sender (AI/PS): tell AE to store `dir` as the project's image folder (XMP).
function mtagSwitchSetAeImageDir(scriptPath, dir) {
    try {
        if (typeof BridgeTalk === "undefined") return _mtagErr("BridgeTalk unavailable.");
        var resultPath = _mtagTempPath(_MTAG_RESULT_FILE);
        var body = "$.evalFile(" + _mtagQuote(scriptPath) + ");" +
            "mtagSwitchApplyImageDir(" + _mtagQuote(dir) + "," + _mtagQuote(resultPath) + ");";
        var spec = _mtagBeamCall("aftereffects", body, resultPath);
        if (!spec) return _mtagErr("After Effects not found.");
        return _mtagOk({ sent: true, resultFile: resultPath });
    } catch (e) {
        return _mtagErr(e.toString());
    }
}

// Receiver (runs in AE): report image-folder status to the result file.
function mtagSwitchReportImageDir(resultPath) {
    var res;
    try {
        var info = { imageDirSet: false, imageDir: null, projectSaved: false, aepDir: null };
        var s = {};
        try { s = _mtagReadProjectSettings(); } catch (e) {}
        if (s && s.imageExportDir) { info.imageDirSet = true; info.imageDir = s.imageExportDir; }
        if (app.project && app.project.file) {
            info.projectSaved = true;
            info.aepDir = app.project.file.parent.fsName.replace(/\\/g, "/");
        }
        res = _mtagOk(info);
    } catch (e) {
        res = _mtagErr(e.toString());
    }
    try { _mtagWriteFile(resultPath, res); } catch (e2) {}
    return res;
}

// Receiver (runs in AE): persist the chosen image folder into the project XMP.
function mtagSwitchApplyImageDir(dir, resultPath) {
    var res;
    try { res = mtagSetProjectSetting("imageExportDir", dir); }
    catch (e) { res = _mtagErr(e.toString()); }
    try { _mtagWriteFile(resultPath, res); } catch (e2) {}
    return res;
}

// ---------------- shared color / gradient helpers (AI side) ----------------

// Convert any AI color object to a straight [r,g,b] in 0..1. Alpha is carried
// separately (AI colors don't hold alpha; it comes from stop/object opacity).
function _mtagRgbFromAiColor(c) {
    if (!c) return [0, 0, 0];
    if (c.typename === "RGBColor") {
        return [c.red / 255, c.green / 255, c.blue / 255];
    } else if (c.typename === "CMYKColor") {
        var r = (1 - c.cyan / 100) * (1 - c.black / 100);
        var g = (1 - c.magenta / 100) * (1 - c.black / 100);
        var b = (1 - c.yellow / 100) * (1 - c.black / 100);
        return [r, g, b];
    } else if (c.typename === "GrayColor") {
        var v = 1 - c.gray / 100;
        return [v, v, v];
    } else if (c.typename === "SpotColor") {
        // Resolve the spot's underlying process color, then apply the tint. A
        // spot tint blends from paper white (0%) to the full color (100%), so a
        // 40% spot must NOT come through at full strength.
        try {
            var base = _mtagRgbFromAiColor(c.spot.color);
            var t = (c.tint != null ? c.tint : 100) / 100;
            return [
                1 - (1 - base[0]) * t,
                1 - (1 - base[1]) * t,
                1 - (1 - base[2]) * t
            ];
        } catch (e) { return [0, 0, 0]; }
    } else if (c.typename === "PatternColor") {
        // Patterns can't be represented in an AE shape fill. Use a neutral gray
        // placeholder (visible, unlike the old black) — the export notes it.
        return [0.5, 0.5, 0.5];
    }
    return [0, 0, 0];
}

// Build a Paint (solid|gradient) from an AI color object. `conv` maps AI
// points to layer/pixel space; `alpha` is the object-level opacity (0..1).
function _mtagPaintFromAiColor(col, alpha, conv, bbox) {
    if (col && col.typename === "GradientColor") {
        var gc = col;
        var g = gc.gradient;
        var stops = [];
        for (var i = 0; i < g.gradientStops.length; i++) {
            var st = g.gradientStops[i];
            var rgb = _mtagRgbFromAiColor(st.color);
            var sa = (st.opacity != null ? st.opacity / 100 : 1) * alpha;
            stops.push({
                offset: st.rampPoint / 100,
                rgba: [rgb[0], rgb[1], rgb[2], sa],
                midpoint: (st.midPoint != null ? st.midPoint / 100 : 0.5)
            });
        }
        var isRadial = (String(g.type) === String(GradientType.RADIAL));
        var origin = gc.origin;                 // [x, y] pts
        var ang = (gc.angle || 0) * Math.PI / 180;
        var len = gc.length || 0;
        
        var start, end;
        if (len > 0.01) {
            var startAi = origin;
            var endAi = [origin[0] + len * Math.cos(ang), origin[1] + len * Math.sin(ang)];
            start = conv(startAi);
            end = conv(endAi);
        } else if (bbox) {
            // Default gradient mapping (spans the bounding box)
            if (isRadial) {
                var cx = bbox.x + bbox.w / 2;
                var cy = bbox.y + bbox.h / 2;
                start = [cx, cy];
                end = [cx + bbox.w / 2, cy];
            } else {
                start = [bbox.x, bbox.y + bbox.h / 2];
                end = [bbox.x + bbox.w, bbox.y + bbox.h / 2];
            }
        } else {
            start = [0, 0];
            end = [100, 0];
        }

        return {
            kind: "gradient",
            type: isRadial ? "radial" : "linear",
            stops: stops,
            start: start,
            end: end
        };
    }
    var rgb2 = _mtagRgbFromAiColor(col);
    return { kind: "solid", rgba: [rgb2[0], rgb2[1], rgb2[2], alpha] };
}

// Map AI cap/join enums to the schema's string form.
function _mtagCap(v) {
    if (String(v) === String(StrokeCap.ROUNDENDCAP)) return "round";
    if (String(v) === String(StrokeCap.PROJECTINGENDCAP)) return "square";
    return "butt";
}
function _mtagJoin(v) {
    if (String(v) === String(StrokeJoin.ROUNDENDJOIN)) return "round";
    if (String(v) === String(StrokeJoin.BEVELENDJOIN)) return "bevel";
    return "miter";
}

// Map AI BlendModes enum to the schema's blend-mode string.
function _mtagBlend(v) {
    var s = String(v);
    var map = [
        [BlendModes.MULTIPLY, "multiply"], [BlendModes.SCREEN, "screen"],
        [BlendModes.OVERLAY, "overlay"], [BlendModes.DARKEN, "darken"],
        [BlendModes.LIGHTEN, "lighten"], [BlendModes.COLORDODGE, "colorDodge"],
        [BlendModes.COLORBURN, "colorBurn"], [BlendModes.HARDLIGHT, "hardLight"],
        [BlendModes.SOFTLIGHT, "softLight"], [BlendModes.DIFFERENCE, "difference"],
        [BlendModes.EXCLUSION, "exclusion"], [BlendModes.HUE, "hue"],
        [BlendModes.SATURATION, "saturation"], [BlendModes.COLOR, "color"],
        [BlendModes.LUMINOSITY, "luminosity"]
    ];
    for (var i = 0; i < map.length; i++) {
        if (s === String(map[i][0])) return map[i][1];
    }
    return "normal";
}

// Extract an embedded raster (or any single item) to a PNG on disk by
// duplicating it into a temp document sized to its bounds and exporting. Used
// when a RasterItem is embedded (no linked source file) so AE has something to
// import. Best-effort — callers wrap in try/catch and warn on failure.
function _mtagExportItemToPng(item, outPath) {
    var gb = item.geometricBounds; // [left, top, right, bottom], y up
    var w = Math.abs(gb[2] - gb[0]);
    var h = Math.abs(gb[1] - gb[3]);
    if (w < 1) w = 1;
    if (h < 1) h = 1;
    var tempDoc = app.documents.add(DocumentColorSpace.RGB, w, h);
    try {
        var dup = item.duplicate(tempDoc.layers[0], ElementPlacement.PLACEATEND);
        // Rather than repositioning the item (AI's `position` coordinate space is
        // error-prone), fit the temp artboard exactly to the duplicated item's
        // geometric bounds and clip to it — captures just the item wherever it
        // landed. Matches the placement bbox (also from geometricBounds).
        var db;
        try { db = dup.geometricBounds; } catch (eB) { db = gb; }
        try { tempDoc.artboards[0].artboardRect = db; } catch (eR) {}
        var opts = new ExportOptionsPNG24();
        opts.artBoardClipping = true;
        opts.transparency = true;
        opts.horizontalScale = 100;
        opts.verticalScale = 100;
        tempDoc.exportFile(new File(outPath), ExportType.PNG24, opts);
    } finally {
        try { tempDoc.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {}
    }
}

// ---------------- Illustrator export ----------------
// Collects the selected vector paths, converts geometry to AE-compatible
// tangents, and reads each path's fill + stroke appearance (solid or gradient),
// object opacity, blend mode, cap/join/miter, and dash pattern.
//
// LIMITATION: the ExtendScript DOM exposes only ONE fill and ONE stroke per
// PathItem (the appearance-stack / multiple-fills API is not scriptable). So
// `fills`/`strokes` arrays hold at most one entry each here; the schema keeps
// them as arrays for forward-compat and because the AE side can emit stacks.
function mtagSwitchAiExport(grouped, centerAnchor, parametric) {
    try {
        // Default ON: recognised rectangles/ellipses/polygons/stars go over as
        // live AE parametric shapes. Pass false to force raw bezier paths.
        var emitParametric = (parametric !== false);
        if (!app.documents || app.documents.length === 0) {
            return _mtagErr("No open document.");
        }
        var doc = app.activeDocument;
        var sel = doc.selection;
        if (!sel || sel.length === 0) {
            return _mtagErr("Nothing selected.");
        }

        // Each entry carries the item plus an `inheritedName` — the closest
        // named ancestor group. Selecting a named group in AI and recursing to
        // its unnamed <Path> children would otherwise lose the group's name, so
        // we thread it down as a naming fallback.
        var skipped = [];   // types/names we can't handle — reported, not dropped

        var ab = doc.artboards[doc.artboards.getActiveArtboardIndex()];
        var abRect = ab.artboardRect;
        var abLeft = abRect[0];
        var abTop = abRect[1];
        var PT_TO_PX = 1.0;

        function conv(pt) {
            return [ (pt[0] - abLeft) * PT_TO_PX, (abTop - pt[1]) * PT_TO_PX ];
        }

        // Extract a path/compound-path's subpaths (AE-space vertices+tangents).
        // Used for both rendered paths and clip-mask geometry.
        function subpathsOf(it) {
            var subs = [];
            var paths = it.typename === "CompoundPathItem" ? it.pathItems : [it];
            for (var sp = 0; sp < paths.length; sp++) {
                var pth = paths[sp];
                var verts = [], ins = [], outs = [];
                for (var kk = 0; kk < pth.pathPoints.length; kk++) {
                    var pp = pth.pathPoints[kk];
                    var a = conv(pp.anchor);
                    var lir = conv(pp.leftDirection);
                    var ror = conv(pp.rightDirection);
                    verts.push(a);
                    ins.push([lir[0] - a[0], lir[1] - a[1]]);
                    outs.push([ror[0] - a[0], ror[1] - a[1]]);
                }
                subs.push({ closed: !!pth.closed, vertices: verts, inTangents: ins, outTangents: outs });
            }
            return subs;
        }

        // Recognise a single closed subpath as an axis-aligned rectangle,
        // ellipse, or regular polygon/star, returning an AE-space parametric
        // descriptor (see schema ParametricShape) or null. Works purely on the
        // AE-space subpaths + bbox, so no coordinate math is duplicated. Any
        // ambiguity → null, and the caller keeps the exact bezier path (safe).
        function detectShape(subpaths, bbox) {
            if (!subpaths || subpaths.length !== 1) return null;
            var sp = subpaths[0];
            if (!sp.closed) return null;
            var v = sp.vertices, itn = sp.inTangents, otn = sp.outTangents;
            var n = v.length;
            if (n < 2) return null;

            var EPS = Math.max(bbox.w, bbox.h) * 0.01 + 0.75;  // px tolerance
            function zeroT(t) { return Math.abs(t[0]) < EPS && Math.abs(t[1]) < EPS; }
            function allStraight() {
                for (var i = 0; i < n; i++) { if (!zeroT(itn[i]) || !zeroT(otn[i])) return false; }
                return true;
            }
            var cx = bbox.x + bbox.w / 2, cy = bbox.y + bbox.h / 2;

            // Rectangle: 4 straight corners, every edge axis-aligned.
            if (n === 4 && allStraight()) {
                var axis = true;
                for (var e = 0; e < 4; e++) {
                    var a = v[e], b = v[(e + 1) % 4];
                    if (Math.abs(a[0] - b[0]) > EPS && Math.abs(a[1] - b[1]) > EPS) { axis = false; break; }
                }
                if (axis) return { type: "rect", center: [cx, cy], size: [bbox.w, bbox.h], roundness: 0 };
            }

            // Ellipse: 4 curved vertices sitting at the mid-point of each edge.
            if (n === 4 && !allStraight()) {
                var onMid = 0;
                for (var m = 0; m < 4; m++) {
                    var p = v[m];
                    var atTB = Math.abs(p[0] - cx) < EPS &&
                        (Math.abs(p[1] - bbox.y) < EPS || Math.abs(p[1] - (bbox.y + bbox.h)) < EPS);
                    var atLR = Math.abs(p[1] - cy) < EPS &&
                        (Math.abs(p[0] - bbox.x) < EPS || Math.abs(p[0] - (bbox.x + bbox.w)) < EPS);
                    if (atTB || atLR) onMid++;
                }
                if (onMid === 4) return { type: "ellipse", center: [cx, cy], size: [bbox.w, bbox.h] };
            }

            // Regular polygon / star: straight edges, vertices radially regular
            // about the centroid with even angular spacing.
            if (n >= 6 && allStraight()) {
                var gx = 0, gy = 0;
                for (var c = 0; c < n; c++) { gx += v[c][0]; gy += v[c][1]; }
                gx /= n; gy /= n;
                var radii = [], angs = [];
                for (var r = 0; r < n; r++) {
                    var dx = v[r][0] - gx, dy = v[r][1] - gy;
                    radii.push(Math.sqrt(dx * dx + dy * dy));
                    angs.push(Math.atan2(dx, -dy));   // 0 = up, CW+ (AE convention)
                }
                var RTOL = Math.max(bbox.w, bbox.h) * 0.02 + 0.5;
                function eq(a, b) { return Math.abs(a - b) <= RTOL; }
                function evenlySpaced(step) {
                    for (var i = 0; i < n; i++) {
                        var d = angs[i] - (angs[0] + i * step);
                        while (d > Math.PI) d -= 2 * Math.PI;
                        while (d < -Math.PI) d += 2 * Math.PI;
                        if (Math.abs(d) > 0.06) return false;
                    }
                    return true;
                }
                // Polygon: all radii equal.
                var allEq = true;
                for (var q = 1; q < n; q++) { if (!eq(radii[q], radii[0])) { allEq = false; break; } }
                if (allEq && evenlySpaced(Math.PI * 2 / n)) {
                    return { type: "polystar", star: false, points: n, center: [gx, gy],
                             rotation: angs[0] * 180 / Math.PI, outerRadius: radii[0], outerRoundness: 0 };
                }
                // Star: even vertex count, alternating outer/inner radii, first
                // vertex on the outer ring.
                if (n % 2 === 0) {
                    var outR = radii[0], inR = radii[1], ok = true;
                    for (var s2 = 0; s2 < n; s2++) {
                        if (!eq(radii[s2], (s2 % 2 === 0) ? outR : inR)) { ok = false; break; }
                    }
                    if (ok && outR > inR && evenlySpaced(Math.PI * 2 / n)) {
                        return { type: "polystar", star: true, points: n / 2, center: [gx, gy],
                                 rotation: angs[0] * 180 / Math.PI, outerRadius: outR, innerRadius: inR,
                                 outerRoundness: 0, innerRoundness: 0 };
                    }
                }
            }
            return null;
        }

        // Pattern fills/strokes come through as a flat gray placeholder (see
        // _mtagRgbFromAiColor); note it so the downgrade isn't silent.
        function noteIfPattern(colObj, what) {
            try {
                if (colObj && colObj.typename === "PatternColor") {
                    skipped.push(what + " uses a pattern → flat gray placeholder");
                }
            } catch (eP) {}
        }

        var _imgSeq = 0;

        // Build one leaf node (path/text/image); returns the node or null.
        function buildLeaf(item, inheritedName) {
            var objOpacity = (item.opacity != null ? item.opacity / 100 : 1);
            var blend = "normal";
            try { blend = _mtagBlend(item.blendingMode); } catch (eB) { blend = "normal"; }

            var bounds = item.geometricBounds;
            var bl = conv([bounds[0], bounds[1]]);
            var br = conv([bounds[2], bounds[3]]);
            var bbox = { x: Math.min(bl[0], br[0]), y: Math.min(bl[1], br[1]),
                         w: Math.abs(br[0]-bl[0]), h: Math.abs(br[1]-bl[1]) };

            if (item.typename === "PlacedItem" || item.typename === "RasterItem") {
                var imgName = (item.name && item.name.length) ? item.name : (inheritedName || "Image");
                var srcPath = null;
                var linked = false;
                // Prefer a linked source file when present (PlacedItem, or a
                // RasterItem that still points at its origin file).
                try {
                    if (item.file && item.file.exists) { srcPath = item.file.fsName; linked = true; }
                } catch (eFile) {}
                if (!srcPath) {
                    // Embedded / missing link → extract to a temp PNG for AE.
                    try {
                        var tmp = _mtagTempPath("mtag_img_" + (_imgSeq++) + "_" + (new Date().getTime()) + ".png");
                        _mtagExportItemToPng(item, tmp);
                        srcPath = tmp;
                        linked = false;
                    } catch (eExtract) {
                        skipped.push("image '" + imgName + "' (extract failed: " + eExtract.toString() + ")");
                        return null;
                    }
                }
                return {
                    kind: "image",
                    name: imgName,
                    bbox: bbox,
                    sourcePath: String(srcPath).replace(/\\/g, "/"),
                    linked: linked,
                    opacity: objOpacity,
                    blendMode: blend
                };
            }

            if (item.typename === "TextFrame") {
                var contents = item.contents;
                var font = "ArialMT";
                var fontSize = 12;
                var just = "left";
                var fills = [];
                var strokes = [];
                var aiAnchor = null;

                // Point vs area (box) vs path text — drives AE layer creation.
                var textKind = "point";
                try {
                    if (item.kind === TextType.AREATEXT) textKind = "area";
                    else if (item.kind === TextType.PATHTEXT) textKind = "path";
                } catch (eKind) {}

                // Point text uses its baseline anchor; area text is positioned by
                // its box top-left.
                try {
                    if (textKind === "area") aiAnchor = [bbox.x, bbox.y];
                    else if (item.anchor) aiAnchor = conv(item.anchor);
                } catch (e) {}

                // Walk characters, grouping consecutive same-style ones (font /
                // size / fill) into runs so multi-style text can round-trip.
                var runs = [];
                try {
                    var range = item.textRange;
                    if (range && range.length > 0) {
                        var chars = range.characters;
                        var cur = null;
                        for (var ci = 0; ci < chars.length; ci++) {
                            var ca = chars[ci].characterAttributes;
                            var cf = "ArialMT";
                            try { if (ca.textFont) cf = ca.textFont.name; } catch (e1) {}
                            var cz = 12;
                            try { if (ca.size) cz = ca.size * PT_TO_PX; } catch (e2) {}
                            var crgba = null;
                            try {
                                if (ca.fillColor && ca.fillColor.typename !== "NoColor") {
                                    if (ca.fillColor.typename === "PatternColor")
                                        noteIfPattern(ca.fillColor, "'" + (item.name || "text") + "' fill");
                                    var pr = _mtagPaintFromAiColor(ca.fillColor, 1, conv);
                                    if (pr && pr.kind === "solid") crgba = pr.rgba;
                                }
                            } catch (e3) {}
                            var chStr = "";
                            try { chStr = chars[ci].contents; } catch (e4) {}
                            var same = cur && cur.font === cf && cur.fontSize === cz &&
                                ((cur.fillRgba == null && crgba == null) ||
                                 (cur.fillRgba && crgba && cur.fillRgba[0] === crgba[0] &&
                                  cur.fillRgba[1] === crgba[1] && cur.fillRgba[2] === crgba[2] &&
                                  cur.fillRgba[3] === crgba[3]));
                            if (same) { cur.text += chStr; }
                            else { cur = { text: chStr, font: cf, fontSize: cz, fillRgba: crgba }; runs.push(cur); }
                        }

                        // Stroke (DOM exposes one) + paragraph justification.
                        var charAttrs = range.characterAttributes;
                        if (charAttrs.strokeColor && charAttrs.strokeColor.typename !== "NoColor") {
                            noteIfPattern(charAttrs.strokeColor, "'" + (item.name || "text") + "' stroke");
                            strokes.push({
                                paint: _mtagPaintFromAiColor(charAttrs.strokeColor, 1, conv),
                                width: (charAttrs.strokeWeight || 1) * PT_TO_PX,
                                cap: "butt", join: "miter", miterLimit: 4
                            });
                        }
                        var pAttrs = range.paragraphAttributes;
                        if (pAttrs && pAttrs.justification) {
                            var j = String(pAttrs.justification);
                            if (j.indexOf("CENTER") !== -1) just = "center";
                            else if (j.indexOf("RIGHT") !== -1) just = "right";
                        }
                    }
                } catch(e) {}

                // Dominant run (most characters) sets the layer-wide style so a
                // single-style AE fallback still looks right.
                var dom = null;
                for (var dr = 0; dr < runs.length; dr++) {
                    if (!dom || runs[dr].text.length > dom.text.length) dom = runs[dr];
                }
                if (dom) {
                    font = dom.font;
                    fontSize = dom.fontSize;
                    if (dom.fillRgba) fills = [{ kind: "solid", rgba: dom.fillRgba }];
                }
                if (runs.length > 1) skipped.push("'" + (item.name || "text") + "' text has " + runs.length + " style runs");

                // Name the AE text layer after its content (matches AI's own
                // Layers-panel behaviour of showing the string). Collapse
                // newlines/whitespace so the layer name stays single-line.
                var textName = contents ? String(contents).replace(/[\r\n\t]+/g, " ").replace(/^\s+|\s+$/g, "") : "";
                if (!textName.length) textName = (item.name && item.name.length) ? item.name : "Text";

                return {
                    kind: "text",
                    name: textName,
                    text: contents,
                    font: font,
                    fontSize: fontSize,
                    justification: just,
                    textKind: textKind,
                    boxSize: (textKind === "area") ? [bbox.w, bbox.h] : null,
                    runs: (runs.length > 1) ? runs : null,
                    bbox: bbox,
                    aiAnchor: aiAnchor,
                    opacity: objOpacity,
                    blendMode: blend,
                    appearance: { fills: fills, strokes: strokes }
                };
            } else {
                var subpaths = [];
                var paths = item.typename === "CompoundPathItem" ? item.pathItems : [item];
                
                for (var p = 0; p < paths.length; p++) {
                    var pth = paths[p];
                    var verts = [], ins = [], outs = [];
                    for (var k = 0; k < pth.pathPoints.length; k++) {
                        var pp = pth.pathPoints[k];
                        var a = conv(pp.anchor);
                        var lir = conv(pp.leftDirection);
                        var ror = conv(pp.rightDirection);
                        verts.push(a);
                        ins.push([lir[0] - a[0], lir[1] - a[1]]);
                        outs.push([ror[0] - a[0], ror[1] - a[1]]);
                    }
                    subpaths.push({
                        closed: !!pth.closed,
                        vertices: verts,
                        inTangents: ins,
                        outTangents: outs
                    });
                }
                
                var first = item.typename === "CompoundPathItem" ? item.pathItems[0] : item;
                var fills = [];
                if (first.filled && first.fillColor) {
                    noteIfPattern(first.fillColor, "'" + (item.name || "path") + "' fill");
                    fills.push(_mtagPaintFromAiColor(first.fillColor, 1, conv, bbox));
                }
                var strokes = [];
                if (first.stroked && first.strokeColor) {
                    noteIfPattern(first.strokeColor, "'" + (item.name || "path") + "' stroke");
                    var dashes = [];
                    try {
                        if (first.strokeDashes && first.strokeDashes.length) {
                            for (var d = 0; d < first.strokeDashes.length; d++) {
                                dashes.push(first.strokeDashes[d] * PT_TO_PX);
                            }
                        }
                    } catch (eDash) {}
                    strokes.push({
                        paint: _mtagPaintFromAiColor(first.strokeColor, 1, conv, bbox),
                        width: (first.strokeWidth || 1) * PT_TO_PX,
                        cap: _mtagCap(first.strokeCap),
                        join: _mtagJoin(first.strokeJoin),
                        miterLimit: (first.strokeMiterLimit || 4),
                        dashes: dashes,
                        dashOffset: (first.strokeDashOffset || 0) * PT_TO_PX
                    });
                }

                var name = item.name;
                // Fall back to the enclosing named group before guessing from
                // geometry, so objects inside a named AI group carry that name.
                if (!name || name.length === 0) name = inheritedName || "";
                if (!name || name.length === 0) {
                    if (item.typename === "CompoundPathItem") name = "Compound Path";
                    else if (subpaths[0] && subpaths[0].vertices.length === 4 && subpaths[0].closed) {
                        var t0 = subpaths[0].inTangents[0];
                        if (Math.abs(t0[0]) < 0.1 && Math.abs(t0[1]) < 0.1) name = "Rectangle";
                        else name = "Ellipse";
                    } else {
                        name = "Path";
                    }
                }
                
                // AI compound paths rely on winding to punch holes (donuts,
                // letter counters). The DOM doesn't expose the rule, but
                // even-odd reproduces holes far more often than nonzero, which
                // would fill them. Plain paths stay nonzero.
                var fillRule = (item.typename === "CompoundPathItem") ? "even-odd" : "nonzero";

                // Try to send a live parametric primitive (compound paths are
                // never single primitives, so skip them). subpaths still ride
                // along as the fallback.
                var shape = null;
                if (emitParametric && item.typename !== "CompoundPathItem") {
                    try { shape = detectShape(subpaths, bbox); } catch (eSh) { shape = null; }
                }

                return {
                    kind: "path",
                    name: name,
                    bbox: bbox,
                    opacity: objOpacity,
                    blendMode: blend,
                    geometry: { subpaths: subpaths, fillRule: fillRule, shape: shape },
                    appearance: { fills: fills, strokes: strokes }
                };
            }
        }

        // Build a group node, preserving nesting. A clipped group's clip path is
        // captured separately (it masks the children) and not rendered as a shape.
        function buildGroup(group, inheritedName) {
            var gName = (group.name && group.name.length) ? group.name : inheritedName;
            var isClip = false;
            try { isClip = !!group.clipped; } catch (eC) {}
            var clip = null;
            var children = [];
            for (var gi = 0; gi < group.pageItems.length; gi++) {
                var child = group.pageItems[gi];
                var isClipMember = false;
                try { isClipMember = isClip && child.clipping; } catch (eM) {}
                if (isClipMember) {
                    try {
                        if (child.typename === "PathItem" || child.typename === "CompoundPathItem") {
                            clip = subpathsOf(child);
                        }
                    } catch (eS) {}
                    continue;
                }
                var node = buildItem(child, gName);
                if (node) children.push(node);
            }
            if (children.length === 0) return null;
            var gOpacity = 1;
            try { gOpacity = (group.opacity != null ? group.opacity / 100 : 1); } catch (eO) {}
            var gBlend = "normal";
            try { gBlend = _mtagBlend(group.blendingMode); } catch (eBl) {}
            return {
                kind: "group",
                name: (gName && gName.length) ? gName : "Group",
                opacity: gOpacity,
                blendMode: gBlend,
                clip: clip,
                children: children
            };
        }

        // Dispatch: group → recurse; supported leaf → buildLeaf; else skip-note.
        function buildItem(item, inheritedName) {
            if (item.typename === "GroupItem") return buildGroup(item, inheritedName);
            if (item.typename === "PathItem" || item.typename === "CompoundPathItem" ||
                item.typename === "TextFrame" || item.typename === "PlacedItem" ||
                item.typename === "RasterItem") {
                return buildLeaf(item, inheritedName);
            }
            var label = item.typename;
            try { if (item.name && item.name.length) label += " '" + item.name + "'"; } catch (eN) {}
            skipped.push(label);
            return null;
        }

        // AI's `selection` array isn't guaranteed to be in z-order, so multiple
        // loose (ungrouped) objects could export in the wrong stacking order and
        // land reversed/scrambled in AE. Sort front-to-back (frontmost first) so
        // the AE side — which stacks items[0] on top — preserves the AI design.
        // Key: containing-layer index in doc.layers (0 = topmost layer), then
        // zOrderPosition (higher = more front within a layer). Wrapped so any DOM
        // quirk falls back to the raw selection order. A single object or a lone
        // group is unaffected (length <= 1; a group's children keep pageItems
        // order inside buildGroup).
        var selArr = [];
        for (var so = 0; so < sel.length; so++) selArr.push(sel[so]);
        if (selArr.length > 1) {
            try {
                var _layerIndexOf = function (it) {
                    try {
                        var lyr = it.layer, lyrs = doc.layers;
                        for (var li = 0; li < lyrs.length; li++) { if (lyrs[li] === lyr) return li; }
                    } catch (e) {}
                    return 0;
                };
                selArr.sort(function (a, b) {
                    var la = _layerIndexOf(a), lb = _layerIndexOf(b);
                    if (la !== lb) return la - lb;      // lower layer index = more front
                    var za = 0, zb = 0;
                    try { za = a.zOrderPosition; } catch (e1) {}
                    try { zb = b.zOrderPosition; } catch (e2) {}
                    return zb - za;                     // higher zOrderPosition = more front
                });
            } catch (eSort) {
                selArr = [];
                for (var sr = 0; sr < sel.length; sr++) selArr.push(sel[sr]);
            }
        }

        var outItems = [];
        for (var s = 0; s < selArr.length; s++) {
            var topNode = buildItem(selArr[s], "");
            if (topNode) outItems.push(topNode);
        }

        if (outItems.length === 0) {
            return _mtagErr("No supported items in selection." +
                (skipped.length ? " Skipped: " + skipped.join(", ") : ""));
        }

        var artboardWidth = (abRect[2] - abRect[0]) * PT_TO_PX;
        var artboardHeight = (abRect[1] - abRect[3]) * PT_TO_PX;

        return _mtagOk({
            origin: {
                ref: "artboard",
                sourceX: 0, sourceY: 0,
                sourceUnit: "px",
                artboardWidth: artboardWidth,
                artboardHeight: artboardHeight
            },
            options: {
                grouped: !!grouped,
                centerAnchor: !!centerAnchor
            },
            skipped: skipped,
            items: outItems
        });
    } catch (e) {
        return _mtagErr(e.toString());
    }
}

// ---------------- AI color extraction ----------------
// Reads fill/stroke/both solid colors from the selected objects, deduplicates
// them, and returns an array of upper-case hex strings (no '#' prefix) via
// the standard {ok, data} envelope so evalJsx<string[]> can unwrap them.
// mode: "fill" | "stroke" | "both"
function mtagAiExtractColors(mode) {
    try {
        if (!app.documents || app.documents.length === 0) {
            return _mtagErr("No open document.");
        }
        var doc = app.activeDocument;
        var sel = doc.selection;
        if (!sel || sel.length === 0) {
            return _mtagErr("Nothing selected.");
        }

        function hexFromAiColor(c) {
            if (!c) return null;
            var rgb;
            if (c.typename === "RGBColor") {
                rgb = [c.red, c.green, c.blue];
            } else if (c.typename === "CMYKColor") {
                rgb = [
                    Math.round((1 - c.cyan / 100) * (1 - c.black / 100) * 255),
                    Math.round((1 - c.magenta / 100) * (1 - c.black / 100) * 255),
                    Math.round((1 - c.yellow / 100) * (1 - c.black / 100) * 255)
                ];
            } else if (c.typename === "GrayColor") {
                var v = Math.round((1 - c.gray / 100) * 255);
                rgb = [v, v, v];
            } else if (c.typename === "SpotColor") {
                // Resolve the spot's base color, then apply the tint (blend from
                // white toward the full color) so tinted spots aren't extracted
                // at full strength.
                try {
                    var baseHex = hexFromAiColor(c.spot.color);
                    if (!baseHex) return null;
                    var t = (c.tint != null ? c.tint : 100) / 100;
                    var br = parseInt(baseHex.substr(0, 2), 16);
                    var bg = parseInt(baseHex.substr(2, 2), 16);
                    var bb = parseInt(baseHex.substr(4, 2), 16);
                    rgb = [255 - (255 - br) * t, 255 - (255 - bg) * t, 255 - (255 - bb) * t];
                } catch(e) { return null; }
            } else if (c.typename === "GradientColor") {
                // Return first gradient stop as a representative solid
                try {
                    var stops = c.gradient.gradientStops;
                    if (stops.length > 0) return hexFromAiColor(stops[0].color);
                } catch(e) {}
                return null;
            } else {
                return null;
            }
            var toHex = function(n) {
                var h = Math.min(255, Math.max(0, Math.round(n))).toString(16).toUpperCase();
                return h.length === 1 ? "0" + h : h;
            };
            return toHex(rgb[0]) + toHex(rgb[1]) + toHex(rgb[2]);
        }

        var useFill = (mode === "fill" || mode === "both");
        var useStroke = (mode === "stroke" || mode === "both");
        var seen = {};
        var result = [];

        function collect(item) {
            var src = item;
            if (item.typename === "CompoundPathItem") {
                src = item.pathItems && item.pathItems.length > 0 ? item.pathItems[0] : null;
            }
            if (!src) return;
            if (useFill) {
                try {
                    if (src.filled && src.fillColor) {
                        var h = hexFromAiColor(src.fillColor);
                        if (h && !seen[h]) { seen[h] = true; result.push(h); }
                    }
                } catch(e) {}
            }
            if (useStroke) {
                try {
                    if (src.stroked && src.strokeColor) {
                        var hs = hexFromAiColor(src.strokeColor);
                        if (hs && !seen[hs]) { seen[hs] = true; result.push(hs); }
                    }
                } catch(e) {}
            }
        }

        function walk(item) {
            if (item.typename === "PathItem" || item.typename === "CompoundPathItem") {
                collect(item);
            } else if (item.typename === "TextFrame") {
                try {
                    var attrs = item.textRange.characterAttributes;
                    if (useFill && attrs.fillColor) {
                        var h = hexFromAiColor(attrs.fillColor);
                        if (h && !seen[h]) { seen[h] = true; result.push(h); }
                    }
                    if (useStroke && attrs.strokeColor) {
                        var hs = hexFromAiColor(attrs.strokeColor);
                        if (hs && !seen[hs]) { seen[hs] = true; result.push(hs); }
                    }
                } catch(e) {}
            } else if (item.typename === "GroupItem") {
                for (var j = 0; j < item.pageItems.length; j++) walk(item.pageItems[j]);
            }
        }

        for (var i = 0; i < sel.length; i++) walk(sel[i]);

        if (result.length === 0) return _mtagErr("No solid colors found in the selection (" + mode + ").");
        return _mtagOk(result);
    } catch (e) {
        return _mtagErr(e.toString());
    }
}

// ---------------- Photoshop export (PS → AE) ----------------
// Photoshop is raster-native, so a layer maps cleanly onto AE footage: export
// each SELECTED PS layer to its own trimmed PNG and emit an ImageItem the AE
// side already knows how to import (reuses the AI image path). PS doc space is
// top-left origin, y-down — identical to AE comp space — so bbox = layer.bounds
// with no artboard offset. All PS-specific globals (ActionReference,
// executeActionGet, charIDToTypeID, BlendMode, PNGSaveOptions…) are referenced
// only inside these functions, so this file still loads in AI/AE.

function _psPx(u) {
    // layer.bounds returns UnitValue objects; normalise to a plain px number.
    try { return (u && u.as) ? u.as("px") : parseFloat(u); } catch (e) { return parseFloat(u); }
}

// Recursively flatten every layer/layerSet so we can look one up by id.
function _psAllLayers(container, acc) {
    for (var i = 0; i < container.layers.length; i++) {
        var l = container.layers[i];
        acc.push(l);
        if (l.typename === "LayerSet") _psAllLayers(l, acc);
    }
    return acc;
}
function _psLayerById(id) {
    var all = _psAllLayers(app.activeDocument, []);
    for (var i = 0; i < all.length; i++) {
        try { if (all[i].id === id) return all[i]; } catch (e) {}
    }
    return null;
}

// The DOM exposes only ONE active layer; multi-selection lives in the Action
// Manager. Read the `targetLayers` list, map each selection index to a real
// layer id (accounting for the Background-layer index offset), and fall back to
// the single active layer when the list is absent.
function _psSelectedLayerIds() {
    var ids = [];
    try {
        var sidTargetLayers = stringIDToTypeID("targetLayers");
        var ref = new ActionReference();
        ref.putEnumerated(charIDToTypeID("Dcmn"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        var desc = executeActionGet(ref);
        if (desc.hasKey(sidTargetLayers)) {
            var hasBg = false;
            try {
                var layers = app.activeDocument.layers;
                hasBg = layers[layers.length - 1].isBackgroundLayer;
            } catch (e) {}
            var list = desc.getList(sidTargetLayers);
            for (var i = 0; i < list.count; i++) {
                // selIndex is 0-based excluding a Background layer; the layer
                // reference index is 1-based, so add 1 when there's no Background.
                var selIndex = list.getReference(i).getIndex();
                var lref = new ActionReference();
                lref.putIndex(charIDToTypeID("Lyr "), selIndex + (hasBg ? 0 : 1));
                var ldesc = executeActionGet(lref);
                ids.push(ldesc.getInteger(stringIDToTypeID("layerID")));
            }
        }
    } catch (eAM) {
        // Action Manager read failed (older PS, odd doc state) — fall through
        // to the single active layer below.
        ids = [];
    }
    // Fallback: no multi-selection resolved → use the active layer.
    if (ids.length === 0) {
        try { ids.push(app.activeDocument.activeLayer.id); } catch (e2) {}
    }
    return ids;
}

// Map a PS BlendMode enum to the schema's blend-mode string.
function _psBlend(bm) {
    var s = String(bm);
    var map = [
        [BlendMode.MULTIPLY, "multiply"], [BlendMode.SCREEN, "screen"],
        [BlendMode.OVERLAY, "overlay"], [BlendMode.DARKEN, "darken"],
        [BlendMode.LIGHTEN, "lighten"], [BlendMode.COLORDODGE, "colorDodge"],
        [BlendMode.COLORBURN, "colorBurn"], [BlendMode.HARDLIGHT, "hardLight"],
        [BlendMode.SOFTLIGHT, "softLight"], [BlendMode.DIFFERENCE, "difference"],
        [BlendMode.EXCLUSION, "exclusion"], [BlendMode.HUE, "hue"],
        [BlendMode.SATURATION, "saturation"], [BlendMode.COLOR, "color"],
        [BlendMode.LUMINOSITY, "luminosity"]
    ];
    for (var i = 0; i < map.length; i++) {
        if (s === String(map[i][0])) return map[i][1];
    }
    return "normal";
}

// Build an editable TextItem from a PS text layer, reusing the AE text-import
// path (same schema as AI text). Returns null when the layer can't be sent as
// editable text (warp present, or any read failure) so the caller rasterizes
// it to PNG instead. PS text has one dominant style per layer via the DOM;
// mixed per-character runs flatten to that style.
function _psTextItem(layer, left, top, w, h, opacity, blend) {
    try {
        var ti = layer.textItem;
        // Warp doesn't map to AE text — signal the caller to rasterize.
        try { if (ti.warpStyle && String(ti.warpStyle) !== String(WarpStyle.NONE)) return null; } catch (eW) {}

        var contents = "";
        try { contents = ti.contents; } catch (eC) {}

        var font = "ArialMT";
        try { if (ti.font) font = ti.font; } catch (eF) {}

        // ti.size is typographic points; rendered px scales with doc resolution.
        var szPt = 12;
        try { var sz = ti.size; szPt = (sz && sz.as) ? sz.as("pt") : parseFloat(sz); } catch (eS) {}
        var res = 72;
        try { res = app.activeDocument.resolution; } catch (eR) {}
        var fontSizePx = szPt * res / 72;

        var just = "left";
        try {
            var j = String(ti.justification);
            if (j.indexOf("CENTER") !== -1) just = "center";
            else if (j.indexOf("RIGHT") !== -1) just = "right";
        } catch (eJ) {}

        var fills = [];
        try {
            var c = ti.color;
            if (c && c.rgb) {
                fills.push({ kind: "solid", rgba: [c.rgb.red / 255, c.rgb.green / 255, c.rgb.blue / 255, 1] });
            }
        } catch (eCol) {}

        // ti.position is the text origin (baseline start for point text) in px,
        // top-left/y-down — same space as AE. Feed it as aiAnchor so AE places
        // the layer there directly.
        var anchor = null;
        try { var pos = ti.position; anchor = [_psPx(pos[0]), _psPx(pos[1])]; } catch (eP) {}

        var name = (layer.name && layer.name.length)
            ? layer.name
            : (contents ? String(contents).replace(/[\r\n\t]+/g, " ").replace(/^\s+|\s+$/g, "") : "Text");

        return {
            kind: "text",
            name: name,
            text: contents,
            font: font,
            fontSize: fontSizePx,
            justification: just,
            bbox: { x: left, y: top, w: w, h: h },
            aiAnchor: anchor,
            opacity: opacity,
            blendMode: blend,
            appearance: { fills: fills, strokes: [] }
        };
    } catch (e) {
        return null;
    }
}

// Duplicate one layer into a fresh transparent doc, trim to its pixels, save a
// PNG. The trimmed PNG matches layer.bounds, so AE can place it by bbox.
function _psExportLayerToPng(layer, outPath) {
    var srcDoc = app.activeDocument;
    var newDoc = app.documents.add(
        srcDoc.width, srcDoc.height, srcDoc.resolution,
        "__mtag_tmp", NewDocumentMode.RGB, DocumentFill.TRANSPARENT
    );
    try {
        app.activeDocument = srcDoc;
        layer.duplicate(newDoc, ElementPlacement.PLACEATBEGINNING);
        app.activeDocument = newDoc;
        try { newDoc.trim(TrimType.TRANSPARENT, true, true, true, true); } catch (eTrim) {}
        var opts = new PNGSaveOptions();
        opts.compression = 6;
        opts.interlaced = false;
        newDoc.saveAs(new File(outPath), opts, true, Extension.LOWERCASE);
    } finally {
        try { newDoc.close(SaveOptions.DONOTSAVECHANGES); } catch (eClose) {}
        app.activeDocument = srcDoc;
    }
}

// Panel entry point (PS side). Exports each selected layer to a PNG and returns
// an ArtworkPayload of ImageItems for AE. grouped/centerAnchor are carried for
// AE-side placement; each layer is always its own footage layer.
function mtagSwitchPsExport(grouped, centerAnchor) {
    try {
        if (!app.documents || app.documents.length === 0) return _mtagErr("No open document.");
        var doc = app.activeDocument;
        var ids = _psSelectedLayerIds();
        if (!ids || ids.length === 0) return _mtagErr("No layers selected.");

        var outItems = [];
        var skipped = [];
        for (var i = 0; i < ids.length; i++) {
            var layer = _psLayerById(ids[i]);
            if (!layer) continue;

            var b;
            try { b = layer.bounds; } catch (eB) { b = null; }
            if (!b) { skipped.push("layer (no bounds)"); continue; }
            var left = _psPx(b[0]), top = _psPx(b[1]), right = _psPx(b[2]), bottom = _psPx(b[3]);
            var w = right - left, h = bottom - top;
            if (!(w >= 1 && h >= 1)) { skipped.push("'" + layer.name + "' (empty/no pixels)"); continue; }

            var op = 1;
            try { op = layer.opacity / 100; } catch (eO) {}
            var blend = "normal";
            try { blend = _psBlend(layer.blendMode); } catch (eBl) {}

            // Editable text: a text layer (with no warp) → AE text layer. Any
            // failure or a warp falls through to the raster path below.
            var isText = false;
            try { isText = (layer.kind === LayerKind.TEXT); } catch (eK) {}
            if (isText) {
                var textItem = _psTextItem(layer, left, top, w, h, op, blend);
                if (textItem) { outItems.push(textItem); continue; }
                // else: warp/rich text → rasterize, noting the downgrade.
                skipped.push("'" + layer.name + "' (text warped/unsupported → sent as image)");
            }

            var outPath = _mtagTempPath("mtag_ps_" + i + "_" + (new Date().getTime()) + ".png");
            try {
                _psExportLayerToPng(layer, outPath);
            } catch (eExp) {
                skipped.push("'" + layer.name + "' (export failed: " + eExp.toString() + ")");
                continue;
            }

            outItems.push({
                kind: "image",
                name: layer.name || ("Layer " + (i + 1)),
                bbox: { x: left, y: top, w: w, h: h },
                sourcePath: String(outPath).replace(/\\/g, "/"),
                linked: false,
                opacity: op,
                blendMode: blend
            });
        }

        if (outItems.length === 0) {
            return _mtagErr("Nothing exportable in selection." +
                (skipped.length ? " Skipped: " + skipped.join(", ") : ""));
        }

        return _mtagOk({
            origin: {
                ref: "comp-center",
                sourceX: 0, sourceY: 0, sourceUnit: "px",
                artboardWidth: _psPx(doc.width), artboardHeight: _psPx(doc.height)
            },
            options: { grouped: !!grouped, centerAnchor: !!centerAnchor },
            skipped: skipped,
            items: outItems
        });
    } catch (e) {
        return _mtagErr(e.toString());
    }
}

// ---------------- shared helpers (AE side) ----------------

// Map the schema's blend-mode string to AE's BlendingMode enum for layers.
function _mtagAeBlend(str) {
    switch (str) {
        case "multiply":   return BlendingMode.MULTIPLY;
        case "screen":     return BlendingMode.SCREEN;
        case "overlay":    return BlendingMode.OVERLAY;
        case "darken":     return BlendingMode.DARKEN;
        case "lighten":    return BlendingMode.LIGHTEN;
        case "colorDodge": return BlendingMode.CLASSIC_COLOR_DODGE;
        case "colorBurn":  return BlendingMode.CLASSIC_COLOR_BURN;
        case "hardLight":  return BlendingMode.HARD_LIGHT;
        case "softLight":  return BlendingMode.SOFT_LIGHT;
        case "difference": return BlendingMode.DIFFERENCE;
        case "exclusion":  return BlendingMode.EXCLUSION;
        case "hue":        return BlendingMode.HUE;
        case "saturation": return BlendingMode.SATURATION;
        case "color":      return BlendingMode.COLOR;
        case "luminosity": return BlendingMode.LUMINOSITY;
        default:           return BlendingMode.NORMAL;
    }
}

// AE cap/join integer enums.
function _mtagAeCap(str) { return str === "round" ? 2 : str === "square" ? 3 : 1; }
function _mtagAeJoin(str) { return str === "round" ? 2 : str === "bevel" ? 3 : 1; }

// True if any fill or stroke of the item is a gradient. Historically this forced
// isolation onto its own layer in grouped mode, because the old Gradient Ramp
// fallback was layer-wide and tinted siblings. Gradients now apply as real
// per-group G-Fill/G-Stroke operators (via the .ffx preset), so they NO LONGER
// need isolation and can share the grouped layer. Kept for reference / the rare
// case where a gradient degrades to the layer-wide Ramp fallback.
function _mtagItemHasGradient(item) {
    var a = item.appearance;
    if (!a) return false;
    var i;
    if (a.fills) {
        for (i = 0; i < a.fills.length; i++) {
            if (a.fills[i] && a.fills[i].kind === "gradient") return true;
        }
    }
    if (a.strokes) {
        for (i = 0; i < a.strokes.length; i++) {
            if (a.strokes[i] && a.strokes[i].paint && a.strokes[i].paint.kind === "gradient") return true;
        }
    }
    return false;
}

// True if the item has a non-normal blend mode. AE blend modes live on the
// LAYER, not on a shape group, so a grouped item's blend mode would be lost if
// it shared a layer. Such items are isolated onto their own layer (like
// gradients) so the blend mode can actually be applied.
function _mtagItemHasBlend(item) {
    return !!(item.blendMode && item.blendMode !== "normal");
}

// An item must own its layer (even in grouped mode) only if it carries a
// layer-level property that can't live on a shared shape layer — i.e. a
// non-normal blend mode. Gradients used to force this too, but they now apply
// per shape group (see _mtagItemHasGradient) and share the grouped layer fine.
function _mtagItemNeedsOwnLayer(item) {
    return _mtagItemHasBlend(item);
}

// Build the flat value array AE's "Gradient Colors" property expects:
// color stops first ([pos, r, g, b] each), then alpha stops ([pos, alpha]
// each), with equal counts. Stop midpoints are NOT representable here (AE fixes
// them at 0.5), so they're dropped — logged by the caller as a downgrade.
function _mtagGradValue(stops) {
    // AE expects stops in ascending position order; AI usually provides them
    // sorted but doesn't guarantee it. Copy + sort defensively.
    var sorted = stops.slice().sort(function (a, b) { return a.offset - b.offset; });
    var colorArr = [];
    var alphaArr = [];
    for (var i = 0; i < sorted.length; i++) {
        var s = sorted[i];
        var pos = s.offset;
        colorArr.push(pos, s.rgba[0], s.rgba[1], s.rgba[2]);
        alphaArr.push(pos, (s.rgba[3] == null ? 1 : s.rgba[3]));
    }
    return colorArr.concat(alphaArr);
}

// Remove an orphaned gradient operator that AE may leave in the group after
// addProperty threw an internal verification failure. Scans from the tail (the
// just-attempted operator is last) and removes the first match found there.
function _mtagStripTrailingGrad(groupContents, matchName) {
    try {
        for (var p = groupContents.numProperties; p >= 1; p--) {
            var pr = groupContents.property(p);
            if (pr && pr.matchName === matchName) {
                try { pr.remove(); } catch (e1) {}
                return;
            }
        }
    } catch (e2) {}
}

// Add a fill operator (solid or gradient) to a shape group's Contents.
// shapeLayer is needed for the Ramp effect fallback when gradient colors
// can't be set via setValue (AE scripting limitation).
// Returns a warnings array.
function _mtagAddFill(groupContents, paint, shapeLayer) {
    var warnings = [];
    if (paint.kind === "gradient") {
        // NOTE: addProperty("ADBE Vector Graphic - G-Fill") itself can THROW an
        // "internal verification failure" on some AE builds (seen on AE 2026/v26:
        // matchName G-Fill mismatch with resultP expected Fill). It must stay
        // inside the try so a throw degrades to the Ramp/solid fallback below
        // instead of aborting the entire beam. _mtagStripTrailingGrad cleans up
        // any orphaned operator AE may leave behind after the failed add.
        var gf = null;
        var gradSet = false;
        var gradViaPreset = false;
        try {
            gf = groupContents.addProperty("ADBE Vector Graphic - G-Fill");
            gf.property("ADBE Vector Grad Type").setValue(paint.type === "radial" ? 2 : 1);
            gf.property("ADBE Vector Grad Start Pt").setValue(paint.start);
            gf.property("ADBE Vector Grad End Pt").setValue(paint.end);
            // PRIMARY color path: patch the stops with AE's own .ffx serialization
            // (real N stops + midpoints), mirroring AEUX. Falls back to the
            // reverse-engineered flat-array setValue if the preset helper is
            // absent or the apply fails.
            if (typeof _mtagApplyGradColorsPreset === "function" &&
                _mtagApplyGradColorsPreset(shapeLayer, gf, paint.stops)) {
                gradViaPreset = true;
            } else {
                gf.property("ADBE Vector Grad Colors").setValue(_mtagGradValue(paint.stops));
            }
            gradSet = true;
        } catch (eg) {
            gradSet = false;
        }
        if (!gradSet) {
            // G-Fill add or Grad Colors setValue failed on this AE version
            // (notably AE 2026/v26). Clean up any orphaned operator first.
            try { if (gf) gf.remove(); } catch(er) {}
            _mtagStripTrailingGrad(groupContents, "ADBE Vector Graphic - G-Fill");
            // FIRST fallback: apply a pre-built gradient .ffx preset, which
            // injects a valid G-Fill stream without the scripted addProperty
            // that v26 rejects, preserving all stops + midpoints. Only fires if
            // the helper loaded; degrades to the Ramp path below on any failure.
            if (typeof _mtagApplyGradientFillPreset === "function" && shapeLayer) {
                try {
                    if (_mtagApplyGradientFillPreset(shapeLayer, groupContents, paint)) {
                        if (paint.stops.length > 8) warnings.push("gradient had " + paint.stops.length + " stops; preset supports max 8 (extra stops dropped)");
                        warnings.push("gradient applied via .ffx preset (native G-Fill unavailable on this AE build)");
                        return warnings;
                    }
                } catch (ePreset) {}
            }
            // SECOND fallback: add a solid so the shape is visible, then apply
            // the ADBE Ramp effect to approximate the gradient (2-stop).
            var sf = groupContents.addProperty("ADBE Vector Graphic - Fill");
            // Use last stop color so the shape at least shows the end color
            var sLast = paint.stops[paint.stops.length - 1] || paint.stops[0] || { rgba: [0,0,0,1] };
            sf.property("Color").setValue([sLast.rgba[0], sLast.rgba[1], sLast.rgba[2]]);
            sf.property("Opacity").setValue((sLast.rgba[3] == null ? 1 : sLast.rgba[3]) * 100);
            // Apply ADBE Ramp (Gradient Ramp) effect on the layer for the 2-stop approximation
            if (shapeLayer && paint.stops.length >= 2) {
                try {
                    var ramp = shapeLayer.property("Effects").addProperty("ADBE Ramp");
                    var s0 = paint.stops[0];
                    var s1 = paint.stops[paint.stops.length - 1];
                    ramp.property("ADBE Ramp-0001").setValue(paint.start);
                    ramp.property("ADBE Ramp-0002").setValue([s0.rgba[0], s0.rgba[1], s0.rgba[2]]);
                    ramp.property("ADBE Ramp-0003").setValue(paint.end);
                    ramp.property("ADBE Ramp-0004").setValue([s1.rgba[0], s1.rgba[1], s1.rgba[2]]);
                    // Ramp shape: 1=linear, 2=radial
                    ramp.property("ADBE Ramp-0005").setValue(paint.type === "radial" ? 2 : 1);
                    warnings.push("gradient applied via Gradient Ramp effect (2-stop approximation; AE scripting limitation on Grad Colors)");
                } catch(eRamp) {
                    warnings.push("gradient fill downgraded to solid (Ramp effect also failed): " + eRamp.toString());
                }
            } else {
                warnings.push("gradient fill downgraded to solid (AE scripting limitation on Grad Colors)");
            }
        } else if (!gradViaPreset) {
            // Only the reverse-engineered setValue path flattens midpoints; the
            // .ffx preset carries them, so skip the warning when it was used.
            var anyMid = false;
            for (var m = 0; m < paint.stops.length; m++) {
                if (paint.stops[m].midpoint != null && Math.abs(paint.stops[m].midpoint - 0.5) > 0.001) anyMid = true;
            }
            if (anyMid) warnings.push("gradient midpoints flattened to 0.5 (AE limitation)");
        }
        return warnings;
    }
    var fillProp = groupContents.addProperty("ADBE Vector Graphic - Fill");
    fillProp.property("Color").setValue([paint.rgba[0], paint.rgba[1], paint.rgba[2]]);
    fillProp.property("Opacity").setValue((paint.rgba[3] == null ? 1 : paint.rgba[3]) * 100);
    return warnings;
}

// Build a live parametric shape (Rect/Ellipse/Polystar) inside a vector group
// from a ParametricShape descriptor. Position is the shape's absolute comp
// center (layers sit at [0,0], matching the baked-path convention). Returns
// true if the shape prop was created, false to fall back to the bezier path.
// Note: AE's real matchNames misspell roundness as "Roundess" — intentional.
function _mtagAddParametricShape(groupContents, shape) {
    if (shape.type === "rect") {
        var rc = groupContents.addProperty("ADBE Vector Shape - Rect");
        try { rc.property("ADBE Vector Rect Size").setValue(shape.size); } catch (e1) {}
        try { rc.property("ADBE Vector Rect Position").setValue(shape.center); } catch (e2) {}
        try { if (shape.roundness) rc.property("ADBE Vector Rect Roundness").setValue(shape.roundness); } catch (e3) {}
        return true;
    }
    if (shape.type === "ellipse") {
        var el = groupContents.addProperty("ADBE Vector Shape - Ellipse");
        try { el.property("ADBE Vector Ellipse Size").setValue(shape.size); } catch (e4) {}
        try { el.property("ADBE Vector Ellipse Position").setValue(shape.center); } catch (e5) {}
        return true;
    }
    if (shape.type === "polystar") {
        var st = groupContents.addProperty("ADBE Vector Shape - Star");
        try { st.property("ADBE Vector Star Type").setValue(shape.star ? 1 : 2); } catch (e6) {}  // 1=star, 2=polygon
        try { st.property("ADBE Vector Star Points").setValue(shape.points); } catch (e7) {}
        try { st.property("ADBE Vector Star Position").setValue(shape.center); } catch (e8) {}
        try { st.property("ADBE Vector Star Rotation").setValue(shape.rotation || 0); } catch (e9) {}
        try { st.property("ADBE Vector Star Outer Radius").setValue(shape.outerRadius); } catch (e10) {}
        try { if (shape.outerRoundness != null) st.property("ADBE Vector Star Outer Roundess").setValue(shape.outerRoundness); } catch (e11) {}
        if (shape.star) {
            try { st.property("ADBE Vector Star Inner Radius").setValue(shape.innerRadius); } catch (e12) {}
            try { if (shape.innerRoundness != null) st.property("ADBE Vector Star Inner Roundess").setValue(shape.innerRoundness); } catch (e13) {}
        }
        return true;
    }
    return false;
}

// Add a stroke operator (solid or gradient) with width/cap/join/miter/dashes.
function _mtagAddStroke(groupContents, stroke, shapeLayer) {
    var warnings = [];
    var paint = stroke.paint;
    var strokeProp;
    if (paint.kind === "gradient") {
        // See _mtagAddFill: the G-Stroke add can throw an internal verification
        // failure on some AE builds (AE 2026/v26). Keep it inside the try so it
        // degrades to a solid stroke instead of aborting the whole beam.
        strokeProp = null;
        var gradSet = false;
        try {
            strokeProp = groupContents.addProperty("ADBE Vector Graphic - G-Stroke");
            strokeProp.property("ADBE Vector Grad Type").setValue(paint.type === "radial" ? 2 : 1);
            strokeProp.property("ADBE Vector Grad Start Pt").setValue(paint.start);
            strokeProp.property("ADBE Vector Grad End Pt").setValue(paint.end);
            // Grad Colors matchName is shared with G-Fill, so the same fill .ffx
            // preset patches the selected G-Stroke's stops (real N stops +
            // midpoints). Falls back to the reverse-engineered setValue.
            if (!(typeof _mtagApplyGradColorsPreset === "function" &&
                  _mtagApplyGradColorsPreset(shapeLayer, strokeProp, paint.stops))) {
                strokeProp.property("ADBE Vector Grad Colors").setValue(_mtagGradValue(paint.stops));
            }
            gradSet = true;
        } catch (egs) {
            gradSet = false;
        }
        if (!gradSet) {
            try { if (strokeProp) strokeProp.remove(); } catch(er) {}
            _mtagStripTrailingGrad(groupContents, "ADBE Vector Graphic - G-Stroke");
            strokeProp = groupContents.addProperty("ADBE Vector Graphic - Stroke");
            var s0 = paint.stops[0] || { rgba: [0, 0, 0, 1] };
            strokeProp.property("Color").setValue([s0.rgba[0], s0.rgba[1], s0.rgba[2]]);
            warnings.push("gradient stroke downgraded to solid (AE scripting limitation on Grad Colors)");
        }
    } else {
        strokeProp = groupContents.addProperty("ADBE Vector Graphic - Stroke");
        strokeProp.property("Color").setValue([paint.rgba[0], paint.rgba[1], paint.rgba[2]]);
        strokeProp.property("Opacity").setValue((paint.rgba[3] == null ? 1 : paint.rgba[3]) * 100);
    }

    strokeProp.property("ADBE Vector Stroke Width").setValue(stroke.width || 1);
    try { strokeProp.property("ADBE Vector Stroke Line Cap").setValue(_mtagAeCap(stroke.cap)); } catch (e1) {}
    try { strokeProp.property("ADBE Vector Stroke Line Join").setValue(_mtagAeJoin(stroke.join)); } catch (e2) {}
    try { strokeProp.property("ADBE Vector Stroke Miter Limit").setValue(stroke.miterLimit || 4); } catch (e3) {}

    // Dashes: AE stores dash/gap as sibling sliders under the stroke's Dashes
    // group. Alternate dash → gap → dash → gap. Offset is a single slider.
    if (stroke.dashes && stroke.dashes.length) {
        try {
            var dashGroup = strokeProp.property("ADBE Vector Stroke Dashes");
            for (var di = 0; di < stroke.dashes.length; di++) {
                var isGap = (di % 2) === 1;
                var mn = isGap ? ("ADBE Vector Stroke Gap " + Math.ceil((di + 1) / 2))
                               : ("ADBE Vector Stroke Dash " + (Math.floor(di / 2) + 1));
                var dp = dashGroup.addProperty(mn);
                dp.setValue(stroke.dashes[di]);
            }
            if (stroke.dashOffset) {
                var offProp = dashGroup.addProperty("ADBE Vector Stroke Offset");
                offProp.setValue(stroke.dashOffset);
            }
        } catch (eDash) {
            warnings.push("dash pattern not fully applied: " + eDash.toString());
        }
    }
    return warnings;
}

// ---------------- Per-project settings (AE side) ----------------
// AE persists a project's XMP metadata packet (RDF/XML) INSIDE the .aep via
// app.project.xmpPacket. We stash MTAG's per-project settings there as a JSON
// blob under our own namespace, so e.g. the image export folder travels with
// the project file and differs per project. Requires the AdobeXMPScript
// ExternalObject (bundled with AE).

var _MTAG_XMP_NS = "http://motiontoolbar.com/xmp/1.0/";
var _MTAG_XMP_PREFIX = "mtag:";
var _MTAG_XMP_PROP = "mtagSettings";

function _mtagLoadXmpLib() {
    if (typeof ExternalObject === "undefined") return false;
    try {
        if (ExternalObject.AdobeXMPScript == undefined) {
            ExternalObject.AdobeXMPScript = new ExternalObject("lib:AdobeXMPScript");
        }
        XMPMeta.registerNamespace(_MTAG_XMP_NS, _MTAG_XMP_PREFIX);
        return true;
    } catch (e) {
        return false;
    }
}

// Returns the parsed settings object stored on the active project ({} if none).
function _mtagReadProjectSettings() {
    if (!app.project) return {};
    if (!_mtagLoadXmpLib()) return {};
    var packet = app.project.xmpPacket || "";
    if (!packet) return {};
    var xmp = new XMPMeta(packet);
    if (!xmp.doesPropertyExist(_MTAG_XMP_NS, _MTAG_XMP_PROP)) return {};
    var val = xmp.getProperty(_MTAG_XMP_NS, _MTAG_XMP_PROP);
    var str = val ? val.toString() : "";
    if (!str) return {};
    try { return JSON.parse(str) || {}; } catch (e) { return {}; }
}

// Panel entry point: read all per-project settings.
function mtagGetProjectSettings() {
    try {
        if (!app.project) return _mtagErr("No project open.");
        if (typeof ExternalObject === "undefined") return _mtagErr("XMP scripting unavailable in this host.");
        return _mtagOk(_mtagReadProjectSettings());
    } catch (e) {
        return _mtagErr(e.toString());
    }
}

// Panel entry point: set one key. Writing marks the project dirty; the value
// only reaches disk when the user saves the .aep. Returns the merged settings.
function mtagSetProjectSetting(key, value) {
    try {
        if (!app.project) return _mtagErr("No project open.");
        if (!_mtagLoadXmpLib()) return _mtagErr("XMP scripting unavailable in this host.");
        var packet = app.project.xmpPacket || "";
        var xmp = packet ? new XMPMeta(packet) : new XMPMeta();
        var current = {};
        if (xmp.doesPropertyExist(_MTAG_XMP_NS, _MTAG_XMP_PROP)) {
            try { current = JSON.parse(xmp.getProperty(_MTAG_XMP_NS, _MTAG_XMP_PROP).toString()) || {}; }
            catch (ep) { current = {}; }
        }
        current[key] = value;
        xmp.setProperty(_MTAG_XMP_NS, _MTAG_XMP_PROP, JSON.stringify(current));
        app.project.xmpPacket = xmp.serialize();
        return _mtagOk(current);
    } catch (e) {
        return _mtagErr(e.toString());
    }
}

// Returns the folder containing the saved .aep. Errors when the project has
// never been saved (no file on disk) so the panel can prompt the user to save.
function mtagGetProjectDir() {
    try {
        if (!app.project) return _mtagErr("No project open.");
        if (!app.project.file) return _mtagErr("unsaved");
        return _mtagOk({ dir: app.project.file.parent.fsName.replace(/\\/g, "/") });
    } catch (e) {
        return _mtagErr(e.toString());
    }
}

// Native folder picker. `defaultPath` (optional) sets the initial location.
// Returns { path } on selection or { cancelled:true } if dismissed.
function mtagPickFolder(defaultPath) {
    try {
        var start = null;
        if (defaultPath) {
            var f = new Folder(defaultPath);
            if (f.exists) start = f;
        }
        var picked = start
            ? start.selectDlg("Select image export folder")
            : Folder.selectDialog("Select image export folder");
        if (!picked) return _mtagOk({ cancelled: true });
        return _mtagOk({ path: picked.fsName.replace(/\\/g, "/") });
    } catch (e) {
        return _mtagErr(e.toString());
    }
}

// Resolve the folder that imported images are copied into, in priority order:
// the project's per-project imageExportDir (XMP), else an "MTAG_Images" folder
// next to a saved .aep, else the OS temp dir. Always returns an existing Folder.
function _mtagResolveImageDir() {
    var dir = null;
    try {
        var s = _mtagReadProjectSettings();
        if (s && s.imageExportDir) dir = s.imageExportDir;
    } catch (e) {}
    var f;
    if (dir) {
        f = new Folder(dir);
        if (!f.exists) { try { f.create(); } catch (e2) {} }
        if (f.exists) return f;
    }
    if (app.project.file) {
        try {
            f = new Folder(app.project.file.parent.fsName + "/MTAG_Images");
            if (!f.exists) f.create();
            if (f.exists) return f;
        } catch (e3) {}
    }
    f = new Folder(Folder.temp.fsName + "/MTAG_Images");
    if (!f.exists) { try { f.create(); } catch (e4) {} }
    return f;
}

function _mtagSameFile(a, b) {
    try { return a.fsName === b.fsName; } catch (e) { return false; }
}

// Add a clipping path as a layer mask (works on shape/text/footage layers).
// clipSubpaths are in absolute comp space, matching the layer's [0,0] base
// transform, so the mask lines up with the content. Multiple subpaths → multiple
// Add-mode masks (union). Masks must be closed.
function _mtagAddLayerMask(layer, clipSubpaths, warnings) {
    if (!clipSubpaths || !clipSubpaths.length) return;
    try {
        var parade = layer.property("ADBE Mask Parade");
        for (var i = 0; i < clipSubpaths.length; i++) {
            var sp = clipSubpaths[i];
            var maskAtom = parade.addProperty("ADBE Mask Atom");
            var shape = new Shape();
            shape.vertices = sp.vertices;
            shape.inTangents = sp.inTangents;
            shape.outTangents = sp.outTangents;
            shape.closed = true;
            maskAtom.property("ADBE Mask Shape").setValue(shape);
        }
    } catch (e) {
        if (warnings) warnings.push("clip mask not applied: " + e.toString());
    }
}

// Flatten the payload tree (group nodes → their leaves) into a flat leaf list,
// matching the pre-tree render behaviour. Along the way it (a) multiplies
// ancestor group opacity into each leaf and (b) tags leaves inside a clipping
// group with the clip geometry + a shared clip id, so clipped siblings land on
// one masked layer. Nested vector-group hierarchy itself is intentionally
// flattened here (AE renders identically); clipping is the behavioural part.
function _mtagFlattenItems(nodes) {
    var flat = [];
    var clipSeq = { n: 0 };
    function walk(list, clip, clipId, clipName, opMul) {
        for (var i = 0; i < list.length; i++) {
            var nd = list[i];
            if (nd && nd.kind === "group") {
                var c = clip, cid = clipId, cname = clipName;
                if (nd.clip && nd.clip.length) {
                    c = nd.clip; cid = "clip" + (clipSeq.n++); cname = nd.name || "Clip Group";
                }
                var mul = opMul * (nd.opacity != null ? nd.opacity : 1);
                walk(nd.children || [], c, cid, cname, mul);
            } else if (nd) {
                if (clip) { nd.__clip = clip; nd.__clipId = clipId; nd.__clipName = clipName; }
                if (opMul < 1) nd.opacity = (nd.opacity != null ? nd.opacity : 1) * opMul;
                flat.push(nd);
            }
        }
    }
    walk(nodes, null, null, null, 1);
    return flat;
}

// ---------------- After Effects import ----------------
// Creates a shape layer in the active comp from an ArtworkPayload: one shape
// group holding all subpaths, with fills and strokes stacked so strokes render
// over fills. Applies object opacity + blend mode at the layer level.
// Group nodes are flattened (see _mtagFlattenItems); clipping groups become
// masked layers.
function mtagSwitchAeImport(jsonString) {
    try {
        var payload = JSON.parse(jsonString);
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return _mtagErr("No active composition.");
        }
        var items = payload.items;
        if (!items || items.length === 0) return _mtagErr("Payload has no items.");
        // Flatten group nodes → leaves (carrying clip + group-opacity info).
        items = _mtagFlattenItems(items);
        if (items.length === 0) return _mtagErr("Payload has no renderable items.");

        var options = payload.options || { grouped: true, centerAnchor: false };
        var warnings = [];

        app.beginUndoGroup("MTAG Switch: Import");

        var groupedShapeLayer = null;
        // Clipping groups: one masked shape layer per clip id, keyed here. Masks
        // are applied after all paths are added.
        var clipLayers = {};
        // Gradient items in grouped mode get isolated onto their own layers
        // (see _mtagItemHasGradient). Tracked here so the final alignment block
        // positions them together with the grouped layer.
        var isolatedLayers = [];
        var isolatedNoted = false;
        var totalFills = 0, totalStrokes = 0;

        // Comp multiplier (Overlord parity): scale incoming art so an AI artboard
        // maps onto a differently-sized comp (e.g. hi-res boards, or a comp that
        // isn't 1:1 with the artboard). Mirrors AEUX getCompMultiplier =
        // comp.width / artboardWidth. Defaults to 1 when sizes match / unknown,
        // so the common 1:1 case is byte-identical to before. Because every layer
        // sits at anchor A / position A*M with Scale = M, each point P maps to
        // P*M (uniform scale about the comp origin), keeping vectors, text and
        // images consistent. Uniform width-ratio scale (AEUX does the same) —
        // differing aspect ratios scale by width, may overflow height.
        var compMul = 1;
        try {
            var _abW = payload.origin && payload.origin.artboardWidth;
            if (_abW && _abW > 0 && comp.width > 0) compMul = comp.width / _abW;
            if (!isFinite(compMul) || compMul <= 0) compMul = 1;
        } catch (eMul) { compMul = 1; }
        // Scale a point (or scalar) by the comp multiplier.
        function _mtagM(p) {
            if (p == null) return p;
            if (p.length != null) return [p[0] * compMul, p[1] * compMul];
            return p * compMul;
        }

        // Preserve AI's front-to-back z-order: AI's frontmost object (items[0],
        // which _mtagFlattenItems emits first) must become the TOP AE layer.
        // comp.layers.add* always inserts at the top (index 1), so adding items
        // in order would REVERSE them (last added ends on top, hiding the rest —
        // the reported bug). Moving each newly created layer just below the
        // previously created one keeps items[0] on top and the rest in order.
        // Also stamps the comp-multiplier scale on each layer (images override it
        // with their own fit-scale * compMul).
        var _lastImportLayer = null;
        function _mtagOrderLayer(lyr) {
            if (!lyr) return lyr;
            if (_lastImportLayer) { try { lyr.moveAfter(_lastImportLayer); } catch (eMv) {} }
            _lastImportLayer = lyr;
            if (compMul !== 1) {
                try { lyr.property("Transform").property("Scale").setValue([compMul * 100, compMul * 100]); } catch (eSc) {}
            }
            return lyr;
        }

        for (var idx = 0; idx < items.length; idx++) {
            var item = items[idx];
            
            if (item.kind === "text") {
                // Area text → a box/paragraph text layer so wrapping is kept;
                // point/path text → a normal point-text layer.
                var textLayer;
                if (item.textKind === "area" && item.boxSize && comp.layers.addBoxText) {
                    try {
                        textLayer = comp.layers.addBoxText(item.boxSize, item.text);
                    } catch (eBox) {
                        textLayer = comp.layers.addText(item.text);
                    }
                } else {
                    textLayer = comp.layers.addText(item.text);
                    if (item.textKind === "path") warnings.push("text '" + (item.name || "") + "' was on a path → imported as point text");
                }
                textLayer.name = item.name || "Text";
                _mtagOrderLayer(textLayer);

                var textProp = textLayer.property("Source Text");
                var textDoc = textProp.value;
                textDoc.font = item.font;
                textDoc.fontSize = item.fontSize;
                
                if (item.justification === "center") textDoc.justification = ParagraphJustification.CENTER_JUSTIFY;
                else if (item.justification === "right") textDoc.justification = ParagraphJustification.RIGHT_JUSTIFY;
                else textDoc.justification = ParagraphJustification.LEFT_JUSTIFY;
                
                var appr = item.appearance || {};
                var fills = appr.fills || [];
                var strokes = appr.strokes || [];
                
                if (fills.length > 0) {
                    var f = fills[0];
                    if (f.kind === "solid") {
                        textDoc.fillColor = [f.rgba[0], f.rgba[1], f.rgba[2]];
                        textDoc.applyFill = true;
                    } else {
                        textDoc.applyFill = false;
                    }
                } else {
                    textDoc.applyFill = false;
                }
                
                if (strokes.length > 0) {
                    var s = strokes[0];
                    if (s.paint && s.paint.kind === "solid") {
                        textDoc.strokeColor = [s.paint.rgba[0], s.paint.rgba[1], s.paint.rgba[2]];
                        textDoc.strokeWidth = s.width || 1;
                        textDoc.applyStroke = true;
                    } else {
                        textDoc.applyStroke = false;
                    }
                } else {
                    textDoc.applyStroke = false;
                }
                
                textProp.setValue(textDoc);

                // Multi-style text: apply each run's font/size/fill to its
                // character range. Requires AE's per-character CharacterRange API
                // (newer AE); otherwise the dominant style above stands.
                if (item.runs && item.runs.length > 1) {
                    var perRunOk = false;
                    try {
                        if (typeof textProp.characterRange === "function") {
                            var total = 0;
                            for (var rt = 0; rt < item.runs.length; rt++) total += item.runs[rt].text.length;
                            if (total === String(item.text).length) {
                                var off = 0;
                                for (var rn = 0; rn < item.runs.length; rn++) {
                                    var run = item.runs[rn];
                                    var len = run.text.length;
                                    if (len > 0) {
                                        var cr = textProp.characterRange(off, off + len);
                                        try { cr.font = run.font; } catch (eF) {}
                                        try { cr.fontSize = run.fontSize; } catch (eZ) {}
                                        try {
                                            if (run.fillRgba) {
                                                cr.applyFill = true;
                                                cr.fillColor = [run.fillRgba[0], run.fillRgba[1], run.fillRgba[2]];
                                            }
                                        } catch (eCol) {}
                                    }
                                    off += len;
                                }
                                perRunOk = true;
                            }
                        }
                    } catch (eRange) { perRunOk = false; }
                    if (!perRunOk) warnings.push("multi-style text '" + (item.name || "") + "' flattened to dominant style (per-character styling unavailable)");
                }

                if (item.opacity != null && item.opacity < 1) {
                    textLayer.property("Transform").property("Opacity").setValue(item.opacity * 100);
                }
                if (item.blendMode && item.blendMode !== "normal") {
                    try { textLayer.blendingMode = _mtagAeBlend(item.blendMode); } catch (eBl) {}
                }
                
                var bbox = item.bbox || { x: 0, y: 0, w: 100, h: 100 };
                if (item.aiAnchor) {
                    textLayer.property("Transform").property("Position").setValue(_mtagM(item.aiAnchor));
                } else {
                    var posX = bbox.x;
                    if (item.justification === "center") posX = bbox.x + bbox.w / 2;
                    else if (item.justification === "right") posX = bbox.x + bbox.w;
                    textLayer.property("Transform").property("Position").setValue(_mtagM([posX, bbox.y + bbox.h]));
                }

                if (options.centerAnchor) {
                    try {
                        // sourceRectAtTime is in layer (pre-transform) space, so the
                        // anchor is unscaled; the offset added to position must be
                        // scaled by the comp multiplier to stay put visually.
                        var rect = textLayer.sourceRectAtTime(comp.time, false);
                        var ax = rect.left + rect.width / 2;
                        var ay = rect.top + rect.height / 2;
                        var oldPos = textLayer.property("Transform").property("Position").value;
                        textLayer.property("Transform").property("Anchor Point").setValue([ax, ay]);
                        textLayer.property("Transform").property("Position").setValue([oldPos[0] + ax * compMul, oldPos[1] + ay * compMul]);
                    } catch(eText) {}
                }

                if (item.__clip) warnings.push("clip group: text '" + (item.name || "") + "' left unclipped (text masking not supported)");

            } else if (item.kind === "path") {
                var geom = item.geometry;
                var appr = item.appearance || { fills: [], strokes: [] };
                var fills = appr.fills || [];
                var strokes = appr.strokes || [];
                
                // Clipped items share one masked layer per clip group (a layer
                // mask would otherwise clip unrelated grouped siblings).
                var clipId = item.__clipId || null;
                // Gradient items (layer-wide Ramp fallback) and blend-mode items
                // (blend lives on the layer) can't safely share the grouped
                // layer. Isolate them onto their own layer, which is aligned
                // with the group at the end.
                var isolated = !clipId && options.grouped && _mtagItemNeedsOwnLayer(item);
                var ownLayer = !clipId && ((!options.grouped) || isolated);

                var layerToUse, targetContents;
                if (clipId) {
                    if (!clipLayers[clipId]) {
                        var cl = comp.layers.addShape();
                        cl.name = item.__clipName || "Clip Group";
                        cl.property("Transform").property("Anchor Point").setValue([0, 0]);
                        cl.property("Transform").property("Position").setValue([0, 0]);
                        clipLayers[clipId] = { layer: cl, clip: item.__clip };
                        isolatedLayers.push(cl); // aligned with the group at the end
                        _mtagOrderLayer(cl);
                    }
                    layerToUse = clipLayers[clipId].layer;
                    targetContents = layerToUse.property("Contents");
                } else if (ownLayer) {
                    layerToUse = comp.layers.addShape();
                    layerToUse.name = item.name || "Shape";
                    // Neutralise the default transform so path coords map 1:1 to
                    // comp space; final positioning happens below / at the end.
                    layerToUse.property("Transform").property("Anchor Point").setValue([0, 0]);
                    layerToUse.property("Transform").property("Position").setValue([0, 0]);
                    _mtagOrderLayer(layerToUse);
                    targetContents = layerToUse.property("Contents");
                    if (isolated) {
                        isolatedLayers.push(layerToUse);
                        if (!isolatedNoted) {
                            warnings.push("item(s) with a gradient or blend mode placed on their own layer(s) so they don't affect grouped siblings");
                            isolatedNoted = true;
                        }
                    }
                } else {
                    if (!groupedShapeLayer) {
                        groupedShapeLayer = comp.layers.addShape();
                        groupedShapeLayer.name = "Imported Shapes";
                        groupedShapeLayer.property("Transform").property("Anchor Point").setValue([0, 0]);
                        groupedShapeLayer.property("Transform").property("Position").setValue([0, 0]);
                        _mtagOrderLayer(groupedShapeLayer);
                    }
                    layerToUse = groupedShapeLayer;
                    targetContents = layerToUse.property("Contents");
                }
                
                var group = targetContents.addProperty("ADBE Vector Group");
                group.name = item.name || "Path Group";
                var groupContents = group.property("Contents");
                
                var madeShape = false;
                if (geom && geom.shape) {
                    // Live parametric primitive (Rect/Ellipse/Polystar). Falls
                    // back to the bezier subpaths if the prop can't be created.
                    try { madeShape = _mtagAddParametricShape(groupContents, geom.shape); } catch (ePs) { madeShape = false; }
                    if (!madeShape) warnings.push("shape '" + (item.name || "path") + "' → path (parametric build failed)");
                }
                if (!madeShape && geom && geom.subpaths) {
                    for (var i = 0; i < geom.subpaths.length; i++) {
                        var sp = geom.subpaths[i];
                        var pathProp = groupContents.addProperty("ADBE Vector Shape - Group");
                        pathProp.name = "Path " + (i + 1);
                        var shape = new Shape();
                        shape.vertices = sp.vertices;
                        shape.inTangents = sp.inTangents;
                        shape.outTangents = sp.outTangents;
                        shape.closed = !!sp.closed;
                        pathProp.property("Path").setValue(shape);
                    }
                }
                
                for (var si = 0; si < strokes.length; si++) {
                    warnings = warnings.concat(_mtagAddStroke(groupContents, strokes[si], layerToUse));
                    totalStrokes++;
                }
                for (var fi = 0; fi < fills.length; fi++) {
                    warnings = warnings.concat(_mtagAddFill(groupContents, fills[fi], layerToUse));
                    totalFills++;
                }
                
                if (geom && geom.fillRule === "even-odd") {
                    for (var r = 1; r <= groupContents.numProperties; r++) {
                        var pr = groupContents.property(r);
                        if (pr && pr.matchName === "ADBE Vector Graphic - Fill") {
                            try { pr.property("ADBE Vector Fill Rule").setValue(2); } catch (eR) {}
                        }
                    }
                }
                
                if (ownLayer) {
                    // Opacity + blend belong to the whole layer when the item
                    // owns it (separate mode, or an isolated gradient item).
                    if (item.opacity != null && item.opacity < 1) {
                        layerToUse.property("Transform").property("Opacity").setValue(item.opacity * 100);
                    }
                    if (item.blendMode && item.blendMode !== "normal") {
                        try { layerToUse.blendingMode = _mtagAeBlend(item.blendMode); } catch (eBl) {
                            warnings.push("blend mode '" + item.blendMode + "' not applied");
                        }
                    }

                    if (!options.grouped) {
                        // Separate mode: position each layer independently now.
                        // Anchor stays in unscaled geometry space; position =
                        // anchor * compMul so (with Scale = compMul) every vertex
                        // P maps to P*compMul about the comp origin.
                        var bbox = item.bbox || { x: 0, y: 0, w: 100, h: 100 };
                        var anchor = [bbox.x + bbox.w / 2, bbox.y + bbox.h / 2];
                        if (options.centerAnchor) {
                            layerToUse.property("Transform").property("Anchor Point").setValue(anchor);
                            layerToUse.property("Transform").property("Position").setValue(_mtagM(anchor));
                        } else {
                            layerToUse.property("Transform").property("Anchor Point").setValue([comp.width / 2, comp.height / 2]);
                            layerToUse.property("Transform").property("Position").setValue(_mtagM([comp.width / 2, comp.height / 2]));
                        }
                    }
                    // Isolated-in-grouped: leave transform at [0,0]; the final
                    // alignment block below positions it with the grouped layer.
                } else {
                    var groupTransform = group.property("Transform");
                    if (item.opacity != null && item.opacity < 1) {
                        try { groupTransform.property("Opacity").setValue(item.opacity * 100); } catch(e){}
                    }
                }
            } else if (item.kind === "image") {
                // Images always own a footage layer (can't merge into a shape
                // layer). Copy the source into the project's image folder so the
                // .aep has a stable asset, then import + place/scale to bbox.
                var srcFile = new File(item.sourcePath);
                if (!srcFile.exists) {
                    warnings.push("image source missing: " + item.sourcePath);
                } else {
                    var destDir = _mtagResolveImageDir();
                    var safeBase = String(item.name || "image").replace(/[^\w\-. ]+/g, "_");
                    var ext = "";
                    var dot = srcFile.name.lastIndexOf(".");
                    if (dot >= 0) ext = srcFile.name.substring(dot);
                    var destFile = new File(destDir.fsName + "/" + safeBase + ext);
                    // Avoid clobbering an unrelated file of the same name.
                    var nDup = 1;
                    while (destFile.exists && !_mtagSameFile(destFile, srcFile)) {
                        destFile = new File(destDir.fsName + "/" + safeBase + "_" + nDup + ext);
                        nDup++;
                    }
                    try { if (!destFile.exists) srcFile.copy(destFile.fsName); } catch (eCopy) {}
                    var useFile = destFile.exists ? destFile : srcFile;

                    var footageItem = null;
                    try {
                        var io = new ImportOptions(useFile);
                        // Layered formats (PSD/AI/PDF) would import as a comp by
                        // default; force merged footage so we get one placeable
                        // layer. canImportAs guards formats that don't support it.
                        try {
                            if (io.canImportAs(ImportAsType.FOOTAGE)) io.importAs = ImportAsType.FOOTAGE;
                        } catch (eIA) {}
                        footageItem = app.project.importFile(io);
                    } catch (eImp) {
                        var ext = useFile.name.replace(/^.*\./, "").toUpperCase();
                        warnings.push("image import failed (" + (item.name || "image") + ", ." + ext + "): " + eImp.toString());
                    }
                    if (footageItem) {
                        var imgLayer = comp.layers.add(footageItem);
                        imgLayer.name = item.name || "Image";
                        _mtagOrderLayer(imgLayer);
                        var ibbox = item.bbox || { x: 0, y: 0, w: footageItem.width, h: footageItem.height };
                        // Footage anchor defaults to its center; scale to bbox and
                        // drop the center at the bbox center → aligns with vectors.
                        var isx = footageItem.width ? (ibbox.w / footageItem.width) * 100 : 100;
                        var isy = footageItem.height ? (ibbox.h / footageItem.height) * 100 : 100;
                        // Fit-scale and position both carry the comp multiplier so
                        // images scale about the comp origin like the vectors.
                        imgLayer.property("Transform").property("Scale").setValue([isx * compMul, isy * compMul]);
                        imgLayer.property("Transform").property("Position").setValue(_mtagM([ibbox.x + ibbox.w / 2, ibbox.y + ibbox.h / 2]));
                        if (item.opacity != null && item.opacity < 1) {
                            imgLayer.property("Transform").property("Opacity").setValue(item.opacity * 100);
                        }
                        if (item.blendMode && item.blendMode !== "normal") {
                            try { imgLayer.blendingMode = _mtagAeBlend(item.blendMode); } catch (eBl) {}
                        }
                        if (item.__clip) warnings.push("clip group: image '" + (item.name || "") + "' left unclipped (image masking not supported)");
                    }
                }
            }
        }

        // Apply each clip group's mask to its layer. Layers are still at [0,0]
        // (alignment below sets anchor==position, a visual no-op), so the mask —
        // authored in absolute comp coords — lines up with the shape content.
        for (var cid in clipLayers) {
            if (!clipLayers.hasOwnProperty(cid)) continue;
            _mtagAddLayerMask(clipLayers[cid].layer, clipLayers[cid].clip, warnings);
        }

        // Position the grouped layer AND any isolated gradient/clip layers together
        // so they overlay correctly (all share [0,0] base transform + absolute
        // path coords).
        var alignLayers = [];
        if (groupedShapeLayer) alignLayers.push(groupedShapeLayer);
        for (var il = 0; il < isolatedLayers.length; il++) alignLayers.push(isolatedLayers[il]);

        if (options.grouped && alignLayers.length > 0) {
            var targetAP;
            if (options.centerAnchor) {
                var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (var i = 0; i < items.length; i++) {
                    if (items[i].kind === 'path' && items[i].bbox) {
                        var b = items[i].bbox;
                        if (b.x < minX) minX = b.x;
                        if (b.y < minY) minY = b.y;
                        if (b.x + b.w > maxX) maxX = b.x + b.w;
                        if (b.y + b.h > maxY) maxY = b.y + b.h;
                    }
                }
                targetAP = (minX !== Infinity)
                    ? [minX + (maxX - minX) / 2, minY + (maxY - minY) / 2]
                    : [comp.width / 2, comp.height / 2];
            } else {
                targetAP = [comp.width / 2, comp.height / 2];
            }
            // Anchor stays in unscaled geometry space; position = anchor *
            // compMul so (with each layer's Scale = compMul) the grouped art
            // scales about the comp origin, consistent with images.
            var alignPos = _mtagM(targetAP);
            for (var al = 0; al < alignLayers.length; al++) {
                alignLayers[al].property("Transform").property("Anchor Point").setValue(targetAP);
                alignLayers[al].property("Transform").property("Position").setValue(alignPos);
            }
        }

        app.endUndoGroup();
        var reportLayer = groupedShapeLayer || (isolatedLayers.length ? isolatedLayers[0] : null);
        return _mtagOk({
            layerIndex: reportLayer ? reportLayer.index : (items.length > 0 ? 1 : 0),
            layerName: reportLayer ? reportLayer.name : items.length + " items imported",
            fills: totalFills,
            strokes: totalStrokes,
            warnings: warnings
        });
    } catch (e) {
        try { app.endUndoGroup(); } catch (_) {}
        return _mtagErr(e.toString());
    }
}
