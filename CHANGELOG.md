# Changelog

Installers for macOS, Windows, and Linux and the self-hosting tarball
are on each version's [GitHub release page](https://github.com/hew3d/hew/releases).
The same build runs in the browser at [app.hew3d.com](https://app.hew3d.com).

A newer Hew always opens documents saved by an older one. The reverse
is not guaranteed: releases that change the `.hew` format say so under
**Changed**.

## [Unreleased]

### Added

- **API:** Dimensions and leader text can be created through the API, so a script or an agent that builds a model can dimension it. They save into the `.hew` and are there when the file is opened in Hew.
- **API:** Headless output carries dimensions. Line drawings, printed PDFs, and rendered snapshots all show the model's dimensions and leader text, in whichever unit format is asked for.
- **Sketches:** A sketch is a drawing you can keep. Each one is a single row in the Outliner with its shapes nested inside, and it takes a name, tags, and a hide toggle like an object does. A hidden sketch is out of the cursor's way too: nothing snaps to it and Push/Pull clicks through it.
- **Sketches:** **Object ▸ New Sketch** starts a fresh sketch with the next thing you draw, instead of adding to the last one on that plane. **Draw Into Sketch**, or a double-click on a sketch's Outliner row, goes back to an older one. The Outliner marks the sketch your next stroke will join.
- **Sketches:** Locked sketches. Check **Locked sketch** in Object Info and new strokes land beside the sketch instead of cutting into it, while Push/Pull and Follow Me build from it by copy, so a floor plan survives every wall raised from it.
- **API:** `hew.entity.rename` and `hew.tag.assign` work on a sketch, so a script can name a drawing and file it under a tag like any other part of the model.
- **Measurements:** Each dimension in the Measurements box carries a dot colored by the axis it runs along, so `W,D` is unambiguous on a wall or a tilted plane instead of depending on how that plane happened to be built. Move, Line, and Push/Pull show one for the axis the gesture is on.
- **Self-hosting:** Remote control. `hew-bridge` gives `hew-cli --live` and the MCP server the same reach into a browser tab they already have into an open desktop app: a client on your server dispatches into the document someone has open, in their undo history, in front of them. Two gates are required, not one: the person in the tab turns it on, and everything under `/bridge/` sits behind an authenticating front that the bridge verifies itself rather than trusting.
- **Web:** **Settings ▸ Advanced ▸ Allow remote control**, off by default and asked for per tab, is how that consent is given. One tab holds the session at a time: the most recent to turn it on takes it, and the tab it displaced is told so.

### Changed

- **File format:** `.hew` documents are saved as manifest version 18, which lets a sketch carry a name, tags, and hidden state. Older builds of Hew will not open a document saved by this one.
- **API:** `hew-cli mcp --live` no longer has to be started after someone has consented. It starts whether or not anything is attached, finds the instance when a tool call needs one, and recovers on its own when a tab reloads. A call made with nothing attached says so and the next one succeeds, with no restart. With `--launch`, the app is started by the first tool call rather than when the server starts.

### Fixed

- **Draw:** A rectangle's two live dimensions are shown in the same order typing them back uses. On a plane other than the ground, dragging into some directions showed them swapped.

## [1.1.0] (2026-09-16) - The "User Feedback" Release

Hew had no users before 1.0 and so this is the first one incorporating
user feedback... and there was a lot of that! As a result, this release
has the most changes of any Hew release to date.

Most of these changes are "muscle memory" changes for SketchUp users: type a
size after a click, Shift to pan mid-orbit, *all* selection modifiers, and
Cut and Paste In Place (which also works in groups).

Plus, shapes drawn on solids are now editable, history has names and is
visible, materials and components can be tidied, and there are even more
ways to install on Linux and macOS (and Windows per-machine installs
work, too).

### Added

- **Draw:** Shapes drawn on a solid's face are editable before they are pushed: select, move, rotate, scale, offset, or delete them on the face. [#9]
- **Typed sizes:** Every tool accepts a typed measurement after its committing click too, and the shape redraws in place as one undo step.
- **Draw:** Hold Shift to pin the drawing plane under the cursor until Shift or Escape releases it (like the docs already claimed), so a shape can stand in empty space on that plane. [#14]
- **Edit:** Cut, Copy, Paste, and Paste In Place for the selection, with the clipboard shared across desktop windows. [#18]
- **Groups:** Move parts into or out of a group by dragging in the Outliner, or by Cut, open the group, Paste In Place.
- **Selection:** Shift toggles, Ctrl/Cmd/Option adds, Shift with either subtracts; a triple click selects a connected shape; Select None and Invert Selection.
- **Camera:** Shift during an orbit drag switches to pan. Hold Ctrl/Cmd for a precise camera with no inertia; pressing it also stops a coasting view. [#5]
- **Undo:** Undo and Redo name what they will do, a Changes panel shows the session's timeline, and the unsaved-changes prompt lists what would be lost.
- **Draw:** Circles and arcs on a face stay true circles, with center, quadrant, and tangent snaps and smooth walls when pushed.
- **Outliner:** A filter field, a Model row that hides or shows everything, and show-all/hide-all on every group.
- **Materials:** Rename and delete materials from the Materials panel.
- **Components:** A Components panel lists every definition with a thumbnail and instance count, and can rename or delete one.
- **Purge Unused:** Remove unused materials and component definitions in one undoable step.
- **Report Bug:** Help ▸ Report Bug previews what a report contains, lets you untick parts, scrubs home paths, and sends or saves it. The crash screen can save a reproducer.
- **macOS:** A Homebrew tap: `brew install --cask hew3d/tap/hew` installs the app and puts `hew-cli` on the PATH. [#15]
- **Linux:** A signed pacman repository for Arch, a Gentoo overlay, and a signed Flatpak repository with a bundle on each release.
- **Windows:** The installer offers a per-machine install into Program Files as well as the per-user default.
- **API:** `hew.library` commands list, insert, save, and manage Library items from hew-cli and the MCP server. Groups get `hew.group.reparent`.
- **Docs:** Every Learn chapter opens with a captured demo clip, and a new section covers drawing on planes other than the ground.

### Changed

- **Push/Pull:** Hover picks the face first, so the cue near a corner no longer reads "Endpoint" and the drag anchors on the face being pushed.
- **Move and Rotate:** The copy toggle is Option on macOS and Ctrl on Windows and Linux. It was Option everywhere.
- **Camera:** Orbit and zoom pivot on the geometry under the cursor, so zoom no longer stops short of a detail on a large model.
- **Viewport:** Renders only when something changes. Idle CPU dropped about threefold in the foreground and tenfold in the background.
- **Saving:** Undo back to the saved state reads clean, so a change followed by its undo no longer prompts to save.
- **Follow Me:** Sweeps exactly the selected path; a single selected segment is no longer expanded to its connected run.
- **Linux:** The `.deb` carries a description, a desktop category, and the `.hew` file association; the association also applies on macOS and Windows.

### Fixed

- **Undo:** Undoing a vertex drag after undoing the extrusion that followed it crashed the kernel. [#12]
- **Draw:** A closed Line chain drawn on a face landed on the ground instead. Interior chains now imprint a sub-face, and chains that touch the boundary cut it per stretch. [#8]
- **Push/Pull:** A drawn shape standing in front of a solid's face lost the pick to the face behind it, with no way to choose. What is in front now wins. [#13]
- **Snapping:** On a face, the point snapped is the one the inference chip names, and an axis crossing an edge snaps as an intersection, so a corner-to-midpoint shape closes without a gap. [#11]
- **Push/Pull:** Pushing past a nearer wall facing the same way, or pulling out past a wall ahead, was refused. Both now carve or merge.
- **Draw:** A shape with one side along the face's own edge was refused; it now splits the face along that chord.
- **Draw:** A Line started on an edge or corner fell to the ground plane instead of the face the edge belongs to.
- **Snapping:** A ranking panic on dense floor plans broke every later snap until reload. Stacked corners in a plan view resolve to the nearest.
- **Dimensions:** In a Top view a dimension could land one endpoint on the floor. The first click now freezes the plane.
- **Units:** Imperial lengths with no integer part (`.75"`, `-.5`) were refused.
- **macOS:** Cmd+C, Cmd+V, and Cmd+A did not work in rename fields or in the Settings and Library windows.
- **Materials:** Double-clicking a material that was not yet selected did not open the rename editor.

### Security

- **Desktop:** Updated rustls to 0.23.45 for RUSTSEC-2026-0285.
- **All:** An audit of the Report Bug intake and everything new since 1.0. An upload is bounded in size, shape, and time, a guessed report id costs the service nothing, the log scrub covers any home folder, and a malformed arc claim is refused.

## [1.0.0] (2026-08-24) - The "Rock Solid" Release

Hew is now a use-it-every-day modeler: free, open source, and the same full app
on macOS, Windows, Linux, and in any modern browser with no account and no
reduced web tier.

The Library now works in the browser, the menus get a proper layout, and a
full-stack audit closes out the 0.x series.

### Added

- **Library:** Works in the browser, stored in the browser's own storage with nothing to set up.
- **Library:** On Chrome, Edge, and Brave, bind the Library to a folder on disk and let Dropbox, Nextcloud, or iCloud Drive carry it between machines.
- **Help:** Help ▸ Search finds any command by name.

### Changed

- **Menus:** One HIG-shaped layout on every platform. Object commands move from Edit to a new Object menu, panels move to View, and Draw and Tools are grouped by task.
- **Docs:** The website and user guide are rewritten for SketchUp users, with a feature-by-feature [comparison](https://hew3d.com/compare/sketchup/).
- **Tools:** The Axes tool is now Drawing Axes, so it no longer collides with View ▸ Axes.

### Fixed

- **Groups:** A group holding a component instance now moves as a whole.
- **Booleans:** Booleans on imported geometry no longer refuse themselves.
- **Web:** Two browser tabs can no longer overwrite each other's crash-recovery snapshot.
- **Rendering:** A sliver triangle no longer produces a bad face.

### Security

- **All:** An audit across the kernel, importers, relay, desktop shell, and browser build. A malformed model can no longer overflow an importer or pass a bad number into the kernel.

## [0.10.0] (2026-08-19) - The "Put It On Paper" Release

Hew can print. No, not 3D printing - paper, or a PDF, at an exact drawing scale.
Scaled floor plans, and 1:1 templates tiled across pages for gluing to a board
as a cut guide. SketchUp Make never had printing this good!

### Added

- **Print:** File ▸ Print Layout, with a Standard mode that prints what you see and a Scaled mode at any drawing scale (1:10, 1:1, 1" = 1').
- **Print:** A template larger than the page tiles across sheets with trim marks and an overlap margin for gluing.
- **Print:** Save PDF writes the PDF itself, so vectors stay vectors on every platform. Printing goes through the OS dialog at 100% / Actual Size.
- **Print:** Line art (white faces, black edges) alongside the full-color view; in Scaled mode it is true vector with hidden lines removed.
- **Export:** SVG line drawings, for laser cutters and CNC.
- **Print:** A cut list page lists every part with quantity and L × W × H.
- **Print:** Print every Scene as one drawing set, and a print sheet in Shop Mode.
- **API:** Printing and PDF export are available to hew-cli and agents.

### Security

- **All:** Updated the h2 crate to 0.4.16 for RUSTSEC-2026-0258.

## [0.9.0] (2026-08-17) - The "Making the Scene" Release

Scenes save a named view of a model. This includes the camera, what is hidden,
and the section plane. Set up the views you need before heading to the shop and
switch between them on the phone.

Also, self-hosting now covers Open on Phone, so a transfer can stay entirely on
your own network.

### Added

- **Scenes:** Named snapshots of the camera, hidden objects and tags, the section plane, and the grid, axes, and guides. Usable from Shop Mode and the API.
- **Self-hosting:** `hew-relay`, a static Linux binary that serves Open on Phone from your own origin, with a container image and a Proxmox LXC installer.
- **Desktop:** A setting points the Open on Phone QR code at your own server.
- **Tags:** Select everything a tag carries, rename a tag in place, and tag several objects at once.
- **Shop Mode:** The document menu lists recent models.

### Changed

- **File format:** Bumped to version 16 for Scenes and the section plane. Documents saved by 0.9.0 do not open in 0.8.0.
- **Desktop:** Opening a file already open in another window switches to that window.

## [0.8.0] (2026-08-15) - The "Hew on your Phone" Release

How can Hew be genuinely useful on a small screen? Enter "Shop Mode," a
dedicated mode, laser-focused on smartphones and touch screens. Tap a part for
its size, check the parts list, or see it in AR (iPhone/iPad only). Get the
file to the phone through any synced folder, or scan a QR code from the desktop
app for an end-to-end encrypted handoff.

Self-hosting the web app is more accessible, with a solid guide and a Proxmox
LXC script.

### Added

- **Shop Mode:** A read-only, touch-first viewer. Tap a part for its dimensions, browse a live parts sheet, measure with a loupe, isolate a part, and keep recent models offline.
- **Desktop:** File ▸ Open on Phone shows a QR code that loads the model in Shop Mode. The key travels only in the QR code; the relay sees ciphertext.
- **Export:** USDZ, and View in AR in Shop Mode on an iPhone or iPad.
- **Self-hosting:** A guide and a Proxmox LXC script for running the web app on your own machine.

### Fixed

- **Web:** Muted cross-origin errors no longer produce useless reproducer dumps on iOS home-screen installs.

## [0.7.2] (2026-08-11) - The "Update the code to match the docs" Release

Rewriting the Getting Started tutorial exposed a shortcut that differed between
platforms.

### Changed

- **Shortcuts:** The command palette is `Cmd+/` on macOS and `Ctrl+/` everywhere else.
- **Docs:** The [Getting Started](https://hew3d.com/learn/getting-started/) tutorial is rewritten to be easier to follow.

## [0.7.1] (2026-08-09) - First Bug Fix Release

### Fixed

- **Snapping:** Projected inference points were ignored under an axis lock, a regression from 0.4.0.

## [0.7.0] (2026-08-08) - Shared Library and Nested Components

Some parts are too useful to live in one model. The Library keeps components,
materials, and whole models for reuse, and components can finally contain other
components.

SketchUp imports honor groups and components properly.

### Added

- **Library:** Save components, materials, and models as plain `.hew` files in a folder you choose, then insert them into any document or open them to edit.
- **Components:** Definitions nest. A component can hold other components and groups, and all of them edit in place through any instance.

### Changed

- **File format:** Bumped to version 15 for nested definitions. Documents saved by 0.7.0 do not open in 0.6.0.
- **Import:** A plain SketchUp group imports as an Object, a nested group as a Group, and a component as a Component. Groups used to arrive as plain objects and components as componentized plain objects.
- **Build:** Every dependency is pinned and audited daily, so security fixes reach releases promptly.

## [0.6.0] (2026-08-05) - Public API and MCP

Hew can be driven from a shell, a script, or an AI agent. A new `hew-cli` builds
models headless or writes into the desktop document you already have open.

### Added

- **API:** The Hew API and `hew-cli`, which builds and edits models with no UI. `--live` drives the open desktop document instead.
- **MCP:** An MCP server in `hew-cli`, so an AI agent can model in Hew. See [docs/API_GUIDE.md](docs/API_GUIDE.md).
- **Desktop:** `hew-cli` ships inside the app on every platform. On Linux, prefer the `.deb` or `.rpm` over the AppImage to get it on the PATH.
- **Data:** Every entity has a stable ID that survives undo and save, and can carry attribute dictionaries for scripts.

### Changed

- **File format:** Bumped to version 14 for stable IDs and attributes. Documents saved by 0.6.0 do not open in 0.5.0.
- **Export:** glTF, STL, and 3MF share one writer and all keep colors.

## [0.5.0] (2026-08-01)

Groups and components used to support tools one at a time, so some tools did not
work inside them and others worked differently. Now they become plain geometry
for the length of an edit and every tool works.

### Added

- **Groups and components:** Every tool works inside an edit. A group's copy is a fresh copy; a component's copy is another instance.
- **Tape Measure:** Works on any plane and honors axis locks, modeled on SketchUp.
- **Tape Measure:** Type a new length inside a group or component edit to rescale just that part instead of the whole model.

## [0.4.0] (2026-07-30)

3D text, dimensions, a full camera system, texture positioning, and modeling
inside component definitions. One step closer to SketchUp parity.

### Added

- **3D Text:** Extruded solid text on any face or plane, with five bundled open-license fonts plus your system fonts.
- **Dimensions:** Linear and radial dimensions and leader text, saved with the document and legible at any zoom.
- **Camera:** Parallel Projection, typed Field of View, Zoom Window, and Position Camera, Look Around, and Walk.
- **Components:** Sketching, extrusion, Follow Me, booleans, slice, and transforms all work inside a definition and apply to every instance.
- **Textures:** Position Texture drags corner pins to move, rotate, scale, and shear a texture on a face, or type an exact angle or scale.
- **Paint:** Alt-click samples a face's material; Shift-click replaces that material everywhere, or within the clicked object with Ctrl/Cmd.
- **Rotate:** Rotational arrays, matching the linear arrays in Move.
- **Push/Pull:** Double-click a face to repeat the last distance; Ctrl/Cmd extrudes a new solid instead of stretching the existing one.
- **Tape Measure:** Measure between two points and type the length it should be to rescale the model.
- **Axes:** Place and orient the drawing origin anywhere on the model.
- **Axis locks:** An arrow key sets the lock at any point up to a shape's second click.
- **Materials:** A searchable palette, with the add-color and add-texture panels collapsed until needed.
- **Snapping:** The label says "projected" when a point is used as an alignment reference rather than as the point itself.

### Changed

- **File format:** Bumped to version 13 for annotations, the camera, and drawing axes. Documents saved by 0.4.0 do not open in 0.3.0.

### Fixed

- **Input:** Double-click did not register in Chromium-based browsers or the Windows desktop app.

## [0.3.0] (2026-07-22)

Sketches leave the ground, STL comes in, Follow Me grows up, and the desktop app
opens more than one window.

### Added

- **Draw:** Draw on any plane. Extend any sketch in place, or lock a drawing plane with the arrow keys.
- **Import:** STL, binary and ASCII, with healing, hollow-part reconstruction, and a units chooser.
- **Polygon:** Regular N-gons with a live typed side count, plus selectable polygon and circle centers.
- **Scale:** Non-uniform scale through a grip gizmo: stretch one axis, two, or all three.
- **Section Plane:** A non-destructive clipping plane for looking inside a model, with an offset-sweep widget.
- **Desktop:** Multiple windows, one Open dialog for every format, and opens that go to a new window instead of replacing unsaved work.
- **Object Info:** Shows bounding-box dimensions, so you can tell whether a part fits a 3D printer's print bed.
- **Circle:** Editable segment counts.

### Changed

- **File format:** Bumped to version 12 for polygons and other curve kinds. Documents saved by 0.3.0 do not open in 0.2.0.
- **Follow Me:** Profiles auto-orient to the path, corner starts and partial sweeps work, a face can be the profile, and spheres and tori render smooth.
- **Snapping:** Circle and polygon centers and quadrants pull harder than facet noise; Ctrl+Alt flattens the pull for the exact point.
- **Rotate:** Axis-locked Rotate is constrained to the pivot plane.

### Fixed

- **Viewport:** The origin axes no longer paint over linework.
- **Undo:** Undoing a sketch island move after other edits could resolve the wrong island.
- **Selection:** A drawn curve could not be selected from its own snap points.

## [0.2.0] (2026-07-18)

The first feature release after the MVP: two new tools and a round of polish.

### Added

- **Follow Me:** Sweep a profile along a path for moldings and pipes, or around an axis as a lathe for spheres, goblets, and cones.
- **Offset:** Inset or outset a profile, region, or face by a set distance.
- **Move:** Copy an object a set distance, then type `5x` to repeat it.
- **Groups:** Union, Subtract, and Intersect work on groups, and a group duplicates in one step.
- **Components:** Definition and instance names, and clear marking of which instances belong to which component.
- **Sketches:** Rotate a sketch out of plane, or copy an island off-plane onto its own sketch.
- **Tape Measure:** Lays down guides.
- **Viewport:** Guidance when the GPU is unavailable, with a software-rendering fallback.

### Changed

- **Selection:** A tool click on an object selects it and acts; there is no separate select step.
- **Move:** Dragging objects works as expected.
- **View:** Zoom Extents frames only what is visible.
- **Welcome:** Choose your units on the welcome screen instead of in Settings.

### Fixed

- **Push/Pull:** The direction no longer flips under drag noise, and a typed negative distance is honored.
- **Viewport:** Edges shimmered after orbiting.
- **Follow Me:** The path on a solid's face is directly pickable.
- **Snapping:** Circle centers snap reliably.
- **Tags:** Deleting a tag works and is undoable.

## [0.1.1] (2026-07-15)

### Fixed

- **Linux:** The AppImage failed to start on Ubuntu and other recent distributions because its bundled libwayland conflicted with the system's. No other changes from 0.1.0.

## [0.1.0] (2026-07-15)

The first public release: the minimum viable Hew, with the basic
modeling tools working and builds for every platform.

### Added

- **Draw:** Line, Rectangle, Circle, and Arc, on the ground or on any face, with inference snapping.
- **Push/Pull:** With a live preview. Every extrusion is a discrete, watertight solid, and objects never merge on their own.
- **Solids:** Union, Subtract, and Intersect, run only when you ask, and Slice to cut a solid along a plane.
- **Transform:** Move with copy, Rotate, and Scale.
- **Groups and components:** Non-destructive, with components that edit once and update everywhere.
- **Materials:** A palette, per-face and per-object paint, image textures, and per-material opacity.
- **Organization:** Tags with per-tag visibility, an Outliner, and construction guides.
- **Measure:** Tape Measure and Protractor, which measure or drop a guide.
- **Curves:** A drawn circle stays a circle underneath its facets, so exports can re-facet it at any smoothness.
- **Undo:** Grouped by gesture, on a deterministic kernel so the same steps always give the same result.
- **Import:** SketchUp 2017 `.skp` (clean-room, no SketchUp SDK), COLLADA `.dae`, and glTF.
- **Export:** glTF, STL, and 3MF.
- **Files:** The native `.hew` format, an open and documented container.
- **Units:** Metric, decimal inches, or feet-and-inches, with typed lengths in every tool.
- **Welcome:** A welcome screen with bundled sample models.
- **Refusals:** Anything Hew will not do, it explains and leaves the geometry untouched.
- **Platforms:** Native apps for macOS (signed and notarized), Windows, and Linux with a built-in updater, and the same app in the browser with offline support.

### Known issues

- **Linux:** The AppImage can fail to load on newer distributions. Fixed in 0.1.1.

[1.1.0]: https://github.com/hew3d/hew/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/hew3d/hew/compare/v0.10.0...v1.0.0
[0.10.0]: https://github.com/hew3d/hew/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/hew3d/hew/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/hew3d/hew/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/hew3d/hew/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/hew3d/hew/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/hew3d/hew/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/hew3d/hew/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/hew3d/hew/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/hew3d/hew/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/hew3d/hew/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/hew3d/hew/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/hew3d/hew/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/hew3d/hew/releases/tag/v0.1.0

[#5]: https://github.com/hew3d/hew/issues/5
[#8]: https://github.com/hew3d/hew/issues/8
[#9]: https://github.com/hew3d/hew/issues/9
[#11]: https://github.com/hew3d/hew/issues/11
[#12]: https://github.com/hew3d/hew/issues/12
[#13]: https://github.com/hew3d/hew/issues/13
[#14]: https://github.com/hew3d/hew/issues/14
[#15]: https://github.com/hew3d/hew/issues/15
[#18]: https://github.com/hew3d/hew/issues/18
