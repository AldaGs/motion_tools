# Motion Toolbar for After Effects

Motion Toolbar is a premium, high-performance CEP extension designed to streamline the workflow of professional motion designers. It combines a highly configurable macro dashboard with a math-accurate, industry-standard Easing Editor.

![Motion Toolbar Preview](https://via.placeholder.com/800x400?text=Motion+Toolbar+Interface+Preview)

## 🚀 Key Features

### 1. Context-Aware Macro Dashboard
Build custom toolbars that change based on what you select in After Effects.
- **Multi-Action Support**: Bind menu commands, expressions, scripts, and `.ffx` presets to single buttons.
- **Macro Sequences**: Chain multiple actions into a single click (e.g., "Add Null" → "Rename" → "Parent Layer").
- **Automatic Profiling**: Create separate toolbars for Shape Layers, Text, Cameras, or Nulls. The UI switches profiles instantly as your selection changes.
- **Rich Aesthetics**: A modern, glassmorphism-inspired UI that feels like a native part of the AE ecosystem.

### 2. Pro Easing Editor
A high-precision cubic-bezier editor built for performance and accuracy.
- **Math-Accurate**: Uses the same Euclidean distance logic as professional tools like Flow, ensuring eases feel "right" on 2D and 3D spatial properties.
- **Native Easing**: Applies real keyframe easing (not expressions), keeping your timeline fast and clean.
- **Import/Export**: Full compatibility with **Flow (.flow)** and Motion Toolbar library files.
- **Smart Reading**: Select one or two keyframes to instantly "suck" the curve into the editor.
- **Spatial & Color Support**: Correctly handles Position (spatial) and Color properties, accounting for AE's internal coordinate systems and 0-255 scaling.

### 3. Command Palette
Quickly access any AE menu command or your custom macros with a searchable palette (Ctrl/Cmd + K).

---

## 🛠 Usage Guide

### Using the Easing Editor
- **Apply Ease**: Adjust the handles to your desired curve and click **APPLY**. You can choose to apply to the *In* influence, *Out* influence, or *Both*.
- **Read Ease**: Select two keyframes (to read a segment) or one keyframe (to read its neighbors) and click the **Read** button (icon in the overflow menu) to see existing easing.
- **Numeric Entry**: Click the numeric strip at the top to manually enter bezier coordinates.
- **Library Management**: Use the **Import** action in the overflow menu to load your existing Flow libraries.

### Managing Macros
- **Right-Click** any empty tile to create a new macro.
- **Edit Mode**: Toggle the "Pencil" icon to rearrange tiles via drag-and-drop or edit existing ones.
- **Hotkeys**: Bind macros to keyboard shortcuts for lightning-fast execution.

---

## 💻 Installation

1. **System Requirements**: Adobe After Effects CC 2022 or newer.
2. **Setup**:
   - Ensure `PlayerDebugMode` is enabled for your OS (required for unsigned extensions).
   - Place the project folder into your CEP extensions directory:
     - **Windows**: `C:\Users\<user>\AppData\Roaming\Adobe\CEP\extensions\`
     - **macOS**: `~/Library/Application Support/Adobe/CEP/extensions/`
3. **Build**: Run `npm run build` to generate the production bundle.
4. **Open**: In After Effects, go to **Window → Extensions → Motion Toolbar**.

---

## 🏗 Architecture & Accuracy

Motion Toolbar is built on a modern stack:
- **Frontend**: React + TypeScript + Vite.
- **Bridge**: A robust ExtendScript (`hostscript.jsx`) layer that handles complex keyframe math.
- **Math Accuracy**: 
  - **Spatial properties** (Position) use Euclidean distance calculations to ensure temporal speed matches the visual curve.
  - **Color properties** use a 255-multiplier to align with AE's internal scripting velocity.
  - **Cubic Bezier** handles use safe-clamping (0.001 - 0.999) to prevent division-by-zero errors.

---

## 📜 Roadmap & Support
- [x] Math-accurate spatial easing.
- [x] Flow library import support.
- [ ] UXP Migration (Future-proofing for AE 2025+).
- [ ] Multi-profile cloud sync.

Developed with ❤️ for the Motion Community.
