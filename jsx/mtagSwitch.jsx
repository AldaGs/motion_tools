// jsx/mtagSwitch.jsx — MTAG Switch host-side bridge (Stage 2 POC).
//
// Two entry points, host-specific:
//   mtagSwitchAiExport() -> JSON string  (Illustrator)
//   mtagSwitchAeImport(jsonString) -> JSON string  (After Effects)
//
// Both wrap results in {ok:true, data} / {ok:false, error} so the panel can
// distinguish evalScript failures (which return "EvalScript error.") from
// real host-side errors.

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
        // Resolve the spot's underlying process color.
        try { return _mtagRgbFromAiColor(c.spot.color); } catch (e) { return [0, 0, 0]; }
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

// ---------------- Illustrator export ----------------
// Collects the selected vector paths, converts geometry to AE-compatible
// tangents, and reads each path's fill + stroke appearance (solid or gradient),
// object opacity, blend mode, cap/join/miter, and dash pattern.
//
// LIMITATION: the ExtendScript DOM exposes only ONE fill and ONE stroke per
// PathItem (the appearance-stack / multiple-fills API is not scriptable). So
// `fills`/`strokes` arrays hold at most one entry each here; the schema keeps
// them as arrays for forward-compat and because the AE side can emit stacks.
function mtagSwitchAiExport(grouped, centerAnchor) {
    try {
        if (!app.documents || app.documents.length === 0) {
            return _mtagErr("No open document.");
        }
        var doc = app.activeDocument;
        var sel = doc.selection;
        if (!sel || sel.length === 0) {
            return _mtagErr("Nothing selected.");
        }

        var itemsToProcess = [];
        function collect(item) {
            if (item.typename === "PathItem" || item.typename === "TextFrame") {
                itemsToProcess.push(item);
            } else if (item.typename === "CompoundPathItem") {
                itemsToProcess.push(item);
            } else if (item.typename === "GroupItem") {
                for (var j = 0; j < item.pageItems.length; j++) collect(item.pageItems[j]);
            }
        }
        for (var s = 0; s < sel.length; s++) collect(sel[s]);
        if (itemsToProcess.length === 0) return _mtagErr("Selection has no supported items.");

        var ab = doc.artboards[doc.artboards.getActiveArtboardIndex()];
        var abRect = ab.artboardRect;
        var abLeft = abRect[0];
        var abTop = abRect[1];
        var PT_TO_PX = 1.0;

        function conv(pt) {
            return [ (pt[0] - abLeft) * PT_TO_PX, (abTop - pt[1]) * PT_TO_PX ];
        }

        var outItems = [];

        for (var i = 0; i < itemsToProcess.length; i++) {
            var item = itemsToProcess[i];
            
            var objOpacity = (item.opacity != null ? item.opacity / 100 : 1);
            var blend = "normal";
            try { blend = _mtagBlend(item.blendingMode); } catch (eB) { blend = "normal"; }

            var bounds = item.geometricBounds;
            var bl = conv([bounds[0], bounds[1]]);
            var br = conv([bounds[2], bounds[3]]);
            var bbox = { x: Math.min(bl[0], br[0]), y: Math.min(bl[1], br[1]),
                         w: Math.abs(br[0]-bl[0]), h: Math.abs(br[1]-bl[1]) };

            if (item.typename === "TextFrame") {
                var contents = item.contents;
                var font = "ArialMT";
                var fontSize = 12;
                var just = "left";
                var fills = [];
                var strokes = [];
                
                try {
                    var range = item.textRange;
                    if (range && range.length > 0) {
                        var charAttrs = range.characterAttributes;
                        if (charAttrs.textFont) font = charAttrs.textFont.name;
                        if (charAttrs.size) fontSize = charAttrs.size * PT_TO_PX;
                        if (charAttrs.fillColor) fills.push(_mtagPaintFromAiColor(charAttrs.fillColor, 1, conv));
                        if (charAttrs.strokeColor) strokes.push({
                            paint: _mtagPaintFromAiColor(charAttrs.strokeColor, 1, conv),
                            width: (charAttrs.strokeWeight || 1) * PT_TO_PX,
                            cap: "butt", join: "miter", miterLimit: 4
                        });
                        
                        var pAttrs = range.paragraphAttributes;
                        if (pAttrs && pAttrs.justification) {
                            var j = String(pAttrs.justification);
                            if (j.indexOf("CENTER") !== -1) just = "center";
                            else if (j.indexOf("RIGHT") !== -1) just = "right";
                        }
                    }
                } catch(e) {}
                
                outItems.push({
                    kind: "text",
                    name: (item.name && item.name.length) ? item.name : "Text",
                    text: contents,
                    font: font,
                    fontSize: fontSize,
                    justification: just,
                    bbox: bbox,
                    opacity: objOpacity,
                    blendMode: blend,
                    appearance: { fills: fills, strokes: strokes }
                });
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
                    fills.push(_mtagPaintFromAiColor(first.fillColor, 1, conv, bbox));
                }
                var strokes = [];
                if (first.stroked && first.strokeColor) {
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
                
                outItems.push({
                    kind: "path",
                    name: name,
                    bbox: bbox,
                    opacity: objOpacity,
                    blendMode: blend,
                    geometry: { subpaths: subpaths, fillRule: "nonzero" },
                    appearance: { fills: fills, strokes: strokes }
                });
            }
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
                try { return hexFromAiColor(c.spot.color); } catch(e) { return null; }
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

// Build the flat value array AE's "Gradient Colors" property expects:
// color stops first ([pos, r, g, b] each), then alpha stops ([pos, alpha]
// each), with equal counts. Stop midpoints are NOT representable here (AE fixes
// them at 0.5), so they're dropped — logged by the caller as a downgrade.
function _mtagGradValue(stops) {
    var colorArr = [];
    var alphaArr = [];
    for (var i = 0; i < stops.length; i++) {
        var s = stops[i];
        var pos = s.offset;
        colorArr.push(pos, s.rgba[0], s.rgba[1], s.rgba[2]);
        alphaArr.push(pos, (s.rgba[3] == null ? 1 : s.rgba[3]));
    }
    return colorArr.concat(alphaArr);
}

// Add a fill operator (solid or gradient) to a shape group's Contents.
// shapeLayer is needed for the Ramp effect fallback when gradient colors
// can't be set via setValue (AE scripting limitation).
// Returns a warnings array.
function _mtagAddFill(groupContents, paint, shapeLayer) {
    var warnings = [];
    if (paint.kind === "gradient") {
        var gf = groupContents.addProperty("ADBE Vector Graphic - G-Fill");
        var gradSet = false;
        try {
            gf.property("ADBE Vector Grad Type").setValue(paint.type === "radial" ? 2 : 1);
            gf.property("ADBE Vector Grad Start Pt").setValue(paint.start);
            gf.property("ADBE Vector Grad End Pt").setValue(paint.end);
            gf.property("ADBE Vector Grad Colors").setValue(_mtagGradValue(paint.stops));
            gradSet = true;
        } catch (eg) {
            gradSet = false;
        }
        if (!gradSet) {
            // ADBE Vector Grad Colors is not settable via script on this AE version.
            // Fallback: remove the failed gradient fill, add a white solid so the
            // shape is visible, then apply the ADBE Ramp effect to the layer to
            // approximate the gradient visually.
            try { gf.remove(); } catch(er) {}
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
        } else {
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

// Add a stroke operator (solid or gradient) with width/cap/join/miter/dashes.
function _mtagAddStroke(groupContents, stroke, shapeLayer) {
    var warnings = [];
    var paint = stroke.paint;
    var strokeProp;
    if (paint.kind === "gradient") {
        strokeProp = groupContents.addProperty("ADBE Vector Graphic - G-Stroke");
        var gradSet = false;
        try {
            strokeProp.property("ADBE Vector Grad Type").setValue(paint.type === "radial" ? 2 : 1);
            strokeProp.property("ADBE Vector Grad Start Pt").setValue(paint.start);
            strokeProp.property("ADBE Vector Grad End Pt").setValue(paint.end);
            strokeProp.property("ADBE Vector Grad Colors").setValue(_mtagGradValue(paint.stops));
            gradSet = true;
        } catch (egs) {
            gradSet = false;
        }
        if (!gradSet) {
            try { strokeProp.remove(); } catch(er) {}
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

// ---------------- After Effects import ----------------
// Creates a shape layer in the active comp from an ArtworkPayload: one shape
// group holding all subpaths, with fills and strokes stacked so strokes render
// over fills. Applies object opacity + blend mode at the layer level.
function mtagSwitchAeImport(jsonString) {
    try {
        var payload = JSON.parse(jsonString);
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return _mtagErr("No active composition.");
        }
        var items = payload.items;
        if (!items || items.length === 0) return _mtagErr("Payload has no items.");
        
        var options = payload.options || { grouped: true, centerAnchor: false };
        var warnings = [];
        
        app.beginUndoGroup("MTAG Switch: Import");
        
        var groupedShapeLayer = null;
        var totalFills = 0, totalStrokes = 0;

        for (var idx = 0; idx < items.length; idx++) {
            var item = items[idx];
            
            if (item.kind === "text") {
                var textLayer = comp.layers.addText(item.text);
                textLayer.name = item.name || "Text";
                
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
                    }
                }
                
                if (strokes.length > 0) {
                    var s = strokes[0];
                    if (s.paint && s.paint.kind === "solid") {
                        textDoc.strokeColor = [s.paint.rgba[0], s.paint.rgba[1], s.paint.rgba[2]];
                        textDoc.strokeWidth = s.width || 1;
                        textDoc.applyStroke = true;
                    }
                }
                
                textProp.setValue(textDoc);
                
                if (item.opacity != null && item.opacity < 1) {
                    textLayer.property("Transform").property("Opacity").setValue(item.opacity * 100);
                }
                if (item.blendMode && item.blendMode !== "normal") {
                    try { textLayer.blendingMode = _mtagAeBlend(item.blendMode); } catch (eBl) {}
                }
                
                var bbox = item.bbox || { x: 0, y: 0, w: 100, h: 100 };
                textLayer.property("Transform").property("Position").setValue([bbox.x, bbox.y + bbox.h]);

                if (options.centerAnchor) {
                    try {
                        var rect = textLayer.sourceRectAtTime(comp.time, false);
                        var ax = rect.left + rect.width / 2;
                        var ay = rect.top + rect.height / 2;
                        var oldPos = textLayer.property("Transform").property("Position").value;
                        textLayer.property("Transform").property("Anchor Point").setValue([ax, ay]);
                        textLayer.property("Transform").property("Position").setValue([oldPos[0] + ax, oldPos[1] + ay]);
                    } catch(eText) {}
                } else {
                    try {
                        var rect = textLayer.sourceRectAtTime(comp.time, false);
                        var currentAnchorX = rect.left;
                        var currentAnchorY = rect.top + rect.height; // approximate baseline
                        var anchorOffsetX = comp.width/2 - bbox.x;
                        var anchorOffsetY = comp.height/2 - (bbox.y + bbox.h);
                        textLayer.property("Transform").property("Anchor Point").setValue([anchorOffsetX, anchorOffsetY]);
                        textLayer.property("Transform").property("Position").setValue([comp.width/2, comp.height/2]);
                    } catch(eText) {}
                }
                
            } else if (item.kind === "path") {
                var geom = item.geometry;
                var appr = item.appearance || { fills: [], strokes: [] };
                var fills = appr.fills || [];
                var strokes = appr.strokes || [];
                
                var layerToUse, targetContents;
                
                if (options.grouped) {
                    if (!groupedShapeLayer) {
                        groupedShapeLayer = comp.layers.addShape();
                        groupedShapeLayer.name = "Imported Shapes";
                        groupedShapeLayer.property("Transform").property("Anchor Point").setValue([0, 0]);
                        groupedShapeLayer.property("Transform").property("Position").setValue([0, 0]);
                    }
                    layerToUse = groupedShapeLayer;
                    targetContents = layerToUse.property("Contents");
                } else {
                    layerToUse = comp.layers.addShape();
                    layerToUse.name = item.name || "Shape";
                    targetContents = layerToUse.property("Contents");
                }
                
                var group = targetContents.addProperty("ADBE Vector Group");
                group.name = item.name || "Path Group";
                var groupContents = group.property("Contents");
                
                if (geom && geom.subpaths) {
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
                
                if (!options.grouped) {
                    if (item.opacity != null && item.opacity < 1) {
                        layerToUse.property("Transform").property("Opacity").setValue(item.opacity * 100);
                    }
                    if (item.blendMode && item.blendMode !== "normal") {
                        try { layerToUse.blendingMode = _mtagAeBlend(item.blendMode); } catch (eBl) {
                            warnings.push("blend mode '" + item.blendMode + "' not applied");
                        }
                    }
                    
                    var bbox = item.bbox || { x: 0, y: 0, w: 100, h: 100 };
                    var anchor = [bbox.x + bbox.w / 2, bbox.y + bbox.h / 2];
                    if (options.centerAnchor) {
                        layerToUse.property("Transform").property("Anchor Point").setValue(anchor);
                        layerToUse.property("Transform").property("Position").setValue(anchor);
                    } else {
                        layerToUse.property("Transform").property("Anchor Point").setValue([comp.width / 2, comp.height / 2]);
                        layerToUse.property("Transform").property("Position").setValue([comp.width / 2, comp.height / 2]);
                    }
                } else {
                    var groupTransform = group.property("Transform");
                    if (item.opacity != null && item.opacity < 1) {
                        try { groupTransform.property("Opacity").setValue(item.opacity * 100); } catch(e){}
                    }
                }
            }
            
            if (item.appearance && item.appearance.shadows && item.appearance.shadows.length > 0) {
                var sdw = item.appearance.shadows[0];
                var layerForShadow = (item.kind === "path" && options.grouped) ? groupedShapeLayer : (item.kind === "text" ? textLayer : layerToUse);
                if (layerForShadow && !layerForShadow.property("Effects").property("Drop Shadow")) {
                    try {
                        var dropShadow = layerForShadow.property("Effects").addProperty("Drop Shadow");
                        dropShadow.property("Shadow Color").setValue([sdw.color[0], sdw.color[1], sdw.color[2]]);
                        dropShadow.property("Opacity").setValue(sdw.opacity * 100);
                        var dist = Math.sqrt(sdw.offset[0]*sdw.offset[0] + sdw.offset[1]*sdw.offset[1]);
                        var dir = Math.atan2(sdw.offset[1], sdw.offset[0]) * 180 / Math.PI;
                        dropShadow.property("Direction").setValue(dir);
                        dropShadow.property("Distance").setValue(dist);
                        dropShadow.property("Softness").setValue(sdw.blur);
                    } catch(e) {
                        warnings.push("failed to add drop shadow: " + e.toString());
                    }
                }
            }
        }
        
        if (groupedShapeLayer) {
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
                if (minX !== Infinity) {
                    var cx = minX + (maxX - minX)/2;
                    var cy = minY + (maxY - minY)/2;
                    groupedShapeLayer.property("Transform").property("Anchor Point").setValue([cx, cy]);
                    groupedShapeLayer.property("Transform").property("Position").setValue([cx, cy]);
                }
            } else {
                groupedShapeLayer.property("Transform").property("Anchor Point").setValue([comp.width/2, comp.height/2]);
                groupedShapeLayer.property("Transform").property("Position").setValue([comp.width/2, comp.height/2]);
            }
        }

        app.endUndoGroup();
        return _mtagOk({
            layerIndex: groupedShapeLayer ? groupedShapeLayer.index : (items.length > 0 ? 1 : 0),
            layerName: groupedShapeLayer ? groupedShapeLayer.name : items.length + " items imported",
            fills: totalFills,
            strokes: totalStrokes,
            warnings: warnings
        });
    } catch (e) {
        try { app.endUndoGroup(); } catch (_) {}
        return _mtagErr(e.toString());
    }
}
