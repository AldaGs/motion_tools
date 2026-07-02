// jsx/hostscript.jsx

// Module-level flag: true while an undo group is already open by our code.
// Functions that open their own undo group (applyBezierToSelection, etc.)
// check this to avoid nesting, which causes the "Mismatch" dialog in AE.
var _insideUndo = false;

// `_skipUndo` (optional, default false): when true the function executes the
// action logic without opening/closing an undo group.  Used by `sequence`
// processing so sub-steps run inside the sequence's single undo group
// instead of nesting their own (nesting + menu commands = Mismatch dialog).

function executeAction(actionString, _skipUndo) {
    var openedHere = 0;
    try {
        // ExtendScript requires a little help with JSON sometimes
        var action;
        try {
            action = JSON.parse(actionString);
        } catch(e) {
            // Fallback if older AE versions don't have native JSON
            action = eval("(" + actionString + ")");
        }

        // Menu commands (app.executeCommand) and external scripts ($.evalFile)
        // manage their own undo groups internally — wrapping them in ours
        // creates nesting mismatches that trigger AE's "Mismatch" dialog.
        // When _skipUndo is true we also skip (we're inside a sequence's
        // group already).
        var needsUndo = !_skipUndo && action.type !== 'menuCommand' && action.type !== 'script';
        if (needsUndo) {
            app.beginUndoGroup(action.label || "Motion Toolbar Action");
            openedHere++;
            _insideUndo = true;
        }
        
        if (action.type === 'menuCommand') {
            // Stable menu command: try name-based lookup first, fall back to numeric ID
            var cmdId = parseInt(action.payload);
            if (action.menuCommandName) {
                if (typeof app.findMenuCommandId === 'function') {
                    try {
                        var looked = app.findMenuCommandId(action.menuCommandName);
                        if (looked > 0) cmdId = looked;
                    } catch(e) { /* fall back to numeric */ }
                } else {
                    // findMenuCommandId is unavailable in older AE — numeric IDs
                    // are not stable across versions, so warn loudly. We still
                    // attempt the call; the caller can decide what to do.
                    app.executeCommand(cmdId);
                    return "Warning: Used numeric menu ID fallback (" + cmdId +
                           ") for \"" + action.menuCommandName +
                           "\". This AE version lacks findMenuCommandId; the action may target a different command.";
                }
            }
            app.executeCommand(cmdId);

        } else if (action.type === 'expression') {
            var comp = app.project.activeItem;
            if (comp && comp.selectedProperties.length > 0) {
                for (var i = 0; i < comp.selectedProperties.length; i++) {
                    var prop = comp.selectedProperties[i];
                    if (prop.canSetExpression) {
                        prop.expression = action.payload;
                    }
                }
            } else {
                return "Error: Select a property (like Position) to apply the expression.";
            }
            
        } else if (action.type === 'script') {
            
            // MAGIC FIX: Convert Windows backslashes (\) to forward slashes (/)
            var safePath = action.payload.replace(/\\/g, "/");
            
            var file = new File(safePath);
            if (file.exists) {
                $.evalFile(file);
            } else {
                return "Error: Could not find script at " + safePath;
            }

        } else if (action.type === 'ffx') {
            // Apply an After Effects preset (.ffx) to selected layers
            var comp = app.project.activeItem;
            if (!comp || !(comp instanceof CompItem)) {
                return "Error: No active composition.";
            }
            var selLayers = comp.selectedLayers;
            if (!selLayers || selLayers.length === 0) {
                return "Error: Select at least one layer to apply the preset.";
            }
            var safePath = action.payload.replace(/\\/g, "/");
            var presetFile = new File(safePath);
            if (!presetFile.exists) {
                return "Error: Could not find preset at " + safePath;
            }
            for (var i = 0; i < selLayers.length; i++) {
                selLayers[i].applyPreset(presetFile);
            }

        } else if (action.type === 'sequence') {
            // Execute a sequence of sub-actions inside ONE undo group.
            var seq;
            try {
                seq = (typeof action.payload === 'string') ? JSON.parse(action.payload) : action.payload;
            } catch(e) {
                return "Error: Invalid sequence payload.";
            }
            // Open a single undo group for the entire sequence (unless we're
            // already inside one from a parent sequence).
            if (!_skipUndo && openedHere === 0) {
                app.beginUndoGroup(action.label || "Motion Toolbar Sequence");
                openedHere++;
                _insideUndo = true;
            }
            if (seq && seq.steps && seq.steps.length > 0) {
                for (var i = 0; i < seq.steps.length; i++) {
                    var step = seq.steps[i];
                    if (step.type && (step.payload || step.payload === "")) {
                        // Optional delay between steps
                        if (seq.delayMs && i > 0) {
                            $.sleep(seq.delayMs);
                        }

                        // Scripts ($.evalFile) and menu commands each manage
                        // their own undo group internally.  If the sequence's
                        // group is still open, AE sees a nested
                        // beginUndoGroup and eventually throws "Mismatch".
                        // Fix: close our group before the step, let it run
                        // with its own undo, then re-open for subsequent
                        // non-command steps.
                        var selfManaged = (step.type === 'script' || step.type === 'menuCommand');
                        if (selfManaged && openedHere > 0) {
                            app.endUndoGroup();
                            openedHere--;
                            _insideUndo = false;
                        }

                        // Sub-steps run with _skipUndo=true — they execute
                        // their logic but don't open nested undo groups
                        // (only relevant for non-self-managed types).
                        executeAction(JSON.stringify(step), true);

                        // Re-open the sequence undo group for remaining steps
                        // (only if we had one and there are more steps ahead).
                        if (selfManaged && !_skipUndo && i < seq.steps.length - 1) {
                            app.beginUndoGroup(action.label || "Motion Toolbar Sequence");
                            openedHere++;
                            _insideUndo = true;
                        }
                    }
                }
            }
        }

        if (openedHere > 0) {
            app.endUndoGroup();
            openedHere--;
            _insideUndo = false;
        }
        return "Success";

    } catch (err) {
        // Close exactly the groups this invocation opened — not more, not less.
        while (openedHere > 0) {
            try { app.endUndoGroup(); } catch(e) {}
            openedHere--;
        }
        _insideUndo = false;
        return "Error: " + err.toString();
    }

}

