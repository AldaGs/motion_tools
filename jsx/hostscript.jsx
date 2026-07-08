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

// Opens After Effects' native color picker (which has its own on-canvas
// eyedropper) by round-tripping a throwaway Color Control effect through the
// "Edit Value..." menu command. There is no CEP/EyeDropper API in AE's CEF
// build, so this is the only way to reach a real picker from the panel.
//
// IMPORTANT: the "Edit Value..." command is modal and manages its OWN undo
// group. Wrapping it in our own beginUndoGroup/endUndoGroup makes endUndoGroup
// close the wrong group → "Undo group mismatch" → crash. So we deliberately
// hold NO undo group across executeCommand, and only bracket the (non-modal)
// cleanup in its own short group afterwards.
//
// A temp null hosts the Color Control; if no comp is open we spin up a tiny
// temp comp and tear it down after. `seedHex` pre-seeds the picker with the
// panel's current color. Returns the chosen "RRGGBB" hex, "Warning:..." if the
// user cancelled (value unchanged), or "Error:...".
function pickColorViaAe(seedHex) {
    var project = app.project;
    if (!project) return "Error:Open a project first.";

    var seed = _colHexToRGB(seedHex || "808080");
    var comp = _colComp();
    var tempComp = null;
    var tempNull = null;
    var colorProp = null;
    var picked = null;

    // --- Setup + modal pick: NO undo group around any of this. ---
    try {
        if (!comp) {
            tempComp = project.items.addComp("MTAG_TempColorPick", 100, 100, 1, 1, 24);
            tempComp.openInViewer();
            comp = tempComp;
        }

        tempNull = comp.layers.addNull();
        tempNull.name = "MTAG - ColorPicker";
        tempNull.enabled = false;

        var colorControl = tempNull("ADBE Effect Parade").addProperty("ADBE Color Control");
        colorProp = colorControl("ADBE Color Control-0001");
        colorProp.setValue(seed);
        colorProp.selected = true;

        var editValueId = app.findMenuCommandId("Edit Value...");
        if (editValueId) {
            app.executeCommand(editValueId);         // modal AE color picker (own undo group)
            picked = colorProp.value;
        }
    } catch (e) {
        _colPickCleanup(tempNull, tempComp);
        return "Error:" + e.toString();
    }

    _colPickCleanup(tempNull, tempComp);

    if (!picked) return "Error:Color picker unavailable.";
    var hex = _colRgbToHex(picked);
    // Cancelling "Edit Value..." leaves the seed untouched — treat an unchanged
    // value as a cancel so the panel doesn't record a no-op.
    if (hex === _colRgbToHex(seed)) return "Warning:Color pick cancelled.";
    return hex;
}

// Removes the throwaway null/comp created by pickColorViaAe. This is non-modal,
// so it's safe to bracket in its own self-contained undo group (opened AND
// closed here — never spanning the modal command above).
function _colPickCleanup(tempNull, tempComp) {
    try {
        app.beginUndoGroup("MTAG Color - Pick Cleanup");
        try { if (tempNull) tempNull.remove(); } catch (eN) {}
        try { if (tempComp) tempComp.remove(); } catch (eC) {}
        app.endUndoGroup();
    } catch (e) { /* best-effort cleanup */ }
}

// ==========================================================================
// MOTION GIFS — render the active comp using a bundled output-module template,
// then hand the rendered result to the panel (Node runs ffmpeg/gifski).
//
// Ported from GIPHER. The template names (GIPHER_RGBA_PNG, …) and the carrier
// project `gipher_templates.aepx` keep their original names on purpose — old
// easter egg. Unlike GIPHER, this does NOT shell out to the binaries here; it
// only renders and returns { mode, base, … } as JSON for the panel to encode.
//
// Template index → [outputModuleTemplateName, aepxCompName]:
//   0  Gipher_RGBA_PNG        GIPHER_RGBA_PNG      (PNG sequence, alpha)
//   1  Gipher_RGB_PNG         GIPHER_RGB_PNG       (PNG sequence)
//   2  Gipher_ProRes_444_Alpha GIPHER_RGBA_ProRes  (ProRes 4444, alpha)
//   3  Gipher_ProRes_422      GIPHER_RGB_ProRes    (ProRes 422)
var GIPH_TEMPLATES = [
    ["Gipher_RGBA_PNG",        "GIPHER_RGBA_PNG"],
    ["Gipher_RGB_PNG",         "GIPHER_RGB_PNG"],
    ["Gipher_ProRes_444_Alpha","GIPHER_RGBA_ProRes"],
    ["Gipher_ProRes_422",      "GIPHER_RGB_ProRes"]
];

