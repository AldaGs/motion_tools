// jsx/hostscript.jsx

// `openedHere` (declared at the top of executeAction) tracks how many undo
// groups *this invocation* opened so the catch block can close exactly that
// many on failure — avoiding "endUndoGroup without a matching begin" errors
// when sequences nest.

function executeAction(actionString) {
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

        app.beginUndoGroup(action.label || "Motion Toolbar Action");
        openedHere++;
        
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
                    app.endUndoGroup();
                    openedHere--;
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
            // Execute a sequence of sub-actions
            var seq;
            try {
                seq = (typeof action.payload === 'string') ? JSON.parse(action.payload) : action.payload;
            } catch(e) {
                return "Error: Invalid sequence payload.";
            }
            if (seq && seq.steps && seq.steps.length > 0) {
                for (var i = 0; i < seq.steps.length; i++) {
                    var step = seq.steps[i];
                    if (step.type && (step.payload || step.payload === "")) {
                        // Optional delay between steps
                        if (seq.delayMs && i > 0) {
                            $.sleep(seq.delayMs);
                        }
                        // Each sub-step opens its own paired begin/end via the
                        // recursive call — no need to bracket the call ourselves.
                        executeAction(JSON.stringify(step));
                    }
                }
            }
        }

        app.endUndoGroup();
        openedHere--;
        return "Success";

    } catch (err) {
        // Close exactly the groups this invocation opened — not more, not less.
        while (openedHere > 0) {
            try { app.endUndoGroup(); } catch(e) {}
            openedHere--;
        }
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

        app.beginUndoGroup("Apply Custom Ease");
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
        app.endUndoGroup();
        if (!sawAnyKeys)    return "Error: Select at least one keyframe.";
        if (!sawAnyApplied) return "Error: Selected keyframe has no neighbor on the requested side.";
        return "Success";
    } catch (err) {
        if (app.project.activeItem) {
            try { app.endUndoGroup(); } catch(e) {}
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