// jsx/hostscript.jsx

// Helper used by both the >=2-key path and the single-key path. Builds a
// per-dimension KeyframeEase array given a "from" and "to" key on the same
// property, the shared influence/rate values, and which side ('out' or 'in')
// we're computing.
function _buildEaseArrayForSegment(prop, fromKey, toKey, rate, influence) {
    var dt = prop.keyTime(toKey) - prop.keyTime(fromKey);
    if (dt === 0) return null;
    var v1 = prop.keyValue(fromKey);
    var v2 = prop.keyValue(toKey);
    
    var vt = prop.propertyValueType;
    var isSpatial = (vt === PropertyValueType.TwoD_SPATIAL ||
                     vt === PropertyValueType.ThreeD_SPATIAL);
    
    var arr = [];
    if (isSpatial) {
        // Combined spatial properties (like Position) have only ONE temporal dimension for easing
        var sumSq = 0;
        for (var i = 0; i < v1.length; i++) sumSq += Math.pow(v2[i] - v1[i], 2);
        var dist = Math.sqrt(sumSq);
        var speed = rate * (dist / dt);
        if (!isFinite(speed)) speed = 0;
        arr.push(new KeyframeEase(speed, influence));
    } else {
        // Non-spatial properties (OneD, TwoD like Scale, ThreeD, etc.)
        // Drawing logic from Flow (curves.jsx):
        // For SHAPE, CUSTOM_VALUE, and NO_VALUE, we use a normalized speed of 1.
        if (vt === PropertyValueType.SHAPE || 
            vt === PropertyValueType.CUSTOM_VALUE || 
            vt === PropertyValueType.NO_VALUE) {
            arr.push(new KeyframeEase(rate, influence));
        } else {
            var isMulti = (v1 instanceof Array);
            var dimCount = isMulti ? v1.length : 1;
            
            // For COLOR, AE internal easing units are often scaled by 255 (matching Flow)
            var multiplier = (vt === PropertyValueType.COLOR) ? 255 : 1;
            
            for (var d = 0; d < dimCount; d++) {
                var dv_d = isMulti ? (v2[d] - v1[d]) : (v2 - v1);
                var speed_d = rate * (dv_d / dt) * multiplier;
                if (!isFinite(speed_d)) speed_d = 0;
                arr.push(new KeyframeEase(speed_d, influence));
            }
        }
    }
    return arr;
}