function _giphComp() {
    var comp = app.project.activeItem;
    return (comp && comp instanceof CompItem) ? comp : null;
}

function _giphRenderQueue() {
    var rq = app.project.renderQueue;
    return (rq && rq instanceof RenderQueue) ? rq : null;
}

function _giphClearRenderQueue(queue) {
    for (var i = queue.numItems; i >= 1; i--) queue.item(i).remove();
}

function _giphIsTemplate(module, templateName) {
    for (var i = 0; i < module.templates.length; i++) {
        if (module.templates[i] == templateName) return true;
    }
    return false;
}

// Find a render-queue item by the name of its source comp (used to locate the
// items the .aepx brings in, each named after its template).
function _giphRenderItemByCompName(queue, compName) {
    for (var i = 1; i <= queue.numItems; i++) {
        if (queue.item(i).comp.name == compName) return i;
    }
    return -1;
}

// Ensure `templateName` exists as a saved output-module template. If it isn't
// already registered in the user's AE, import the carrier .aepx (which contains
// a render item named `aepxCompName` whose output module holds the desired
// settings), save those settings as a named template, then remove the import.
function _giphEnsureTemplate(templateFilePath, templateName, aepxCompName) {
    var queue = _giphRenderQueue();
    if (!queue) return false;

    var templateFile = new File(templateFilePath);
    if (!templateFile.exists) return false;

    var imported = app.project.importFile(new ImportOptions(templateFile));
    var itemIdx = _giphRenderItemByCompName(queue, aepxCompName);
    if (itemIdx < 0) { try { imported.remove(); } catch (e) {} return false; }

    var module = queue.item(itemIdx).outputModule(1);
    if (!_giphIsTemplate(module, templateName)) {
        module.saveAsTemplate(templateName);
    }
    // The .aepx render item was appended to the queue purely to lift its
    // template; drop it plus the imported project item so we don't render it.
    try { queue.item(itemIdx).remove(); } catch (e) {}
    try { imported.remove(); } catch (e) {}
    return true;
}

// incrementName + helpers, ported so repeated exports don't clobber prior files.
function _giphFileName(displayName, ext) { return displayName.slice(0, displayName.length - ext.length); }
function _giphIsIncrement(name) { return !isNaN(name.split("-").pop()); }
function _giphGetIncrement(name) { return name.split("-").pop(); }
function _giphIncrementName(filePath, ext) {
    var file = File(filePath.replace(/\\/g, "/"));
    var folder = Folder(file.parent);
    var exists = file.exists;
    var fileName = file.displayName;
    var increment = 1;
    while (exists) {
        var name = _giphFileName(file.displayName, ext);
        if (!_giphIsIncrement(name)) {
            fileName = name + "-" + increment + ext;
            file = File(folder.fsName + "\\" + fileName);
        } else {
            increment = _giphGetIncrement(name);
            file = File(folder.fsName + "\\" + name.slice(0, -(String(increment).length)) + (parseInt(increment) + 1) + ext);
        }
        if (!file.exists) { fileName = file.displayName; exists = false; }
    }
    return fileName;
}


// Public entry point. optsJSON: { templateIndex, outputFolder, templateFile }
// Returns JSON: { ok, mode:'png'|'prores', base, folder, name, width, height,
//                 frameRate } or { ok:false, error }.
function giphRenderComp(optsJSON) {
    try {
        var opts = JSON.parse(optsJSON);
        var comp = _giphComp();
        if (!comp) return JSON.stringify({ ok: false, error: "Open a composition first." });

        var idx = parseInt(opts.templateIndex);
        if (isNaN(idx) || idx < 0 || idx >= GIPH_TEMPLATES.length) idx = 0;
        var templateName = GIPH_TEMPLATES[idx][0];
        var aepxCompName = GIPH_TEMPLATES[idx][1];
        var mode = (templateName.indexOf("PNG") != -1) ? "png" : "prores";
        var ext = (mode === "png") ? ".png" : ".mov";

        // The panel decides where intermediates live (a throwaway OS temp
        // folder, or a GIPHERrender subfolder when the user keeps frames) and
        // owns cleanup — we just render into it.
        var renderFolder = Folder(opts.renderFolder);
        if (!renderFolder.exists) renderFolder.create();
        if (!renderFolder.exists) return JSON.stringify({ ok: false, error: "Could not create render folder." });

        var queue = _giphRenderQueue();
        if (!queue) return JSON.stringify({ ok: false, error: "Render queue unavailable." });
        _giphClearRenderQueue(queue);

        var baseName = String(comp.name).replace(/\s/g, "");
        var outFile = File(renderFolder.fsName + "\\" + baseName + ext);
        outFile = File(renderFolder.fsName + "\\" + _giphIncrementName(outFile.fsName, ext));

        var item = queue.items.add(comp);
        var module = item.outputModule(1);
        module.file = outFile;

        if (!_giphIsTemplate(module, templateName)) {
            var ok = _giphEnsureTemplate(opts.templateFile, templateName, aepxCompName);
            if (!ok) return JSON.stringify({ ok: false, error: "Could not install template: " + templateName });
        }
        module.applyTemplate(templateName);
        queue.render();

        var base = outFile.fsName.slice(0, -ext.length); // path without extension
        return JSON.stringify({
            ok: true,
            mode: mode,
            base: base,
            folder: renderFolder.fsName,
            name: baseName,
            width: comp.width,
            height: comp.height,
            frameRate: comp.frameRate,
            duration: comp.duration
        });
    } catch (err) {
        return JSON.stringify({ ok: false, error: err.toString() });
    }
}