// applyMode: 'both' | 'in' | 'out'
//
// Behavior by selection size:
//   selectedKeys.length >= 2  — for each adjacent pair (k, k+1), apply the
//                               outgoing ease to k and the incoming ease to k+1
//                               (filtered by applyMode).
//   selectedKeys.length === 1 — treat the single key as both endpoints of a
//                               virtual segment: outgoing uses (key, next-key),
//                               incoming uses (prev-key, key). Missing
//                               neighbors are silently skipped.
function applyBezierToSelection(bezierString, applyMode) {
    try {
        var coords = JSON.parse(bezierString);
        var x1 = coords[0], y1 = coords[1], x2 = coords[2], y2 = coords[3];
        var comp = app.project.activeItem;
        if (!comp || comp.selectedProperties.length === 0) return "Error: Select a property.";

        var sawAnyKeys = false;
        var sawAnyApplied = false;

        // Only open an undo group if we're not already inside one (e.g. from
        // a sequence macro). Nesting beginUndoGroup causes AE's "Mismatch"
        // dialog on random occasions.
        var ownUndo = !_insideUndo;
        if (ownUndo) {
            app.beginUndoGroup("Apply Custom Ease");
            _insideUndo = true;
        }
        var props = comp.selectedProperties;

        for (var i = 0; i < props.length; i++) {
            var prop = props[i];
            if (!prop.canVaryOverTime) continue;

            var outInfluence = Math.max(0.1, Math.min(100, x1 * 100));
            var inInfluence  = Math.max(0.1, Math.min(100, (1 - x2) * 100));
            
            // Floor the X values slightly more to avoid vertical tangents causing Infinity speed
            var safeX1 = Math.max(0.001, x1);
            var safeX2 = Math.min(0.999, x2);
            var outRate = y1 / safeX1;
            var inRate  = (1 - y2) / (1 - safeX2);

            // Safeguard against non-finite rates
            if (!isFinite(outRate)) outRate = 0;
            if (!isFinite(inRate)) inRate = 0;

            if (prop.selectedKeys.length >= 2) {
                sawAnyKeys = true;
                var selKeys = prop.selectedKeys;
                for (var k = 0; k < selKeys.length - 1; k++) {
                    var key1 = selKeys[k];
                    var key2 = selKeys[k+1];

                    var easeOutArr = _buildEaseArrayForSegment(prop, key1, key2, outRate, outInfluence);
                    var easeInArr  = _buildEaseArrayForSegment(prop, key1, key2, inRate,  inInfluence);
                    if (!easeOutArr) continue;

                    if (applyMode === 'both' || applyMode === 'out') {
                        prop.setTemporalEaseAtKey(key1, prop.keyInTemporalEase(key1), easeOutArr);
                        sawAnyApplied = true;
                    }
                    if (applyMode === 'both' || applyMode === 'in') {
                        prop.setTemporalEaseAtKey(key2, easeInArr, prop.keyOutTemporalEase(key2));
                        sawAnyApplied = true;
                    }
                }
            } else if (prop.selectedKeys.length === 1) {
                sawAnyKeys = true;
                var key   = prop.selectedKeys[0];
                var prevK = key > 1 ? key - 1 : null;
                var nextK = key < prop.numKeys ? key + 1 : null;

                // Outgoing half: written into key K, paired with K+1.
                if (nextK !== null && (applyMode === 'both' || applyMode === 'out')) {
                    var outArr = _buildEaseArrayForSegment(prop, key, nextK, outRate, outInfluence);
                    if (outArr) {
                        prop.setTemporalEaseAtKey(key, prop.keyInTemporalEase(key), outArr);
                        sawAnyApplied = true;
                    }
                }
                // Incoming half: written into key K, paired with K-1.
                if (prevK !== null && (applyMode === 'both' || applyMode === 'in')) {
                    var inArr = _buildEaseArrayForSegment(prop, prevK, key, inRate, inInfluence);
                    if (inArr) {
                        prop.setTemporalEaseAtKey(key, inArr, prop.keyOutTemporalEase(key));
                        sawAnyApplied = true;
                    }
                }
            }
        }
        if (ownUndo) {
            app.endUndoGroup();
            _insideUndo = false;
        }
        if (!sawAnyKeys)    return "Error: Select at least one keyframe.";
        if (!sawAnyApplied) return "Error: Selected keyframe has no neighbor on the requested side.";
        return "Success";
    } catch (err) {
        // Only attempt to close the group if WE opened it.
        if (!_insideUndo) {
            // Already closed or never opened — nothing to do.
        } else {
            try { app.endUndoGroup(); } catch(e) {}
            _insideUndo = false;
        }
        return "Easing Error: " + err.toString();
    }
}

// Reads cubic-bezier (x1,y1,x2,y2) from the currently selected keyframes:
//   - 2+ keys selected: read the segment between the first two selected keys.
//   - 1 key selected: outgoing half (x1,y1) comes from key→next, incoming half
//     (x2,y2) from prev→key. Missing neighbor → that half defaults to linear.
function readEaseFromSelection() {
    try {
        var comp = app.project.activeItem;
        if (!comp || comp.selectedProperties.length === 0) return null;

        var prop = comp.selectedProperties[0];
        if (!prop.canVaryOverTime) return null;

        if (prop.selectedKeys.length >= 2) {
            var key1 = prop.selectedKeys[0];
            var key2 = prop.selectedKeys[1];
            var coords = _readSegmentBezier(prop, key1, key2);
            if (!coords) return JSON.stringify([0, 0, 1, 1]);
            return JSON.stringify([_round3(coords[0]), _round3(coords[1]), _round3(coords[2]), _round3(coords[3])]);
        }

        if (prop.selectedKeys.length === 1) {
            var key   = prop.selectedKeys[0];
            var prevK = key > 1 ? key - 1 : null;
            var nextK = key < prop.numKeys ? key + 1 : null;

            // Defaults (linear) if the relevant neighbor is missing.
            var x1 = 0, y1 = 0, x2 = 1, y2 = 1;

            if (nextK !== null) {
                var outHalf = _readSegmentBezier(prop, key, nextK);
                if (outHalf) { x1 = outHalf[0]; y1 = outHalf[1]; }
            }
            if (prevK !== null) {
                var inHalf = _readSegmentBezier(prop, prevK, key);
                if (inHalf) { x2 = inHalf[2]; y2 = inHalf[3]; }
            }
            return JSON.stringify([_round3(x1), _round3(y1), _round3(x2), _round3(y2)]);
        }

        return null;
    } catch (err) {
        return null;
    }
}

// Round to 3 decimal places — returns a number, not a string.
function _round3(v) { return Math.round(v * 1000) / 1000; }