// Prepare a background (aerender) render: make sure the chosen output-module
// template is registered so aerender can reference it, save the project to disk
// (aerender reads the .aep from disk), and return everything Node needs to spawn
// aerender and then encode. Unlike giphRenderComp this does NOT clear the user's
// render queue or block — it only registers the template via a throwaway item.
//
// optsJSON: { templateIndex, outputFolder, templateFile }
// Returns JSON: { ok, mode, projectPath, compName, templateName, base, folder,
//                 name, width, height, frameRate, duration } or { ok:false, error }.
function giphPrepareBackgroundRender(optsJSON) {
    try {
        var opts = JSON.parse(optsJSON);
        var comp = _giphComp();
        if (!comp) return JSON.stringify({ ok: false, error: "Open a composition first." });

        var proj = app.project;
        if (!proj || !proj.file) {
            return JSON.stringify({ ok: false, error: "Save the project first — background render reads it from disk." });
        }

        var idx = parseInt(opts.templateIndex);
        if (isNaN(idx) || idx < 0 || idx >= GIPH_TEMPLATES.length) idx = 0;
        var templateName = GIPH_TEMPLATES[idx][0];
        var aepxCompName = GIPH_TEMPLATES[idx][1];
        var mode = (templateName.indexOf("PNG") != -1) ? "png" : "prores";

        var renderFolder = Folder(opts.renderFolder);
        if (!renderFolder.exists) renderFolder.create();
        if (!renderFolder.exists) return JSON.stringify({ ok: false, error: "Could not create render folder." });

        // Registering an output-module template needs a render-queue item, and
        // adding one yanks the user to the Render Queue panel. Registration
        // persists in AE prefs, so only do it the first time we see each
        // template — every subsequent background export touches nothing.
        var prefKey = "installed_" + templateName;
        var alreadyInstalled = false;
        try {
            alreadyInstalled = app.settings.haveSetting("MotionGIFS", prefKey) &&
                               app.settings.getSetting("MotionGIFS", prefKey) === "true";
        } catch (e) {}

        if (!alreadyInstalled) {
            var queue = _giphRenderQueue();
            if (!queue) return JSON.stringify({ ok: false, error: "Render queue unavailable." });
            var probe = queue.items.add(comp);
            var module = probe.outputModule(1);
            if (!_giphIsTemplate(module, templateName)) {
                var ok = _giphEnsureTemplate(opts.templateFile, templateName, aepxCompName);
                if (!ok) { try { probe.remove(); } catch (e) {} return JSON.stringify({ ok: false, error: "Could not install template: " + templateName }); }
            }
            try { probe.remove(); } catch (e) {}
            try { app.settings.saveSetting("MotionGIFS", prefKey, "true"); } catch (e) {}
            // We just touched the render queue; bring the comp back to the front
            // so the user isn't left staring at the Render Queue panel.
            try { comp.openInViewer(); } catch (e) {}
        }

        // Flush current edits to disk so aerender renders what the user sees.
        proj.save();

        var baseName = String(comp.name).replace(/\s/g, "");
        // aerender writes literally to -output; keep a stable base (no numeric
        // increment) so the frame glob / .mov path is predictable in Node.
        var base = renderFolder.fsName + "\\" + baseName;

        return JSON.stringify({
            ok: true,
            mode: mode,
            projectPath: proj.file.fsName,
            compName: comp.name,
            templateName: templateName,
            base: base,
            folder: renderFolder.fsName,
            name: baseName,
            width: comp.width,
            height: comp.height,
            frameRate: comp.frameRate,
            duration: comp.duration
        });
    } catch (err) {
        return JSON.stringify({ ok: false, error: err.toString() });
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

// ==========================================================================
// COLOR PALETTE — embed ("incrust") a palette into the current project.
// The palette is stored as a JSON hex array in the project's XMP metadata
// (app.project.xmpPacket) under our own mtag: namespace, so it travels inside
// the .aep and doesn't clutter the project panel. Shares the same settings
// packet the MTAG Switch panel uses for its per-project image folder.
// ==========================================================================

var _COL_XMP_NS = "http://motiontoolbar.com/xmp/1.0/";
var _COL_XMP_PREFIX = "mtag:";
var _COL_XMP_PROP = "mtagSettings";
var _COL_XMP_KEY = "projectPalette";

function _colLoadXmpLib() {
    if (typeof ExternalObject === "undefined") return false;
    try {
        if (ExternalObject.AdobeXMPScript == undefined) {
            ExternalObject.AdobeXMPScript = new ExternalObject("lib:AdobeXMPScript");
        }
        XMPMeta.registerNamespace(_COL_XMP_NS, _COL_XMP_PREFIX);
        return true;
    } catch (e) {
        return false;
    }
}

// Parsed settings object stored on the active project ({} if none/unreadable).
function _colReadProjectSettings() {
    if (!app.project) return {};
    if (!_colLoadXmpLib()) return {};
    var packet = app.project.xmpPacket || "";
    if (!packet) return {};
    var xmp = new XMPMeta(packet);
    if (!xmp.doesPropertyExist(_COL_XMP_NS, _COL_XMP_PROP)) return {};
    var val = xmp.getProperty(_COL_XMP_NS, _COL_XMP_PROP);
    var str = val ? val.toString() : "";
    if (!str) return {};
    try { return JSON.parse(str) || {}; } catch (e) { return {}; }
}

// Merge one key into the settings blob and write it back. Only reaches disk
// when the user saves the .aep. Read-merge-write so it won't clobber sibling
// keys (e.g. the Switch panel's imageExportDir).
function _colWriteProjectSetting(key, value) {
    if (!app.project) return false;
    if (!_colLoadXmpLib()) return false;
    var packet = app.project.xmpPacket || "";
    var xmp = packet ? new XMPMeta(packet) : new XMPMeta();
    var current = {};
    if (xmp.doesPropertyExist(_COL_XMP_NS, _COL_XMP_PROP)) {
        try { current = JSON.parse(xmp.getProperty(_COL_XMP_NS, _COL_XMP_PROP).toString()) || {}; }
        catch (ep) { current = {}; }
    }
    current[key] = value;
    xmp.setProperty(_COL_XMP_NS, _COL_XMP_PROP, JSON.stringify(current));
    app.project.xmpPacket = xmp.serialize();
    return true;
}

// "true" / "false" — whether this project already carries an embedded palette.
function projectPaletteExists() {
    try {
        var settings = _colReadProjectSettings();
        var pal = settings[_COL_XMP_KEY];
        return (pal && pal.length) ? "true" : "false";
    } catch (e) { return "false"; }
}

// Read the embedded palette back as a JSON hex array.
function getProjectPaletteColors() {
    try {
        if (!app.project) return "Warning:No project open.";
        if (typeof ExternalObject === "undefined") return "Error:XMP scripting unavailable in this host.";
        var settings = _colReadProjectSettings();
        var colors = settings[_COL_XMP_KEY];
        if (!colors || !colors.length) return "Warning:This project has no embedded palette yet.";
        var parts = [];
        for (var n = 0; n < colors.length; n++) parts.push('"' + colors[n] + '"');
        return "[" + parts.join(",") + "]";
    } catch (e) {
        return "Error:" + e.toString();
    }
}

// Embed / update the palette in the project. `colorsJson` is a JSON hex array;
// `cols` is accepted for signature compatibility but ignored. Returns a status
// string.
function syncPaletteToProject(colorsJson, cols) {
    try {
        if (!app.project) return "Warning:No project open.";
        var colors;
        try { colors = JSON.parse(colorsJson); } catch (e) { colors = eval("(" + colorsJson + ")"); }
        if (!colors || !colors.length) return "Warning:Palette is empty — nothing to embed.";

        // Normalize to uppercase '#'-prefixed hex for stable storage.
        var norm = [];
        for (var i = 0; i < colors.length; i++) {
            var h = String(colors[i]).replace(/^#/, "").toUpperCase();
            norm.push("#" + h);
        }

        if (!_colWriteProjectSetting(_COL_XMP_KEY, norm)) {
            return "Error:XMP scripting unavailable in this host.";
        }
        return "Embedded " + norm.length + " color" + (norm.length === 1 ? "" : "s") + " into the project.";
    } catch (e) {
        return "Error:" + e.toString();
    }
}