// Helper: returns [x1,y1,x2,y2] (raw numbers) for the segment between key1 and
// key2, or null if the math is undefined (zero dt, or every dimension static).
//
// Three code paths, matching the three branches in _buildEaseArrayForSegment:
//   1. Shape / Custom / NoValue — speed IS the rate; no value-delta involved.
//   2. Spatial (2D/3D Position) — single temporal ease; avgSpeed uses
//      Euclidean distance, NOT per-component delta.
//   3. Everything else (Scale, Rotation, Color, etc.) — one ease per axis;
//      pick the axis with the largest |dv| to avoid divide-by-zero.
function _readSegmentBezier(prop, key1, key2) {
    var dt = prop.keyTime(key2) - prop.keyTime(key1);
    if (dt === 0) return null;

    var vt = prop.propertyValueType;
    var isShape   = (vt === PropertyValueType.SHAPE || vt === PropertyValueType.CUSTOM_VALUE || vt === PropertyValueType.NO_VALUE);
    var isSpatial = (vt === PropertyValueType.TwoD_SPATIAL || vt === PropertyValueType.ThreeD_SPATIAL);
    var isColor   = (vt === PropertyValueType.COLOR);

    var v1 = prop.keyValue(key1);
    var v2 = prop.keyValue(key2);

    // --- Path 1: Shape / Custom / NoValue ---
    // Speed stored in AE *is* the bezier rate; no delta normalisation.
    if (isShape) {
        var outArr = prop.keyOutTemporalEase(key1);
        var inArr  = prop.keyInTemporalEase(key2);
        var x1 = outArr[0].influence / 100;
        var y1 = outArr[0].speed * x1;
        var x2 = 1 - (inArr[0].influence / 100);
        var y2 = 1 - (inArr[0].speed * (1 - x2));
        x1 = Math.max(0, Math.min(1, x1));
        x2 = Math.max(0, Math.min(1, x2));
        return [x1, y1, x2, y2];
    }

    // --- Path 2: Spatial (Position, etc. when dims are NOT separated) ---
    // AE stores ONE temporal ease based on Euclidean distance. The apply
    // path uses  speed = rate * (distance / dt),  so we reverse with
    // avgSpeed = distance / dt.  Using per-component delta here would
    // scale y1/y2 incorrectly on diagonal movements.
    if (isSpatial) {
        var sumSq = 0;
        for (var i = 0; i < v1.length; i++) sumSq += Math.pow(v2[i] - v1[i], 2);
        var dist = Math.sqrt(sumSq);
        if (dist === 0) return null;
        var avgSpeed = dist / dt;

        var outArr = prop.keyOutTemporalEase(key1);
        var inArr  = prop.keyInTemporalEase(key2);
        // Spatial properties always have exactly one temporal ease element.
        var easeOut = outArr[0];
        var easeIn  = inArr[0];

        var x1 = easeOut.influence / 100;
        var y1 = (easeOut.speed * x1) / avgSpeed;
        var x2 = 1 - (easeIn.influence / 100);
        var y2 = 1 - ((easeIn.speed * (1 - x2)) / avgSpeed);

        x1 = Math.max(0, Math.min(1, x1));
        x2 = Math.max(0, Math.min(1, x2));
        return [x1, y1, x2, y2];
    }

    // --- Path 3: Non-spatial multi-dim or scalar properties ---
    // Pick the dimension with the largest |dv| — that's the axis carrying
    // the dominant motion, and avoids divide-by-zero on a near-static axis
    // (e.g. Scale where only X changes while Y stays constant).
    var isMulti = (v1 instanceof Array);
    var dimCount = isMulti ? v1.length : 1;

    var bestDim = 0;
    var bestAbsDv = -1;
    for (var d = 0; d < dimCount; d++) {
        var dv_d = isMulti ? (v2[d] - v1[d]) : (v2 - v1);
        if (Math.abs(dv_d) > bestAbsDv) {
            bestAbsDv = Math.abs(dv_d);
            bestDim = d;
        }
    }

    var multiplier = isColor ? 255 : 1;
    var dv = isMulti ? (v2[bestDim] - v1[bestDim]) : (v2 - v1);
    var avgSpeed = (dv / dt) * multiplier;

    if (bestAbsDv === 0 || avgSpeed === 0) return null;

    var outArr = prop.keyOutTemporalEase(key1);
    var inArr  = prop.keyInTemporalEase(key2);
    var easeOut = outArr[bestDim] || outArr[0];
    var easeIn  = inArr[bestDim]  || inArr[0];

    var x1 = easeOut.influence / 100;
    var y1 = (easeOut.speed * x1) / avgSpeed;
    var x2 = 1 - (easeIn.influence / 100);
    var y2 = 1 - ((easeIn.speed * (1 - x2)) / avgSpeed);

    x1 = Math.max(0, Math.min(1, x1));
    x2 = Math.max(0, Math.min(1, x2));
    return [x1, y1, x2, y2];
}


// Reports the type of selection in the active comp so the panel can
// route to a context-specific profile. Possible return values:
//   "none"          — no comp open, or nothing selected
//   "textLayer", "shapeLayer", "cameraLayer", "lightLayer"
//   "nullLayer", "solidLayer", "precomp", "footageLayer"
//   "mixed"         — multi-selection of differing types
function getSelectionContext() {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) return "none";
        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) return "none";

        var ctx = _layerContext(sel[0]);
        for (var i = 1; i < sel.length; i++) {
            if (_layerContext(sel[i]) !== ctx) return "mixed";
        }
        return ctx;
    } catch (e) {
        return "none";
    }
}

function _layerContext(layer) {
    if (layer instanceof TextLayer)   return "textLayer";
    if (layer instanceof ShapeLayer)  return "shapeLayer";
    if (layer instanceof CameraLayer) return "cameraLayer";
    if (layer instanceof LightLayer)  return "lightLayer";
    if (layer instanceof AVLayer) {
        if (layer.nullLayer) return "nullLayer";
        var src = layer.source;
        if (src instanceof CompItem) return "precomp";
        if (src && src.mainSource && src.mainSource instanceof SolidSource) return "solidLayer";
        return "footageLayer";
    }
    return "none";
}

// Opens the native OS file browser to pick a script
function browseForScript() {
    // Limits the user to selecting .jsx or .jsxbin files
    var file = File.openDialog("Select an After Effects Script", "*.jsx;*.jsxbin");
    if (file) {
        // Return the properly formatted file path
        return file.fsName.replace(/\\/g, "/");
    }
    return ""; // User clicked cancel
}

// ==========================================================================
// COLOR PALETTE — apply/extract colors on the current selection.
// Ported from AG Color Palette. AE color arrays are 0..1 floats; the panel
// speaks 6-digit hex. Public entry points return a plain string the panel
// parses: "Error:..." / "Warning:..." are surfaced as toasts, a JSON array is
// the extraction result.
// ==========================================================================

function _colHexToRGB(hex) {
    hex = String(hex).replace(/^#/, "");
    if (hex.length === 3) hex = hex.charAt(0)+hex.charAt(0)+hex.charAt(1)+hex.charAt(1)+hex.charAt(2)+hex.charAt(2);
    return [
        parseInt(hex.substr(0, 2), 16) / 255,
        parseInt(hex.substr(2, 2), 16) / 255,
        parseInt(hex.substr(4, 2), 16) / 255
    ];
}
function _colValueToHex(c) {
    if (c === undefined || isNaN(c)) c = 0;
    if (c > 1.0 && c <= 255) c = c / 255;
    var v = Math.max(0, Math.min(1, c));
    var s = Math.round(v * 255).toString(16);
    return (s.length === 1 ? "0" + s : s).toUpperCase();
}
function _colRgbToHex(rgb) {
    if (!rgb || rgb.length < 3) return "000000";
    return _colValueToHex(rgb[0]) + _colValueToHex(rgb[1]) + _colValueToHex(rgb[2]);
}

function _colComp() {
    var comp = app.project.activeItem;
    return (comp && comp instanceof CompItem) ? comp : null;
}

// --- Shape-layer traversal helpers (recursive over the vector tree) ---
function _colFindClosestShapeGroup(prop, delimiter) {
    if (prop.matchName == "ADBE Vectors Group" || prop.matchName == "ADBE Vector Group" || prop.matchName == "ADBE Vector Layer") {
        return (prop.matchName == "ADBE Vector Layer") ? prop.property("ADBE Root Vectors Group") : prop;
    }
    for (var i = 1; i <= delimiter; i++) {
        var groupParent = prop.propertyGroup(i);
        if (groupParent.matchName == "ADBE Vectors Group" || groupParent.matchName == "ADBE Vector Group" || groupParent.matchName == "ADBE Vector Layer") {
            return (groupParent.matchName == "ADBE Vector Layer") ? groupParent.property("ADBE Root Vectors Group") : groupParent;
        }
    }
    return false;
}
function _colContents(content, object, matchNameFill, matchNameStroke) {
    if (content.matchName == matchNameFill || content.matchName == matchNameStroke) {
        if (content.propertyGroup().enabled) {
            var color = _colRgbToHex(content.value);
            object[color] = color;
        }
    }
    if (content.numProperties == null) return;
    for (var i = 1; i <= content.numProperties; i++) _colContents(content.property(i), object, matchNameFill, matchNameStroke);
}
function _colSearchInContents(content, theMatchName, arr) {
    if (content.matchName == theMatchName) { arr.push(true); arr.length = 1; }
    if (content.numProperties == null) return;
    for (var i = 1; i <= content.numProperties; i++) _colSearchInContents(content.property(i), theMatchName, arr);
}
function _colApplyToContents(content, color, theMatchName) {
    if (theMatchName.match("Fill") && content.enabled == false && content.matchName == "ADBE Vector Graphic - Fill") content.enabled = true;
    if (theMatchName.match("Stroke") && content.enabled == false && content.matchName == "ADBE Vector Graphic - Stroke") content.enabled = true;
    if (content.matchName == theMatchName) {
        if (content.numKeys > 0) content.setValueAtTime(_colComp().time, color);
        else content.setValue(color);
    }
    if (content.numProperties == null) return;
    for (var i = 1; i <= content.numProperties; i++) _colApplyToContents(content.property(i), color, theMatchName);
}

function _colApplyShapeLayer(layer, color, fill) {
    var layerProps = layer.selectedProperties;
    var match = fill ? "ADBE Vector Fill Color" : "ADBE Vector Stroke Color";
    if (layerProps.length > 0) {
        for (var j = 0; j < layerProps.length; j++) {
            var layerContent = _colFindClosestShapeGroup(layerProps[j], layerProps[j].propertyDepth);
            if (layerContent) {
                var arr = [];
                _colSearchInContents(layerContent, match, arr);
                if (arr.length == 0) {
                    var newProp;
                    if (layerContent.matchName == "ADBE Vector Group") {
                        newProp = layerContent.property("ADBE Vectors Group").addProperty(fill ? "ADBE Vector Graphic - Fill" : "ADBE Vector Graphic - Stroke");
                        newProp.enabled = true;
                        if (!fill) newProp.property("ADBE Vector Composite Order").setValue(2);
                    } else {
                        newProp = layerContent.addProperty(fill ? "ADBE Vector Graphic - Fill" : "ADBE Vector Graphic - Stroke");
                        if (!fill) { newProp.enabled = true; newProp.property("ADBE Vector Composite Order").setValue(2); }
                    }
                }
                _colApplyToContents(layerContent, color, match);
            }
        }
    } else {
        var root = layer.property("ADBE Root Vectors Group");
        var a2 = [];
        _colSearchInContents(root, match, a2);
        if (a2.length == 0) root.addProperty(fill ? "ADBE Vector Graphic - Fill" : "ADBE Vector Graphic - Stroke");
        _colApplyToContents(root, color, match);
    }
}
function _colApplyAvLayer(layer, color, fill) {
    var enabledMatch = fill ? "solidFill/enabled" : "frameFX/enabled";
    var layerContent = layer.property("ADBE Layer Styles");
    if (!layerContent.enabled || !layerContent.property(enabledMatch).enabled) {
        app.executeCommand(fill ? 9006 : 9008);
    }
    var colorMatch = fill ? "solidFill/color" : "frameFX/color";
    var layerStyle = fill ? layerContent.property("solidFill/enabled") : layerContent.property("frameFX/enabled");
    if (layerStyle.property(colorMatch).numKeys > 0) layerStyle.property(colorMatch).setValueAtTime(_colComp().time, color);
    else layerStyle.property(colorMatch).setValue(color);
}
function _colApplyTextLayer(layer, rgb, fill) {
    var source = layer.property("ADBE Text Properties").property("ADBE Text Document");
    var doc = source.value;
    var color = [rgb[0], rgb[1], rgb[2]];
    if (fill) { doc.applyFill = true; doc.fillColor = color; }
    else { doc.applyStroke = true; doc.strokeColor = color; }
    if (source.numKeys > 0) source.setValueAtTime(_colComp().time, doc);
    else source.setValue(doc);
}

// mode: "fill" | "stroke". Returns a status string for the panel.
function applyColorToSelection(hex, mode) {
    try {
        var comp = _colComp();
        if (!comp) return "Warning:Open a composition first.";
        var layers = comp.selectedLayers;
        if (!layers || !layers[0]) return "Warning:Select at least one layer.";

        var fill = (mode !== "stroke");
        var color = _colHexToRGB(hex);
        var touched = 0;

        app.beginUndoGroup("Apply Palette Color (" + (fill ? "Fill" : "Stroke") + ")");
        try {
            for (var i = 0; i < layers.length; i++) {
                var mn = layers[i].matchName;
                if (mn == "ADBE Vector Layer") { _colApplyShapeLayer(layers[i], color, fill); touched++; }
                else if (mn == "ADBE AV Layer") { _colApplyAvLayer(layers[i], color, fill); touched++; }
                else if (mn == "ADBE Text Layer") { _colApplyTextLayer(layers[i], color, fill); touched++; }
            }
        } finally {
            app.endUndoGroup();
        }

        if (touched === 0) return "Warning:No shape, text, or solid/footage layers in the selection.";
        return (fill ? "Fill" : "Stroke") + " applied to " + touched + " layer" + (touched === 1 ? "" : "s") + ".";
    } catch (e) {
        return "Error:" + e.toString();
    }
}

// Returns a JSON array of unique hex strings (no '#'), or "Error:"/"Warning:".
function extractColorsFromSelection() {
    try {
        var comp = _colComp();
        if (!comp) return "Warning:Open a composition first.";
        var layers = comp.selectedLayers;
        if (!layers || !layers[0]) return "Warning:Select at least one layer.";

        var obj = {};
        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            if (layer.matchName == "ADBE Vector Layer") {
                var lp = layer.selectedProperties;
                if (lp.length > 0) {
                    for (var j = 0; j < lp.length; j++) {
                        var lc = _colFindClosestShapeGroup(lp[j], lp[j].propertyDepth);
                        if (lc) _colContents(lc, obj, "ADBE Vector Fill Color", "ADBE Vector Stroke Color");
                    }
                } else {
                    _colContents(layer.property("ADBE Root Vectors Group"), obj, "ADBE Vector Fill Color", "ADBE Vector Stroke Color");
                }
            } else if (layer.matchName == "ADBE AV Layer") {
                var styles = layer.property("ADBE Layer Styles");
                if (styles && styles.property("solidFill/enabled") && styles.property("solidFill/enabled").enabled) {
                    _colContents(styles, obj, "solidFill/color", "solidFill/color");
                }
                if (styles && styles.property("frameFX/enabled") && styles.property("frameFX/enabled").enabled) {
                    _colContents(styles, obj, "frameFX/color", "frameFX/color");
                }
            } else if (layer.matchName == "ADBE Text Layer") {
                var src = layer.property("ADBE Text Properties").property("ADBE Text Document").value;
                if (src.applyFill) { var cf = _colRgbToHex(src.fillColor); obj[cf] = cf; }
                if (src.applyStroke) { var cs = _colRgbToHex(src.strokeColor); obj[cs] = cs; }
            }
        }

        var arr = [];
        for (var k in obj) { if (obj.hasOwnProperty(k)) arr.push(k); }
        return "[" + (function () {
            var parts = [];
            for (var n = 0; n < arr.length; n++) parts.push('"' + arr[n] + '"');
            return parts.join(",");
        })() + "]";
    } catch (e) {
        return "Error:" + e.toString();
    }
}